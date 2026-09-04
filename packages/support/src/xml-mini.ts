/**
 * XML in and out of plain objects. Ported from `ActiveSupport::XmlMini`,
 * `Hash.from_xml` and `Hash.from_trusted_xml`.
 *
 * Nobody writes new XML, and everybody receives it: a payment provider's
 * webhook, a shipping carrier's rate response, a legacy system's export. What
 * arrives is a string, and what the code needs is an object.
 *
 * The interesting part is the typing. XML has no types, so Rails puts them in
 * an attribute — `<count type="integer">3</count>` — and reads them back, so a
 * round trip gives a number rather than `"3"`. Without it every consumer
 * writes its own `parseInt`, and the one that forgets compares a string to a
 * number and silently takes the wrong branch.
 *
 * The other interesting part is what is refused. `fromXml` will not process a
 * document type declaration; `fromTrustedXml` will. That is not a formality:
 *
 *   - **XXE.** `<!ENTITY x SYSTEM "file:///etc/passwd">` makes the parser read
 *     a local file and put its contents in the result, which the application
 *     then stores or echoes. The classic version of this bug leaked private
 *     keys from a dozen well-known products.
 *   - **Entity expansion.** Ten nested entities each referring to the previous
 *     ten times over expand to a gigabyte from a two-line document. The
 *     process dies with an allocation failure that names nothing.
 *
 * Neither has anything to do with the document's contents, so neither is
 * caught by validating them. The document has to be refused before it is read,
 * which is what the two names are for: a caller that types `fromTrustedXml`
 * has said where the document came from.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** Thrown when a document cannot be read, or must not be. */
export class XmlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XmlParseError";
  }
}

export function parseError(message: string): never {
  throw new XmlParseError(message);
}

/** One thing the tokenizer found. */
export type XmlToken =
  | { kind: "open"; name: string; attributes: Record<string, string>; selfClosing: boolean }
  | { kind: "close"; name: string }
  | { kind: "text"; text: string }
  | { kind: "declaration"; text: string };

const NAME = /[A-Za-z_:][\w.:-]*/y;

/**
 * Takes a document apart into tokens. Rails' `tokenize`.
 *
 * Hand-written rather than delegating to `DOMParser`, which exists in Bun but
 * would make the result depend on a browser API's error recovery — and error
 * recovery is exactly what must not happen here: a malformed document from a
 * payment webhook should fail loudly, not parse into something plausible.
 */
export function tokenize(xml: string): XmlToken[] {
  const tokens: XmlToken[] = [];
  let at = 0;

  while (at < xml.length) {
    const next = xml.indexOf("<", at);

    if (next === -1) {
      pushText(tokens, xml.slice(at));
      break;
    }

    pushText(tokens, xml.slice(at, next));

    if (xml.startsWith("<!--", next)) {
      const end = xml.indexOf("-->", next);
      if (end === -1) parseError("a comment is never closed");
      at = end + 3;
      continue;
    }

    if (xml.startsWith("<![CDATA[", next)) {
      const end = xml.indexOf("]]>", next);
      if (end === -1) parseError("a CDATA section is never closed");
      // CDATA is text verbatim: no entities are resolved inside it, which is
      // the reason a document uses it.
      tokens.push({ kind: "text", text: xml.slice(next + 9, end) });
      at = end + 3;
      continue;
    }

    if (xml.startsWith("<?", next) || xml.startsWith("<!", next)) {
      const end = xml.indexOf(">", next);
      if (end === -1) parseError("a declaration is never closed");
      tokens.push({ kind: "declaration", text: xml.slice(next, end + 1) });
      at = end + 1;
      continue;
    }

    if (xml.startsWith("</", next)) {
      NAME.lastIndex = next + 2;
      const match = NAME.exec(xml);
      if (!match) parseError("a closing tag has no name");
      const end = xml.indexOf(">", NAME.lastIndex);
      if (end === -1) parseError("a closing tag is never closed");
      tokens.push({ kind: "close", name: match[0] });
      at = end + 1;
      continue;
    }

    NAME.lastIndex = next + 1;
    const match = NAME.exec(xml);
    if (!match) parseError(`not a tag at ${String(next)}`);

    const [attributes, after, selfClosing] = readAttributes(xml, NAME.lastIndex);

    tokens.push({ kind: "open", name: match[0], attributes, selfClosing });
    at = after;
  }

  return tokens;
}

