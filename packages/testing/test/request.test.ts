/**
 * Driving a real application from a test.
 *
 * Mirrors actionpack/test/dispatch/request/session_test.rb and
 * integration_test.rb. Booted against a real application rather than a stub
 * handler: the whole point of the session is that it carries what an
 * application actually sets, and a stub would only carry what I assumed.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Controller, type Parameters } from "@altair/controller";
import { createApplication, type Application } from "@altair/core";
import { testSession, TestSession } from "../src/request.js";

class SessionsController extends Controller {
  async create() {
    this.session.set("user", String(this.params.get("email") ?? "nobody"));
    return this.redirectTo("/account");
  }

  async destroy() {
    this.session.reset();
    return this.redirectTo("/account");
  }
}

class AccountController extends Controller {
  async show() {
    const user = this.session.get("user");

    return this.render.text(user ? `Signed in as ${user}` : "Signed out");
  }
}

/** The standard Rails idiom, against a real form post. */
class PostsController extends Controller {
  async create() {
    const post = (this.params.require("post") as Parameters).permit("title", "tags");

    return this.render.json(post.toObject());
  }
}

/** Echoes back what arrived, so the encoding can be asserted on. */
class EchoController extends Controller {
  #echo() {
    return this.render.json({
      // Permitted rather than raw: `toObject` refuses anything unpermitted,
      // which is strong parameters working, not the test being awkward.
      params: this.params.permit("q", "page", { post: ["title", "tags"] }).toObject(),
      contentType: this.request.headers.get("content-type"),
      accept: this.request.headers.get("accept"),
    });
  }

  async create() {
    return this.#echo();
  }

  async index() {
    return this.#echo();
  }
}

let app: Application;
let session: TestSession;

beforeAll(async () => {
  app = createApplication({
    env: "test",
    secretKeyBase: "y".repeat(64),
    database: { url: "sqlite://:memory:" },
    log: { level: "fatal", format: "json", queries: false },
    routes: (r) => {
      r.post("/session", { to: "sessions#create" });
      r.delete("/session", { to: "sessions#destroy" });
      r.get("/account", { to: "account#show" });
      r.post("/echo", { to: "echo#create" });
      r.get("/echo", { to: "echo#index" });
      r.post("/posts", { to: "posts#create" });
    },
    controllers: {
      sessions: SessionsController,
      account: AccountController,
      echo: EchoController,
      posts: PostsController,
    },
  });

  await app.boot();
});

afterAll(async () => {
  await app.stop();
});

beforeEach(() => {
  session = testSession(app);
});

describe("a request", () => {
  it("comes back with a status and a body already read", async () => {
    const response = await session.get("/account");

    expect(response.status).toBe(200);
    expect(response.body).toBe("Signed out");
    expect(response.successful).toBe(true);
  });

  it("puts params on the query string for a GET", async () => {
    const response = await session.get("/echo", { params: { q: "ruby", page: 2 } });

    expect(response.json<{ params: Record<string, string> }>().params).toMatchObject({
      q: "ruby",
      page: "2",
    });
  });

  // The shape a browser posts, and the shape the parameter parser reads back.
  it("posts nested params as a form does", async () => {
    const response = await session.post("/echo", {
      params: { post: { title: "Hello", tags: ["a", "b"] } },
    });

    const body = response.json<{ params: Record<string, unknown>; contentType: string }>();

    expect(body.contentType).toBe("application/x-www-form-urlencoded");
    expect(body.params).toMatchObject({ post: { title: "Hello", tags: ["a", "b"] } });
  });

  it("posts JSON when asked", async () => {
    const response = await session.post("/echo", {
      params: { post: { title: "Hello" } },
      as: "json",
    });

    const body = response.json<{ params: Record<string, unknown>; contentType: string }>();

    expect(body.contentType).toBe("application/json");
    expect(body.params).toMatchObject({ post: { title: "Hello" } });
  });

  /**
   * A GET asking an endpoint for JSON has no body to declare a type on, so the
   * `Accept` header is the whole of what `as: "json"` does here — and the echo
   * hands it back, which is what this asks about.
   *
   * It used to assert that `json()` returned something defined. `json()` parses
   * or throws, so a defined result is the only result it can have; the case
   * passed whatever the header said.
   */
  it("asks for JSON back even with nothing to send", async () => {
    const response = await session.get("/echo", { as: "json" });

    expect(response.json<{ accept: string }>().accept).toContain("application/json");
  });

  it("keeps headers that were given", async () => {
    const response = await session.post("/echo", {
      params: {},
      headers: { accept: "text/plain" },
    });

    expect(response.json<{ accept: string }>().accept).toBe("text/plain");
  });

  it("says what it got when the body is not JSON", async () => {
    const response = await session.get("/account");

    expect(() => response.json()).toThrow(/Signed out/);
  });
});

// The reason this exists. A hand-built request does not carry the session
// cookie, so a test signs in and the next request arrives signed out.
describe("a visit across requests", () => {
  it("carries the session from one request to the next", async () => {
    await session.post("/session", { params: { email: "ada@example.com" } });

    const response = await session.get("/account");

    expect(response.body).toBe("Signed in as ada@example.com");
  });

  it("holds the cookie the application set", async () => {
    await session.post("/session", { params: { email: "ada@example.com" } });

    expect(session.cookies.size).toBeGreaterThan(0);
  });

  it("does not carry it into a second visitor", async () => {
    await session.post("/session", { params: { email: "ada@example.com" } });

    const other = testSession(app);

    expect((await other.get("/account")).body).toBe("Signed out");
  });

  it("forgets when the visit is reset", async () => {
    await session.post("/session", { params: { email: "ada@example.com" } });
    session.reset();

    expect((await session.get("/account")).body).toBe("Signed out");
  });

  // A jar that ignored the deletion would carry a session the app just cleared,
  // which is the difference between testing sign-out and testing nothing.
  it("drops a cookie the application deleted", async () => {
    await session.post("/session", { params: { email: "ada@example.com" } });
    await session.delete("/session");

    expect((await session.get("/account")).body).toBe("Signed out");
  });
});

describe("following a redirect", () => {
  it("goes where the response pointed", async () => {
    const redirect = await session.post("/session", { params: { email: "ada@example.com" } });

    expect(redirect.redirect).toBe(true);
    expect(redirect.location).toBe("/account");

    expect((await session.followRedirect()).body).toBe("Signed in as ada@example.com");
  });

  // Quietly doing nothing would let the test go on asserting against the page
  // before the redirect and pass for the wrong reason.
  it("complains when there was no redirect to follow", async () => {
    await session.get("/account");

    expect(session.followRedirect()).rejects.toThrow(/Expected a redirect/);
  });

  it("complains when nothing has been requested yet", () => {
    expect(testSession(app).followRedirect()).rejects.toThrow(/no response/);
  });
});

// The whole reason nested names are parsed rather than passed through: this
// idiom is in every Rails controller, and it needs `post[title]` to have
// arrived as an object rather than as a key with brackets in its name.
describe("the params a real form posts", () => {
  it("reach require and permit", async () => {
    const response = await session.post("/posts", {
      params: { post: { title: "Hello", tags: ["a", "b"] } },
    });

    expect(response.status).toBe(200);
    expect(response.json<unknown>()).toEqual({ title: "Hello", tags: ["a", "b"] });
  });

  it("arrive the same way over JSON", async () => {
    const response = await session.post("/posts", {
      params: { post: { title: "Hello", tags: ["a", "b"] } },
      as: "json",
    });

    expect(response.json<unknown>()).toEqual({ title: "Hello", tags: ["a", "b"] });
  });
});
