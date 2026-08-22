/**
 * Controllers, ported from `AbstractController` and `ActionController::Metal`.
 *
 * The filter chain is Rails' — before, around and after filters over the
 * action, with `only`/`except`, halting and inheritance. Rails halts by
 * noticing that a filter already produced a response:
 *
 *     terminator: ->(controller, result_lambda) { result_lambda.call; controller.performed? }
 *
 * which is exactly what the callback chain's custom terminator expresses, so the
 * behaviour comes across rather than being re-implemented.
 *
 * Requests and responses are the Web classes Bun serves natively; there is no
 * Rack equivalent to port.
 */

import {
  Callbacks,
  type Filter,
  type SetCallbackOptions,
  callbackDecorators,
  setCallback,
  skipCallback,
} from "@altair/support";
import { Parameters } from "./parameters.js";
import { CookieJar } from "./cookies.js";
import { Flash, Session, type SessionOptions } from "./session.js";
import { InvalidAuthenticityToken, isVerifiedRequest, maskedToken } from "./csrf.js";
import type { Secrets } from "@altair/support";
import { renderDocument, renderInertia, type InertiaOptions, type Node } from "@altair/view";

export type ActionName = string;

export interface ControllerContext {
  request: Request;
  params?: Record<string, unknown>;
  /** Route params from recognition, merged over query and body. */
  routeParams?: Record<string, string>;
  /** Needed for signed and encrypted cookies, and so for sessions. */
  secrets?: Secrets;
  session?: SessionOptions;
}

/** Filters accept Rails' `only:`/`except:` alongside the usual conditions. */
export interface FilterOptions<T> extends SetCallbackOptions<T> {
  only?: ActionName | ActionName[];
  except?: ActionName | ActionName[];
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Translates `only:`/`except:` into ordinary chain conditions.
 *
 * Rails implements them the same way — they are sugar over a conditional, not a
 * separate mechanism — so the chain needs no knowledge of them.
 */
function filterConditions<T extends Controller>(options: FilterOptions<T>): SetCallbackOptions<T> {
  const only = toArray(options.only);
  const except = toArray(options.except);

  const conditions: SetCallbackOptions<T> = { ...options };
  delete (conditions as FilterOptions<T>).only;
  delete (conditions as FilterOptions<T>).except;

  const extraIf = only.length > 0 ? [(c: T) => only.includes(c.actionName)] : [];
  const extraUnless = except.length > 0 ? [(c: T) => except.includes(c.actionName)] : [];

  if (extraIf.length > 0) {
    conditions.if = [...toArray(conditions.if), ...extraIf] as SetCallbackOptions<T>["if"];
  }
  if (extraUnless.length > 0) {
    conditions.unless = [
      ...toArray(conditions.unless),
      ...extraUnless,
    ] as SetCallbackOptions<T>["unless"];
  }
  return conditions;
}

export class Controller extends Callbacks {
  static {
    this.defineCallbacks<Controller>("action", {
      // Rails' filter terminator: run the filter, then halt if it responded.
      terminator: async (controller, run) => {
        await run();
        return controller.performed();
      },
    });
  }

  readonly request: Request;
  readonly params: Parameters;
  readonly url: URL;
  readonly cookies: CookieJar;

  /** The action currently being processed. `only:` and `except:` read this. */
  actionName: ActionName = "";

  #response: Response | undefined;

  constructor(context: ControllerContext) {
    super();
    this.request = context.request;
    this.url = new URL(context.request.url);

    const query = Object.fromEntries(this.url.searchParams.entries());
    this.params = Parameters.from(query, context.params, context.routeParams);

    this.cookies = new CookieJar(context.request, context.secrets);
    this.#sessionOptions = context.session ?? {};
  }

  #sessionOptions: SessionOptions;
  #session: Session | undefined;
  #flash: Flash | undefined;

  /** The session, decrypted from its cookie on first use. */
  get session(): Session {
    this.#session ??= new Session(this.cookies, this.#sessionOptions);
    return this.#session;
  }

  /** Messages that survive one redirect. Rails' `flash`. */
  get flash(): Flash {
    this.#flash ??= new Flash(this.session);
    return this.#flash;
  }

  /** A fresh masked CSRF token to embed in a form. */
  get authenticityToken(): string {
    return maskedToken(this.session);
  }

  /**
   * Rails' `protect_from_forgery`, as a filter.
   *
   *     class ApplicationController extends Controller {
   *       @beforeAction
   *       verifyAuthenticity() { this.verifyAuthenticityToken() }
   *     }
   */
  verifyAuthenticityToken(): void {
    if (isVerifiedRequest(this.request, this.params, this.session)) return;
    throw new InvalidAuthenticityToken();
  }

  /** Rails' `performed?`: whether a response has already been produced. */
  performed(): boolean {
    return this.#response !== undefined;
  }

  get response(): Response | undefined {
    return this.#response;
  }

  /**
   * Runs an action through the filter chain and returns its response.
   *
   * A filter that renders or redirects stops the chain and the action never
   * runs, which is how Rails' authentication filters work.
   */
  async processAction(name: ActionName): Promise<Response> {
    this.actionName = name;

    const action = (this as unknown as Record<string, unknown>)[name];
    if (typeof action !== "function") {
      throw new Error(`The action "${name}" could not be found for ${this.constructor.name}`);
    }

    await this.runCallbacks("action", async () => {
      await (action as () => unknown | Promise<unknown>).call(this);
    });

    // Flash is swept and the session written back before the response leaves,
    // so a redirect carries what the action set.
    this.#flash?.commit();
    this.#session?.commit();

    const response = this.#response ?? new Response(null, { status: 204 });
    return this.cookies.applyTo(response);
  }

