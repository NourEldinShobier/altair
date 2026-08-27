/**
 * Reading, writing and expiring a fragment by hand, ported from
 * `actionview/test/template/fragment_caching_test.rb`.
 *
 * `Cached` covers the normal case. These are for the fragments whose key does
 * not move on its own: a sidebar keyed on nothing in particular, a footer with
 * a count in it.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { Cache, i18n } from "@altair/support";
import {
  Cached,
  configureFragmentCache,
  existFragment,
  expireFragment,
  fragmentCacheKey,
  readFragment,
  renderToString,
  writeFragment,
} from "../src/index.js";

afterEach(() => {
  configureFragmentCache(undefined);
  i18n.locale = "en";
});

describe("a fragment by hand", () => {
  it("comes back as it was written", async () => {
    await writeFragment("sidebar", "<b>hi</b>");

    expect(await readFragment("sidebar")).toBe("<b>hi</b>");
    expect(await existFragment("sidebar")).toBe(true);
  });

  it("is missing before it is written", async () => {
    expect(await readFragment("sidebar")).toBeNull();
    expect(await existFragment("sidebar")).toBe(false);
  });

  it("goes away when expired", async () => {
    await writeFragment("sidebar", "<b>hi</b>");
    await expireFragment("sidebar");

    expect(await existFragment("sidebar")).toBe(false);
  });

  it("sweeps several by pattern", async () => {
    await writeFragment(["posts", 1], "one");
    await writeFragment(["posts", 2], "two");
    await writeFragment(["users", 1], "user");

    expect(await expireFragment(/posts/)).toBe(2);
    expect(await existFragment(["posts", 1])).toBe(false);
    expect(await existFragment(["users", 1])).toBe(true);
  });
});

/**
 * The bug this guards against: a helper that builds the key a different way
 * from `Cached` deletes nothing and reports success. It looks like it worked.
 */
describe("the key these share with Cached", () => {
  it("is the one Cached actually stored under", async () => {
    await renderToString(await Cached({ on: "sidebar", children: "rendered" }));

    expect(await readFragment("sidebar")).toBe("rendered");
  });

  it("lets expireFragment reach what Cached wrote", async () => {
    let renders = 0;
    const render = async () =>
      await renderToString(
        await Cached({
          on: "sidebar",
          children: `render ${(renders += 1)}`,
        }),
      );

    expect(await render()).toBe("render 1");
    expect(await render()).toBe("render 1");

    await expireFragment("sidebar");

    expect(await render()).toBe("render 3");
  });

  it("keeps the locale in it, so one language is not served to another", async () => {
    i18n.locale = "en";
    await writeFragment("greeting", "Hello");

    i18n.locale = "fr";

    expect(await readFragment("greeting")).toBeNull();
    expect(fragmentCacheKey("greeting")).toEqual(["views", "fr", "greeting"]);
  });
});

describe("sweeping a store that cannot list its keys", () => {
  it("says so rather than deleting nothing quietly", async () => {
    configureFragmentCache(
      new Cache({
        read: async () => null,
        write: async () => undefined,
        delete: async () => false,
        exists: async () => false,
        clear: async () => undefined,
        increment: async () => 0,
        decrement: async () => 0,
      }),
    );

    await expect(expireFragment(/posts/)).rejects.toThrow(/cannot list its keys/);
  });
});
