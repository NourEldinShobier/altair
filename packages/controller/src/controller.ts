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
import { parseNestedParams } from "./nested_params.js";
import { CookieJar } from "./cookies.js";
import { Flash, Session, type SessionOptions } from "./session.js";
import { InvalidAuthenticityToken, isVerifiedRequest, maskedToken } from "./csrf.js";
import { Current, type Secrets } from "@altair/support";
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

import {
  cacheControl,
  freshnessFor,
  notModified,
  type FreshnessOptions,
} from "./conditional_get.js";
import { negotiateFormat } from "./mime.js";
import {
  eventStreamResponse,
  streamResponse,
  type ServerSentEvent,
  type StreamOptions,
} from "./streaming.js";
import { clientIp, type ClientIpOptions } from "./client_ip.js";
import { sendData, sendFile, type SendOptions } from "./send.js";
import { decodeBasic, requestAuthentication, type Credentials } from "./basic_auth.js";

/** A copy of a response with extra headers. Response headers are immutable. */
function withHeaders(response: Response, extra: Record<string, string>): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** One `rescue_from` registration. */
export interface RescueHandler {
  kind: new (...args: never[]) => Error;
  handler: (this: Controller, error: Error) => unknown | Promise<unknown>;
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

    // Not `Object.fromEntries`: it keeps only the last of a repeated name, so
    // `?tags[]=a&tags[]=b` would silently arrive as one tag.
    const query = parseNestedParams(this.url.searchParams.entries());
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

  /**
   * Handlers for exceptions raised while processing an action. Rails'
   * `rescue_from`.
   */
  static rescueHandlers: RescueHandler[] = [];

  /**
   * Turns an exception into a response. Rails' `rescue_from`.
   *
   *     static {
   *       this.rescueFrom(RecordNotFound, function () { this.head(404) })
   *     }
   *
   * Declared on a base controller and inherited, which is the point: without
   * it every action needs its own try/catch, and the one that forgets returns
   * a stack trace to a stranger.
   *
   * Handlers are searched in reverse order of declaration, as Rails does, so a
   * subclass can narrow what its parent already handles.
   */
  static rescueFrom<E extends Error>(
    kind: new (...args: never[]) => E,
    handler: (this: Controller, error: E) => unknown | Promise<unknown>,
  ): void {
    // Copy on write, so a subclass adding a handler leaves its parent alone.
    if (!Object.hasOwn(this, "rescueHandlers")) this.rescueHandlers = [...this.rescueHandlers];

    this.rescueHandlers.push({ kind, handler: handler as RescueHandler["handler"] });
  }

  /** The handler for an error, or undefined. */
  static handlerFor(error: unknown): RescueHandler | undefined {
    // Reverse, so the most recently declared wins — the same rule Rails uses,
    // and the one that lets a subclass narrow its parent's handling.
    for (let index = this.rescueHandlers.length - 1; index >= 0; index -= 1) {
      const candidate = this.rescueHandlers[index];
      if (candidate && error instanceof candidate.kind) return candidate;
    }

    return undefined;
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
    this.publishToCurrent();

    const action = (this as unknown as Record<string, unknown>)[name];
    if (typeof action !== "function") {
      throw new Error(`The action "${name}" could not be found for ${this.constructor.name}`);
    }

    try {
      await this.runCallbacks("action", async () => {
        await (action as () => unknown | Promise<unknown>).call(this);
      });
    } catch (error) {
      // Filters are inside the try as well as the action: an authorisation
      // filter that raises is exactly the thing a handler is for.
      const rescued = (this.constructor as typeof Controller).handlerFor(error);
      if (!rescued) throw error;

      await rescued.handler.call(this, error as Error);
    }

    // Flash is swept and the session written back before the response leaves,
    // so a redirect carries what the action set.
    this.#flash?.commit();
    this.#session?.commit();

    const response = this.#response ?? new Response(null, { status: 204 });
    return this.cookies.applyTo(response);
  }

  /**
   * Puts what a view needs into the request scope.
   *
   * A CSRF token would otherwise have to be threaded through every layout and
   * partial between the page and the form that needs it, and so would the
   * flash. Both are true of the whole request, which is what the scope is for.
   */
  protected publishToCurrent(): void {
    if (!Current.isActive) return;

    // Lazily, as getters on the scope. A page with no form never needs a CSRF
    // token, and producing one builds the session, which needs secrets an
    // API-only application has no reason to configure. Computing both on
    // every action would make that a crash rather than an unused feature.
    const store = Current.attributes as Record<string, unknown>;

    Object.defineProperty(store, "csrfToken", {
      configurable: true,
      enumerable: true,
      get: () => {
        try {
          return this.authenticityToken;
        } catch {
          // A view asking for a token it cannot have renders without one,
          // rather than taking the page down.
          return undefined;
        }
      },
    });

    Object.defineProperty(store, "flash", {
      configurable: true,
      enumerable: true,
      get: () => this.flash.toObject(),
    });
  }

  /** Cache headers set before the body was rendered. */
  #pendingCacheHeaders: Record<string, string> | undefined;

  /** The format `respondTo` settled on. */
  #format: string | undefined;

  #setResponse(response: Response): Response {
    if (this.#response) {
      throw new Error(
        `Render and/or redirect were called multiple times in this action (${this.constructor.name}#${this.actionName})`,
      );
    }

