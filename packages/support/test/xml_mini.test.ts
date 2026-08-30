/**
 * XML in and out of plain objects, ported from
 * `activesupport/test/core_ext/hash_ext_test.rb` (the `from_xml` cases) and
 * `activesupport/test/xml_mini_test.rb`.
 *
 * Nobody writes new XML and everybody receives it. What arrives is a string,
 * what the code needs is an object, and the gap between them is where a
 * `"3"` gets compared to a `3`.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  XmlParseError,
  backend,
  characters,
  endDocument,
  endElement,
  fromTrustedXml,
  fromXml,
  parseError,
  resetBackend,
  setBackend,
  startDocument,
  startElement,
  toTag,
  toXmlDocument,
  tokenize,
  walkXml,
  withBackend,
  xmlNameEscape,
} from "../src/xml_mini.js";
import type { XmlHandler } from "../src/xml_mini.js";

afterEach(() => {
  resetBackend();
});

describe("tokenize", () => {
  it("finds an element and its text", () => {
    expect(tokenize("<a>hello</a>")).toEqual([
      { kind: "open", name: "a", attributes: {}, selfClosing: false },
      { kind: "text", text: "hello" },
      { kind: "close", name: "a" },
    ]);
  });

  it("finds attributes", () => {
    const [open] = tokenize('<a href="/x" title="t"/>');

    expect(open).toEqual({
      kind: "open",
      name: "a",
      attributes: { href: "/x", title: "t" },
      selfClosing: true,
    });
  });

  it("takes single-quoted attributes too", () => {
    expect(tokenize("<a href='/x'/>")[0]).toMatchObject({ attributes: { href: "/x" } });
  });

  it("skips a comment", () => {
    expect(tokenize("<a><!-- ignore me --></a>")).toHaveLength(2);
  });

  /** No entities are resolved inside it, which is the reason a document uses it. */
  it("takes CDATA verbatim", () => {
    const tokens = tokenize("<a><![CDATA[<b>&amp;</b>]]></a>");

    expect(tokens[1]).toEqual({ kind: "text", text: "<b>&amp;</b>" });
  });

  it("keeps the declaration as its own token", () => {
    expect(tokenize('<?xml version="1.0"?><a/>')[0]?.kind).toBe("declaration");
  });

  it("resolves the five entities XML defines", () => {
    expect(tokenize("<a>&lt;&amp;&gt;&quot;&apos;</a>")[1]).toEqual({
      kind: "text",
      text: "<&>\"'",
    });
  });

  it("resolves a numeric entity", () => {
    expect(tokenize("<a>&#65;&#x42;</a>")[1]).toEqual({ kind: "text", text: "AB" });
  });

  /**
   * Error recovery is exactly what must not happen: a malformed document from
   * a payment webhook should fail loudly, not parse into something plausible.
   */
  it("refuses a tag that is never closed", () => {
    expect(() => tokenize("<a")).toThrow(XmlParseError);
  });

  it("refuses a comment that is never closed", () => {
    expect(() => tokenize("<a><!-- forever")).toThrow(XmlParseError);
  });

  it("refuses an unquoted attribute", () => {
    expect(() => tokenize("<a href=/x/>")).toThrow(XmlParseError);
  });

  it("refuses an attribute with no value", () => {
    expect(() => tokenize("<a href/>")).toThrow(XmlParseError);
  });
});

describe("walkXml", () => {
  function record(xml: string): string[] {
    const events: string[] = [];
    const handler: XmlHandler = {
      onStartDocument: () => events.push("start"),
      onEndDocument: () => events.push("end"),
      onStartElement: (name) => events.push(`<${name}>`),
      onEndElement: (name) => events.push(`</${name}>`),
      onCharacters: (text) => events.push(`"${text}"`),
    };

    walkXml(xml, handler);

    return events;
  }

  it("reports the document and its elements in order", () => {
    expect(record("<a><b>x</b></a>")).toEqual([
      "start",
      "<a>",
      "<b>",
      '"x"',
      "</b>",
      "</a>",
      "end",
    ]);
  });

  it("closes a self-closing element immediately", () => {
    expect(record("<a/>")).toEqual(["start", "<a>", "</a>", "end"]);
  });

  it("says nothing about a declaration", () => {
    expect(record('<?xml version="1.0"?><a/>')).toEqual(["start", "<a>", "</a>", "end"]);
  });

  /** Guessing which tag was meant is how a parser makes a plausible object from nonsense. */
  it("refuses tags that do not nest", () => {
    expect(() => walkXml("<a><b></a></b>", {})).toThrow(XmlParseError);
  });

  it("refuses a closing tag for nothing", () => {
    expect(() => walkXml("</a>", {})).toThrow(XmlParseError);
  });

  it("refuses an element that is never closed", () => {
    expect(() => walkXml("<a><b>x</b>", {})).toThrow(XmlParseError);
  });

  it("survives a handler that wants nothing", () => {
    expect(() => walkXml("<a>x</a>", {})).not.toThrow();
  });

  it("drives one event directly", () => {
    const seen: string[] = [];

    startDocument({ onStartDocument: () => seen.push("start") });
    startElement({ onStartElement: (name) => seen.push(name) }, "a");
    characters({ onCharacters: (text) => seen.push(text) }, "x");
    endElement({ onEndElement: (name) => seen.push(`/${name}`) }, "a");
    endDocument({ onEndDocument: () => seen.push("end") });

    expect(seen).toEqual(["start", "a", "x", "/a", "end"]);
  });
});

