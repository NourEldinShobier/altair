/**
 * The dispatcher, ported from `ActionDispatch::Routing::RouteSet`.
 *
 * Turns a recognized route into a controller instance, runs the action, and
 * returns its response. This is the piece that makes a route table answer an
 * HTTP request.
 *
 * The result is a plain `fetch` handler, which is what `Bun.serve` wants, so
 * there is no adapter between the framework and the runtime.
 */

import { parameterParserFor } from "./parameter_wrapping.js";
import { Current } from "@altair/support";
import type { Router } from "@altair/router";
import { Controller, type ControllerContext } from "./controller.js";
import { parseNestedParams } from "./nested_params.js";

export type ControllerClass = new (context: ControllerContext) => Controller;

/** Maps the controller name a route carries to the class that serves it. */
export type ControllerRegistry = Record<string, ControllerClass>;

export interface DispatcherOptions {
  router: Router;
  controllers: ControllerRegistry;
  /** Called when no route matches. Defaults to a bare 404. */
  notFound?: (request: Request) => Response | Promise<Response>;
  /** Called when an action throws. Defaults to rethrowing in development. */
  onError?: (error: unknown, request: Request) => Response | Promise<Response>;
  /**
   * Extra context every controller is built with.
   *
   * This is how the application's secrets reach controllers, and so how signed
   * cookies and sessions work without per-controller setup.
   */
  context?: (request: Request) => Partial<ControllerContext>;
}

/** Raised when a route names a controller that was never registered. */
export class MissingController extends Error {
  constructor(readonly controller: string) {
    super(
      `No controller registered for "${controller}". Add it to the controllers map passed to createDispatcher.`,
    );
    this.name = "MissingController";
  }
}

/**
 * Reads the request body into params.
 *
 * Rails' ParamsParser middleware does this for JSON and form encodings; the
 * same two cover almost every request. Anything else can register a parser
 * with `registerParameterParser`.
 */
export async function parseBody(request: Request): Promise<Record<string, unknown>> {
  if (request.method === "GET" || request.method === "HEAD") return {};

  const contentType = request.headers.get("content-type") ?? "";

  // A registered parser wins, so an application can teach the framework a body
  // format rather than reading it off the request in every action.
  const registered = parameterParserFor(contentType);

  if (registered) {
    try {
      return await registered(request.clone() as Request);
    } catch {
      return {};
    }
  }

  try {
    if (contentType.includes("application/json")) {
      const parsed: unknown = await request.clone().json();
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : { _json: parsed };
    }

    if (
      contentType.includes("application/x-www-form-urlencoded") ||
      contentType.includes("multipart/form-data")
    ) {
      // `post[title]` is the shape every form Rails generates posts in, and
      // what `params.require("post")` needs to find.
      return parseNestedParams((await request.clone().formData()).entries());
    }
  } catch {
    // A malformed body is not a crash; the action sees no params and can
    // decide what to do, which is what Rails does for unparseable input.
    return {};
  }

  return {};
}

/**
 * Builds a `fetch` handler from a route table and a controller registry.
 *
 *     Bun.serve({ fetch: createDispatcher({ router, controllers }) })
 */
export function createDispatcher(
  options: DispatcherOptions,
): (request: Request) => Promise<Response> {
  const { router, controllers, notFound, onError, context } = options;

  return async function dispatch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const recognized = router.recognize(request.method, url.pathname);

    if (!recognized) {
      return notFound ? await notFound(request) : new Response("Not Found", { status: 404 });
    }

    const ControllerClass = controllers[recognized.controller];
    if (!ControllerClass) throw new MissingController(recognized.controller);

    try {
      const controller = new ControllerClass({
        ...context?.(request),
        request,
        params: await parseBody(request),
        routeParams: recognized.params,
      });
      // Recorded on Current before the action runs, so everything downstream
      // can say which action it belongs to — the request log, the error
      // reporter, and the comment on every SQL statement. Cheap here and
      // impossible to reconstruct later.
      if (Current.isActive) {
        Current.set({ controller: recognized.controller, action: recognized.action });
      }

      return await controller.processAction(recognized.action);
    } catch (error) {
      if (onError) return await onError(error, request);
      throw error;
    }
  };
}
