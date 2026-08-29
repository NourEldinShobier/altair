/**
 * Back where they came from, ported from
 * `actionpack/test/controller/redirect_test.rb`.
 *
 * The fallback is required, and that is the whole design. `Referer` is a header
 * the client chooses: absent on a bookmark, absent behind most privacy
 * settings, and whatever the caller likes when the caller is not a browser.
 * Rails made `fallback_location` mandatory in 5.0 for exactly that reason.
 */

import { describe, expect, it } from "bun:test";
import { Controller, UnsafeRedirect } from "../src/index.js";

class Posts extends Controller {
  async back(): Promise<Response> {
    return this.redirectBack("/posts");
  }
}

const requestWith = (referer?: string) =>
  new Request("https://app.example/posts/1/like", {
    method: "POST",
    headers: referer ? { referer } : {},
  });

const run = async (referer?: string) => {
  const controller = new Posts({ request: requestWith(referer) });
  return await controller.back();
};

describe("going back", () => {
  it("goes to the referrer when there is one", async () => {
    const response = await run("https://app.example/posts");

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://app.example/posts");
  });

  /**
   * The requests with no referrer are the ones a `redirect_back` without a
   * fallback answers with a 302 to nowhere.
   */
  it("goes to the fallback when there is not", async () => {
    expect((await run()).headers.get("location")).toBe("/posts");
  });

  it("takes a relative referrer", async () => {
    expect((await run("/posts?page=2")).headers.get("location")).toBe("/posts?page=2");
  });
});

/**
 * `Referer` is chosen by whoever made the request, so it gets the same host
 * check as any other redirect. Without it, a link from an attacker's page
 * bounces the visitor straight back to the attacker's copy of the login form.
 */
describe("a referrer pointing somewhere else", () => {
  it("is not followed", async () => {
    const response = await run("https://evil.example/login");

    expect(response.headers.get("location")).toBe("/posts");
  });

  it("falls back rather than raising", async () => {
    // A forged referrer is an ordinary thing to receive, not an error the
    // application should surface — unlike `redirectTo` on a bad location,
    // where the application named the location itself.
    //
    // `expect(async () => ...).not.toThrow()` stood here and asserted nothing:
    // an async function never throws synchronously, so it passes whatever the
    // code does. Awaited and checked instead.
    const response = await run("https://evil.example/login");

    expect(response.status).toBe(302);
  });

  it("is followed when the caller says so", async () => {
    const controller = new Posts({ request: requestWith("https://evil.example/x") });
    const response = controller.redirectBack("/posts", { allowOtherHost: true });

    expect(response.headers.get("location")).toBe("https://evil.example/x");
  });
});

describe("the status", () => {
  it("is 302 unless another is asked for", async () => {
    const controller = new Posts({ request: requestWith("/posts") });

    expect(controller.redirectBack("/posts", { status: 303 }).status).toBe(303);
  });
});

/**
 * The contrast: `redirectTo` raises on an off-host location because the
 * application named that location itself, and a redirect the application wrote
 * pointing off-site is a bug worth stopping on.
 */
describe("compared with redirectTo", () => {
  it("still raises when the application names another host", () => {
    const controller = new Posts({ request: requestWith() });

    expect(() => controller.redirectTo("https://evil.example")).toThrow(UnsafeRedirect);
  });
});