describe("fromXml", () => {
  it("reads an element into an object", () => {
    expect(fromXml("<hash><name>Ada</name></hash>")).toEqual({ hash: { name: "Ada" } });
  });

  it("nests", () => {
    expect(fromXml("<a><b><c>x</c></b></a>")).toEqual({ a: { b: { c: "x" } } });
  });

  /** Without the type attribute every consumer writes its own parseInt. */
  it("reads a typed integer as a number", () => {
    expect(fromXml('<a><count type="integer">3</count></a>')).toEqual({ a: { count: 3 } });
  });

  it("reads a float", () => {
    expect(fromXml('<a><rate type="float">1.5</rate></a>')).toEqual({ a: { rate: 1.5 } });
  });

  it("reads a decimal as a number too", () => {
    expect(fromXml('<a><n type="decimal">2.25</n></a>')).toEqual({ a: { n: 2.25 } });
  });

  /** Rails' rule exactly: only "1" and "true". */
  it("reads a boolean", () => {
    expect(fromXml('<a><ok type="boolean">true</ok></a>')).toEqual({ a: { ok: true } });
    expect(fromXml('<a><ok type="boolean">1</ok></a>')).toEqual({ a: { ok: true } });
  });

  /** It looks true and it is not, so being consistent about it matters. */
  it("does not read yes as true", () => {
    expect(fromXml('<a><ok type="boolean">yes</ok></a>')).toEqual({ a: { ok: false } });
  });

  it("reads a datetime", () => {
    const read = fromXml('<a><at type="datetime">2026-03-04T05:06:07Z</at></a>') as {
      a: { at: Date };
    };

    expect(read.a.at).toBeInstanceOf(Date);
    expect(read.a.at.toISOString()).toBe("2026-03-04T05:06:07.000Z");
  });

  it("reads a date at midnight UTC rather than guessing a zone", () => {
    const read = fromXml('<a><on type="date">2026-03-04</on></a>') as { a: { on: Date } };

    expect(read.a.on.toISOString()).toBe("2026-03-04T00:00:00.000Z");
  });

  it("reads base64", () => {
    const read = fromXml('<a><b type="base64Binary">aGk=</b></a>') as { a: { b: Uint8Array } };

    expect(Buffer.from(read.a.b).toString()).toBe("hi");
  });

  it("reads an explicit nil as null", () => {
    expect(fromXml('<a><b nil="true"/></a>')).toEqual({ a: { b: null } });
  });

  it("leaves an untyped value a string", () => {
    expect(fromXml("<a><b>3</b></a>")).toEqual({ a: { b: "3" } });
  });

  it("reads repeated elements as an array", () => {
    expect(fromXml("<a><b>1</b><b>2</b></a>")).toEqual({ a: { b: ["1", "2"] } });
  });

  /** XML's oldest ambiguity: a list of one looks like a single value. */
  it("reads a marked array of one as an array", () => {
    expect(fromXml('<a type="array"><b>1</b></a>')).toEqual({ a: { b: ["1"] } });
  });

  it("reads an empty marked array as an empty array", () => {
    expect(fromXml('<a><list type="array"/></a>')).toEqual({ a: { list: [] } });
  });

  it("reads an empty element as an empty string", () => {
    expect(fromXml("<a><b></b></a>")).toEqual({ a: { b: "" } });
  });

  it("resolves entities in the text", () => {
    expect(fromXml("<a><b>a &amp; b</b></a>")).toEqual({ a: { b: "a & b" } });
  });
});

describe("what fromXml refuses", () => {
  /**
   * `<!ENTITY x SYSTEM "file:///etc/passwd">` makes the parser read a local
   * file and put its contents in the result — the classic version of this bug
   * leaked private keys from a dozen well-known products.
   */
  it("refuses a document type declaration", () => {
    const attack = '<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a>&x;</a>';

    expect(() => fromXml(attack)).toThrow(XmlParseError);
  });

  it("says why", () => {
    expect(() => fromXml("<!DOCTYPE a><a/>")).toThrow("XXE");
  });

  it("refuses it whatever its case", () => {
    expect(() => fromXml("<!doctype a><a/>")).toThrow(XmlParseError);
  });

  /**
   * Ten nested entities each referring to the previous ten times over expand
   * to a gigabyte from a two-line document.
   */
  it("refuses an expansion bomb before reading it", () => {
    const bomb =
      '<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]><lolz>&lol2;</lolz>';

    expect(() => fromXml(bomb)).toThrow(XmlParseError);
  });

  /** An entity a document declares for itself is never resolved. */
  it("leaves an unknown entity alone rather than resolving it", () => {
    expect(fromXml("<a><b>&whatever;</b></a>")).toEqual({ a: { b: "&whatever;" } });
  });

  /**
   * A separate name rather than an option: an option defaults, and a name has
   * to be typed by somebody who knows where the document came from.
   */
  it("takes the declaration when the caller says it is trusted", () => {
    expect(fromTrustedXml("<!DOCTYPE a><a><b>x</b></a>")).toEqual({ a: { b: "x" } });
  });

  it("still refuses malformed markup when trusted", () => {
    expect(() => fromTrustedXml("<a><b></a></b>")).toThrow(XmlParseError);
  });
});

