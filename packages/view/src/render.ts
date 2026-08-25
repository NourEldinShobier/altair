/**
 * Server-side rendering, replacing ActionView.
 *
 * ActionView is 21,159 lines, and 13,926 of them are helpers — `form_with`,
 * `link_to`, `content_tag`, `number_to_currency`. They exist because ERB cannot
 * compose. TSX composes, so that entire subsystem does not shrink here, it
 * disappears: a layout is a component, a partial is a component, and a helper
 * is a function that returns one.
 *
 * Elements render straight to a string. There is no virtual DOM, no diffing and
 * no hydration payload, which is what makes this the fast path for pages that
 * ship no client framework.
 */

import { isExecutableUrl } from "@altair/support";
export type Attributes = Record<string, unknown>;

export interface Element {
  type: string | Component;
  props: Attributes;
}

export type Component = (props: Attributes) => Node | Promise<Node>;

export type Node =
  | Element
  | RawHtml
  | string
  | number
  | bigint
  | boolean
  | null
  | undefined
  | Node[];

/** Marks a string as already-safe HTML, so it is written out untouched. */
export class RawHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

/**
 * Marks trusted HTML as safe.
 *
 * The name is deliberately blunt. Everything else is escaped, and this is the
 * only way past that, so it should be obvious in review.
 */
export function raw(value: string): RawHtml {
  return new RawHtml(value);
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escapes text for HTML. Rails' `h`, applied automatically. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ESCAPES[character]!);
}

/** Elements that never have a closing tag. */
const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/**
 * Attributes whose presence alone is the value.
 *
 * `<input disabled={false}>` must omit the attribute rather than write
 * `disabled="false"`, which browsers read as true.
 */
const BOOLEAN_ATTRIBUTES = new Set([
  "allowfullscreen",
  "async",
  "autofocus",
  "autoplay",
  "checked",
  "controls",
  "default",
  "defer",
  "disabled",
  "formnovalidate",
  "hidden",
  "inert",
  "ismap",
  "itemscope",
  "loop",
  "multiple",
  "muted",
  "nomodule",
  "novalidate",
  "open",
  "playsinline",
  "readonly",
  "required",
  "reversed",
  "selected",
]);

/** React spellings people type out of habit, mapped to real HTML attributes. */
const ATTRIBUTE_ALIASES: Record<string, string> = {
  className: "class",
  htmlFor: "for",
  httpEquiv: "http-equiv",
  acceptCharset: "accept-charset",
};

function isElement(node: unknown): node is Element {
  return typeof node === "object" && node !== null && "type" in node && "props" in node;
}

function renderStyle(style: Record<string, unknown>): string {
  return Object.entries(style)
    .filter(([, value]) => value !== null && value !== undefined && value !== false)
    .map(([property, value]) => {
      const name = property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
      return `${name}:${String(value)}`;
    })
    .join(";");
}

/** Raised when a name or a URL would change the markup around it. */
export class UnsafeMarkup extends Error {
  constructor(what: string, value: string, reason: string) {
    super(`Refusing to render ${what} ${JSON.stringify(value)}: ${reason}.`);
    this.name = "UnsafeMarkup";
  }
}

/**
 * An HTML attribute name: anything but the characters that end one.
 *
 * The value is escaped and the name was not, so a name carrying a quote
 * closed the attribute and started another:
 *
 *     <div {...{ 'x" onmouseover="alert(1)': "y" }} />
 *     -> <p x" onmouseover="alert(1)="y">
 *
 * Which a browser reads as a live handler. Spreading props built from data —
 * a CMS payload, a form schema — is the ordinary way that gets reached.
 */
const ATTRIBUTE_NAME = /^[^\s"'>/=]+$/;

/** A tag name, per the HTML parser: a letter then letters and digits. */
const TAG_NAME = /^[a-zA-Z][a-zA-Z0-9-]*$/;

/** Attributes a browser follows, and so may not carry a scheme that runs. */
const URL_ATTRIBUTES = new Set([
  "href",
  "src",
  "action",
  "formaction",
  "poster",
  "cite",
  "data",
  "srcdoc",
]);

function renderAttributes(props: Attributes): string {
  const parts: string[] = [];

  for (const [rawName, value] of Object.entries(props)) {
    if (rawName === "children" || rawName === "key" || rawName === "dangerouslySetInnerHTML") {
      continue;
    }
    if (value === null || value === undefined || value === false) continue;

    const name = ATTRIBUTE_ALIASES[rawName] ?? rawName;

    if (!ATTRIBUTE_NAME.test(name)) {
      throw new UnsafeMarkup(
        "an attribute named",
        name,
        "an attribute name cannot contain whitespace, a quote, a slash, an equals sign or a closing bracket",
      );
    }

    // An event handler cannot cross to the server; silently dropping it is
    // better than writing `onclick="function () {...}"` into the page.
    if (typeof value === "function") continue;

    if (BOOLEAN_ATTRIBUTES.has(name)) {
      if (value !== false) parts.push(name);
      continue;
    }

    if (name === "style" && typeof value === "object") {
      parts.push(`style="${escapeHtml(renderStyle(value as Record<string, unknown>))}"`);
      continue;
    }

    if (value === true) {
      parts.push(name);
      continue;
    }

    // The value is escaped, which stops it ending the attribute — and does
    // nothing about a scheme, because `javascript:alert(1)` needs no special
    // characters at all.
    if (URL_ATTRIBUTES.has(name.toLowerCase()) && isExecutableUrl(String(value))) {
      throw new UnsafeMarkup(
        `a ${name}`,
        String(value),
        "it names a scheme that runs code rather than fetching something",
      );
    }

    parts.push(`${name}="${escapeHtml(String(value))}"`);
  }

  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

/**
 * Renders a node to HTML.
 *
 * Components may be async, so a page can await its data inline rather than
 * threading every query through the controller.
 */
export async function renderToString(node: Node): Promise<string> {
  if (node === null || node === undefined || node === false || node === true) return "";
  if (node instanceof RawHtml) return node.value;

  if (Array.isArray(node)) {
    const parts = await Promise.all(node.map((child) => renderToString(child)));
    return parts.join("");
  }

  if (typeof node === "string") return escapeHtml(node);
  if (typeof node === "number" || typeof node === "bigint") return String(node);

  if (!isElement(node)) return escapeHtml(String(node));

  const { type, props } = node;

  if (typeof type === "function") {
    return await renderToString(await type(props));
  }

  // The Fragment marker renders its children with no wrapper.
  if (type === "") return await renderToString(props.children as Node);

  if (!TAG_NAME.test(type)) {
    throw new UnsafeMarkup(
      "a tag named",
      type,
      "a tag name is a letter followed by letters, digits or dashes",
    );
  }

  const attributes = renderAttributes(props);

  if (VOID_ELEMENTS.has(type)) return `<${type}${attributes}>`;

  const inner = props.dangerouslySetInnerHTML as { __html?: string } | undefined;
  if (inner?.__html !== undefined) {
    return `<${type}${attributes}>${inner.__html}</${type}>`;
  }

  const children = await renderToString(props.children as Node);
  return `<${type}${attributes}>${children}</${type}>`;
}

/** Renders a full document, prefixed with a doctype. */
export async function renderDocument(node: Node): Promise<string> {
  return `<!DOCTYPE html>${await renderToString(node)}`;
}
