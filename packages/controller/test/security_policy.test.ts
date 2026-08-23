/**
 * Content Security Policy and rate limiting.
 *
 * Mirrors actionpack/test/dispatch/content_security_policy_test.rb and
 * actionpack/test/controller/rate_limiting_test.rb. Both are security
 * features, so the tests are about what they refuse, not what they allow.
 */

import { describe, expect, it } from "bun:test";
import { Current, MemoryStore, minutes, seconds } from "@altair/support";
import {
  ContentSecurityPolicy,
  contentSecurityPolicy,
  generateNonce,
  quoteSource,
} from "../src/csp.js";
import {
  clientAddress,
  counterKey,
  rateLimit,
  recordRequest,
  tooManyRequests,
  windowSeconds,
} from "../src/rate_limit.js";

const request = (init: RequestInit & { url?: string } = {}) =>
  new Request(init.url ?? "https://example.com/", init);

const ok = async () => new Response("ok");

describe("policy sources", () => {
  // Written bare, `self` is a hostname called self, and the policy silently
  // does nothing.
  it("quote the keywords", () => {
    expect(quoteSource("self")).toBe("'self'");
    expect(quoteSource("none")).toBe("'none'");
    expect(quoteSource("unsafe-inline")).toBe("'unsafe-inline'");
  });

  it("leave a host alone", () => {
    expect(quoteSource("https://cdn.example.com")).toBe("https://cdn.example.com");
    expect(quoteSource("data:")).toBe("data:");
    expect(quoteSource("*.example.com")).toBe("*.example.com");
  });
});

describe("building a policy", () => {
  it("writes the directives it was given", () => {
    const policy = new ContentSecurityPolicy()
      .defaultSrc("self")
      .imgSrc("self", "data:")
      .scriptSrc("self", "https://cdn.example.com");

    expect(policy.toHeader()).toBe(
      "default-src 'self'; img-src 'self' data:; script-src 'self' https://cdn.example.com",
    );
  });

  it("replaces a directive on set and appends on add", () => {
    const policy = new ContentSecurityPolicy().scriptSrc("self");

    policy.add("script-src", "https://cdn.example.com");
    expect(policy.toHeader()).toBe("script-src 'self' https://cdn.example.com");

    policy.set("script-src", "none");
    expect(policy.toHeader()).toBe("script-src 'none'");
  });

  // `script-src;` means nothing; forbidding everything is spelled 'none'.
  it("writes a directive with no sources as none", () => {
    expect(new ContentSecurityPolicy().set("object-src").toHeader()).toBe("object-src 'none'");
  });

  it("writes directives that carry no sources", () => {
    const policy = new ContentSecurityPolicy().defaultSrc("self").flag("upgrade-insecure-requests");
    expect(policy.toHeader()).toBe("default-src 'self'; upgrade-insecure-requests");
  });

  it("takes a report uri", () => {
    expect(new ContentSecurityPolicy().reportUri("/csp-reports").toHeader()).toBe(
      "report-uri /csp-reports",
    );
  });

  it("knows when it says nothing", () => {
    expect(new ContentSecurityPolicy().isEmpty).toBe(true);
    expect(new ContentSecurityPolicy().defaultSrc("self").isEmpty).toBe(false);
  });

  // A per-action change must not edit the application's own policy.
  it("clones without sharing", () => {
    const original = new ContentSecurityPolicy().scriptSrc("self");
    const copy = original.clone().add("script-src", "https://extra.example.com");

    expect(original.toHeader()).toBe("script-src 'self'");
    expect(copy.toHeader()).toContain("https://extra.example.com");
  });
});

describe("nonces", () => {
  it("are not guessable", () => {
    const nonces = new Set(Array.from({ length: 100 }, () => generateNonce()));
    expect(nonces.size).toBe(100);
    expect(generateNonce().length).toBeGreaterThan(16);
  });

  it("join the script and style directives", () => {
    const policy = new ContentSecurityPolicy().scriptSrc("self").imgSrc("self");
    const header = policy.toHeader("abc123");

    expect(header).toContain("script-src 'self' 'nonce-abc123'");
    expect(header).toContain("img-src 'self'");
    expect(header).not.toContain("img-src 'self' 'nonce-abc123'");
  });

  it("join whichever directives the policy names", () => {
    const policy = new ContentSecurityPolicy().imgSrc("self").nonceDirectives("img-src");
    expect(policy.toHeader("abc123")).toContain("img-src 'self' 'nonce-abc123'");
  });
});

