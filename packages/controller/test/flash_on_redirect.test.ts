/**
 * Setting a message and redirecting in one call, ported from
 * `actionpack/test/controller/flash_test.rb`.
 *
 * `redirect_to post, notice: "Saved"` is the most common line in a Rails
 * controller, and the reason it is one call rather than two is a rake worth
 * naming: the message has to be set before the response is built, so a
 * `redirectTo` placed above the `flash` line loses it with nothing to show.
 */

import { describe, expect, it } from "bun:test";
import { Secrets } from "@altair/support";
import { Controller, UnsafeRedirect } from "../src/index.js";

// The flash lives in the session, and the session cookie is encrypted.
const secrets = new Secrets("a".repeat(64));

// GET, because none of this depends on the method and a POST would have to
// carry a CSRF token that has nothing to do with what is under test.
const requestFor = (path = "/posts") => new Request(`https://app.example${path}`);

class Posts extends Controller {
  async create(): Promise<Response> {
    return this.redirectTo("/posts", { notice: "Saved" });
  }

  async fail(): Promise<Response> {
    return this.redirectTo("/posts", { alert: "Could not save" });
  }

  async both(): Promise<Response> {
    return this.redirectTo("/posts", { notice: "Saved", alert: "But check the date" });
  }

  async nested(): Promise<Response> {
    return this.redirectTo("/posts", { flash: { anything: "at all" } });
  }

  async typo(): Promise<Response> {
    return this.redirectTo("/posts", { notic: "Saved" });
  }

  async offsite(): Promise<Response> {
    return this.redirectTo("https://evil.example", { notice: "Saved" });
  }
}

const run = async (action: string) => {
  const controller = new Posts({ request: requestFor(), secrets });
  const response = await controller.processAction(action as never);

  return { controller, response };
};

/**
 * What the *next* request sees.
 *
 * A flash set during a redirect is for the page being redirected to, so
 * reading it off the controller that set it asks the wrong question — that one
 * holds the messages it was *given*. This follows the session cookie to a
 * second request, which is the whole behaviour and the only honest check.
 */
const followedBy = async (response: Response): Promise<Record<string, unknown>> => {
  const cookie = response.headers
    .getSetCookie()
    .map((one) => one.split(";")[0])
    .join("; ");

  const next = new Posts({
    request: new Request("https://app.example/posts", { headers: { cookie } }),
    secrets,
  });

  return next.flash.toObject();
};

describe("redirecting with a message", () => {
  it("redirects", async () => {
    const { response } = await run("create");

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/posts");
  });

  it("carries a notice to the page it redirects to", async () => {
    const { response } = await run("create");

    expect((await followedBy(response)).notice).toBe("Saved");
  });

  it("carries an alert", async () => {
    const { response } = await run("fail");

    expect((await followedBy(response)).alert).toBe("Could not save");
  });

  it("carries both at once", async () => {
    const { response } = await run("both");
    const carried = await followedBy(response);

    expect(carried.notice).toBe("Saved");
    expect(carried.alert).toBe("But check the date");
  });

  it("takes anything at all inside flash", async () => {
    const { response } = await run("nested");

    expect((await followedBy(response)).anything).toBe("at all");
  });
});

/**
 * `{ notic: "Saved" }` should not be a redirect that quietly shows no message.
 * Refusing the key is the difference between noticing at once and wondering
 * later why it never appears.
 */
describe("a key nobody declared", () => {
  it("is refused rather than ignored", async () => {
    await expect(run("typo")).rejects.toThrow(/not a redirect option or a flash type/);
  });

  it("says how to declare it", async () => {
    await expect(run("typo")).rejects.toThrow(/addFlashTypes/);
  });
});

describe("declaring another type", () => {
  it("accepts it as an option", async () => {
    class WithWarning extends Controller {
      static {
        this.addFlashTypes("warning");
      }

      async show(): Promise<Response> {
        return this.redirectTo("/posts", { warning: "Check the date" });
      }
    }

    const controller = new WithWarning({ request: requestFor(), secrets });
    const response = await controller.processAction("show");

    const cookie = response.headers
      .getSetCookie()
      .map((one) => one.split(";")[0])
      .join("; ");

    const next = new WithWarning({
      request: new Request("https://app.example/posts", { headers: { cookie } }),
      secrets,
    });

    expect(next.flash.toObject().warning).toBe("Check the date");
  });

  it("keeps notice and alert alongside it", () => {
    class WithWarning extends Controller {
      static {
        this.addFlashTypes("warning");
      }
    }

    expect(WithWarning.flashTypes).toContain("notice");
    expect(WithWarning.flashTypes).toContain("warning");
  });

  it("leaves the parent alone", () => {
    class Child extends Controller {
      static {
        this.addFlashTypes("child_only");
      }
    }

    expect(Child.flashTypes).toContain("child_only");
    expect(Controller.flashTypes).not.toContain("child_only");
  });

  it("does not add the same type twice", () => {
    class Twice extends Controller {
      static {
        this.addFlashTypes("warning");
        this.addFlashTypes("warning");
      }
    }

    expect(Twice.flashTypes.filter((type) => type === "warning")).toHaveLength(1);
  });
});

/**
 * A flash set by a redirect that was then refused would appear on whatever
 * page renders instead — a message about something that did not happen.
 */
describe("a redirect that is refused", () => {
  it("raises, as it did before flash options existed", async () => {
    await expect(run("offsite")).rejects.toBeInstanceOf(UnsafeRedirect);
  });

  it("leaves no message behind", async () => {
    const controller = new Posts({ request: requestFor(), secrets });

    await controller.processAction("offsite" as never).catch(() => undefined);

    // Nothing was queued for the next request either — the flash writes only
    // once the redirect is certain.
    expect(controller.flash.pending()).toEqual({});
  });
});
