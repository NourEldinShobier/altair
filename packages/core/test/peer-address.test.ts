/**
 * The other half of `request.ip`: the handler asking the server for it.
 *
 * `client-ip.ts` has taken a `socketAddress` since it was written and says
 * plainly what happens without one — "the default is to trust nothing and use
 * the socket address" — and nothing supplied it. `Bun.serve` hands the fetch
 * handler a server that answers `requestIP`, and the handler never asked.
 *
 * So every address in the process fell through to `X-Real-Ip`, a header any
 * client can write, in a file whose whole purpose is to stop an address being
 * read out of a header a client wrote.
 *
 * Lives here rather than beside `client-ip.ts` because only a booted
 * application has a handler and a server to hand it.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Controller } from "@altair/controller";
import { createApplication, type Application, type UpgradeServer } from "../src/index.js";

class VisitsController extends Controller {
  index(): void {
    this.render.json({
      client: this.clientIp() ?? null,
      behindProxy: this.clientIp({ trustedProxies: 1 }) ?? null,
    });
  }
}

let app: Application;
let handler: (request: Request, server?: UpgradeServer) => Promise<Response>;

/** What `Bun.serve` hands the handler, narrowed to the two methods used. */
const serverSaying = (address: string | null): UpgradeServer => ({
  upgrade: () => false,
  requestIP: () => (address === null ? null : { address }),
});

const visit = async (
  server?: UpgradeServer,
  headers: Record<string, string> = {},
): Promise<{ client: string | null; behindProxy: string | null }> => {
  const response = await handler(new Request("https://example.com/visits", { headers }), server);

  return (await response.json()) as { client: string | null; behindProxy: string | null };
};

beforeAll(async () => {
  app = createApplication({
    env: "test",
    secretKeyBase: "z".repeat(64),
    database: { url: "sqlite://:memory:" },
    log: { level: "fatal", format: "json", queries: false },
    routes: (r) => r.resources("visits"),
    controllers: { visits: VisitsController },
  });

  await app.boot();
  handler = app.handler();
});

afterAll(async () => {
  await app.stop();
});

describe("what the server observed", () => {
  it("reaches the action", async () => {
    expect((await visit(serverSaying("203.0.113.9"))).client).toBe("203.0.113.9");
  });

  /** The bug this closes: a forged header was the only answer available. */
  it("is preferred to a header a client wrote", async () => {
    const seen = await visit(serverSaying("203.0.113.9"), {
      "x-forwarded-for": "1.2.3.4",
      "x-real-ip": "1.2.3.4",
    });

    expect(seen.client).toBe("203.0.113.9");
  });

  it("is absent when the server cannot say", async () => {
    expect(await visit(serverSaying(null))).toEqual({ client: null, behindProxy: null });
  });

  /**
   * A test driving the handler directly passes no server at all, and that has
   * to keep working — an action is testable without a socket.
   */
  it("is absent when there is no server, without failing the request", async () => {
    expect(await visit()).toEqual({ client: null, behindProxy: null });
  });

  /**
   * Declaring a proxy is what makes the header readable, and the observed
   * address is still the floor underneath it: a chain shorter than the number
   * of proxies declared means the request did not come through them.
   */
  it("is still the floor once a proxy is declared", async () => {
    const through = await visit(serverSaying("10.0.0.7"), {
      "x-forwarded-for": "203.0.113.9, 10.0.0.7",
    });

    expect(through.behindProxy).toBe("10.0.0.7");

    const direct = await visit(serverSaying("10.0.0.7"));

    expect(direct.behindProxy).toBe("10.0.0.7");
  });

  /**
   * Per request, like everything else in `Current`. Two requests through one
   * handler must not see each other's peer.
   */
  it("belongs to one request and does not outlive it", async () => {
    expect((await visit(serverSaying("203.0.113.9"))).client).toBe("203.0.113.9");
    expect((await visit(serverSaying("198.51.100.1"))).client).toBe("198.51.100.1");
    expect((await visit()).client).toBeNull();
  });
});