describe("the middleware", () => {
  const policy = new ContentSecurityPolicy().defaultSrc("self").scriptSrc("self");

  it("sets the header", async () => {
    const response = await contentSecurityPolicy(policy)(request(), ok);
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
  });

  // The way to deploy a policy to a site that has never had one.
  it("reports without enforcing when asked", async () => {
    const response = await contentSecurityPolicy(policy, { reportOnly: true })(request(), ok);

    expect(response.headers.get("content-security-policy-report-only")).toContain("default-src");
    expect(response.headers.get("content-security-policy")).toBeNull();
  });

  // The nonce in the header and the one the page renders have to be the same
  // one, or the pair is no use at all.
  it("puts the nonce where a view can read it", async () => {
    let seen: string | undefined;

    await Current.run({}, async () => {
      const response = await contentSecurityPolicy(policy)(request(), async () => {
        seen = Current.cspNonce;
        return new Response("ok");
      });

      expect(seen).toBeDefined();
      expect(response.headers.get("content-security-policy")).toContain(`'nonce-${seen}'`);
    });
  });

  it("gives every request its own", async () => {
    const first = await contentSecurityPolicy(policy)(request(), ok);
    const second = await contentSecurityPolicy(policy)(request(), ok);

    expect(first.headers.get("content-security-policy")).not.toBe(
      second.headers.get("content-security-policy"),
    );
  });

  it("sets no nonce when told not to", async () => {
    const response = await contentSecurityPolicy(policy, { nonce: false })(request(), ok);
    expect(response.headers.get("content-security-policy")).not.toContain("nonce-");
  });

  it("leaves a header the application set", async () => {
    const response = await contentSecurityPolicy(policy)(
      request(),
      async () =>
        new Response("ok", { headers: { "content-security-policy": "default-src 'none'" } }),
    );

    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'");
  });

  it("does nothing for an empty policy", async () => {
    const response = await contentSecurityPolicy(new ContentSecurityPolicy())(request(), ok);
    expect(response.headers.get("content-security-policy")).toBeNull();
  });

  it("passes the response through", async () => {
    const response = await contentSecurityPolicy(policy)(request(), async () =>
      Response.json({ ok: true }, { status: 201 }),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true });
  });
});

