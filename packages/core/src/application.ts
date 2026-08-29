/**
 * The application object, ported from `Rails::Application`.
 *
 * Holds the config, the route table, the controller registry and the boot
 * lifecycle, and produces the `fetch` handler `Bun.serve` takes.
 *
 * The lifecycle is Adonis' four phases rather than Rails' railtie machinery,
 * because it is the same idea with far less indirection: providers register
 * bindings, then boot, then the app starts, then it terminates.
 */

import { join } from "node:path";
import {
  errors,
  jsonFormatter,
  Logger,
  prettyFormatter,
  Secrets,
  type Subscription,
} from "@altair/support";
import { Current } from "@altair/support";
import { Router, type Mapper } from "@altair/router";
import {
  MiddlewareStack,
  createDispatcher,
  hostAuthorization,
  methodOverride,
  forceSsl,
  requestId,
  securityHeaders,
  serveStatic,
  type ControllerContext,
  type ControllerRegistry,
} from "@altair/controller";
import {
  configureEncryption,
  configureTokens,
  connect,
  withQueryCache,
  type Connection,
} from "@altair/orm";
import { configFor } from "./config_for.js";
import { buildConfig, type ApplicationConfig } from "./config.js";
import { healthCheck } from "./health.js";
import { statusForError, statusText, wantsJson } from "./rescue_responses.js";
import { renderErrorPage } from "./error_page.js";
import { credentialsFor, type Credentials } from "./credentials.js";
import { logQueries, requestLogging } from "./logging.js";

export interface Provider {
  name?: string;
  /** Add bindings. Nothing else has booted yet. */
  register?: (app: Application) => void | Promise<void>;
  /** Everything is registered; extend the framework here. */
  boot?: (app: Application) => void | Promise<void>;
  /** The app is about to serve requests. */
  start?: (app: Application) => void | Promise<void>;
  /** The app is shutting down. Close what you opened. */
  terminate?: (app: Application) => void | Promise<void>;
}

/**
 * What `Bun.serve` gives the fetch handler for upgrading a request.
 *
 * Narrowed to the one method used, so a test can hand in a plain object rather
 * than a running server.
 */
export interface UpgradeServer {
  upgrade(request: Request, options?: { data?: unknown }): boolean;
}

/**
 * Something that answers WebSocket upgrades — `Cable`, in practice.
 *
 * Structural on purpose. Core has no business depending on `@altair/cable`,
 * and an application that speaks its own protocol should be able to attach
 * without one existing.
 */
export interface UpgradeHandler {
  /** Whether this request is for the socket rather than for a controller. */
  handles(request: Request): boolean;
  /** What to hang off the socket, or null to refuse the connection. */
  upgradeData(request: Request): Promise<unknown | null>;
  /** The handlers `Bun.serve({ websocket })` takes. */
  handlers(): unknown;
}

/**
 * Returned when a request became a socket.
 *
 * `Bun.serve` wants no response once `upgrade` has succeeded, but the type
 * says a Response comes back, so this stands in for one that is never sent.
 */
const UPGRADED = new Response(null, { status: 101 });

export interface ApplicationOptions extends Partial<ApplicationConfig> {
  routes?: (r: Mapper) => void;
  controllers?: ControllerRegistry;
  providers?: Provider[];
  /** Replaces the default stack entirely. Rails' `config.middleware`. */
  middleware?: (stack: MiddlewareStack) => void;
}

export type ErrorHandler = (error: unknown, request: Request) => Response | Promise<Response>;

// Current lives in @altair/support so a view can read the request without
// depending on the layer that served it. Re-exported here, where Rails users
// expect to find it.
export { Current, type CurrentState } from "@altair/support";

export class Application {
  readonly config: ApplicationConfig;
  readonly router = new Router();
  readonly secrets: Secrets;
  /** Rails' `Rails.logger`. Everything the framework writes goes here. */
  readonly logger: Logger;

  controllers: ControllerRegistry = {};
  providers: Provider[] = [];
  #upgrade: UpgradeHandler | undefined;
  /**
   * Run once at boot, after the database is connected. Rails'
   * `config/initializers`, loaded by `loadApplication`.
   */
  initializers: ((app: Application) => void | Promise<void>)[] = [];
  readonly middleware = new MiddlewareStack();

  #credentials: Credentials | undefined;
  #queryLog: Subscription | undefined;
  #connection: Connection | undefined;
  #booted = false;
  #server: { stop: (closeActive?: boolean) => void } | undefined;
  #onError: ErrorHandler | undefined;

