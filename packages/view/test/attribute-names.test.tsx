/**
 * Escaping the name of an attribute or a tag, ported from
 * `ERB::Util.xml_name_escape` in
 * `activesupport/lib/active_support/core_ext/erb/util.rb` and the
 * `tag_option` path in `actionview/lib/action_view/helpers/tag_helper.rb`,
 * which calls it on every key.
 *
 * A value is written inside quotes and escaping it keeps it there. A name is
 * written outside them, so escaping the value alone is only half the job:
 *
 *     tagOptions({ 'x><script>alert(1)</script': "1" })
 *     //  x><script>alert(1)</script="1"
 *
 * The tag closes at the `>` and everything after it is markup the browser
 * runs. `render.ts` refuses such a name outright, because in JSX it can only
 * be a literal and so can only be a mistake; these helpers take an object at
 * run time, where it can be data, and Rails' answer there is to replace what
 * is not part of a name with `_`.
 */

import { describe, expect, it } from "bun:test";
import { contentTag, contentTagString, selfClosingTag, tagOptions, voidTag } from "../src/tags.js";
import { xmlNameEscape } from "../src/escaping.js";

const BREAKOUT = "x><script>alert(1)</script";

describe("an attribute name", () => {
  it("cannot close the tag it is written in", () => {
    const html = tagOptions({ [BREAKOUT]: "1" });

    expect(html).not.toContain("<script>");
    expect(html).not.toContain(">");
  });

  it("leaves an ordinary name exactly as it was", () => {
    expect(tagOptions({ class: "card", "data-id": "4", "aria-label": "Close" })).toBe(
      ' class="card" data-id="4" aria-label="Close"',
    );
  });

  /** `@click` and `:href` are how the client frameworks spell an attribute. */
  it("leaves a framework's punctuation alone", () => {
    expect(tagOptions({ "@click": "go", ":href": "url" })).toBe(' @click="go" :href="url"');
  });

  it("escapes the name of a valueless attribute too", () => {
    expect(tagOptions({ [BREAKOUT]: true })).not.toContain(">");
  });

  it("still escapes the value", () => {
    expect(tagOptions({ title: 'a" onmouseover="alert(1)' })).toBe(
      ' title="a&quot; onmouseover=&quot;alert(1)"',
    );
  });
});

describe("a tag name", () => {
  /**
   * Rails leaves this one alone, because `tag.p` takes its name from a method
   * call and cannot be handed a string. These helpers take a string.
   */
  it("cannot close its own tag", () => {
    for (const html of [
      String(contentTag(BREAKOUT, "hi")),
      String(voidTag(BREAKOUT)),
      String(selfClosingTag(BREAKOUT)),
      contentTagString(BREAKOUT, "hi"),
    ]) {
      expect(html).not.toContain("<script>");
    }
  });

  it("opens and closes with the same name", () => {
    expect(contentTagString(BREAKOUT, "hi")).toBe(
      "<x__script_alert_1___script>hi</x__script_alert_1___script>",
    );
  });

  it("leaves an ordinary element alone", () => {
    expect(contentTagString("p", "hi", { class: "lead" })).toBe('<p class="lead">hi</p>');
  });

  it("leaves a custom element alone", () => {
    expect(String(contentTag("my-widget", "hi"))).toBe("<my-widget>hi</my-widget>");
  });
});

describe("the escape itself", () => {
  /**
   * Rails' own example, with the answer its code gives rather than the one
   * its comment claims. The docstring says `1___2___3`, and a digit cannot
   * *start* an XML name — `TAG_NAME_START_CODEPOINTS` has no digits in it —
   * so `xml_name_escape` replaces that first `1` as well. The comment has
   * been wrong since it was written; the behaviour is what is ported here.
   */
  it("replaces what is not part of a name", () => {
    expect(xmlNameEscape("1 < 2 & 3")).toBe("____2___3");
  });

  it("leaves a name that is already one", () => {
    expect(xmlNameEscape("data-user-id")).toBe("data-user-id");
    expect(xmlNameEscape("viewBox")).toBe("viewBox");
    expect(xmlNameEscape("_private")).toBe("_private");
  });

  /**
   * A digit cannot start a name and can follow one, so the first character
   * and the rest are held to different rules — `1a` is `_a`, not `_1a`.
   */
  it("holds the first character to the stricter rule", () => {
    expect(xmlNameEscape("1a")).toBe("_a");
    expect(xmlNameEscape("a1")).toBe("a1");
  });

  it("handles a single character", () => {
    expect(xmlNameEscape("1")).toBe("_");
    expect(xmlNameEscape("a")).toBe("a");
  });

  it("gives an empty name back", () => {
    expect(xmlNameEscape("")).toBe("");
  });

  it("keeps a name that is not ASCII", () => {
    expect(xmlNameEscape("données")).toBe("données");
  });
});
