/**
 * Callback chains, ported from `ActiveSupport::Callbacks`.
 *
 * This is the hook mechanism that `before_save`, `around_action` and friends
 * are built on. Models and controllers both need it, which is why it lands
 * early.
 *
 * One deliberate departure from Rails: every callback may be async, and
 * `runCallbacks` returns a promise. Rails' chains are synchronous because Ruby's
 * are; ours cannot be, since a `beforeSave` that touches the database is the
 * normal case rather than the exception. The ordering, conditional, halting and
 * inheritance semantics are otherwise Rails'.
 */

/** Thrown by {@link abortCallback} to halt a chain, mirroring Ruby's `throw :abort`. */
export class CallbackAbort extends Error {
  constructor() {
    super("Callback chain halted");
    this.name = "CallbackAbort";
  }
}

/**
 * Halts the running callback chain.
 *
 * Rails halts on `throw :abort`. Returning `false` does not halt — that
 * behaviour was removed in Rails 5 and we do not bring it back.
 */
export function abortCallback(): never {
  throw new CallbackAbort();
}

export type CallbackKind = "before" | "around" | "after";

/**
 * A callback body: a method name on the target, or a function.
 *
 * The signature always carries the `block` argument even though only `around`
 * callbacks use it. A function that declares fewer parameters is assignable to
 * one that declares more, so `() => {}` and `(post) => {}` both fit — writing
 * this as a union of arities instead makes inference fail at every call site.
 */
export type Filter<T> = string | ((this: T, target: T, block: () => Promise<unknown>) => unknown);

/** An `if`/`unless` guard: a method name on the target, or a predicate. */
export type Condition<T> = string | ((this: T, target: T) => unknown);

export interface SetCallbackOptions<T> {
  if?: Condition<T> | Condition<T>[];
  unless?: Condition<T> | Condition<T>[];
  /** Insert at the front of its group instead of the back. */
  prepend?: boolean;
}

/**
 * Decides whether a callback halted the chain.
 *
 * Receives the target and a function that runs the callback, exactly as Rails'
 * terminator lambda does, so a chain can define halting in terms of the
 * callback's return value.
 */
export type Terminator<T> = (target: T, run: () => Promise<unknown>) => boolean | Promise<boolean>;

export interface ChainConfig<T> {
  terminator?: Terminator<T>;
  /** When true, halting also skips the `after` callbacks. Rails defaults to false. */
  skipAfterCallbacksIfTerminated?: boolean;
}

/**
 * Rails' `DEFAULT_TERMINATOR`: run the callback, and treat a thrown abort as a
 * halt. Any other error propagates.
 */
const DEFAULT_TERMINATOR: Terminator<unknown> = async (_target, run) => {
  try {
    await run();
    return false;
  } catch (error) {
    if (error instanceof CallbackAbort) return true;
    throw error;
  }
};

interface Callback<T> {
  kind: CallbackKind;
  filter: Filter<T>;
  /** Identity for `skipCallback`: the filter itself, so functions match by reference. */
  key: unknown;
  conditions: { if: Condition<T>[]; unless: Condition<T>[] };
}

interface Chain<T> {
  callbacks: Callback<T>[];
  config: Required<ChainConfig<T>>;
}

interface Env<T> {
  target: T;
  halted: boolean;
  value: unknown;
}

/** Per-constructor chain storage. Subclasses copy on write, as in Rails. */
const CHAINS = Symbol("altair.callbacks.chains");

type Chained = {
  [CHAINS]?: Map<string, Chain<unknown>>;
};

function ownChains(klass: object): Map<string, Chain<unknown>> {
  const holder = klass as Chained;
  if (!Object.prototype.hasOwnProperty.call(holder, CHAINS)) {
    // Copy the inherited chains so a subclass can modify without touching its
    // parent — Rails' `class_attribute` semantics.
    const inherited = findChains(Object.getPrototypeOf(klass) as object | null);
    const copy = new Map<string, Chain<unknown>>();
    if (inherited) {
      for (const [name, chain] of inherited) {
        copy.set(name, { callbacks: [...chain.callbacks], config: { ...chain.config } });
      }
    }
    Object.defineProperty(holder, CHAINS, { value: copy, writable: true, configurable: true });
  }
  return holder[CHAINS]!;
}