  constructor(options: ApplicationOptions = {}) {
    const { routes, controllers, providers, middleware, ...config } = options;

    this.config = buildConfig(config);
    this.secrets = new Secrets(this.config.secretKeyBase);
    this.logger = new Logger({
      level: this.config.log.level,
      formatter: this.config.log.format === "text" ? prettyFormatter() : jsonFormatter,
    });
    this.controllers = controllers ?? {};
    this.providers = providers ?? [];

    this.#defaultMiddleware();
    middleware?.(this.middleware);

    if (routes) this.router.draw(routes);
  }

  /**
   * The encrypted credentials. Rails' `Rails.application.credentials`.
   *
   *     app.credentials.get("stripe.secret_key")
   *
   * Built on first use rather than at boot: an application that keeps its
   * secrets in the environment has no credentials file, and should not have to
   * explain that to the framework.
   */
  get credentials(): Credentials {
    this.#credentials ??= credentialsFor(this.config.env, this.config.root);
    return this.#credentials;
  }

  /**
   * The stack every application starts with.
   *
   * Rails ships a default stack for the same reason: the headers and redirects
   * here are ones an application should not have to remember to add, and the
   * ones it forgets are the ones that matter.
   */
  #defaultMiddleware(): void {
    if (this.config.forceSsl) this.middleware.use("ssl", forceSsl());

    // First of all: a request from a host this application does not answer to
    // should not reach anything that logs, sets a cookie, or touches a session.
    if (this.config.hosts.length > 0) {
      this.middleware.use(
        "hostAuthorization",
        hostAuthorization({ allowed: this.config.hosts, exclude: (path) => path === "/up" }),
      );
    }

    // Before anything that reads the method: a request that says it is a
    // DELETE should be one by the time the router looks at it.
    this.middleware.use("methodOverride", methodOverride());
    this.middleware.use("requestId", requestId());
    // Outside the dispatcher, so a request that fails in another middleware is
    // still logged with the id the response carries.
    this.middleware.use("logging", requestLogging({ logger: this.logger }));
    this.middleware.use("securityHeaders", securityHeaders());

    // Rails 7.1 puts `/up` in the routes it generates, and this stack already
    // assumed it existed: `hostAuthorization` excludes that path so a load
    // balancer checking by IP is not turned away. Nothing answered it.
    //
    // The database is the check worth making by default. An application whose
    // connection pool is wedged is one a load balancer should take out of
    // rotation, and it is the failure that looks healthiest from outside —
    // the process is up and answering, and every request is failing.
    if (this.config.healthCheck) {
      this.middleware.use(
        "health",
        healthCheck({
          checks: {
            database: async () => {
              // Not `connection` — that throws before boot, and a health check
              // that throws is a health check that fails for the wrong reason.
              if (!this.#connection) return false;
              await this.#connection.query("SELECT 1");
              return true;
            },
          },
        }),
      );
    }

    // Last, so a file gets the headers and the request id above it, and so a
    // route always wins over a file of the same name. Rails ships this for the
    // same reason: without it a new application cannot serve its own favicon.
    if (this.config.publicFileServer) {
      this.middleware.use("static", serveStatic({ root: join(this.config.root, "public") }));
    }
  }

  get connection(): Connection {
    if (!this.#connection) {
      throw new Error("The database is not connected yet. Call boot() first.");
    }
    return this.#connection;
  }

  get isBooted(): boolean {
    return this.#booted;
  }

  /** Adds routes after construction. Rails' `routes.draw`. */
  draw(body: (r: Mapper) => void): this {
    this.router.draw(body);
    return this;
  }

  /** Registers controllers by the name their routes use. */
  register(controllers: ControllerRegistry): this {
    this.controllers = { ...this.controllers, ...controllers };
    return this;
  }

  use(provider: Provider): this {
    this.providers.push(provider);
    return this;
  }

  onError(handler: ErrorHandler): this {
    this.#onError = handler;
    return this;
  }

