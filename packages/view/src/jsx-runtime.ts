/**
 * The JSX runtime.
 *
 * TSX compiles to calls into this module, so a component is a plain function
 * returning a node and there is no framework in between. Point tsconfig at it
 * with `"jsxImportSource": "@altair/view"`.
 */

import type { Attributes, Element, Node } from "./render.js";

export type { Attributes, Element, Node } from "./render.js";

/** The empty type marks a fragment, which renders its children bare. */
export const Fragment = "" as const;

export function jsx(type: Element["type"], props: Attributes): Element {
  return { type, props };
}

/** Called instead of `jsx` when an element has several children. */
export const jsxs = jsx;

/** Development builds call this; the shape is the same. */
export function jsxDEV(type: Element["type"], props: Attributes): Element {
  return { type, props };
}

/**
 * The JSX namespace the compiler looks for.
 *
 * `Element` is our own node type, not the DOM's — these components render to a
 * string on the server and never touch a document.
 */
export namespace JSX {
  export type ElementType = string | ((props: never) => Node | Promise<Node>);
  export type Element = import("./render.js").Element;
  export interface IntrinsicElements {
    [name: string]: Attributes;
  }
  export interface ElementChildrenAttribute {
    children: unknown;
  }
}
