/**
 * What a controller publishes into the request scope.
 *
 * A CSRF token would otherwise have to be threaded through every layout and
 * partial between the page and the form that needs it. Publishing it into the
 * scope is what lets a view reach it, and doing that lazily is what keeps an
 * application that never renders a form from paying for one.
 */

import { describe, expect, it } from "bun:test";
import { Current, Secrets } from "@altair/support";
import { Controller } from "../src/controller.js";

const secrets = new Secrets("a".repeat(64));

class PostsController extends Controller {
  create(): void {
    this.flash.now("notice", "Saved");
    this.render.json({ ok: true });
  }

  show(): void {
    this.render.json({ ok: true });
  }
}

function controllerFor(overrides: Record<string, unknown> = {}): PostsController {
  return new PostsController({
    request: new Request("http://test.host/posts", { method: "POST" }),
    secrets,
    ...overrides,
  } as never);
}

describe("publishing to the request scope", () => {
  it("makes the CSRF token readable from a view", async () => {
    await Current.run({}, async () => {
      await controllerFor().processAction("create" as never);
      expect(typeof Current.csrfToken).toBe("string");
      expect((Current.csrfToken ?? "").length).toBeGreaterThan(0);
    });
  });

  it("makes the flash readable from a view", async () => {
    await Current.run({}, async () => {
      await controllerFor().processAction("create" as never);
      expect(Current.flash).toEqual({ notice: "Saved" });
    });
  });

  // Producing a token builds the session, which needs secrets an API-only
  // application has no reason to configure. Doing it eagerly on every action
  // turned that from an unused feature into a crash.
  it("does not build a session for an action that never asks", async () => {
    await Current.run({}, async () => {
      const response = await controllerFor({ secrets: undefined }).processAction("show" as never);
      expect(response.status).toBe(200);
    });
  });

  it("renders without a token rather than failing when it cannot make one", async () => {
    await Current.run({}, async () => {
      await controllerFor({ secrets: undefined }).processAction("show" as never);
      expect(Current.csrfToken).toBeUndefined();
    });
  });

  it("does nothing outside a request scope", async () => {
    const response = await controllerFor().processAction("show" as never);
    expect(response.status).toBe(200);
  });
});