function pushText(tokens: XmlToken[], text: string): void {
  if (text !== "") tokens.push({ kind: "text", text: decodeEntities(text) });
}

function readAttributes(xml: string, from: number): [Record<string, string>, number, boolean] {
  const attributes: Record<string, string> = {};
  let at = from;

  for (;;) {
    while (at < xml.length && /\s/.test(xml[at] as string)) at += 1;

    if (at >= xml.length) parseError("a tag is never closed");

    if (xml.startsWith("/>", at)) return [attributes, at + 2, true];
    if (xml[at] === ">") return [attributes, at + 1, false];

    NAME.lastIndex = at;
    const name = NAME.exec(xml);
    if (!name) parseError(`not an attribute at ${String(at)}`);

    at = NAME.lastIndex;
    while (at < xml.length && /\s/.test(xml[at] as string)) at += 1;

    if (xml[at] !== "=") parseError(`attribute ${name[0]} has no value`);

    at += 1;
    while (at < xml.length && /\s/.test(xml[at] as string)) at += 1;

    const quote = xml[at];
    if (quote !== '"' && quote !== "'") parseError(`attribute ${name[0]} is not quoted`);

    const end = xml.indexOf(quote, at + 1);
    if (end === -1) parseError(`attribute ${name[0]} is never closed`);

    attributes[name[0]] = decodeEntities(xml.slice(at + 1, end));
    at = end + 1;
  }
}

/**
 * Only the five entities XML defines.
 *
 * Nothing else, and nothing numeric beyond a plain code point: an entity a
 * document declares for itself is the expansion attack, and resolving one here
 * would put the refusal in the wrong place.
 */
