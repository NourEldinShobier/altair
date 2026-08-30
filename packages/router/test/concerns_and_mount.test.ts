/**
 * Routing concerns and mounted applications, ported from
 * `actionpack/test/dispatch/routing/concerns_test.rb` and the mount cases in
 * `actionpack/test/dispatch/mount_test.rb`.
 */

import { describe, expect, it } from "bun:test";
import { Router } from "../src/router.js";

function draw(body: Parameters<Router["draw"]>[0]): Router {
  const router = new Router();
  router.draw(body);
  return router;
}

describe("concerns", () => {
  it("draws a named block where it is used", () => {
    const router = draw((r) => {
      r.concern("commentable", (c) => {
        c.resources("comments");
      });
      r.resources("posts", (p) => {
        p.concerns("commentable");
      });
    });

    expect(router.routeNamed("post_comments")).toBeDefined();
  });

  /** The reason to name it: the same block in two places, declared once. */
  it("draws it in several places", () => {
    const router = draw((r) => {
      r.concern("commentable", (c) => {
        c.resources("comments");
      });
      r.resources("posts", (p) => {
        p.concerns("commentable");
      });
      r.resources("photos", (p) => {
        p.concerns("commentable");
      });
    });

    expect(router.routeNamed("post_comments")).toBeDefined();
    expect(router.routeNamed("photo_comments")).toBeDefined();
  });

  it("draws several concerns at once", () => {
    const router = draw((r) => {
      r.concern("commentable", (c) => {
        c.resources("comments");
      });
      r.concern("taggable", (c) => {
        c.resources("tags");
      });
      r.resources("posts", (p) => {
        p.concerns("commentable", "taggable");
      });
    });

    expect(router.routeNamed("post_comments")).toBeDefined();
    expect(router.routeNamed("post_tags")).toBeDefined();
  });

  it("draws one at the top level too", () => {
    const router = draw((r) => {
      r.concern("healthcheck", (c) => {
        c.get("/up", { to: "health#show", as: "up" });
      });
      r.concerns("healthcheck");
    });

    expect(router.routeNamed("up")).toBeDefined();
  });

  /**
   * A silently skipped concern is a set of routes that simply are not there,
   * and the symptom is a 404 a long way from the typo.
   */
  it("throws on a name nobody declared", () => {
    expect(() =>
      draw((r) => {
        r.concerns("nonexistent");
      }),
    ).toThrow(/No routing concern named "nonexistent"/);
  });

  it("names the ones that were declared", () => {
    expect(() =>
      draw((r) => {
        r.concern("commentable", () => {});
        r.concerns("typo");
      }),
    ).toThrow(/commentable/);
  });

  it("says none when nothing was declared", () => {
    expect(() =>
      draw((r) => {
        r.concerns("anything");
      }),
    ).toThrow(/none/);
  });
});

describe("mount", () => {
  const app = () => new Response("mounted");

  it("records what was mounted and where", () => {
    const router = draw((r) => {
      r.mount(app, { at: "/admin" });
    });

    expect(router.mountedApps).toHaveLength(1);
    expect(router.mountedApps[0]?.at).toBe("/admin");
  });

  it("normalises the path", () => {
    const router = draw((r) => {
      r.mount(app, { at: "admin/" });
    });

    expect(router.mountedApps[0]?.at).toBe("/admin");
  });

  it("keeps the name", () => {
    const router = draw((r) => {
      r.mount(app, { at: "/admin", as: "admin_engine" });
    });

    expect(router.mountedApps[0]?.name).toBe("admin_engine");
  });

  it("finds the app for a path under it", () => {
    const router = draw((r) => {
      r.mount(app, { at: "/admin" });
    });

    expect(router.mountedFor("/admin")).toBeDefined();
    expect(router.mountedFor("/admin/users")).toBeDefined();
  });

  it("finds nothing for a path outside it", () => {
    const router = draw((r) => {
      r.mount(app, { at: "/admin" });
    });

    expect(router.mountedFor("/posts")).toBeUndefined();
  });

  /** A prefix match on the string alone would claim /administrators. */
  it("does not match a path that merely starts with the same letters", () => {
    const router = draw((r) => {
      r.mount(app, { at: "/admin" });
    });

    expect(router.mountedFor("/administrators")).toBeUndefined();
  });

  /**
   * Longest prefix wins regardless of declaration order, or mounting /api
   * first would swallow every /api/v2 request.
   */
  it("prefers the more specific mount", () => {
    const general = () => new Response("general");
    const specific = () => new Response("specific");

    const router = draw((r) => {
      r.mount(general, { at: "/api" });
      r.mount(specific, { at: "/api/v2" });
    });

    expect(router.mountedFor("/api/v2/posts")?.handler).toBe(specific);
    expect(router.mountedFor("/api/posts")?.handler).toBe(general);
  });

  it("prefers it even when declared the other way round", () => {
    const general = () => new Response("general");
    const specific = () => new Response("specific");

    const router = draw((r) => {
      r.mount(specific, { at: "/api/v2" });
      r.mount(general, { at: "/api" });
    });

    expect(router.mountedFor("/api/v2/posts")?.handler).toBe(specific);
  });

  it("keeps them in declaration order", () => {
    const one = () => new Response("one");
    const two = () => new Response("two");

    const router = draw((r) => {
      r.mount(one, { at: "/a" });
      r.mount(two, { at: "/b" });
    });

    expect(router.mountedApps.map((m) => m.at)).toEqual(["/a", "/b"]);
  });
});
