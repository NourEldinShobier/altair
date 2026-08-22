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

import { Secrets } from "@altair/support";
import { Router, type Mapper } from "@altair/router";
import {
  createDispatcher,
  type ControllerRegistry,
  type ControllerContext,
} from "@altair/controller";
import { connect, type Connection } from "@altair/orm";
import { buildConfig, type ApplicationConfig } from "./config.js";

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
}

export type ErrorHandler = (error: unknown, request: Request) => Response | Promise<Response>;

export class Application {
  readonly config: ApplicationConfig;
  readonly router = new Router();
  readonly secrets: Secrets;

  controllers: ControllerRegistry = {};
  providers: Provider[] = [];

  #connection: Connection | undefined;
  #booted = false;
  #server: { stop: (closeActive?: boolean) => void } | undefined;
  #onError: ErrorHandler | undefined;

  constructor(options: ApplicationOptions = {}) {
    const { routes, controllers, providers, ...config } = options;

    this.config = buildConfig(config);
    this.secrets = new Secrets(this.config.secretKeyBase);
    this.controllers = controllers ?? {};
    this.providers = providers ?? [];

    if (routes) this.router.draw(routes);
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

    return async (request: Request) => {
      try {
        return await dispatch(request);
      } catch (error) {
        return await this.#handleError(error, request);
      }
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

    await this.#connection?.close();
    this.#connection = undefined;
    this.#booted = false;
  }
}

/** Builds an application. The entry point an app's `bin/server` calls. */
export function createApplication(options: ApplicationOptions = {}): Application {
  return new Application(options);
}