const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeEntities(text: string): string {
  return text.replaceAll(/&(#x?[0-9a-f]+|\w+);/gi, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body.startsWith("#x")
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);

      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }

    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** What a SAX-style reader is told. Rails' handler interface. */
export interface XmlHandler {
  onStartDocument?(): void;
  onEndDocument?(): void;
  onStartElement?(name: string, attributes: Record<string, string>): void;
  onEndElement?(name: string): void;
  onCharacters?(text: string): void;
}

/**
 * Walks a document, telling a handler what it finds.
 *
 * Events rather than a tree for the case a tree cannot serve: a 200MB export
 * that has to be read a record at a time. Rails offers the same two shapes for
 * the same reason.
 */
export function walkXml(xml: string, handler: XmlHandler): void {
  startDocument(handler);

  const open: string[] = [];

  for (const token of tokenize(xml)) {
    switch (token.kind) {
      case "declaration":
        continue;
      case "open":
        startElement(handler, token.name, token.attributes);
        if (token.selfClosing) endElement(handler, token.name);
        else open.push(token.name);
        continue;
      case "close": {
        const expected = open.pop();

        // Checked rather than tolerated. A document whose tags do not nest is
        // a document nobody meant to send, and guessing which tag was intended
        // is how a parser produces a plausible object from nonsense.
        if (expected !== token.name) {
          parseError(`</${token.name}> closes ${expected === undefined ? "nothing" : expected}`);
        }

        endElement(handler, token.name);
        continue;
      }
      case "text":
        characters(handler, token.text);
        continue;
    }
  }

  if (open.length > 0) parseError(`<${open[open.length - 1] as string}> is never closed`);

  endDocument(handler);
}

// The five events, as named functions so a handler can be driven directly —
// which is what a test of one event does, and what a caller assembling a
// document from another source does.

export function startDocument(handler: XmlHandler): void {
  handler.onStartDocument?.();
}

export function endDocument(handler: XmlHandler): void {
  handler.onEndDocument?.();
}

export function startElement(
  handler: XmlHandler,
  name: string,
  attributes: Record<string, string> = {},
): void {
  handler.onStartElement?.(name, attributes);
}

export function endElement(handler: XmlHandler, name: string): void {
  handler.onEndElement?.(name);
}

export function characters(handler: XmlHandler, text: string): void {
  handler.onCharacters?.(text);
}

/** How a `type=` attribute is read back. Rails' `PARSING`. */
const PARSING: Readonly<Record<string, (text: string) => unknown>> = {
  integer: (text) => Number.parseInt(text.trim(), 10),
  float: (text) => Number.parseFloat(text.trim()),
  decimal: (text) => Number.parseFloat(text.trim()),
  // Exactly Rails' rule: only "1" and "true" are true. Anything else is false,
  // including "yes" — which looks true and is not, so a document using it is
  // wrong in a way worth being consistent about.
  boolean: (text) => ["1", "true"].includes(text.trim().toLowerCase()),
  string: (text) => text,
  symbol: (text) => text.trim(),
  date: (text) => new Date(`${text.trim()}T00:00:00Z`),
  datetime: (text) => new Date(text.trim()),
  dateTime: (text) => new Date(text.trim()),
  base64Binary: (text) => new Uint8Array(Buffer.from(text.trim(), "base64")),
};

/** How a value is written. Rails' `TYPE_NAMES` plus `FORMATTING`. */
function typeNameFor(value: unknown): string | undefined {
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "float";
  if (typeof value === "boolean") return "boolean";
  if (value instanceof Date) return "datetime";
  if (value instanceof Uint8Array) return "base64Binary";

  return undefined;
}

export interface FromXmlOptions {
  /** Whether a document type declaration may be processed. */
  trusted?: boolean;
}

/**
 * A document as a plain object. Rails' `Hash.from_xml`.
 *
 * Refuses a document type declaration. See the note at the top: this is XXE
 * and entity expansion, neither of which is visible in the document's
 * contents, so neither can be caught after parsing.
 */
export function fromXml(xml: string, options: FromXmlOptions = {}): Record<string, unknown> {
  if (options.trusted !== true && /<!DOCTYPE/i.test(xml)) {
    parseError(
      "a document type declaration is refused: it can read local files (XXE) or expand to " +
        "gigabytes. Use fromTrustedXml if you know where this document came from.",
    );
  }

  const builder = new HashBuilder();
  walkXml(xml, builder);

  return builder.result();
}

/**
 * The same, for a document whose origin is known. Rails' `Hash.from_trusted_xml`.
 *
 * A separate name rather than an option, because an option defaults and a name
 * has to be typed. Somebody typing this one has said where the document came
 * from; somebody passing `{ trusted: true }` from a config value has not.
 */
export function fromTrustedXml(xml: string): Record<string, unknown> {
  return fromXml(xml, { trusted: true });
}

/** Builds the object as the events arrive. */
class HashBuilder implements XmlHandler {
  #stack: {
    name: string;
    attributes: Record<string, string>;
    children: Record<string, unknown[]>;
    text: string;
  }[] = [];
  #root: Record<string, unknown> = {};

  onStartElement(name: string, attributes: Record<string, string>): void {
    this.#stack.push({ name, attributes, children: {}, text: "" });
  }

  onCharacters(text: string): void {
    const top = this.#stack[this.#stack.length - 1];

    if (top) top.text += text;
  }

  onEndElement(name: string): void {
    const finished = this.#stack.pop();

    if (!finished) parseError(`</${name}> closes nothing`);

    const value = valueOf(finished);
    const parent = this.#stack[this.#stack.length - 1];

    if (parent) {
      (parent.children[name] ??= []).push(value);

      return;
    }

    this.#root = { [name]: value };
  }

  result(): Record<string, unknown> {
    return this.#root;
  }
}