  #setResponse(response: Response): Response {
    if (this.#response) {
      throw new Error(
        `Render and/or redirect were called multiple times in this action (${this.constructor.name}#${this.actionName})`,
      );
    }
    this.#response = response;
    return response;
  }

  /** Responses. Rails spells these `render json:`, `render plain:`, `render html:`. */
  readonly render = {
    json: (body: unknown, init: ResponseInit = {}): Response =>
      this.#setResponse(Response.json(body, { status: 200, ...init })),

    text: (body: string, init: ResponseInit = {}): Response =>
      this.#setResponse(
        new Response(body, {
          status: 200,
          ...init,
          headers: { "content-type": "text/plain; charset=utf-8", ...init.headers },
        }),
      ),

    html: (body: string, init: ResponseInit = {}): Response =>
      this.#setResponse(
        new Response(body, {
          status: 200,
          ...init,
          headers: { "content-type": "text/html; charset=utf-8", ...init.headers },
        }),
      ),

    /**
     * Renders TSX to a full HTML document. The hypermedia path: no client
     * framework, no hydration payload.
     */
    view: async (node: Node, init: ResponseInit = {}): Promise<Response> =>
      this.#setResponse(
        new Response(await renderDocument(node), {
          status: 200,
          ...init,
          headers: { "content-type": "text/html; charset=utf-8", ...init.headers },
        }),
      ),

    /**
     * Renders an Inertia page: typed props to the client framework, with the
     * first load served as HTML and later visits as JSON.
     */
    inertia: async (
      component: string,
      props: Record<string, unknown> = {},
      options: InertiaOptions = {},
    ): Promise<Response> =>
      this.#setResponse(await renderInertia(this.request, component, props, options)),
  };

  /** Rails' `redirect_to`. Defaults to 302, as Rails does. */
  redirectTo(location: string, init: { status?: number } = {}): Response {
    return this.#setResponse(
      new Response(null, {
        status: init.status ?? 302,
        headers: { location },
      }),
    );
  }

  /** Rails' `head`: a response with a status and no body. */
  head(status: number, headers: Record<string, string> = {}): Response {
    return this.#setResponse(new Response(null, { status, headers }));
  }

  /** Rails' `before_action`, in its explicit form. */
  static beforeAction<T extends Controller>(
    this: abstract new (context: ControllerContext) => T,
    filter: Filter<T>,
    options: FilterOptions<T> = {},
  ): void {
    setCallback(this, "action", "before", filter, filterConditions(options));
  }

  static aroundAction<T extends Controller>(
    this: abstract new (context: ControllerContext) => T,
    filter: Filter<T>,
    options: FilterOptions<T> = {},
  ): void {
    setCallback(this, "action", "around", filter, filterConditions(options));
  }

  static afterAction<T extends Controller>(
    this: abstract new (context: ControllerContext) => T,
    filter: Filter<T>,
    options: FilterOptions<T> = {},
  ): void {
    setCallback(this, "action", "after", filter, filterConditions(options));
  }

  /** Rails' `skip_before_action`. */
  static skipBeforeAction<T extends Controller>(
    this: abstract new (context: ControllerContext) => T,
    filter: Filter<T>,
    options: { raise?: boolean } = {},
  ): void {
    skipCallback(this, "action", "before", filter, options);
  }
}

const actionDecorators = callbackDecorators("action");

/**
 * `@beforeAction` — the decorator form.
 *
 *     class PostsController extends Controller {
 *       @beforeAction({ only: ["edit", "update"] })
 *       requireLogin() { if (!Current.user) this.redirectTo("/login") }
 *     }
 *
 * `only`/`except` name actions, so a typo names an action that never runs
 * rather than failing loudly — the same trade Rails makes.
 */
export function beforeAction<T extends Controller>(
  options: FilterOptions<T>,
): ReturnType<typeof actionDecorators.before>;
export function beforeAction<T extends Controller>(
  value: unknown,
  context: ClassMethodDecoratorContext<T>,
): void;
export function beforeAction<T extends Controller>(
  valueOrOptions: unknown,
  context?: ClassMethodDecoratorContext<T>,
): unknown {
  if (context) return actionDecorators.before(valueOrOptions, context);
  return actionDecorators.before(filterConditions((valueOrOptions ?? {}) as FilterOptions<T>));
}

export function aroundAction<T extends Controller>(
  options: FilterOptions<T>,
): ReturnType<typeof actionDecorators.around>;
export function aroundAction<T extends Controller>(
  value: unknown,
  context: ClassMethodDecoratorContext<T>,
): void;
export function aroundAction<T extends Controller>(
  valueOrOptions: unknown,
  context?: ClassMethodDecoratorContext<T>,
): unknown {
  if (context) return actionDecorators.around(valueOrOptions, context);
  return actionDecorators.around(filterConditions((valueOrOptions ?? {}) as FilterOptions<T>));
}

export function afterAction<T extends Controller>(
  options: FilterOptions<T>,
): ReturnType<typeof actionDecorators.after>;
export function afterAction<T extends Controller>(
  value: unknown,
  context: ClassMethodDecoratorContext<T>,
): void;
export function afterAction<T extends Controller>(
  valueOrOptions: unknown,
  context?: ClassMethodDecoratorContext<T>,
): unknown {
  if (context) return actionDecorators.after(valueOrOptions, context);
  return actionDecorators.after(filterConditions((valueOrOptions ?? {}) as FilterOptions<T>));
}
