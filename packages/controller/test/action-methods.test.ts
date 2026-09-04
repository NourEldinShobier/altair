/**
 * Action introspection, ported from
 * `actionpack/test/abstract/abstract_controller_test.rb`.
 */

import { describe, expect, it } from "bun:test";
import {
  UnknownAction,
  actionMethods,
  availableActions,
  isActionMethod,
  methodForAction,
  sendAction,
} from "../src/action-methods.js";

/** Stands in for the framework's base controller. */
class Base {
  redirectTo(): string {
    return "framework";
  }

  get session(): string {
    throw new Error("a getter must never be called to dispatch");
  }
}

class PostsController extends Base {
  index(): string {
    return "index";
  }

  show(): string {
    return "show";
  }

  #secret(): string {
    return "private";
  }

  get currentUser(): string {
    throw new Error("a getter must never be called to dispatch");
  }

  callsPrivate(): string {
    return this.#secret();
  }
}

class AdminBase extends Base {
  dashboard(): string {
    return "dashboard";
  }
}

class AdminPostsController extends AdminBase {
  index(): string {
    return "admin index";
  }
}

describe("actionMethods", () => {
  it("lists what the controller defined", () => {
    expect(actionMethods(PostsController, Base)).toEqual(["callsPrivate", "index", "show"]);
  });

  /** Otherwise a request could ask for redirectTo. */
  it("leaves out what the framework defined", () => {
    expect(actionMethods(PostsController, Base)).not.toContain("redirectTo");
  });

  /**
   * Calling a getter to dispatch runs it for its side effects, and
   * `get session()` is exactly the kind that builds something for a request
   * that never asked.
   */
  it("leaves out getters", () => {
    expect(actionMethods(PostsController, Base)).not.toContain("currentUser");
  });

  it("leaves out the constructor", () => {
    expect(actionMethods(PostsController, Base)).not.toContain("constructor");
  });

  /** A private method is not on the prototype under that name at all. */
  it("leaves out a private method", () => {
    expect(actionMethods(PostsController, Base).join(",")).not.toContain("secret");
  });

  /** A shared action on an application base has to stay reachable. */
  it("includes what an intermediate base defined", () => {
    const actions = actionMethods(AdminPostsController, Base);

    expect(actions).toContain("index");
    expect(actions).toContain("dashboard");
  });

  it("gives nothing for a controller that defined nothing", () => {
    class Empty extends Base {}

    expect(actionMethods(Empty, Base)).toEqual([]);
  });

  it("answers the same set", () => {
    expect([...availableActions(PostsController, Base)].sort()).toEqual(
      actionMethods(PostsController, Base),
    );
  });
});

describe("isActionMethod", () => {
  it("says yes for an action", () => {
    expect(isActionMethod(PostsController, Base, "index")).toBe(true);
  });

  it("says no for a framework method", () => {
    expect(isActionMethod(PostsController, Base, "redirectTo")).toBe(false);
  });

  /** The reason checking "does the method exist" is not enough. */
  it("says no for something inherited from Object", () => {
    expect(isActionMethod(PostsController, Base, "toString")).toBe(false);
    expect(isActionMethod(PostsController, Base, "constructor")).toBe(false);
  });

  it("says no for a name nobody defined", () => {
    expect(isActionMethod(PostsController, Base, "nonexistent")).toBe(false);
  });
});

describe("methodForAction", () => {
  it("resolves an action", () => {
    expect(methodForAction(PostsController, Base, "index")).toBeDefined();
  });

  /** A 404 is the caller's to decide, and it may want to fall through. */
  it("gives undefined rather than throwing", () => {
    expect(methodForAction(PostsController, Base, "redirectTo")).toBeUndefined();
    expect(methodForAction(PostsController, Base, "nonexistent")).toBeUndefined();
  });
});

describe("sendAction", () => {
  it("calls the action", async () => {
    expect(await sendAction(new PostsController(), Base, "index")).toBe("index");
  });

  it("calls it on the instance, so private state works", async () => {
    expect(await sendAction(new PostsController(), Base, "callsPrivate")).toBe("private");
  });

  /** The check lives here rather than in a comment asking people to remember. */
  it("refuses a framework method", async () => {
    await expect(sendAction(new PostsController(), Base, "redirectTo")).rejects.toThrow(
      UnknownAction,
    );
  });

  it("refuses a name nobody defined", async () => {
    await expect(sendAction(new PostsController(), Base, "nonexistent")).rejects.toThrow(
      UnknownAction,
    );
  });

  it("names the controller and what it does expose", async () => {
    await expect(sendAction(new PostsController(), Base, "nope")).rejects.toThrow(
      /PostsController.*index/s,
    );
  });

  it("carries the controller and action on the error", async () => {
    try {
      await sendAction(new PostsController(), Base, "nope");
      expect.unreachable();
    } catch (error) {
      expect((error as UnknownAction).controller).toBe("PostsController");
      expect((error as UnknownAction).action).toBe("nope");
    }
  });

  it("reaches an action from an intermediate base", async () => {
    expect(await sendAction(new AdminPostsController(), Base, "dashboard")).toBe("dashboard");
  });
});
