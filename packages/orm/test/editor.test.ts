/**
 * Getting a body in and out of the editor, ported from
 * `actiontext/test/unit/trix_attachment_test.rb` and the round-trip cases in
 * `actiontext/test/unit/content_test.rb`.
 *
 * The incoming direction is the half that loses work: an editor saves
 * `<figure data-trix-attachment="…">`, and stored as it arrives that body no
 * longer matches the attachment selector — so the attachment is invisible to
 * `contentAttachables`, invisible to a purge check, and renders as an empty
 * figure.
 */

import { describe, expect, it } from "bun:test";
import { contentAttachableSgids } from "../src/content.js";
import { Fragment } from "../src/fragment.js";
import {
  TRIX_ATTACHMENT_ATTRIBUTE,
  editorTag,
  elementName,
  escapeMarkdownText,
  fragmentFromEditorHtml,
  fromTrixAttachment,
  markdownLink,
  toEditorHtml,
  toTrixAttachment,
} from "../src/editor.js";

const STORED = '<p>Hi</p><action-text-attachment sgid="abc"></action-text-attachment>';

function editorNode(attachment: Record<string, unknown>): string {
  const json = JSON.stringify(attachment).replaceAll("&", "&amp;").replaceAll('"', "&quot;");

  return `<figure ${TRIX_ATTACHMENT_ATTRIBUTE}="${json}"></figure>`;
}

describe("names", () => {
  it("knows the editor's tag", () => {
    expect(editorTag()).toBe("trix-editor");
  });

  it("knows what it calls an attachment", () => {
    expect(elementName()).toBe("figure");
  });
});

describe("reading an editor attachment", () => {
  it("reads the json blob", () => {
    const attachment = fromTrixAttachment(
      editorNode({ sgid: "abc", filename: "cat.png", width: 100 }),
    );

    expect(attachment?.sgid).toBe("abc");
    expect(attachment?.filename).toBe("cat.png");
    expect(attachment?.width).toBe(100);
  });

  /**
   * Rails writes the signed id as its own attribute on the way out and the
   * editor sends the blob back, so a real round trip produces one of each.
   * Reading only one silently drops half the attachments in an edited body.
   */
  it("reads the signed id written as its own attribute", () => {
    const attachment = fromTrixAttachment('<figure data-trix-attachment-sgid="abc"></figure>');

    expect(attachment?.sgid).toBe("abc");
  });

  it("decodes entities in the blob", () => {
    const attachment = fromTrixAttachment(editorNode({ caption: 'He said "hi" & left' }));

    expect(attachment?.caption).toBe('He said "hi" & left');
  });

  /** The blob comes back from a browser and a person can edit it. */
  it("gives null for a blob that will not parse", () => {
    expect(
      fromTrixAttachment(`<figure ${TRIX_ATTACHMENT_ATTRIBUTE}="not json"></figure>`),
    ).toBeNull();
  });

  it("gives null for a blob that is not an object", () => {
    expect(fromTrixAttachment(editorNode([1, 2] as never))).toBeNull();
  });

  it("gives null for a figure with no attachment at all", () => {
    expect(fromTrixAttachment("<figure><img src='x'></figure>")).toBeNull();
  });
});

describe("writing an editor attachment", () => {
  it("writes the blob the editor reads", () => {
    const node = toTrixAttachment({ sgid: "abc", filename: "cat.png" });

    expect(node).toContain(TRIX_ATTACHMENT_ATTRIBUTE);
    expect(fromTrixAttachment(node)?.filename).toBe("cat.png");
  });

  it("escapes the blob so it cannot close the attribute", () => {
    const node = toTrixAttachment({ caption: '"><script>alert(1)</script>' });

    expect(node).not.toContain("<script>");
    expect(fromTrixAttachment(node)?.caption).toBe('"><script>alert(1)</script>');
  });
});