function valueOf(node: {
  attributes: Record<string, string>;
  children: Record<string, unknown[]>;
  text: string;
}): unknown {
  const names = Object.keys(node.children);

  if (names.length > 0) {
    const object: Record<string, unknown> = {};

    for (const name of names) {
      const held = node.children[name] as unknown[];

      // One child collapses to the value and several become an array, which is
      // XML's oldest ambiguity: a list of one looks like a single value. An
      // explicit `type="array"` settles it, and that is what `toXml` writes.
      object[name] = held.length === 1 && node.attributes["type"] !== "array" ? held[0] : held;
    }

    return object;
  }

  if (node.attributes["nil"] === "true") return null;

  const type = node.attributes["type"];

  if (type === "array") return [];
  if (type !== undefined && type in PARSING)
    return (PARSING[type] as (t: string) => unknown)(node.text);

  return node.text;
}

/** Escapes what may not appear in an element's text or an attribute's value. */
export function xmlNameEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * One element, with the `type` attribute that lets it be read back. Rails'
 * `to_tag`.
 */
export function toTag(name: string, value: unknown, indent = ""): string {
  const tag = xmlNameEscape(name);

  if (value === null || value === undefined) return `${indent}<${tag} nil="true"/>`;

  if (Array.isArray(value)) {
    // The array marker is what stops a list of one reading back as a single
    // value — which is the ambiguity that makes XML feeds annoying to consume.
    const items = value.map((each) => toTag("item", each, `${indent}  `)).join("\n");

    return value.length === 0
      ? `${indent}<${tag} type="array"/>`
      : `${indent}<${tag} type="array">\n${items}\n${indent}</${tag}>`;
  }

  if (value instanceof Date) {
    return `${indent}<${tag} type="datetime">${value.toISOString()}</${tag}>`;
  }

  if (value instanceof Uint8Array) {
    const encoded = Buffer.from(value).toString("base64");

    return `${indent}<${tag} type="base64Binary">${encoded}</${tag}>`;
  }

  if (typeof value === "object") {
    const inner = Object.entries(value as Record<string, unknown>)
      .map(([key, held]) => toTag(key, held, `${indent}  `))
      .join("\n");

    return inner === "" ? `${indent}<${tag}/>` : `${indent}<${tag}>\n${inner}\n${indent}</${tag}>`;
  }

  const type = typeNameFor(value);
  const attribute = type === undefined ? "" : ` type="${type}"`;

  return `${indent}<${tag}${attribute}>${xmlNameEscape(String(value))}</${tag}>`;
}

/** A whole document. */
export function toXmlDocument(value: Record<string, unknown>, root = "hash"): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${toTag(root, value)}`;
}

/**
 * Which parser is in use. Rails' `backend`, which chose between REXML, Nokogiri
 * and LibXML.
 *
 * Kept because an application that has to match another system's parsing
 * quirks needs somewhere to put a replacement, and because a bug report that
 * says which parser produced a result is worth more than one that does not.
 */
export interface XmlBackend {
  name: string;
  parse(xml: string, options: FromXmlOptions): Record<string, unknown>;
}

const DEFAULT_BACKEND: XmlBackend = { name: "altair", parse: fromXml };

let current: XmlBackend = DEFAULT_BACKEND;

/** The parser a `withBackend` block chose, which is not the process's. */
const scopedBackend = new AsyncLocalStorage<XmlBackend>();

export function backend(): XmlBackend {
  return scopedBackend.getStore() ?? current;
}

export function setBackend(replacement: XmlBackend): void {
  current = replacement;
}

/**
 * Runs something with a different parser, and puts the old one back.
 *
 * Restored in a `finally`, because the alternative is that one throwing test
 * leaves every later one on the wrong parser — and the failure appears in a
 * test that did nothing wrong.
 */
export function withBackend<T>(replacement: XmlBackend, body: () => T): T {
  return scopedBackend.run(replacement, body);
}

export function resetBackend(): void {
  current = DEFAULT_BACKEND;
}
