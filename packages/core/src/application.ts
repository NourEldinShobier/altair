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

import {
  errors,
  jsonFormatter,
  Logger,
  Secrets,
  textFormatter,
  type Subscription,
} from "@altair/support";
import { Current } from "@altair/support";
import { Router, type Mapper } from "@altair/router";
import {
  MiddlewareStack,
  createDispatcher,
  forceSsl,
  requestId,
  securityHeaders,
  type ControllerContext,
  type ControllerRegistry,
} from "@altair/controller";
import { connect, type Connection } from "@altair/orm";
import { buildConfig, type ApplicationConfig } from "./config.js";
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
      formatter: this.config.log.format === "text" ? textFormatter : jsonFormatter,
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
    this.middleware.use("requestId", requestId());
    // Outside the dispatcher, so a request that fails in another middleware is
    // still logged with the id the response carries.
    this.middleware.use("logging", requestLogging({ logger: this.logger }));
    this.middleware.use("securityHeaders", securityHeaders());
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

    this.#connection = connect(this.config.database.url);

    // Subscribed at boot rather than at construction, so an application that
    // is built and never booted leaves no subscriber behind.
    if (this.config.log.queries || this.config.database.logQueries) {
      this.#queryLog ??= logQueries({ logger: this.logger });
    }

    for (const provider of this.providers) await provider.boot?.(this);

    this.#booted = true;
    return this;
  }

  /**
   * The request handler.
   *
   * Every controller is constructed with the application's secrets, which is
   * what makes signed cookies and sessions work without per-controller setup.
   */
  handler(): (request: Request) => Promise<Response> {
    const dispatch = createDispatcher({
      router: this.router,
      controllers: this.controllers,
      context: (request) => this.contextFor(request),
      onError: (error, request) => this.#handleError(error, request),
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

    return async (request: Request) => {
      // Every request runs inside its own Current scope, so anything it sets
      // is invisible to the requests running beside it.
      return await Current.run(
        { request, requestId: request.headers.get("x-request-id") ?? crypto.randomUUID() },
        async () => await stack(request),
      );
    };
  }

  /** The context every controller is built with. Used by the dispatcher. */
  contextFor(request: Request, extra: Partial<ControllerContext> = {}): ControllerContext {
    return {
      request,
      secrets: this.secrets,
      session: { secure: this.config.forceSsl },
      ...extra,
    };
  }

  async #handleError(error: unknown, request: Request): Promise<Response> {
    // Reported before anything is rendered, and whatever the handler decides:
    // an application that turns every error into a friendly page still needs
    // the error to reach whatever is watching for them.
    errors.report(error, {
      handled: false,
      severity: "error",
      source: "altair",
      context: { method: request.method, path: new URL(request.url).pathname },
    });

    if (this.#onError) return await this.#onError(error, request);

    // Detailed errors are a development convenience and a production leak, so
    // the environment decides, not the caller.
    if (this.config.showDetailedErrors) {
      const detail =
        error instanceof Error
          ? `${error.name}: ${error.message}\n\n${error.stack ?? ""}`
          : String(error);
      return new Response(`${request.method} ${new URL(request.url).pathname}\n\n${detail}`, {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    return new Response("Internal Server Error", { status: 500 });
  }

  /** Boots if needed, runs the start phase, and serves. */
  async listen(
    port: number = this.config.server.port,
  ): Promise<{ port: number; stop: () => void }> {
    await this.boot();
    for (const provider of this.providers) await provider.start?.(this);

    const server = Bun.serve({
      port,
      hostname: this.config.server.hostname,
      fetch: this.handler(),
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
