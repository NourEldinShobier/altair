/**
 * A rate limiter whose counters cannot be reached.
 *
 * The store is failsafe, which is right for a cache and wrong for a limit: a
 * failed increment answers 0, and 0 reads as "under the limit". So a limit
 * backed by a Redis that is down stops limiting, and stops silently — which is
 * the window a credential-stuffing run waits for.
 *
 * What makes it detectable at all: a successful increment always answers at
 * least 1, the request that just counted. Zero cannot be a real count.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { errors, MemoryStore, seconds } from "@altair/support";
import { rateLimit, recordRequest } from "../src/rate_limit.js";

/** A store that has stopped answering, the way a failsafe cache reports it. */
class BrokenStore extends MemoryStore {
  override async increment(): Promise<number> {
    return 0;
  }
}

const request = () =>
  new Request("https://app.example/session", {
    method: "POST",
    headers: { "x-forwarded-for": "203.0.113.9" },
  });

const ok = async () => new Response("ok");

/** Collects what the framework reports for the length of one case. */
function reported(): { seen: unknown[] } {
  const seen: unknown[] = [];
  subscription = errors.subscribe((error) => void seen.push(error));
  return { seen };
}

let subscription: { unsubscribe(): void } | undefined;

afterEach(() => {
  subscription?.unsubscribe();
  subscription = undefined;
});

describe("an outage", () => {
  it("is told apart from a first request", async () => {
    const broken = { to: 5, within: seconds(60), store: new BrokenStore() };
    const working = { to: 5, within: seconds(60), store: new MemoryStore() };

    expect((await recordRequest(broken, request())).storeFailed).toBe(true);
    expect((await recordRequest(working, request())).storeFailed).toBe(false);
  });

  // A limit exists to protect something, and a limit that is not working is
  // not protecting it.
  it("refuses the request by default", async () => {
    const response = await rateLimit({ to: 5, within: seconds(60), store: new BrokenStore() })(
      request(),
      ok,
    );

    expect(response.status).toBe(429);
  });

  // An endpoint that has quietly stopped being limited looks exactly like one
  // that is working, so the outage has to say something.
  it("is reported", async () => {
    const { seen } = reported();

    await rateLimit({ to: 5, within: seconds(60), store: new BrokenStore(), name: "login" })(
      request(),
      ok,
    );

    expect(seen).toHaveLength(1);
    expect((seen[0] as Error).message).toContain("login");
  });

  // Telling a client it has its whole allowance left, while refusing it, is
  // telling it something that is not true.
  it("does not claim the allowance is untouched", async () => {
    const response = await rateLimit({ to: 5, within: seconds(60), store: new BrokenStore() })(
      request(),
      ok,
    );

    expect(response.headers.get("x-ratelimit-remaining")).toBe("0");
  });

  /**
   * The other side of the trade, and it is a real one: an application may
   * rather stay up on a limit where unlimited is survivable and unavailable is
   * not. It has to be asked for.
   */
  it("lets the request through when asked to", async () => {
    const { seen } = reported();

    const response = await rateLimit({
      to: 5,
      within: seconds(60),
      store: new BrokenStore(),
      onStoreFailure: "allow",
    })(request(), ok);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    // Still reported: allowed is not the same as unnoticed.
    expect(seen).toHaveLength(1);
  });
});

describe("a store that is answering", () => {
  it("reports nothing", async () => {
    const { seen } = reported();

    const response = await rateLimit({ to: 5, within: seconds(60), store: new MemoryStore() })(
      request(),
      ok,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratelimit-remaining")).toBe("4");
    expect(seen).toEqual([]);
  });
});
