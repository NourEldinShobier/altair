/**
 * `contentFor` and `provide`, ported from
 * `actionview/lib/action_view/helpers/capture_helper.rb` and the
 * `content_for` cases in `actionview/test/template/capture_helper_test.rb`.
 *
 * The two were here under each other's names. Rails' `content_for` appends and
 * Rails' `provide` replaces; this had `provide` appending and `provideOnly`
 * replacing, so a reader who knew Rails got appending from `provide` — the
 * opposite of what that name means there — and had no way to ask for it by its
 * own name at all.
 *
 * `contentFor` also reads with one argument, as Rails does, which is what
 * makes it usable in the middle of a template rather than only at the top.
 */

import { describe, expect, it } from "bun:test";
import { contentFor, provide, withContentStore, yieldContent } from "../src/content-for.js";
import { raw } from "../src/render.js";
import { renderToString } from "../src/render.js";

const text = (node: unknown): string => String(node ?? "");

async function inStore<T>(body: () => Promise<T> | T): Promise<T> {
  return await withContentStore(async () => await body());
}

describe("contentFor", () => {
  it("appends, so a page and its partial share a slot", async () => {
    const rendered = await inStore(async () => {
      contentFor("head", raw("<meta a>"));
      contentFor("head", raw("<meta b>"));

      return await renderToString(yieldContent("head") as never);
    });

    expect(rendered).toContain("<meta a>");
    expect(rendered).toContain("<meta b>");
  });

  it("reads back what was set", async () => {
    await inStore(() => {
      contentFor("title", raw("Posts"));

      expect(text(contentFor("title"))).toContain("Posts");
    });
  });

  it("reads undefined when nothing was set", async () => {
    await inStore(() => {
      expect(contentFor("title")).toBeUndefined();
    });
  });

  it("reads the same thing yieldContent does", async () => {
    await inStore(() => {
      contentFor("head", raw("<meta>"));

      expect(contentFor("head")).toBe(yieldContent("head"));
    });
  });

  /**
   * Silent rather than throwing: a component used in a test without a layout
   * is not a bug, and there is nowhere to put the content.
   */
  it("does nothing outside a render", () => {
    expect(() => {
      contentFor("head", raw("<meta>"));
    }).not.toThrow();
  });
});

describe("provide", () => {
  it("replaces, because two titles are not a longer title", async () => {
    await inStore(() => {
      provide("title", raw("First"));
      provide("title", raw("Second"));

      expect(text(contentFor("title"))).toContain("Second");
      expect(text(contentFor("title"))).not.toContain("First");
    });
  });

  it("replaces what contentFor appended", async () => {
    await inStore(() => {
      contentFor("title", raw("First"));
      contentFor("title", raw("Second"));
      provide("title", raw("Only"));

      expect(text(contentFor("title"))).toContain("Only");
      expect(text(contentFor("title"))).not.toContain("First");
    });
  });

  it("is appended to afterwards, if a caller asks for that", async () => {
    const rendered = await inStore(async () => {
      provide("head", raw("<base>"));
      contentFor("head", raw("<meta>"));

      return await renderToString(yieldContent("head") as never);
    });

    expect(rendered).toContain("<base>");
    expect(rendered).toContain("<meta>");
  });
});
