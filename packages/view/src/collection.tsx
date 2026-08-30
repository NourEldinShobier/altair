/**
 * Rendering one component per item, ported from
 * `ActionView::Helpers::RenderingHelper#render` with a collection and
 * `ActionView::PartialIteration`.
 *
 *     renderCollection(posts, PostRow, { spacer: <hr /> })
 *
 * A plain `items.map(...)` renders the list and gives the component nothing to
 * reason about. Three things it cannot express, and each is why this exists:
 *
 *   - **where in the list an item is** — needed to skip the separator after the
 *     last one, to stripe alternate rows, to number them
 *   - **how long the list is** — needed for "3 of 12", which cannot be known
 *     from inside a map
 *   - **what goes between** — a spacer belongs between items and not after the
 *     last, which is the off-by-one everybody writes at least once
 */

import { escapeHtml as escape, RawHtml, type Node } from "./render.js";

/**
 * Where an item sits in the collection. Rails' `PartialIteration`.
 *
 * Counted from zero, with `first` and `last` given as booleans rather than
 * left to the caller to derive. `index === size - 1` is correct and is also
 * the line that gets written as `index === size` once per codebase.
 */
export class PartialIteration {
  constructor(
    readonly index: number,
    readonly size: number,
  ) {}

  /** Rails' `first?`. */
  get first(): boolean {
    return this.index === 0;
  }

  /** Rails' `last?`. */
  get last(): boolean {
    return this.index === this.size - 1;
  }

  /** The one-based position, for anything a person reads. */
  get number(): number {
    return this.index + 1;
  }

  /** Alternating, for striping a table. Rails' `cycle` without the state. */
  get even(): boolean {
    return this.index % 2 === 1;
  }

  get odd(): boolean {
    return this.index % 2 === 0;
  }
}

/** What a collection component is given. */
export interface CollectionItemProps<T> {
  item: T;
  iteration: PartialIteration;
}

export interface RenderCollectionOptions {
  /** Rendered between items, never after the last. Rails' `spacer_template`. */
  spacer?: Node;
  /** Rendered instead when the collection is empty. */
  empty?: Node;
}

function valueOf(node: Node | undefined): string {
  if (node === undefined || node === null) return "";
  if (node instanceof RawHtml) return node.value;

  return escape(String(node));
}

/**
 * Renders a component per item. Rails' `render collection:`.
 *
 * The empty case is a separate option rather than something the caller checks,
 * because "no posts yet" is part of rendering a list and a template that
 * forgets it renders a blank area with no explanation — which reads as a bug
 * in the page rather than as an empty collection.
 */
export function renderCollection<T>(
  items: readonly T[],
  component: (props: CollectionItemProps<T>) => Node,
  options: RenderCollectionOptions = {},
): Node {
  if (items.length === 0) return options.empty ?? new RawHtml("");

  const spacer = valueOf(options.spacer);

  const rendered = items.map((item, index) =>
    valueOf(component({ item, iteration: new PartialIteration(index, items.length) })),
  );

  // Joined rather than appended per item: a spacer appended in the loop leaves
  // one after the last, which is the off-by-one this helper exists to remove.
  return new RawHtml(rendered.join(spacer));
}

/**
 * Renders one item with a component. Rails' `render partial:`.
 *
 * Here so a single render and a collection render read the same way, and so
 * the component sees the same iteration shape either way — a component written
 * for a collection does not break when somebody renders one of them.
 */
export function renderPartial<T>(
  item: T,
  component: (props: CollectionItemProps<T>) => Node,
): Node {
  return component({ item, iteration: new PartialIteration(0, 1) });
}

/**
 * Renders a collection, giving each item's cache key to a fragment cache.
 * Rails' cached collection rendering.
 *
 * The reason Rails does this in one pass: rendering fifty rows with a cache
 * around each is fifty cache reads. Reading them together turns that into one,
 * and the rows that missed are the only ones rendered. `read` is handed every
 * key at once for exactly that.
 */
export async function renderCachedCollection<T>(
  items: readonly T[],
  component: (props: CollectionItemProps<T>) => Node,
  cache: {
    read: (keys: string[]) => Promise<Map<string, string>>;
    write: (entries: Map<string, string>) => Promise<void>;
  },
  keyFor: (item: T) => string,
  options: RenderCollectionOptions = {},
): Promise<Node> {
  if (items.length === 0) return options.empty ?? new RawHtml("");

  const keys = items.map((item) => keyFor(item));
  const hits = await cache.read(keys);
  const misses = new Map<string, string>();

  const rendered = items.map((item, index) => {
    const key = keys[index] as string;
    const hit = hits.get(key);

    if (hit !== undefined) return hit;

    const html = valueOf(component({ item, iteration: new PartialIteration(index, items.length) }));

    misses.set(key, html);

    return html;
  });

  if (misses.size > 0) await cache.write(misses);

  return new RawHtml(rendered.join(valueOf(options.spacer)));
}

/** How many were rendered, for a caller reporting on a page. */
export function collectionCounter<T>(items: readonly T[]): number {
  return items.length;
}