  /** Runs the register and boot phases, and connects the database. */
  async boot(): Promise<this> {
    if (this.#booted) return this;

    for (const provider of this.providers) await provider.register?.(this);

    // Both derive their keys from the application's secret, and neither was
    // ever called outside its own test — so `encrypts` threw in every
    // application that reached for it, and `generatesTokenFor` would have
    // done the same. Derived here, once, before anything can use them.
    configureEncryption(this.config.secretKeyBase);
    configureTokens(this.config.secretKeyBase);

    this.#connection = connect(this.config.database.url);

    // Subscribed at boot rather than at construction, so an application that
    // is built and never booted leaves no subscriber behind.
    if (this.config.log.queries || this.config.database.logQueries) {
      this.#queryLog ??= logQueries({ logger: this.logger });
    }

    for (const provider of this.providers) await provider.boot?.(this);

    // After the providers, so an initializer can use what they registered, and
    // after the connection, since configuring storage or a cache is the usual
    // reason to write one.
    for (const initializer of this.initializers) await initializer(this);

    this.#booted = true;
    return this;
  }

  /**
   * The request handler.
   *
   * Every controller is constructed with the application's secrets, which is
   * what makes signed cookies and sessions work without per-controller setup.
   */
  /**
   * Attaches something that answers upgrade requests — a cable, in practice.
   *
   * Structural rather than a direct dependency: core has no business importing
   * `@altair/cable`, and the cable already has this shape. Anything else that
   * speaks WebSocket can be attached the same way.
   */
  useWebSocket(handler: UpgradeHandler): this {
    this.#upgrade = handler;
    return this;
  }

  get webSocket(): UpgradeHandler | undefined {
    return this.#upgrade;
  }

  handler(): (request: Request, server?: UpgradeServer) => Promise<Response> {
    const dispatch = createDispatcher({
      router: this.router,
      controllers: this.controllers,
      context: (request) => this.contextFor(request),
      onError: (error, request) => this.#handleError(error, request),
      notFound: (request) => this.#respondWith(404, request),
    });

    // Built once: the closures are the same every request, and rebuilding them
    // per request is work for nothing.
    const stack = this.middleware.build(async (request) => {
      try {
        return await dispatch(request);
      } catch (error) {
        return await this.#handleError(error, request);
      }
    });

    return async (request: Request, server?: UpgradeServer) => {
      // Before the middleware, and before `Current`: an upgrade is not a
      // request that gets a response, and running it through a stack built to
      // produce one would have it answered rather than upgraded.
      if (server && this.#upgrade?.handles(request)) {
        const data = await this.#upgrade.upgradeData(request);

        // Null means the connection was refused. Rails answers an unauthorized
        // cable with a 401 rather than upgrading and closing, so a client can
        // tell "you may not" from "the server went away" and stop retrying.
        if (data === null) return new Response("Unauthorized", { status: 401 });

        if (server.upgrade(request, { data })) return UPGRADED;

        return new Response("Expected a WebSocket upgrade", { status: 426 });
      }

      // Every request runs inside its own Current scope, so anything it sets
      // is invisible to the requests running beside it.
      return await Current.run(
        { request, requestId: request.headers.get("x-request-id") ?? crypto.randomUUID() },
        // A query cache per request, and only per request. A page built from
        // partials asks for the current user in the header, the sidebar and
        // the footer, and none of the three can see the other two; held any
        // longer than the request, the same cache is a stale-read waiting for
        // a slow page.
        async () => {
          try {
            return await withQueryCache(async () => await stack(request));
          } catch (error) {
            // Out here as well as inside the stack. The inner catch is under
            // every middleware, so anything one of them threw — a session
            // store that is down, a header builder given bad config — went
            // past it: no report, no status, and whatever the runtime does
            // with a rejected promise.
            return await this.#handleError(error, request);
          }
        },
      );
    };
  }

  /**
   * Settings from `config/<name>.yml` for this environment.
   *
   * Rails' `Rails.application.config_for`. The environment and root come from
   * the application's own config, which is the whole reason to reach for it
   * here rather than calling `configFor` directly.
   */
  async configFor(name: string): Promise<Record<string, unknown>> {
    return await configFor(name, { env: this.config.env, root: this.config.root });
  }

  /** The context every controller is built with. Used by the dispatcher. */
  contextFor(request: Request, extra: Partial<ControllerContext> = {}): ControllerContext {
    return {
      request,
      secrets: this.secrets,
      session: { secure: this.config.forceSsl },
      forgeryProtection: this.config.forgeryProtection,
      ...extra,
    };
  }

  /**
   * The response for a status nothing threw for — a route that matched nothing.
   *
   * Through the same rendering as an error, so a 404 from the router looks
   * like a 404 from a controller: the same page, the same JSON, and a
   * content-type either way. The dispatcher used to answer its own bare
   * `new Response("Not Found")`, which in Bun carries no content-type at all —
   * so a browser offered to download the words "Not Found" as a file.
   */
  async #respondWith(status: number, request: Request): Promise<Response> {
    if (wantsJson(request)) {
      return Response.json({ status, error: statusText(status) }, { status });
    }

    const page = Bun.file(join(this.config.root, "public", `${status}.html`));

    if (await page.exists()) {
      return new Response(page, {
        status,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    return new Response(statusText(status), {
      status,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  async #handleError(error: unknown, request: Request): Promise<Response> {
    // Reported before anything is rendered, and whatever the handler decides:
    // an application that turns every error into a friendly page still needs
    // the error to reach whatever is watching for them.
    const status = statusForError(error, this.config.rescueResponses);

    // An error the framework has a status for is the client's doing, not a
    // fault. Every one of them used to arrive as an unhandled server error, so
    // a crawler walking ids paged whoever was on call.
    errors.report(error, {
      handled: status !== 500,
      severity: status >= 500 ? "error" : "info",
      source: "altair",
      context: { method: request.method, path: new URL(request.url).pathname, status },
    });

    if (this.#onError) return await this.#onError(error, request);

    // A client that asked for JSON cannot read a plain-text body: calling
    // `response.json()` on it is a parse error rather than the 404 it was
    // actually given. Rails renders the format the request asked for; so does
    // this, before deciding how much to say.
    if (wantsJson(request)) {
      const detail =
        this.config.showDetailedErrors && error instanceof Error
          ? { message: error.message, name: error.name, stack: error.stack }
          : status === 500
            ? {}
            : { message: error instanceof Error ? error.message : statusText(status) };

      return Response.json({ status, error: statusText(status), ...detail }, { status });
    }

    // Detailed errors are a development convenience and a production leak, so
    // the environment decides, not the caller.
    if (this.config.showDetailedErrors) {
      // An HTML page with the failing line of source in it, rather than the
      // stack alone. A trace says where; this says where and what the line
      // said, which is the difference between reading a path and reading the
      // code — several minutes, several times a day.
      //
      // If rendering it fails, fall back to the text that was here before.
      // This runs when something has already gone wrong, and an error page
      // that raises replaces a useful answer with none.
      try {
        return new Response(
          await renderErrorPage(error, request, { root: this.config.root, status }),
          { status, headers: { "content-type": "text/html; charset=utf-8" } },
        );
      } catch {
        const detail =
          error instanceof Error
            ? `${error.name}: ${error.message}\n\n${error.stack ?? ""}`
            : String(error);

        return new Response(`${request.method} ${new URL(request.url).pathname}\n\n${detail}`, {
          status,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
    }

    // Rails serves `public/404.html` and `public/500.html` when they are
    // there, which is how an application gets a page in its own design without
    // the framework having an opinion about typography.
    const page = Bun.file(join(this.config.root, "public", `${status}.html`));

    if (await page.exists()) {
      return new Response(page, {
        status,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    // The message goes out for a status the client can act on — "no such
    // record" tells them something and gives nothing away. A 500 keeps its
    // mouth shut, because the message is where the stack traces and the
    // connection strings are.
    if (status !== 500 && error instanceof Error) {
      return new Response(error.message, {
        status,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    return new Response("Internal Server Error", { status });
  }

  /** Boots if needed, runs the start phase, and serves. */
  async listen(
    port: number = this.config.server.port,
  ): Promise<{ port: number; stop: () => void }> {
    await this.boot();
    for (const provider of this.providers) await provider.start?.(this);

    const fetch = this.handler();

    const server = Bun.serve({
      port,
      hostname: this.config.server.hostname,
      fetch: (request, server) => fetch(request, server as UpgradeServer),
      websocket: this.#upgrade?.handlers() as never,
    });

    this.#server = server;
    return { port: Number(server.port ?? port), stop: () => void this.stop() };
  }

  /** Runs the terminate phase and closes the connection. */
  async stop(): Promise<void> {
    this.#server?.stop(true);
    this.#server = undefined;

    for (const provider of [...this.providers].reverse()) await provider.terminate?.(this);

    this.#queryLog?.unsubscribe();
    this.#queryLog = undefined;

    await this.#connection?.close();
    this.#connection = undefined;
    this.#booted = false;
  }
}

/** Builds an application. The entry point an app's `bin/server` calls. */
export function createApplication(options: ApplicationOptions = {}): Application {
  return new Application(options);
}