function findChains(klass: object | null): Map<string, Chain<unknown>> | undefined {
  let current = klass;
  while (current) {
    const holder = current as Chained;
    if (Object.prototype.hasOwnProperty.call(current, CHAINS)) return holder[CHAINS];
    current = Object.getPrototypeOf(current) as object | null;
  }
  return undefined;
}

function lookupChain(klass: object, name: string): Chain<unknown> | undefined {
  return findChains(klass)?.get(name);
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** Resolves a method name against the target, or calls the function. */
async function invokeFilter<T>(
  target: T,
  filter: Filter<T>,
  block?: () => Promise<unknown>,
): Promise<unknown> {
  if (typeof filter === "string") {
    const method = (target as Record<string, unknown>)[filter];
    if (typeof method !== "function") {
      throw new TypeError(`Callback ${filter} is not a method on the target`);
    }
    return await (method as (...args: unknown[]) => unknown).call(target, block);
  }
  return await (filter as (target: T, block?: () => Promise<unknown>) => unknown).call(
    target,
    target,
    block!,
  );
}

async function conditionHolds<T>(target: T, condition: Condition<T>): Promise<boolean> {
  const result = await invokeFilter(target, condition as Filter<T>);
  return Boolean(result);
}

async function matches<T>(env: Env<T>, callback: Callback<T>): Promise<boolean> {
  for (const condition of callback.conditions.if) {
    if (!(await conditionHolds(env.target, condition))) return false;
  }
  for (const condition of callback.conditions.unless) {
    if (await conditionHolds(env.target, condition)) return false;
  }
  return true;
}

/**
 * Declares one or more callback chains on a class.
 *
 *     defineCallbacks(Person, ["save", "validate"])
 */
export function defineCallbacks<T>(
  klass: object,
  names: string | string[],
  config: ChainConfig<T> = {},
): void {
  const chains = ownChains(klass);
  for (const name of toArray(names)) {
    chains.set(name, {
      callbacks: [],
      config: {
        terminator: (config.terminator ?? DEFAULT_TERMINATOR) as Terminator<unknown>,
        skipAfterCallbacksIfTerminated: config.skipAfterCallbacksIfTerminated ?? false,
      },
    });
  }
}

/**
 * Adds a callback to a chain.
 *
 *     setCallback(Person, "save", "before", "normalizeName")
 *     setCallback(Person, "save", "after", (p) => p.notify(), { if: "shouldNotify" })
 */
export function setCallback<T>(
  klass: object,
  name: string,
  kind: CallbackKind,
  filter: Filter<T>,
  options: SetCallbackOptions<T> = {},
): void {
  const chains = ownChains(klass);
  let chain = chains.get(name);
  if (!chain) {
    defineCallbacks(klass, name);
    chain = chains.get(name)!;
  }

  const callback: Callback<unknown> = {
    kind,
    filter: filter as Filter<unknown>,
    key: filter,
    conditions: {
      if: toArray(options.if) as Condition<unknown>[],
      unless: toArray(options.unless) as Condition<unknown>[],
    },
  };

  // Rails excludes duplicates: re-declaring the same filter moves it rather
  // than running it twice.
  const existing = chain.callbacks.findIndex((c) => c.kind === kind && c.key === filter);
  if (existing !== -1) chain.callbacks.splice(existing, 1);

  if (options.prepend) chain.callbacks.unshift(callback);
  else chain.callbacks.push(callback);
}

/** Removes a previously registered callback. */
export function skipCallback<T>(
  klass: object,
  name: string,
  kind: CallbackKind,
  filter: Filter<T>,
  { raise = true }: { raise?: boolean } = {},
): void {
  const chains = ownChains(klass);
  const chain = chains.get(name);
  const index = chain?.callbacks.findIndex((c) => c.kind === kind && c.key === filter) ?? -1;

  if (index === -1) {
    if (raise) {
      const label = typeof filter === "string" ? filter : "the given function";
      throw new Error(`No ${kind} callback ${label} defined for ${name}`);
    }
    return;
  }
  chain!.callbacks.splice(index, 1);
}

/** Drops every callback in a chain, leaving the chain defined. */
export function resetCallbacks(klass: object, name: string): void {
  const chain = ownChains(klass).get(name);
  if (chain) chain.callbacks = [];
}

/** The callbacks registered on a chain, in order. Introspection for tests and tooling. */
export function callbacksFor(klass: object, name: string): readonly { kind: CallbackKind }[] {
  return lookupChain(klass, name)?.callbacks ?? [];
}

/**
 * Runs a chain around a block.
 *
 * Returns the block's value, or `false` if the chain was halted. `before`
 * callbacks run in declaration order, `after` callbacks in reverse, and
 * `around` callbacks wrap everything declared after them.
 */
export function runCallbacks<T>(target: T, name: string): Promise<boolean>;
export function runCallbacks<T, R>(
  target: T,
  name: string,
  block: () => R | Promise<R>,
): Promise<R | false>;
export async function runCallbacks<T, R>(
  target: T,
  name: string,
  block?: () => R | Promise<R>,
): Promise<R | false> {
  const klass = (target as object).constructor;
  const chain = lookupChain(klass, name);

  if (!chain || chain.callbacks.length === 0) {
    return block ? await block() : (true as R);
  }

  const env: Env<T> = { target, halted: false, value: undefined };
  const { terminator, skipAfterCallbacksIfTerminated } = chain.config;
  const callbacks = chain.callbacks as Callback<T>[];

  const invoke = async (index: number): Promise<void> => {
    if (index >= callbacks.length) {
      env.value = env.halted ? false : block ? await block() : true;
      return;
    }

    const callback = callbacks[index]!;

    if (callback.kind === "before") {
      if (!env.halted && (await matches(env, callback))) {
        env.halted = await terminator(target, () => invokeFilter(target, callback.filter));
      }
      await invoke(index + 1);
      return;
    }

    if (callback.kind === "around") {
      if (env.halted || !(await matches(env, callback))) {
        await invoke(index + 1);
        return;
      }
      let inner = false;
      await invokeFilter(target, callback.filter, async () => {
        inner = true;
        await invoke(index + 1);
        return env.value;
      });
      // An around callback that never yields still has to let the chain unwind,
      // but the block and everything nested stay unrun — the same shape Rails
      // gets from a filter that does not call `yield`.
      if (!inner) env.halted = true;
      return;
    }

    await invoke(index + 1);
    if (!env.halted || !skipAfterCallbacksIfTerminated) {
      if (await matches(env, callback)) {
        await invokeFilter(target, callback.filter);
      }
    }
  };

  await invoke(0);
  return env.value as R | false;
}

/**
 * Convenience base class.
 *
 * Rails mixes `ActiveSupport::Callbacks` into a class; the equivalent here is
 * extending this, which gives the same API without threading the constructor
 * through every call.
 */
export class Callbacks {
  // The `this` parameter is what lets T be inferred as the instance type, so
  // `Post.setCallback("save", "before", function () { this.title })` type-checks
  // against Post rather than falling back to unknown.
  static defineCallbacks<T>(
    this: abstract new (...args: never[]) => T,
    names: string | string[],
    config?: ChainConfig<T>,
  ): void {
    defineCallbacks(this, names, config);
  }

  static setCallback<T>(
    this: abstract new (...args: never[]) => T,
    name: string,
    kind: CallbackKind,
    filter: Filter<T>,
    options?: SetCallbackOptions<T>,
  ): void {
    setCallback(this, name, kind, filter, options);
  }

  static skipCallback<T>(
    this: abstract new (...args: never[]) => T,
    name: string,
    kind: CallbackKind,
    filter: Filter<T>,
    options?: { raise?: boolean },
  ): void {
    skipCallback(this, name, kind, filter, options);
  }

  static resetCallbacks(name: string): void {
    resetCallbacks(this, name);
  }

  runCallbacks(name: string): Promise<boolean>;
  runCallbacks<R>(name: string, block: () => R | Promise<R>): Promise<R | false>;
  runCallbacks<R>(name: string, block?: () => R | Promise<R>): Promise<R | false> {
    return runCallbacks(this, name, block as () => R | Promise<R>);
  }
}
