/**
 * Turning exceptions into responses.
 *
 * Mirrors actionpack/test/controller/rescue_test.rb. The inheritance tests are
 * the ones that matter: `rescue_from` is declared on a base controller once,
 * and the whole value is that no action has to remember it.
 */

import { describe, expect, it } from "bun:test";
import { Controller, beforeAction } from "../src/controller.js";

class NotFound extends Error {
  constructor() {
    super("no such record");
    this.name = "NotFound";
  }
}

class Forbidden extends Error {
  constructor() {
    super("not allowed");
    this.name = "Forbidden";
  }
}

/** More specific than NotFound, to check which handler wins. */
class GoneForever extends NotFound {}

class ApplicationController extends Controller {
  static {
    this.rescueFrom(Error, function () {
      this.render.json({ error: "something went wrong" }, { status: 500 });
    });

    this.rescueFrom(NotFound, function (error) {
      this.render.json({ error: error.message }, { status: 404 });
    });
  }
}

class PostsController extends ApplicationController {
  ok(): void {
    this.render.json({ ok: true });
  }

  missing(): void {
    throw new NotFound();
  }

  gone(): void {
    throw new GoneForever();
  }

  broken(): void {
    throw new TypeError("a genuine mistake");
  }

  refused(): void {
    throw new Forbidden();
  }

  async filtered(): Promise<void> {
    await Promise.resolve();
    this.render.json({ ok: true });
  }
}

class NarrowedController extends ApplicationController {
  static {
    // A subclass narrowing what its parent already handles.
    this.rescueFrom(NotFound, function () {
      this.head(410);
    });
  }

  missing(): void {
    throw new NotFound();
  }
}

class UnhandledController extends Controller {
  boom(): void {
    throw new Forbidden();
  }
}

const run = async <C extends Controller>(
  Klass: new (context: { request: Request; session: Record<string, unknown> }) => C,
  action: string,
) =>
  await (
    new Klass({ request: new Request("http://test.host/"), session: {} }) as Controller
  ).processAction(action as never);

describe("handling an exception", () => {
  it("leaves a working action alone", async () => {
    const response = await run(PostsController, "ok");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("turns the exception into the response the handler rendered", async () => {
    const response = await run(PostsController, "missing");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "no such record" });
  });

  it("hands the error to the handler", async () => {
    const response = await run(PostsController, "missing");

    expect(((await response.json()) as { error: string }).error).toBe("no such record");
  });

  // The reason it is declared on a base controller: no action has to remember.
  it("is inherited by a subclass", async () => {
    expect((await run(PostsController, "missing")).status).toBe(404);
  });

  it("matches a subclass of the exception it was registered for", async () => {
    expect((await run(PostsController, "gone")).status).toBe(404);
  });

  // Registered for Error, so anything unclaimed lands there.
  it("falls back to a broader handler", async () => {
    const response = await run(PostsController, "broken");

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "something went wrong" });
  });

  it("uses the broad handler for an exception with no specific one", async () => {
    expect((await run(PostsController, "refused")).status).toBe(500);
  });
});

// Rails searches in reverse order of declaration, which is what lets a
// subclass narrow what its parent already handles.
describe("which handler wins", () => {
  it("takes the most recently declared", async () => {
    expect((await run(NarrowedController, "missing")).status).toBe(410);
  });

  it("leaves the parent's own handling alone", async () => {
    expect((await run(PostsController, "missing")).status).toBe(404);
  });
});

describe("an exception nobody handles", () => {
  // Swallowing it would turn a bug into a silent 204, which is worse than the
  // stack trace it replaced.
  it("goes on up", async () => {
    await expect(run(UnhandledController, "boom")).rejects.toThrow(Forbidden);
  });
});

describe("a filter that raises", () => {
  class GuardedController extends ApplicationController {
    @beforeAction
    authorize(): void {
      throw new NotFound();
    }

    index(): void {
      this.render.json({ reached: true });
    }
  }

  // An authorisation filter that raises is exactly the thing a handler is for,
  // so the try has to cover the filters and not only the action.
  it("is handled too", async () => {
    const response = await run(GuardedController, "index");

    expect(response.status).toBe(404);
  });

  it("does not run the action", async () => {
    const response = await run(GuardedController, "index");

    expect(await response.text()).not.toContain("reached");
  });
});
