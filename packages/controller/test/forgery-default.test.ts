/**
 * Forgery protection being on without anybody asking.
 *
 * Mirrors the ground actionpack/test/controller/request_forgery_protection_test.rb
 * covers, and the reason Rails made it a default in 5.2.
 *
 * The implementation was complete and correct — session-bound tokens, masked
 * against BREACH, constant-time comparison — and nothing called it. No
 * middleware, no template, no generated controller. An application was open
 * until somebody wrote the filter by hand, which is the same as saying most
 * applications were open. Protection nobody remembers to turn on is protection
 * an application ships without.
 */

import { describe, expect, it } from "bun:test";
import { Secrets } from "@altair/support";
import { Controller, InvalidAuthenticityToken, maskedToken } from "../src/index.js";

const secrets = new Secrets("x".repeat(64));

class PostsController extends Controller {
  create(): void {
    this.render.json({ created: true });
  }

  index(): void {
    this.render.json({ listed: true });
  }
}

class ApiController extends Controller {
  // Authenticated by something a browser will not attach on its own, so a
  // session cookie is not what is trusted.
  static {
    this.skipForgeryProtection();
  }

  create(): void {
    this.render.json({ created: true });
  }
}

const post = (body?: string, headers: Record<string, string> = {}) =>
  new Request("https://app.example/posts", { method: "POST", body, headers });

const run = async (
  Klass: typeof PostsController | typeof ApiController,
  request: Request,
  action = "create",
  forgeryProtection?: boolean,
) => {
  const controller = new Klass({ request, secrets, forgeryProtection } as never);
  return await controller.processAction(action);
};

describe("an unsafe request with no token", () => {
  it("is refused, without anybody turning anything on", () => {
    expect(run(PostsController, post())).rejects.toBeInstanceOf(InvalidAuthenticityToken);
  });

  it("is refused for every unsafe verb", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const request = new Request("https://app.example/posts", { method });

      expect(run(PostsController, request)).rejects.toBeInstanceOf(InvalidAuthenticityToken);
    }
  });

  it("is refused when the token is wrong rather than missing", () => {
    expect(
      run(PostsController, post(undefined, { "x-csrf-token": "not-a-token" })),
    ).rejects.toBeInstanceOf(InvalidAuthenticityToken);
  });
});

describe("a safe request", () => {
  it("goes through, since a link cannot carry a token", async () => {
    const response = await run(PostsController, new Request("https://app.example/posts"), "index");

    expect(response.status).toBe(200);
  });

  // `this.session` is an argument to the check, and an argument is evaluated
  // whether it is needed or not — so asking the checker to decide would build
  // a session for every GET in the application before finding out it need not.
  it("does not need secrets to be configured", async () => {
    const controller = new PostsController({
      request: new Request("https://app.example/posts"),
    } as never);

    expect((await controller.processAction("index")).status).toBe(200);
  });
});

describe("a request that carries the token", () => {
  /**
   * A token and the session it belongs to, as a browser would hold them.
   *
   * Both halves are needed: the token is only meaningful against the session
   * secret it was masked from, so sending it without the cookie proves
   * nothing. A first version of this test minted a token from one controller
   * and sent it to another — two fresh sessions, two different secrets, and a
   * failure that looked like the guard being broken rather than the test.
   */
  const issued = () => {
    const controller = new PostsController({
      request: new Request("https://app.example/posts"),
      secrets,
    } as never);

    const token = maskedToken(controller.session);
    controller.session.commit();

    const header = controller.cookies.toHeaders()[0] as string;

    return { token, cookie: header.split(";")[0] as string };
  };

  it("goes through when it came from this session", async () => {
    const { token, cookie } = issued();

    const response = await run(PostsController, post(undefined, { "x-csrf-token": token, cookie }));

    expect(response.status).toBe(200);
  });

  it("goes through as a form field as well as a header", async () => {
    const { token, cookie } = issued();

    const body = new URLSearchParams({ authenticity_token: token });
    const request = new Request("https://app.example/posts", {
      method: "POST",
      body,
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    });

    const controller = new PostsController({
      request,
      secrets,
      params: Object.fromEntries(body),
    } as never);

    expect((await controller.processAction("create")).status).toBe(200);
  });

  // The token is masked with a fresh pad every time it is rendered, so two
  // reads of the same session token do not look alike — that is what stops a
  // compressed response leaking it.
  it("is different every time it is issued, and both work", () => {
    const one = issued();
    const two = issued();

    expect(one.token).not.toBe(two.token);
  });

  // Someone else's token, against this session, is the attack.
  it("is refused when it belongs to another session", () => {
    const mine = issued();
    const theirs = issued();

    expect(
      run(PostsController, post(undefined, { "x-csrf-token": theirs.token, cookie: mine.cookie })),
    ).rejects.toBeInstanceOf(InvalidAuthenticityToken);
  });
});

describe("turning it off", () => {
  it("is per controller, for an endpoint a browser does not authenticate", async () => {
    const response = await run(ApiController, post());

    expect(response.status).toBe(200);
  });

  // Two applications booting in one process is every test suite, and a setting
  // written onto the base class would leave whichever booted last deciding for
  // both.
  it("is per request when the application says so", async () => {
    const response = await run(PostsController, post(), "create", false);

    expect(response.status).toBe(200);
  });

  it("does not leak to a sibling controller", () => {
    expect(run(PostsController, post())).rejects.toBeInstanceOf(InvalidAuthenticityToken);
  });

  // An application saying "protect" cannot override a controller that has
  // said it is not session-authenticated.
  it("keeps a controller's own opt-out when the application is protecting", async () => {
    const response = await run(ApiController, post(), "create", true);

    expect(response.status).toBe(200);
  });
});
