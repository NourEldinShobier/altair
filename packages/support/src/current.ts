/**
 * Per-request state, ported from `ActiveSupport::CurrentAttributes`.
 *
 *     class Current extends currentAttributes<{ user?: User; requestId?: string }>() {}
 *
 *     await Current.run({ requestId }, async () => {
 *       Current.user = await User.find(id)
 *       await handle(request)          // anything in here sees Current.user
 *     })
 *
 * Rails stores these in a thread-local and resets them between requests, which
 * works because a Ruby request owns a thread. A JavaScript request does not, so
 * this uses `AsyncLocalStorage`: the store follows the async call chain rather
 * than the thread, and two requests in flight cannot see each other's values.
 *
 * That difference is the whole reason to be careful here. A module-level
 * variable would look identical in a single-request test and leak one user's
 * identity into another user's response under load.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** Raised when current state is read outside a `run` block. */
export class NoCurrentScope extends Error {
  constructor(name: string) {
    super(
      `${name} was read outside a run() block. Wrap the request in ${name}.run({}, ...) so each one gets its own state.`,
    );
    this.name = "NoCurrentScope";
  }
}

export interface CurrentClass<T extends object> {
  /** Runs a block with a fresh store. Everything awaited inside sees it. */
  run<R>(attributes: Partial<T>, body: () => R | Promise<R>): Promise<R>;
  /** The values in scope, or throws when there is no scope. */
  readonly attributes: Partial<T>;
  /** Whether a scope is active, for code that must work either way. */
  readonly isActive: boolean;
  set(values: Partial<T>): void;
  reset(): void;
  get<K extends keyof T>(key: K): T[K] | undefined;
}

/**
 * Builds a Current class for a set of attributes.
 *
 * Attribute access goes through a proxy so `Current.user` reads and writes the
 * scoped store, which is what makes it a drop-in for Rails' version.
 */
export function currentAttributes<T extends object>(): CurrentClass<T> & Partial<T> {
  const storage = new AsyncLocalStorage<Partial<T>>();

  class Current {
    static async run<R>(attributes: Partial<T>, body: () => R | Promise<R>): Promise<R> {
      return await storage.run({ ...attributes }, async () => await body());
    }

    static get attributes(): Partial<T> {
      const store = storage.getStore();
      if (!store) throw new NoCurrentScope(this.name);
      return store;
    }

    static get isActive(): boolean {
      return storage.getStore() !== undefined;
    }

    static set(values: Partial<T>): void {
      Object.assign(this.attributes, values);
    }

    /** Empties the store without leaving the scope. */
    static reset(): void {
      const store = this.attributes;
      for (const key of Object.keys(store)) delete (store as Record<string, unknown>)[key];
    }

    static get<K extends keyof T>(key: K): T[K] | undefined {
      return this.attributes[key];
    }
  }

  return new Proxy(Current, {
    get(target, property, receiver) {
      if (typeof property === "string" && !Reflect.has(target, property)) {
        // Reading an attribute with no scope is undefined rather than a throw:
        // a helper that logs `Current.requestId` should not crash a script.
        return storage.getStore()?.[property as keyof T];
      }
      return Reflect.get(target, property, receiver) as unknown;
    },

    set(target, property, value, receiver) {
      if (typeof property === "string" && !Reflect.has(target, property)) {
        const store = storage.getStore();
        if (!store) throw new NoCurrentScope(target.name);

        (store as Record<string, unknown>)[property] = value;
        return true;
      }
      return Reflect.set(target, property, value, receiver);
    },
  }) as unknown as CurrentClass<T> & Partial<T>;
}

/**
 * What the framework itself puts in the request scope.
 *
 * An application widens this by declaration merging, so `Current.user` is its
 * own type rather than `unknown`:
 *
 *     declare module "@altair/support" {
 *       interface CurrentState { user?: User }
 *     }
 */
export interface CurrentState {
  request?: Request;
  /** Correlates every log line and query from one request. */
  requestId?: string;
  /** The token a form has to echo back. Views read it from here. */
  csrfToken?: string;
  /** Messages that survive one redirect, as the view sees them. */
  flash?: Readonly<Record<string, unknown>>;
  /** The Content Security Policy nonce this response was built with. */
  cspNonce?: string;
  /** The controller handling this request, for logs and query comments. */
  controller?: string;
  /** The action handling this request. */
  action?: string;
  /** The job running, when there is no request. */
  job?: string;
  user?: unknown;
  [key: string]: unknown;
}

/**
 * Per-request state. Rails' `Current`.
 *
 * This lives here, at the bottom of the dependency graph, so a view can read
 * the request without depending on the layer that served it. It is the same
 * mechanism Next.js's `headers()` and `cookies()` use, and the same one the
 * ORM scopes a transaction with.
 */
export const Current = currentAttributes<CurrentState>();
