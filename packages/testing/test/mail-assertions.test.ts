/**
 * Part assertions, ported from the part cases in
 * `actionmailer/test/base_test.rb`.
 */

import { describe, expect, it } from "bun:test";
import { AssertionFailed } from "@altair/support";
import {
  attachmentParts,
  bodyParts,
  isMultipart,
  messageContentType,
  messagePart,
  messageParts,
  type MessageFields,
} from "@altair/mailer";
import {
  assertAttachment,
  assertEveryBodyContains,
  assertNoAttachment,
  assertNoPart,
  assertPart,
  assertPartContains,
} from "../src/mail-assertions.js";

function message(fields: Partial<MessageFields> = {}): MessageFields {
  return { to: "a@example.com", subject: "Hi", ...fields };
}

describe("messageParts", () => {
  it("gives the text part", () => {
    expect(messageParts(message({ text: "hello" }))).toEqual([
      { contentType: "text/plain", body: "hello" },
    ]);
  });

  /**
   * A multipart/alternative message is read last-part-first by a client
   * choosing what to show, so the richest version has to be last.
   */
  it("puts plain text before HTML", () => {
    const parts = messageParts(message({ html: "<p>hi</p>", text: "hi" }));

    expect(parts.map((one) => one.contentType)).toEqual(["text/plain", "text/html"]);
  });

  it("includes attachments after the bodies", () => {
    const parts = messageParts(
      message({
        text: "hi",
        attachments: [{ filename: "a.pdf", content: "x", contentType: "application/pdf" }],
      }),
    );

    expect(parts.map((one) => one.contentType)).toEqual(["text/plain", "application/pdf"]);
  });

  it("finds one by content type", () => {
    const mail = message({ text: "hi", html: "<p>hi</p>" });

    expect(messagePart(mail, "text/html")?.body).toBe("<p>hi</p>");
    expect(messagePart(mail, "text/csv")).toBeUndefined();
  });

  it("reports whether it is multipart", () => {
    expect(isMultipart(message({ text: "hi" }))).toBe(false);
    expect(isMultipart(message({ text: "hi", html: "<p>hi</p>" }))).toBe(true);
  });

  /** A client picking a body never picks an attachment. */
  it("separates bodies from attachments", () => {
    const mail = message({
      text: "hi",
      attachments: [{ filename: "a.pdf", content: "x", contentType: "application/pdf" }],
    });

    expect(bodyParts(mail).map((one) => one.contentType)).toEqual(["text/plain"]);
    expect(attachmentParts(mail).map((one) => one.filename)).toEqual(["a.pdf"]);
  });

  /** alternative means "pick one"; mixed means "these are all part of it". */
  it("names the content type the whole message carries", () => {
    expect(messageContentType(message({ text: "hi" }))).toBe("text/plain");
    expect(messageContentType(message({ text: "hi", html: "<p>hi</p>" }))).toBe(
      "multipart/alternative",
    );
    expect(
      messageContentType(
        message({ text: "hi", attachments: [{ filename: "a.pdf", content: "x" }] }),
      ),
    ).toBe("multipart/mixed");
  });
});

describe("assertPart", () => {
  it("passes when the part is there", () => {
    expect(() => assertPart(message({ html: "<p>hi</p>" }), "text/html")).not.toThrow();
  });

  it("gives the part back", () => {
    expect(assertPart(message({ html: "<p>hi</p>" }), "text/html").body).toBe("<p>hi</p>");
  });

  /**
   * The bug this is for: a mailer that stopped rendering its HTML template
   * still sends, still has a subject, and still passes every assertion about
   * the text body.
   */
  it("fails when it is missing", () => {
    expect(() => assertPart(message({ text: "hi" }), "text/html")).toThrow(AssertionFailed);
  });

  it("names what was there instead", () => {
    expect(() => assertPart(message({ text: "hi" }), "text/html")).toThrow(/text\/plain/);
  });

  it("says none when there is nothing", () => {
    expect(() => assertPart(message(), "text/html")).toThrow(/none/);
  });

  it("asserts absence", () => {
    expect(() => assertNoPart(message({ text: "hi" }), "text/html")).not.toThrow();
    expect(() => assertNoPart(message({ html: "<p>hi</p>" }), "text/html")).toThrow(
      AssertionFailed,
    );
  });
});

describe("assertPartContains", () => {
  it("passes when the part contains it", () => {
    expect(() =>
      assertPartContains(message({ html: "<p>Order 42</p>" }), "text/html", "Order 42"),
    ).not.toThrow();
  });

  it("takes a pattern", () => {
    expect(() =>
      assertPartContains(message({ html: "<p>Order 42</p>" }), "text/html", /Order \d+/),
    ).not.toThrow();
  });

  it("fails when it does not", () => {
    expect(() =>
      assertPartContains(message({ html: "<p>hi</p>" }), "text/html", "Order 42"),
    ).toThrow(/to contain/);
  });

  /** A search across both parts would pass on exactly the bug this catches. */
  it("does not find it in a different part", () => {
    const mail = message({ text: "Order 42", html: "<p>hi</p>" });

    expect(() => assertPartContains(mail, "text/html", "Order 42")).toThrow(AssertionFailed);
  });

  it("fails when the part is missing entirely", () => {
    expect(() => assertPartContains(message({ text: "hi" }), "text/html", "hi")).toThrow(
      /Expected a text\/html part/,
    );
  });
});

describe("assertEveryBodyContains", () => {
  it("passes when both bodies have it", () => {
    const mail = message({ text: "Order 42", html: "<p>Order 42</p>" });

    expect(() => assertEveryBodyContains(mail, "Order 42")).not.toThrow();
  });

  it("fails when only one does", () => {
    const mail = message({ text: "Order 42", html: "<p>hi</p>" });

    expect(() => assertEveryBodyContains(mail, "Order 42")).toThrow(/text\/html/);
  });

  it("ignores attachments", () => {
    const mail = message({
      text: "Order 42",
      attachments: [{ filename: "a.pdf", content: "nothing", contentType: "application/pdf" }],
    });

    expect(() => assertEveryBodyContains(mail, "Order 42")).not.toThrow();
  });

  it("fails when there is no body at all", () => {
    expect(() => assertEveryBodyContains(message(), "anything")).toThrow(/no body parts/);
  });
});

describe("attachments", () => {
  const mail = message({
    text: "hi",
    attachments: [{ filename: "invoice.pdf", content: "x", contentType: "application/pdf" }],
  });

  it("finds one by name", () => {
    expect(assertAttachment(mail, "invoice.pdf").contentType).toBe("application/pdf");
  });

  it("fails for one that is not there", () => {
    expect(() => assertAttachment(mail, "other.pdf")).toThrow(/invoice.pdf/);
  });

  it("asserts absence", () => {
    expect(() => assertNoAttachment(mail, "other.pdf")).not.toThrow();
    expect(() => assertNoAttachment(mail, "invoice.pdf")).toThrow(AssertionFailed);
  });
});
