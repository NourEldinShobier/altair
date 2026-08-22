/**
 * The Inertia protocol.
 *
 * Inertia replaces only the view layer: routing, controllers, middleware, auth
 * and validation stay exactly where Rails puts them, and the controller returns
 * a page name plus props instead of HTML. The client framework renders those
 * props.
 *
 * Adopting the protocol rather than designing a renderer abstraction is what
 * lets React, Vue, Svelte and Solid all work here without a line of
 * framework-specific code — the protocol is renderer-agnostic by construction.
 *
 * https://inertiajs.com/the-protocol
 */

import { type Node, renderDocument } from "./render.js";

/** The version of the protocol this implements. */
export const INERTIA_VERSION_HEADER = "x-inertia-version";
export const INERTIA_HEADER = "x-inertia";
export const PARTIAL_DATA_HEADER = "x-inertia-partial-data";
export const PARTIAL_COMPONENT_HEADER = "x-inertia-partial-component";
export const LOCATION_HEADER = "x-inertia-location";

export type PropValue = unknown;

/**
 * A prop that is only computed when the client asks for it.
 *
 * Rails has no equivalent; it exists because a partial reload should not pay
 * for data it is not going to use.
 */
export class LazyProp {
  constructor(readonly resolve: () => PropValue | Promise<PropValue>) {}
}

/** Wraps a value so it is skipped unless explicitly requested. */
export function lazy(resolve: () => PropValue | Promise<PropValue>): LazyProp {
  return new LazyProp(resolve);
}

export interface PageObject {
  component: string;
  props: Record<string, PropValue>;
  url: string;
  version: string | null;
}

export interface InertiaOptions {
  /** Props shared with every page, such as the current user and flash. */
  shared?: Record<string, PropValue>;
  /** The asset version. A mismatch triggers a full reload on the client. */
  version?: string | null;
  /** Renders the first, non-Inertia response. Receives the page object. */
  rootLayout?: (page: PageObject) => Node | Promise<Node>;
}

/** Whether this request is an Inertia visit rather than a first page load. */
export function isInertiaRequest(request: Request): boolean {
  return request.headers.get(INERTIA_HEADER) === "true";
}

/**
 * Resolves props for a request.
 *
 * A partial reload asks for a subset by name; anything lazy is skipped unless
 * named, and everything else is awaited.
 */
export async function resolveProps(
  request: Request,
  component: string,
  props: Record<string, PropValue>,
): Promise<Record<string, PropValue>> {
  const partialFor = request.headers.get(PARTIAL_COMPONENT_HEADER);
  const only = request.headers.get(PARTIAL_DATA_HEADER);

  const requested =
    partialFor === component && only
      ? new Set(
          only
            .split(",")
            .map((name) => name.trim())
            .filter(Boolean),
        )
      : null;

  const resolved: Record<string, PropValue> = {};

  for (const [name, value] of Object.entries(props)) {
    if (requested && !requested.has(name)) continue;
    if (value instanceof LazyProp) {
      // Lazy props are only computed when the client names them.
      if (!requested) continue;
      resolved[name] = await value.resolve();
      continue;
    }
    resolved[name] = await value;
  }

  return resolved;
}

/**
 * Builds the response for an Inertia page.
 *
 * A visit gets the page object as JSON; a first load gets the root layout with
 * the page object embedded, which is what the client boots from.
 */
export async function renderInertia(
  request: Request,
  component: string,
  props: Record<string, PropValue> = {},
  options: InertiaOptions = {},
): Promise<Response> {
  const merged = { ...options.shared, ...props };
  const resolved = await resolveProps(request, component, merged);

  const page: PageObject = {
    component,
    props: resolved,
    url: new URL(request.url).pathname + new URL(request.url).search,
    version: options.version ?? null,
  };

  if (isInertiaRequest(request)) {
    return Response.json(page, {
      headers: { [INERTIA_HEADER]: "true", vary: INERTIA_HEADER },
    });
  }

  const layout = options.rootLayout ?? defaultRootLayout;
  const html = await renderDocument(await layout(page));

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", vary: INERTIA_HEADER },
  });
}

/**
 * An Inertia redirect.
 *
 * A visit is an XHR, so a plain 302 after PUT/PATCH/DELETE would be re-issued
 * with the same method. The protocol requires 303 for those.
 */
export function inertiaRedirect(request: Request, location: string): Response {
  const method = request.method.toUpperCase();
  const status = method === "PUT" || method === "PATCH" || method === "DELETE" ? 303 : 302;
  return new Response(null, { status, headers: { location } });
}

/**
 * Sends the client to an external URL.
 *
 * A visit cannot follow a cross-origin redirect, so the protocol uses a 409
 * carrying the destination instead.
 */
export function inertiaLocation(url: string): Response {
  return new Response(null, { status: 409, headers: { [LOCATION_HEADER]: url } });
}

/** The minimal root layout: a mount point and the encoded page object. */
function defaultRootLayout(page: PageObject): Node {
  return {
    type: "html",
    props: {
      lang: "en",
      children: [
        {
          type: "head",
          props: {
            children: [
              { type: "meta", props: { charset: "utf-8" } },
              {
                type: "meta",
                props: { name: "viewport", content: "width=device-width, initial-scale=1" },
              },
            ],
          },
        },
        {
          type: "body",
          props: {
            children: {
              type: "div",
              props: { id: "app", "data-page": JSON.stringify(page) },
            },
          },
        },
      ],
    },
  };
}