describe("writing", () => {
  it("writes an element", () => {
    expect(toTag("name", "Ada")).toBe("<name>Ada</name>");
  });

  it("marks a number so it reads back a number", () => {
    expect(toTag("count", 3)).toBe('<count type="integer">3</count>');
    expect(toTag("rate", 1.5)).toBe('<rate type="float">1.5</rate>');
  });

  it("marks a boolean", () => {
    expect(toTag("ok", true)).toBe('<ok type="boolean">true</ok>');
  });

  it("marks a date", () => {
    expect(toTag("at", new Date(0))).toBe('<at type="datetime">1970-01-01T00:00:00.000Z</at>');
  });

  it("writes null as an explicit nil", () => {
    expect(toTag("b", null)).toBe('<b nil="true"/>');
    expect(toTag("b", undefined)).toBe('<b nil="true"/>');
  });

  /** The marker is what stops a list of one reading back as a single value. */
  it("marks an array", () => {
    expect(toTag("list", [1])).toContain('type="array"');
  });

  it("writes an empty array as a marked empty element", () => {
    expect(toTag("list", [])).toBe('<list type="array"/>');
  });

  it("writes an object's keys", () => {
    expect(toTag("a", { b: "x" })).toBe("<a>\n  <b>x</b>\n</a>");
  });

  it("writes an empty object as an empty element", () => {
    expect(toTag("a", {})).toBe("<a/>");
  });

  it("escapes what would otherwise be markup", () => {
    expect(toTag("b", "<script> & 'x'")).toContain("&lt;script&gt; &amp; &apos;x&apos;");
  });

  it("escapes the element's own name", () => {
    expect(toTag("a<b", "x")).toStartWith("<a&lt;b>");
  });

  it("writes a whole document with its declaration", () => {
    expect(toXmlDocument({ b: "x" })).toStartWith('<?xml version="1.0" encoding="UTF-8"?>');
  });

  it("names the root", () => {
    expect(toXmlDocument({ b: "x" }, "record")).toContain("<record>");
  });
});

describe("round trips", () => {
  it("keeps a typed number a number", () => {
    const written = toXmlDocument({ count: 3 });

    expect(fromXml(written)).toEqual({ hash: { count: 3 } });
  });

  it("keeps a boolean", () => {
    expect(fromXml(toXmlDocument({ ok: false }))).toEqual({ hash: { ok: false } });
  });

  it("keeps a null", () => {
    expect(fromXml(toXmlDocument({ b: null }))).toEqual({ hash: { b: null } });
  });

  it("keeps a nested object", () => {
    expect(fromXml(toXmlDocument({ a: { b: "x" } }))).toEqual({ hash: { a: { b: "x" } } });
  });

  it("keeps text that had markup in it", () => {
    expect(fromXml(toXmlDocument({ b: "a < b & c" }))).toEqual({ hash: { b: "a < b & c" } });
  });
});

describe("xmlNameEscape", () => {
  it("escapes all five", () => {
    expect(xmlNameEscape("<>&\"'")).toBe("&lt;&gt;&amp;&quot;&apos;");
  });

  /** The ampersand goes first, or the escapes themselves get escaped. */
  it("does not double-escape its own output", () => {
    expect(xmlNameEscape("a & b")).toBe("a &amp; b");
  });
});

describe("the backend", () => {
  it("is ours by default", () => {
    expect(backend().name).toBe("altair");
  });

  it("can be replaced", () => {
    setBackend({ name: "other", parse: () => ({ replaced: true }) });

    expect(backend().name).toBe("other");
  });

  it("runs something with a different one", () => {
    const seen = withBackend({ name: "temporary", parse: () => ({}) }, () => backend().name);

    expect(seen).toBe("temporary");
    expect(backend().name).toBe("altair");
  });

  /**
   * Restored in a finally, or one throwing test leaves every later one on the
   * wrong parser — and the failure appears in a test that did nothing wrong.
   */
  it("puts the old one back even when the body throws", () => {
    expect(() =>
      withBackend({ name: "temporary", parse: () => ({}) }, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(backend().name).toBe("altair");
  });
});

describe("parseError", () => {
  it("throws with the reason", () => {
    expect(() => parseError("because")).toThrow("because");
  });

  it("throws the right type", () => {
    expect(() => parseError("x")).toThrow(XmlParseError);
  });
});
