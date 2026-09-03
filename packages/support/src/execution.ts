/**
 * The lock that stops code being swapped underneath a request, and the wrapper
 * that runs one unit of work. Ported from
 * `ActiveSupport::Concurrency::ShareLock`, `ExecutionWrapper` and `Reloader`.
 *
 * Reloading in development is the reason all of this exists. When a file
 * changes, the modules that depend on it are re-imported — and a request that
 * is halfway through is holding references to the old ones. Swap them
 * underneath it and the symptoms are these:
 *
 *   - A record is an instance of the *old* class while its model is the new
 *     one, so `instanceof` is false against the class the file defines. The
 *     error names a class that looks identical to the one you have.
 *   - A callback registered by the old module runs against state owned by the
 *     new one.
 *   - Two versions of the same module both hold half the registry.
 *
 * None of these reproduce reliably, because they need a reload to land inside
 * a request rather than between two.
 *
 * The fix is a lock with two modes rather than one. Requests *share* it —
 * any number at once, since they do not conflict with each other. A reload
 * takes it *exclusively*, which waits for the requests already running and
 * makes the next ones wait for it. The asymmetry is the whole design: a mutex
 * would serialise every request against every other, which is the cost you
 * would be paying to prevent something that only happens on reload.
 */

/** What the lock is currently doing, for a deadlock report. */
export interface ShareLockState {
  sharing: number;
  exclusive: boolean;
  waitingForExclusive: number;
}

/**
 * A lock many can hold together, or one can hold alone.
 *
 * Single-threaded here, so "waiting" is a promise rather than a condition
 * variable — but the ordering rules are the same ones, and so are the mistakes
 * they prevent.
 */
export class ShareLock {
  #sharing = 0;
  #exclusive = false;
  #waitingForExclusive: (() => void)[] = [];
  #waitingForShare: (() => void)[] = [];

  /** Rails' `raw_state`, for reporting what is holding what. */
  rawState(): ShareLockState {
    return {
      sharing: this.#sharing,
      exclusive: this.#exclusive,
      waitingForExclusive: this.#waitingForExclusive.length,
    };
  }

  /** How many hold it right now. The block form below is `sharing`. */
  get shareCount(): number {
    return this.#sharing;
  }

  get isExclusive(): boolean {
    return this.#exclusive;
  }