describe("coming in from the editor", () => {
  /** The bug this exists for: the body no longer matches the selector. */
  it("turns an editor attachment into a stored one", () => {
    const stored = fragmentFromEditorHtml(`<p>Hi</p>${editorNode({ sgid: "abc" })}`);

    expect(contentAttachableSgids(stored)).toEqual(["abc"]);
  });

  it("takes the sgid attribute form too", () => {
    const stored = fragmentFromEditorHtml('<figure data-trix-attachment-sgid="abc"></figure>');

    expect(contentAttachableSgids(stored)).toEqual(["abc"]);
  });

  /**
   * Only the signed id survives: the renderer decides how an attachment looks
   * each time, so storing the editor's width is a body that renders
   * differently from a new one for no reason anybody can see.
   */
  it("keeps nothing but the signed id", () => {
    const stored = fragmentFromEditorHtml(
      editorNode({ sgid: "abc", width: 100, caption: "My cat" }),
    );

    expect(stored.source).toBe('<action-text-attachment sgid="abc"></action-text-attachment>');
  });

  /** Deleting markup because it did not parse is how an editor eats a document. */
  it("leaves an ordinary figure exactly as it was", () => {
    const plain = "<figure><img src='x'><figcaption>A</figcaption></figure>";

    expect(fragmentFromEditorHtml(plain).source).toBe(plain);
  });

  it("leaves an attachment with no sgid alone", () => {
    const node = editorNode({ filename: "cat.png" });

    expect(fragmentFromEditorHtml(node).source).toBe(node);
  });

  it("keeps the rest of the body", () => {
    const stored = fragmentFromEditorHtml(`<p>Hi</p>${editorNode({ sgid: "abc" })}<p>Bye</p>`);

    expect(stored.source).toContain("<p>Hi</p>");
    expect(stored.source).toContain("<p>Bye</p>");
  });

  it("converts several", () => {
    const stored = fragmentFromEditorHtml(editorNode({ sgid: "a" }) + editorNode({ sgid: "b" }));

    expect(contentAttachableSgids(stored)).toEqual(["a", "b"]);
  });
});

describe("going out to the editor", () => {
  it("turns a stored attachment into one the editor loads", () => {
    expect(toEditorHtml(STORED).source).toContain('data-trix-attachment-sgid="abc"');
  });

  it("keeps the rest of the body", () => {
    expect(toEditorHtml(STORED).source).toContain("<p>Hi</p>");
  });

  it("takes a fragment as readily as a string", () => {
    expect(toEditorHtml(Fragment.fromHtml(STORED)).source).toContain("figure");
  });

  it("leaves an attachment with no sgid alone", () => {
    const node = "<action-text-attachment></action-text-attachment>";

    expect(toEditorHtml(node).source).toBe(node);
  });
});

describe("the round trip", () => {
  /** The property that matters: editing a body must not lose its attachments. */
  it("survives a body going out and coming back", () => {
    const returned = fragmentFromEditorHtml(toEditorHtml(STORED).source);

    expect(contentAttachableSgids(returned)).toEqual(["abc"]);
    expect(returned.source).toContain("<p>Hi</p>");
  });

  it("is stable over a second trip", () => {
    const once = fragmentFromEditorHtml(toEditorHtml(STORED).source);
    const twice = fragmentFromEditorHtml(toEditorHtml(once.source).source);

    expect(twice.source).toBe(once.source);
  });
});

describe("markdown", () => {
  it("escapes what would turn text into markup", () => {
    expect(escapeMarkdownText("a *bold* [link]")).toBe("a \\*bold\\* \\[link\\]");
  });

  it("escapes a backslash so the escaping cannot be undone", () => {
    expect(escapeMarkdownText("a\\b")).toBe("a\\\\b");
  });

  /** Escaping more makes a caption unreadable where it is read raw. */
  it("leaves ordinary punctuation alone", () => {
    expect(escapeMarkdownText("Hello, world! It's fine.")).toBe("Hello, world! It's fine.");
  });

  it("builds a link with the text escaped", () => {
    expect(markdownLink("a [thing]", "https://x.test")).toBe("[a \\[thing\\]](https://x.test)");
  });

  /** An unescaped bracket in the url closes the link early. */
  it("escapes a closing bracket in the url", () => {
    expect(markdownLink("a", "https://x.test/(b)")).toBe("[a](https://x.test/(b%29)");
  });
});