describe("identifying a caller", () => {
  // Only the first entry is the client; the rest are proxies it passed through.
  it("reads the client from a forwarding header", () => {
    expect(clientAddress(request({ headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" } }))).toBe(
      "1.2.3.4",
    );
  });

  it("falls back to the real ip header", () => {
    expect(clientAddress(request({ headers: { "x-real-ip": "9.9.9.9" } }))).toBe("9.9.9.9");
  });

  it("says so when it cannot tell", () => {
    expect(clientAddress(request())).toBe("unknown");
  });
});

describe("counting", () => {
  it("measures a window in seconds", () => {
    expect(windowSeconds(60)).toBe(60);
    expect(windowSeconds(minutes(3))).toBe(180);
  });

  // A window expires by being a different key, so nothing has to sweep it.
  it("puts the window in the key", () => {
    const first = counterKey("login", "1.2.3.4", 60, 0);
    const same = counterKey("login", "1.2.3.4", 60, 59_000);
    const next = counterKey("login", "1.2.3.4", 60, 61_000);

    expect(same).toBe(first);
    expect(next).not.toBe(first);
  });

  it("keeps one caller's count from another's", () => {
    expect(counterKey("login", "1.2.3.4", 60, 0)).not.toBe(counterKey("login", "5.6.7.8", 60, 0));
  });

  it("keeps one limit from another on the same caller", () => {
    expect(counterKey("login", "1.2.3.4", 60, 0)).not.toBe(counterKey("api", "1.2.3.4", 60, 0));
  });
});

describe("recording requests", () => {
  const options = () => ({ to: 2, within: seconds(60), store: new MemoryStore() });

  it("counts up", async () => {
    const shared = options();

    expect((await recordRequest(shared, request())).count).toBe(1);
    expect((await recordRequest(shared, request())).count).toBe(2);
  });

  it("reports what is left", async () => {
    const shared = options();
    const state = await recordRequest(shared, request());

    expect(state.remaining).toBe(1);
    expect(state.limit).toBe(2);
    expect(state.exceeded).toBe(false);
  });

  it("goes over on the request past the limit", async () => {
    const shared = options();

    await recordRequest(shared, request());
    await recordRequest(shared, request());

    const third = await recordRequest(shared, request());
    expect(third.exceeded).toBe(true);
    expect(third.remaining).toBe(0);
  });

  it("counts callers separately", async () => {
    const shared = options();
    const first = request({ headers: { "x-real-ip": "1.1.1.1" } });
    const second = request({ headers: { "x-real-ip": "2.2.2.2" } });

    await recordRequest(shared, first);
    await recordRequest(shared, first);

    expect((await recordRequest(shared, second)).exceeded).toBe(false);
  });

  it("starts again in the next window", async () => {
    const shared = options();

    await recordRequest(shared, request(), 0);
    await recordRequest(shared, request(), 0);
    expect((await recordRequest(shared, request(), 0)).exceeded).toBe(true);

    expect((await recordRequest(shared, request(), 61_000)).exceeded).toBe(false);
  });

  it("takes a caller of the application's choosing", async () => {
    const shared = { ...options(), by: () => "everyone" };
    const first = request({ headers: { "x-real-ip": "1.1.1.1" } });
    const second = request({ headers: { "x-real-ip": "2.2.2.2" } });

    await recordRequest(shared, first);
    await recordRequest(shared, first);

    expect((await recordRequest(shared, second)).exceeded).toBe(true);
  });

  // The counter's expiry is what ends the window. An increment that reset it
  // would leave a caller limited for good.
  it("keeps the window's expiry as the count rises", async () => {
    const store = new MemoryStore();
    const shared = { to: 100, within: seconds(60), store };

    await recordRequest(shared, request(), 0);
    await recordRequest(shared, request(), 0);

    const key = counterKey("default", "unknown", 60, 0);
    expect(await store.read<number>(key)).toBe(2);

    // Written with an expiry, so a store that dropped it would still read 2
    // here — what proves it is that the next window starts from nothing.
    expect((await recordRequest(shared, request(), 61_000)).count).toBe(1);
  });
});

describe("the rate limit middleware", () => {
  const limiter = () => rateLimit({ to: 2, within: seconds(60), store: new MemoryStore() });

  it("lets a request through under the limit", async () => {
    const response = await limiter()(request(), ok);
    expect(response.status).toBe(200);
  });

  it("refuses once the limit is reached", async () => {
    const throttle = limiter();

    await throttle(request(), ok);
    await throttle(request(), ok);

    const third = await throttle(request(), ok);
    expect(third.status).toBe(429);
  });

  it("says how long to wait", async () => {
    const throttle = limiter();
    for (let index = 0; index < 3; index += 1) await throttle(request(), ok);

    const refused = await throttle(request(), ok);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("reports the allowance on every response", async () => {
    const response = await limiter()(request(), ok);

    expect(response.headers.get("x-ratelimit-limit")).toBe("2");
    expect(response.headers.get("x-ratelimit-remaining")).toBe("1");
  });

  it("answers however the application says", async () => {
    const throttle = rateLimit({
      to: 1,
      within: seconds(60),
      store: new MemoryStore(),
      with: () => new Response("slow down", { status: 503 }),
    });

    await throttle(request(), ok);
    const refused = await throttle(request(), ok);

    expect(refused.status).toBe(503);
    expect(await refused.text()).toBe("slow down");
  });

  it("builds a plain refusal on its own", () => {
    const response = tooManyRequests(30);

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("30");
  });
});