  /**
   * Joins the shared holders, waiting while somebody holds it alone. Rails'
   * `start_sharing`.
   */
  async startSharing(): Promise<void> {
    while (this.#exclusive) await this.#wait(this.#waitingForShare);

    this.#sharing += 1;
  }

  /** Rails' `stop_sharing`. */
  stopSharing(): void {
    if (this.#sharing === 0) {
      throw new Error("stopSharing was called by something that was not sharing the lock.");
    }

    this.#sharing -= 1;

    // Only the last one out wakes the waiters. Waking them earlier would not be
    // *wrong* — `startExclusive` re-checks the count and goes back to sleep —
    // but it wakes every waiter on every release to no purpose. Correctness is
    // the loop's job; this is just not doing the work.
    if (this.#sharing === 0) this.#release(this.#waitingForExclusive);
  }

  /**
   * Takes it alone, waiting for the shared holders to finish. Rails'
   * `start_exclusive`.
   *
   * `noWait` is for the case where blocking is worse than not reloading: a
   * file watcher that would otherwise queue a reload behind a long request and
   * then apply it much later, against files that have changed again since.
   */
  async startExclusive(options: { noWait?: boolean } = {}): Promise<boolean> {
    if (options.noWait === true && (this.#sharing > 0 || this.#exclusive)) return false;

    while (this.#sharing > 0 || this.#exclusive) await this.#wait(this.#waitingForExclusive);

    this.#exclusive = true;

    return true;
  }

  /** Rails' `stop_exclusive`. */
  stopExclusive(): void {
    this.#exclusive = false;

    // Sharers first: they are the requests, and a queue of them behind one
    // reload is the latency somebody notices.
    this.#release(this.#waitingForShare);
    this.#release(this.#waitingForExclusive);
  }

  /** Runs something holding it alone. Rails' `exclusive`. */
  async exclusive<T>(
    body: () => Promise<T>,
    options: { noWait?: boolean } = {},
  ): Promise<T | undefined> {
    if (!(await this.startExclusive(options))) return undefined;

    try {
      return await body();
    } finally {
      this.stopExclusive();
    }
  }

  /** Runs something holding it with others. Rails' `sharing`. */
  async sharing<T>(body: () => Promise<T>): Promise<T> {
    await this.startSharing();

    try {
      return await body();
    } finally {
      this.stopSharing();
    }
  }

  /**
   * Gives up a share for the duration, and takes it back after. Rails'
   * `yield_shares`.
   *
   * For a request that is about to wait on something slow and unrelated — an
   * HTTP call, a queue — where holding the lock would block a reload for no
   * reason. It is also how a deadlock is avoided when the thing being waited
   * on itself needs the lock.
   */
  async yieldShares<T>(body: () => Promise<T>): Promise<T> {
    const held = this.#sharing;

    this.#sharing = 0;

    if (held > 0) this.#release(this.#waitingForExclusive);

    try {
      return await body();
    } finally {
      while (this.#exclusive) await this.#wait(this.#waitingForShare);

      this.#sharing = held;
    }
  }

  async #wait(queue: (() => void)[]): Promise<void> {
    await new Promise<void>((resolve) => queue.push(resolve));
  }

  #release(queue: (() => void)[]): void {
    const waiting = queue.splice(0);

    for (const resolve of waiting) resolve();
  }
}

/** The one requests and reloads share. Rails' `ActiveSupport::Dependencies.interlock`. */
const interlock = new ShareLock();

export function loadInterlock(): ShareLock {
  return interlock;
}

/** Runs something as a request would: sharing the lock. Rails' `running`. */
export function runInterlock<T>(body: () => Promise<T>): Promise<T> {
  return interlock.sharing(body);
}

/** Runs something as a reload would: holding it alone. Rails' `unloading`. */
export function unloadInterlock<T>(body: () => Promise<T>): Promise<T | undefined> {
  return interlock.exclusive(body);
}

/** Rails' `permit_concurrent_loads`. */
export function permitConcurrentLoads<T>(body: () => Promise<T>): Promise<T> {
  return interlock.yieldShares(body);
}

export type Hook = () => void | Promise<void>;

/**
 * One unit of work, with something to do at each end. Ported from
 * `ActiveSupport::ExecutionWrapper`.
 *
 * A request, a job, a console session. The hooks are where per-unit state is
 * set up and — more importantly — torn down: a connection returned, a
 * request-scoped store cleared, a query cache emptied. Leaving any of those
 * behind means the next unit inherits them, which in a pool of reused workers
 * is one request seeing another's data.
 */
export class Executor {
  readonly #toRun: Hook[] = [];
  readonly #toComplete: Hook[] = [];
  #active = false;

  /** Rails' `to_run`. */
  toRun(hook: Hook): void {
    this.#toRun.push(hook);
  }

  /** Rails' `to_complete`. */
  toComplete(hook: Hook): void {
    this.#toComplete.push(hook);
  }

  /**
   * Registers both halves at once. Rails' `register_hook`.
   *
   * `outer` puts the completion last rather than first, for something that has
   * to be torn down after everything registered inside it — a connection is
   * the example, since the hooks that run before it may still need to query.
   */
  registerHook(hook: { run?: Hook; complete?: Hook }, options: { outer?: boolean } = {}): void {
    if (hook.run) this.#toRun.push(hook.run);

    if (hook.complete) {
      if (options.outer === true) this.#toComplete.push(hook.complete);
      else this.#toComplete.unshift(hook.complete);
    }
  }

  get active(): boolean {
    return this.#active;
  }

  get runOrder(): number {
    return this.#toRun.length;
  }

  /** Runs the opening hooks. Rails' `run!`. */
  async run(): Promise<void> {
    this.#active = true;

    for (const hook of this.#toRun) await hook();
  }

  /**
   * Runs the closing hooks. Rails' `complete!`.
   *
   * Every one of them, even when an earlier one throws. A teardown that stops
   * halfway leaves exactly the state it was supposed to clear, and the failure
   * appears in whichever unit of work runs next.
   */
  async complete(): Promise<void> {
    this.#active = false;

    let failure: unknown;

    for (const hook of this.#toComplete) {
      try {
        await hook();
      } catch (error) {
        failure ??= error;
      }
    }

    if (failure !== undefined) throw failure;
  }

  /**
   * Wraps a unit of work. Rails' `wrap`.
   *
   * Completion is in a `finally`, since the unit that threw is the one whose
   * state most needs clearing.
   */
  async wrap<T>(body: () => Promise<T>): Promise<T> {
    await this.run();

    try {
      return await body();
    } finally {
      await this.complete();
    }
  }

  /** Runs the closing hooks without having run the opening ones. Rails' `run_cleanup`. */
  async runCleanup(): Promise<void> {
    await this.complete();
  }

  /** Adds something that only ever runs at the end. Rails' `run_cleanup_hook`. */
  runCleanupHook(hook: Hook): void {
    this.#toComplete.push(hook);
  }
}

/**
 * Reloads code between units of work, never during one. Ported from
 * `ActiveSupport::Reloader`.
 */
export class Reloader extends Executor {
  #checks: (() => boolean)[] = [];
  #beforeClassUnload: Hook[] = [];
  #afterClassUnload: Hook[] = [];
  #reloaded = false;
  #unloading = false;

  /** How to tell whether anything changed. Rails' `check`. */
  check(updated: () => boolean): void {
    this.#checks.push(updated);
  }

  /** Whether anything has. */
  updated(): boolean {
    return this.#checks.some((each) => each());
  }

  beforeClassUnload(hook: Hook): void {
    this.#beforeClassUnload.push(hook);
  }

  afterClassUnload(hook: Hook): void {
    this.#afterClassUnload.push(hook);
  }

  get reloaded(): boolean {
    return this.#reloaded;
  }

  get unloading(): boolean {
    return this.#unloading;
  }

  /**
   * Reloads, but only if something changed. Rails' `execute_if_updated`.
   *
   * The check is the cheap part and the reload is not, so asking first is what
   * makes a file watcher that fires on every keystroke survivable.
   */
  async executeIfUpdated(body?: () => Promise<void>): Promise<boolean> {
    if (!this.updated()) return false;

    await this.classUnload(body);

    return true;
  }

  /**
   * Swaps the code, holding the interlock alone. Rails' `class_unload!`.
   *
   * Exclusively, which is the entire point: a reload that lands inside a
   * request leaves that request holding modules nothing else refers to.
   */
  async classUnload(body?: () => Promise<void>): Promise<void> {
    await unloadInterlock(async () => {
      this.#unloading = true;

      try {
        for (const hook of this.#beforeClassUnload) await hook();

        await body?.();

        for (const hook of this.#afterClassUnload) await hook();

        this.#reloaded = true;
      } finally {
        this.#unloading = false;
      }
    });
  }
}

/** Hooks that run once, when whatever they are waiting for is ready. */
const loadHooks = new Map<string, ((base: unknown) => void)[]>();
const ranHooks = new Map<string, unknown[]>();

/**
 * Registers something to run when a named thing is loaded. Rails'
 * `ActiveSupport.on_load`.
 *
 * Runs immediately when the thing is already there, which is what stops the
 * order of imports from deciding whether a hook runs at all — a bug that
 * appears as a setting silently not applying.
 */
export function onLoad(name: string, hook: (base: unknown) => void): void {
  for (const base of ranHooks.get(name) ?? []) hook(base);

  const held = loadHooks.get(name);

  if (held) held.push(hook);
  else loadHooks.set(name, [hook]);
}

/** Rails' `run_load_hooks`. */
export function runLoadHooks(name: string, base?: unknown): void {
  const already = ranHooks.get(name);

  if (already) already.push(base);
  else ranHooks.set(name, [base]);

  for (const hook of loadHooks.get(name) ?? []) hook(base);
}

export function resetLoadHooks(): void {
  loadHooks.clear();
  ranHooks.clear();
}
