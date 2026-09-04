/**
 * View paths keyed by class, ported from
 * `actionview/lib/action_view/path_registry.rb` — `get_view_paths` walks up
 * the superclass chain — and the inheritance cases in
 * `actionview/test/template/view_paths_test.rb`.
 *
 * A hierarchy is the natural unit for this. An `AdminController` that prepends
 * `app/views/admin` means every controller under it, and saying so once is the
 * whole point; a process-wide list can only say it for everything or for
 * nothing.
 *
 * The registry falls through to the process's paths when no class in the chain
 * has its own, which is every application that never needed the feature.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  appendViewPath,
  getViewPaths,
  prependViewPath,
  resetViewPaths,
  setViewPaths,
  TemplateResolver,
  viewPaths,
  withViewPaths,
} from "../src/lookup-context.js";

const app = new TemplateResolver("app");
const admin = new TemplateResolver("admin");
const reports = new TemplateResolver("reports");

class Base {}
class AdminBase extends Base {}
class Users extends AdminBase {}
class Reports extends AdminBase {}

const names = (klass: object): string[] => getViewPaths(klass).map((each) => each.name);

afterEach(() => {
  for (const klass of [Base, AdminBase, Users, Reports]) resetViewPaths(klass);
  setViewPaths([]);
});

describe("a class with its own", () => {
  it("searches them", () => {
    setViewPaths(AdminBase, [admin]);

    expect(names(AdminBase)).toEqual(["admin"]);
  });

  it("does not give them to a sibling", () => {
    setViewPaths(AdminBase, [admin]);

    expect(names(Base)).toEqual([]);
  });
});

describe("a subclass", () => {
  /** The point of the feature: say it once on the base and it holds below. */
  it("searches its parent's", () => {
    setViewPaths(AdminBase, [admin]);

    expect(names(Users)).toEqual(["admin"]);
    expect(names(Reports)).toEqual(["admin"]);
  });

  it("walks past a class that has none of its own", () => {
    setViewPaths(Base, [app]);

    expect(names(Users)).toEqual(["app"]);
  });

  it("takes the nearest ancestor that has any", () => {
    setViewPaths(Base, [app]);
    setViewPaths(AdminBase, [admin]);

    expect(names(Users)).toEqual(["admin"]);
    expect(names(Base)).toEqual(["app"]);
  });

  it("keeps its own when it has them", () => {
    setViewPaths(AdminBase, [admin]);
    setViewPaths(Reports, [reports]);

    expect(names(Reports)).toEqual(["reports"]);
    expect(names(Users)).toEqual(["admin"]);
  });
});

describe("a class with nothing above it either", () => {
  it("falls through to the process's paths", () => {
    setViewPaths([app]);

    expect(names(Users)).toEqual(["app"]);
  });

  /**
   * Which is what a block is rendering from, so a controller with no paths of
   * its own follows the block it is inside rather than the process's list.
   */
  it("follows a block that is open", async () => {
    setViewPaths([app]);

    await withViewPaths([admin], async () => {
      expect(names(Users)).toEqual(["admin"]);
    });

    expect(names(Users)).toEqual(["app"]);
  });

  it("does not follow one when it has its own", async () => {
    setViewPaths(Users, [reports]);

    await withViewPaths([admin], async () => {
      expect(names(Users)).toEqual(["reports"]);
    });
  });
});

describe("adding to a class's own", () => {
  /**
   * Starting from what it inherits, which is the difference between this and
   * `setViewPaths(klass, …)`. Building the list by hand is three chances to
   * drop what the parent gave.
   */
  it("appends after what it inherits", () => {
    setViewPaths(AdminBase, [admin]);
    appendViewPath(Users, reports);

    expect(names(Users)).toEqual(["admin", "reports"]);
    expect(names(AdminBase)).toEqual(["admin"]);
  });

  /** In front, which is how a controller overrides a template it inherits. */
  it("prepends before what it inherits", () => {
    setViewPaths(AdminBase, [admin]);
    prependViewPath(Users, reports);

    expect(names(Users)).toEqual(["reports", "admin"]);
  });

  it("takes several at once, in order", () => {
    setViewPaths(AdminBase, [admin]);
    appendViewPath(Users, reports, app);

    expect(names(Users)).toEqual(["admin", "reports", "app"]);
  });

  it("starts from the process's paths when it inherits none", () => {
    setViewPaths([app]);
    appendViewPath(Users, reports);

    expect(names(Users)).toEqual(["app", "reports"]);
  });

  it("adds to what it already had of its own", () => {
    setViewPaths(Users, [reports]);
    appendViewPath(Users, admin);

    expect(names(Users)).toEqual(["reports", "admin"]);
  });

  it("does not reach a sibling", () => {
    setViewPaths(AdminBase, [admin]);
    appendViewPath(Users, reports);

    expect(names(Reports)).toEqual(["admin"]);
  });
});

describe("forgetting them", () => {
  it("makes a class inherit again", () => {
    setViewPaths(AdminBase, [admin]);
    setViewPaths(Users, [reports]);

    resetViewPaths(Users);

    expect(names(Users)).toEqual(["admin"]);
  });
});

describe("the process-wide form", () => {
  it("still sets what a lookup searches", () => {
    setViewPaths([app]);

    expect(viewPaths().map((each) => each.name)).toEqual(["app"]);
  });

  /** A copy, so a caller's array is not the registry's. */
  it("does not keep the array it was given", () => {
    const given = [app];

    setViewPaths(AdminBase, given);
    given.push(admin);

    expect(names(AdminBase)).toEqual(["app"]);
  });
});