    // Applied here rather than at each render: `freshWhen` runs before the
    // action decides what to render, and the validators it worked out have to
    // travel with whatever that turns out to be.
    this.#response = this.#pendingCacheHeaders
      ? withHeaders(response, this.#pendingCacheHeaders)
      : response;
    this.#pendingCacheHeaders = undefined;

    return this.#response;
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
     * A body produced as it is sent. For an export too large to hold.
     *
     *     await this.render.stream(rows(), { contentType: "text/csv" })
     *
     * The request's own abort signal is passed on by default, so a client that
     * closes the tab stops the work rather than leaving it running for nobody.
     */
    stream: (
      source: AsyncIterable<string | Uint8Array> | Iterable<string | Uint8Array>,
      options: StreamOptions = {},
    ): Response =>
      this.#setResponse(streamResponse(source, { signal: this.request.signal, ...options })),

    /**
     * Server-Sent Events. Rails' `ActionController::Live`, without the thread.
     *
     *     await this.render.events(updates())
     */
    events: (
      source: AsyncIterable<ServerSentEvent>,
      options: Omit<StreamOptions, "contentType"> = {},
    ): Response =>
      this.#setResponse(eventStreamResponse(source, { signal: this.request.signal, ...options })),

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

  /**
   * The format this request is being answered in, once one has been chosen.
   *
   * Rails' `request.format`. Undefined until `respondTo` has run, since before
   * that nothing has decided.
   */
  get format(): string | undefined {
    return this.#format;
  }

  /**
   * One action, several representations. Rails' `respond_to`.
   *
   *     await this.respondTo({
   *       html: () => this.render.html(<Show post={post} />),
   *       json: () => this.render.json(post),
   *     })
   *
   * The keys are declared in preference order, so the first is what a client
   * with no opinion gets. Nothing acceptable answers 406 rather than guessing:
   * sending HTML to something that asked for JSON is a failure that surfaces
   * far from here.
   */
  async respondTo(handlers: Record<string, () => unknown | Promise<unknown>>): Promise<void> {
    const available = Object.keys(handlers);
    const asked = this.params.get("format");

    const chosen = negotiateFormat(this.request, {
      available,
      // A `format` parameter is whatever arrived in the query string, so it is
      // only useful when it is a string.
      parameter: typeof asked === "string" ? asked : null,
    });

    // Sent whether or not a format was found, and before anything is rendered.
    // A response that varies by Accept and does not say so is one a shared
    // cache will hand to the next client whatever that client asked for —
    // which is how an API response ends up served to a browser.
    this.#pendingCacheHeaders = { ...this.#pendingCacheHeaders, vary: "Accept" };

    if (!chosen) {
      this.#format = undefined;
      this.head(406);
      return;
    }

    this.#format = chosen;
    await handlers[chosen]?.();
  }

  /**
   * Rails' `fresh_when`.
   *
   * Sets the validators, and answers 304 straight away when the client
   * already has this version. The action stops there — `performed()` is true,
   * so the filter chain halts exactly as it does after a render.
   */
  freshWhen(options: FreshnessOptions): boolean {
    const { fresh, headers } = freshnessFor(this.request, options);

    this.#pendingCacheHeaders = headers;
    if (fresh) this.#setResponse(notModified(headers));

    return fresh;
  }

  /**
   * Rails' `stale?`: true when the client needs the body.
   *
   *     if (this.stale({ etag: post, lastModified: post.updated_at })) {
   *       this.render.json(post)
   *     }
   *
   * A boolean rather than a decorator, because the saving is the render that
   * does not run — not the bytes that are not sent.
   */
  stale(options: FreshnessOptions): boolean {
    return !this.freshWhen(options);
  }

  /**
   * Rails' `expires_in`, without any validators.
   *
   * For a response that may simply be reused for a while — a public listing, a
   * generated image — where there is nothing to compare against.
   */
  expiresIn(seconds: number, options: Omit<FreshnessOptions, "expiresIn"> = {}): void {
    this.#pendingCacheHeaders = {
      "cache-control": cacheControl({ ...options, expiresIn: seconds }),
    };
  }

  /** Rails' `expires_now`: a cache must revalidate before reusing this. */
  expiresNow(): void {
    this.#pendingCacheHeaders = { "cache-control": "no-cache" };
  }

  /** For anything a cache must never keep at all. */
  noStore(): void {
    this.#pendingCacheHeaders = { "cache-control": "no-store" };
  }

  /**
   * The address the request came from. Rails' `request.remote_ip`.
   *
   * Reads nothing from `X-Forwarded-For` unless told how many proxies of your
   * own sit in front — the header is a list a client can write, so trusting
   * the first entry is how a rate limit gets walked around and an audit log
   * gets poisoned.
   */
  clientIp(options: ClientIpOptions = {}): string | undefined {
    return clientIp(this.request, options);
  }

  /** Sends bytes as a download. Rails' `send_data`. */
  send(data: Uint8Array | ArrayBuffer | string | Blob, options: SendOptions = {}): Response {
    return this.#setResponse(sendData(data, options));
  }

  /** Sends a file from disk, without reading it into memory. Rails' `send_file`. */
  async sendFile(path: string, options: SendOptions = {}): Promise<Response> {
    return this.#setResponse(await sendFile(path, options));
  }

  /** The credentials on the request, if it carries any. */
  basicCredentials(): Credentials | undefined {
    return decodeBasic(this.request.headers.get("authorization"));
  }

  /**
   * Rails' `authenticate_or_request_with_http_basic`.
   *
   * Returns whether the request may proceed, and renders the 401 itself when
   * it may not — so an action or a filter reads as one line and cannot forget
   * the second half.
   */
  authenticateOrRequest(
    check: (name: string, password: string) => boolean,
    realm = "Application",
  ): boolean {
    const given = this.basicCredentials();

    if (given && check(given.name, given.password)) return true;

    this.#setResponse(requestAuthentication(realm));
    return false;
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
