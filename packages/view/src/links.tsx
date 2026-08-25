/**
 * Links and buttons, ported from ActionView's `link_to` and `button_to`.
 *
 *     <Link to="/posts">All posts</Link>
 *     <ButtonTo to={`/posts/${post.id}`} method="delete">Delete</ButtonTo>
 *
 * `Link` is thin on purpose: in TSX an anchor is already an anchor, and a
 * helper that only rearranged its arguments would be a second way to write one.
 * What it adds is the `target`/`rel` pairing, which is easy to forget and has
 * a consequence.
 *
 * `ButtonTo` is the one that carries weight. A destructive action reached by a
 * link is a destructive action a crawler will follow, a prefetcher will warm,
 * and a browser will replay on back — GET is defined as safe, and the whole
 * web assumes it. Rails' `button_to` exists because `link_to method: :delete`
 * relied on JavaScript to rewrite the request, and anything that intercepts a
 * click can be missed. This posts a real form.
 */

import { useCsrfToken } from "./context.js";
import type { Node } from "./render.js";

export type Method = "get" | "post" | "patch" | "put" | "delete";

export interface LinkProps {
  to: string;
  children?: Node;
  /** Opens elsewhere, and closes the opener — see below. */
  target?: string;
  rel?: string;
  class?: string;
  [key: string]: unknown;
}

/**
 * An anchor.
 *
 * A page opened with `target` can reach back through `window.opener` and
 * navigate the page that opened it, so `noopener` goes on unless something
 * else was asked for. `noreferrer` comes with it: the referrer would name the
 * page somebody was on, which is not the new tab's business.
 */
export function Link({ to, children, target, rel, ...rest }: LinkProps): Node {
  const safety = target && !rel ? "noopener noreferrer" : rel;

  return (
    <a href={to} target={target} rel={safety} {...rest}>
      {children}
    </a>
  );
}

export interface ButtonToProps {
  to: string;
  method?: Method;
  children?: Node;
  /** Extra fields to post alongside. */
  params?: Record<string, string | number | boolean>;
  class?: string;
  form?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * A button that posts.
 *
 * Always a form and always a POST on the wire: a browser sends only GET and
 * POST from a form, so anything else travels as `_method`, which is the
 * convention the router already reads. The CSRF token is included without
 * being asked for — a form that posts without one is a form that fails, and
 * remembering it at each call site is how one gets forgotten.
 */
export function ButtonTo({
  to,
  method = "post",
  children,
  params,
  form,
  ...rest
}: ButtonToProps): Node {
  const token = useCsrfToken();
  const overridden = method !== "get" && method !== "post";

  return (
    <form action={to} method={method === "get" ? "get" : "post"} {...form}>
      {overridden ? <input type="hidden" name="_method" value={method} /> : null}

      {/* Not sent on a GET: the token would land in the query string, and from
          there into the browser history, the server log and any referrer. */}
      {token && method !== "get" ? (
        <input type="hidden" name="authenticity_token" value={token} />
      ) : null}

      {Object.entries(params ?? {}).map(([name, value]) => (
        <input type="hidden" name={name} value={String(value)} />
      ))}

      <button type="submit" {...rest}>
        {children}
      </button>
    </form>
  );
}
