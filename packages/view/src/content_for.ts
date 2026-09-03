/**
 * Passing content from a page to its layout, ported from ActionView's
 * `content_for` and `yield`.
 *
 *     // in the page
 *     provide("title", "All posts")
 *
 *     // in the layout
 *     <title>{yieldContent("title") ?? "Altair"}</title>
 *
 * The problem it solves is ordering. A layout wraps a page, so it renders
 * first and the page's title does not exist yet — passing it down as a prop
 * means every page and every layout between them has to declare it, which is
 * how a layout ends up with fifteen optional props it does not use.
 *
 * A store scoped to the render solves it, and the scope is the important part:
 * two requests rendering at once must not see each other's title, and a
 * process serving a hundred pages a second is doing exactly that.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { RawHtml, renderToString, type Node } from "./render.js";

const store = new AsyncLocalStorage<Map<string, Node[]>>();

/** Runs a render with a store in scope. The renderer does this per page. */
export async function withContentStore<T>(body: () => Promise<T>): Promise<T> {
  if (store.getStore()) return await body();
  return await store.run(new Map(), body);
}

/**
 * Sets content for the layout to pick up, or reads what was set. Rails'
 * `content_for`.
 *
 * Appends rather than replaces, so a page and a partial inside it can both add
 * to the same slot — which is what `content_for :head` is for. `provide`
 * beside it is the replacing form, and the two are named the way Rails names
 * them: they used to be the other way round here, so a reader who knew Rails
 * got appending from `provide` and had no way to ask for it by its own name.
 *
 * Reads with one argument, as Rails does, which is what makes it usable in the
 * middle of a template:
 *
 *     {contentFor("title") ?? "Untitled"}
 */
export function contentFor(name: string): Node | undefined;
export function contentFor(name: string, content: Node): void;
export function contentFor(name: string, content?: Node): Node | undefined | void {
  if (content === undefined) return yieldContent(name);

  const held = store.getStore();

  // Outside a render there is nowhere to put it. Silent rather than throwing:
  // a component used in a test without a layout is not a bug.
  if (!held) return;

  const existing = held.get(name);
  if (existing) existing.push(content);
  else held.set(name, [content]);
}

/**
 * Replaces whatever was there. Rails' `provide`.
 *
 * For the case where appending is wrong — a title, where two of them is not a
 * longer title but a broken one.
 */
export function provide(name: string, content: Node): void {
  store.getStore()?.set(name, [content]);
}

/** What a page provided, or undefined. Rails' `yield :name`. */
export function yieldContent(name: string): Node | undefined {
  const held = store.getStore()?.get(name);
  if (!held || held.length === 0) return undefined;

  return held.length === 1 ? held[0] : held;
}

/** Whether anything was provided. Rails' `content_for?`. */
export function hasContentFor(name: string): boolean {
  return yieldContent(name) !== undefined;
}

/**
 * Renders a page inside a layout, page first.
 *
 * The order is the whole reason this function exists rather than
 * `<Layout><Page /></Layout>`. A layout wraps a page, so in JSX it runs first —
 * and `yieldContent` in the layout would then read a store the page has not
 * filled in yet, and quietly return nothing. Rendering the page to a string
 * first is how Rails does it, and is what makes `provide` mean anything.
 *
 *     await renderWithLayout(<Show post={post} />, ApplicationLayout)
 */
export async function renderWithLayout(
  page: Node,
  layout: (props: { children: Node }) => Node | Promise<Node>,
): Promise<string> {
  return await withContentStore(async () => {
    // The page goes first, filling the store as it renders.
    const inner = new RawHtml(await renderToString(page));

    return await renderToString(await layout({ children: inner }));
  });
}
