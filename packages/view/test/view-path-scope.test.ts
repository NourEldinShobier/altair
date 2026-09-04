/**
 * Adding a view path while a block is rendering from its own, ported from
 * `append_view_path` / `prepend_view_path` in
 * `actionview/lib/action_view/view_paths.rb` and the resolver cases in
 * `actionview/test/template/lookup_context_test.rb`.
 *
 * `withViewPaths` opens a scope and the appenders wrote to the process's list
 * regardless, so a plugin adding its templates mid-render did two wrong things
 * at once: the block it was rendering in never saw the path, and every render
 * after the block did, for the life of the process.
 *
 * A store is fixed once its scope opens, which is why the block now holds a
 * box. The box is per-block; the list inside it is the block's, and appending
 * reaches it.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  appendViewPaths,
  prependViewPaths,
  setViewPaths,
  TemplateResolver,
  viewPaths,
  withViewPaths,
} from "../src/lookup-context.js";

const app = new TemplateResolver("app");
const plugin = new TemplateResolver("plugin");
const extra = new TemplateResolver("extra");
const override = new TemplateResolver("override");

const names = (): string[] => viewPaths().map((each) => each.name);
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

afterEach(() => {
  setViewPaths([]);
});

describe("outside any block", () => {
  it("appends after what is there", () => {
    setViewPaths([app]);
    appendViewPaths(extra);

    expect(names()).toEqual(["app", "extra"]);
  });

  /** Lookup takes the first match, so in front is how an override wins. */
  it("prepends in front of it", () => {
    setViewPaths([app]);
    prependViewPaths(override);

    expect(names()).toEqual(["override", "app"]);
  });

  it("takes several at once, in order", () => {
    setViewPaths([app]);
    appendViewPaths(extra, override);

    expect(names()).toEqual(["app", "extra", "override"]);
  });

  it("prepends several as a group, keeping their order", () => {
    setViewPaths([app]);
    prependViewPaths(override, extra);

    expect(names()).toEqual(["override", "extra", "app"]);
  });
});

describe("inside a block", () => {
  /** The regression: this used to append to the process's list instead. */
  it("appends to what the block is rendering from", async () => {
    setViewPaths([app]);

    await withViewPaths([plugin], async () => {
      appendViewPaths(extra);
      await tick();

      expect(names()).toEqual(["plugin", "extra"]);
    });
  });

  /** And this is the other half: it used to leak out and stay there. */
  it("leaves the process's paths as they were", async () => {
    setViewPaths([app]);

    await withViewPaths([plugin], async () => {
      appendViewPaths(extra);
    });

    expect(names()).toEqual(["app"]);
  });

  it("prepends inside the block too", async () => {
    setViewPaths([app]);

    await withViewPaths([plugin], async () => {
      prependViewPaths(override);

      expect(names()).toEqual(["override", "plugin"]);
    });

    expect(names()).toEqual(["app"]);
  });

  it("does not reach a block running beside it", async () => {
    setViewPaths([app]);

    let seen: string[] | undefined;

    await Promise.all([
      withViewPaths([plugin], async () => {
        appendViewPaths(extra);
        await tick();
        await tick();
      }),
      withViewPaths([override], async () => {
        await tick();
        seen = names();
      }),
    ]);

    expect(seen).toEqual(["override"]);
  });

  /** A block's list is a copy, so appending cannot reach the caller's array. */
  it("does not write into the array it was given", async () => {
    const given = [plugin];

    await withViewPaths(given, async () => {
      appendViewPaths(extra);
    });

    expect(given).toEqual([plugin]);
  });

  it("nests, and an inner block starts from what it was given", async () => {
    setViewPaths([app]);

    await withViewPaths([plugin], async () => {
      appendViewPaths(extra);

      await withViewPaths([override], async () => {
        expect(names()).toEqual(["override"]);
      });

      expect(names()).toEqual(["plugin", "extra"]);
    });
  });
});

describe("setting them", () => {
  it("replaces the block's when one is open", async () => {
    setViewPaths([app]);

    await withViewPaths([plugin], async () => {
      setViewPaths([override]);

      expect(names()).toEqual(["override"]);
    });

    expect(names()).toEqual(["app"]);
  });
});
