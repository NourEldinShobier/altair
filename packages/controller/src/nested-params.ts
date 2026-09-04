/**
 * Bracket notation in parameter names, ported from `Rack::Utils.parse_nested_query`.
 *
 *     post[title]=Hello&post[tags][]=a&post[tags][]=b
 *     → { post: { title: "Hello", tags: ["a", "b"] } }
 *
 * This is the shape every HTML form Rails generates posts in — `form_with
 * model: @post` names its fields `post[title]`, and the whole
 * `params.require("post").permit("title")` idiom depends on that arriving as
 * a nested object rather than a key with brackets in its name.
 *
 * It matters on the query string too, and for a reason easy to miss:
 * `Object.fromEntries(searchParams)` keeps only the last of a repeated key, so
 * `tags[]=a&tags[]=b` silently becomes one tag.
 */

/** How deep a name may nest before it is refused. */
const DEPTH_LIMIT = 32;

/**
 * Names that would reach the prototype chain rather than the object.
 *
 * A query string is attacker-controlled, so `?__proto__[admin]=1` is a request
 * anybody can make. Dropping the whole parameter is the safe answer: writing
 * it under a mangled name would leave something that looks permitted.
 */
const UNSAFE = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Splits `post[tags][]` into `["post", "tags", ""]`.
 *
 * A name whose brackets do not close, or that has anything outside them,
 * comes back as itself — Rack treats a malformed name as a literal key rather
 * than guessing, and guessing is how `a[b` becomes a parameter nobody meant.
 */
export function keyPath(key: string): string[] {
  const open = key.indexOf("[");
  if (open === -1) return [key];

  const path = [key.slice(0, open)];
  const rest = key.slice(open);
  const segment = /\[([^[\]]*)\]/g;

  let consumed = 0;
  let match: RegExpExecArray | null;

  while ((match = segment.exec(rest)) !== null) {
    if (match.index !== consumed) return [key];
    consumed = segment.lastIndex;
    path.push(match[1] ?? "");
  }

  return consumed === rest.length ? path : [key];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads `key=value` pairs into a nested object.
 *
 * Repeated scalar names keep the last value, which is what Rack does and what
 * a browser posting two fields of the same name means in practice.
 */
export function parseNestedParams(entries: Iterable<[string, unknown]>): Record<string, unknown> {
  const root: Record<string, unknown> = {};

  for (const [key, value] of entries) {
    const path = keyPath(key);

    if (path.length > DEPTH_LIMIT) continue;
    if (path.some((segment) => UNSAFE.has(segment))) continue;

    // An empty segment means "append", and only the last one can: `a[][b]` is
    // an array of objects, which no form Rails generates produces — it emits
    // `a[0][b]`, which is an ordinary key. Treating the name as literal keeps
    // the value reachable instead of quietly reshaping it.
    if (path.slice(0, -1).includes("")) {
      root[key] = value;
      continue;
    }

    // A trailing `[]` means the value appends to an array held one level up,
    // so the walk stops short of it — walking the whole path would replace the
    // array with an object right before pushing into it.
    const appending = path.at(-1) === "";
    const walk = appending ? path.slice(0, -2) : path.slice(0, -1);
    const last = (appending ? path.at(-2) : path.at(-1)) as string;

    let node = root;

    for (const segment of walk) {
      if (!isPlainObject(node[segment])) node[segment] = {};

      node = node[segment] as Record<string, unknown>;
    }

    if (!appending) {
      node[last] = value;
      continue;
    }

    const held = node[last];

    if (Array.isArray(held)) held.push(value);
    else node[last] = [value];
  }

  return root;
}
