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
 * The names of `T`'s methods.
 *
 * Rails takes a symbol here and finds out at run time whether the method
 * exists. Naming the methods in the type instead means `before_save :typo` is
 * a compile error, and renaming a method updates its callback declaration.
 */
export type MethodName<T> = {
  [K in keyof T]: T[K] extends (...args: never[]) => unknown ? K : never;
}[keyof T] &
  string;

/**
 * A callback body: the name of a method on the target, or a function.
 *
 * The signature always carries the `block` argument even though only `around`
 * callbacks use it. A function that declares fewer parameters is assignable to
 * one that declares more, so `() => {}` and `(post) => {}` both fit — writing
 * this as a union of arities instead makes inference fail at every call site.
 */
export type Filter<T> =
  | MethodName<T>
  | ((this: T, target: T, block: () => Promise<unknown>) => unknown)
  | CallbackObject;

/**
 * An object that handles a callback with a method named after it — Rails'
 * `before_save Auditor.new`, which calls `Auditor#before_save`.
 *
 * Worth having because it is the only filter that can hold state: a method name
 * reaches the record's own methods and a closure is written at the declaration,
 * while an object can be configured once and reused by several models. Nothing
 * else in the shape distinguishes it, so the method it must have is named after
 * the callback it was registered for.
 */
export type CallbackObject = Record<string, unknown>;

/** An `if`/`unless` guard: the name of a method on the target, or a predicate. */
export type Condition<T> = MethodName<T> | ((this: T, target: T) => unknown);

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

// Decorator metadata is stage 3 and the well-known symbol is missing in some
// runtimes. Defining it is enough to opt in; Bun populates whatever is present.
(Symbol as { metadata?: symbol }).metadata ??= Symbol.for("Symbol.metadata");

/** @internal Shared with the decorators module. */
export const METADATA = (Symbol as { metadata?: symbol }).metadata!;
/** @internal Where decorators park callbacks until the chain is first touched. */
export const PENDING = Symbol.for("altair.callbacks.pending");
const DRAINED = Symbol.for("altair.callbacks.drained");

/** @internal */
export interface PendingCallback {
  chain: string;
  kind: CallbackKind;
  method: string;
  options: SetCallbackOptions<unknown>;
}

/**
 * Moves decorator-declared callbacks onto a class's chains.
 *
 * Runs before anything reads or writes a chain, so registration order is the
 * source order of the decorators no matter when the chain is first used.
 */
function drainDecorated(klass: object): void {
  if (Object.hasOwn(klass, DRAINED)) return;
  Object.defineProperty(klass, DRAINED, { value: true, configurable: true });

  // Ancestors first: a subclass copies its parent's chain the moment it writes
  // to one, so a parent drained afterwards would never reach the copy.
  const parent = Object.getPrototypeOf(klass) as object | null;
  if (typeof parent === "function") drainDecorated(parent);

  const metadata = (klass as Record<symbol, unknown>)[METADATA] as
    | Record<PropertyKey, unknown>
    | undefined;
  if (!metadata || !Object.hasOwn(metadata, PENDING)) return;

  for (const pending of metadata[PENDING] as PendingCallback[]) {
    // The decorator already proved the method exists — it was attached to it.
    // MethodName<object> is never, so the checked signature cannot say so and
    // this one call goes through the unchecked shape.
    (setCallback as (...args: unknown[]) => void)(
      klass,
      pending.chain,
      pending.kind,
      pending.method,
      pending.options,
    );
  }
}

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
  drainDecorated(klass);
  return findChains(klass)?.get(name);
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * The method an object filter must have, for a callback of this kind and name.
 *
 * `before` + `save` is `beforeSave`. Derived rather than configured, because
 * the point of an object filter is that one object can be registered for
 * several callbacks and answer each with its own method.
 */
export function callbackMethodName(kind: CallbackKind, name: string): string {
  return `${kind}${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

/**
 * One uniform way to call any filter. Rails' `CallTemplate`.
 *
 * A method name, a function and an object each have to be called differently,
 * and doing that at the call site means every place that runs a filter — the
 * chain, a condition, an inverted condition — repeats the same three-way
 * decision and eventually one of them gets it wrong. Resolved once, here.
 */
export function callTemplate<T>(
  filter: Filter<T>,
  kind: CallbackKind = "before",
  name = "",
): (target: T, block?: () => Promise<unknown>) => unknown {
  if (typeof filter === "function") {
    return (target, block) =>
      (filter as (target: T, block?: () => Promise<unknown>) => unknown).call(
        target,
        target,
        block,
      );
  }

  if (typeof filter === "string") {
    return (target, block) => {
      const method = (target as Record<string, unknown>)[filter];

      if (typeof method !== "function") {
        throw new TypeError(`Callback ${filter} is not a method on the target`);
      }

      // Same arguments as a function filter, so a method and a lambda declaring
      // the same parameters behave identically.
      return (method as (...args: unknown[]) => unknown).call(target, target, block);
    };
  }

  const methodName = callbackMethodName(kind, name);

  return (target, block) => {
    const method = (filter as CallbackObject)[methodName];

    if (typeof method !== "function") {
      throw new TypeError(
        `A callback object registered for ${kind} ${name} must have a ${methodName} method.`,
      );
    }

    return (method as (...args: unknown[]) => unknown).call(filter, target, block);
  };
}

/**
 * Rails' `expand_call_template` — the call, bound, but not yet made.
 *
 * Returned rather than invoked so the caller decides when it runs and what
 * happens around it. That is what lets one place resolve the filter and another
 * decide whether a throw is a halt.
 */
export function expandCallTemplate<T>(
  filter: Filter<T>,
  target: T,
  block?: () => Promise<unknown>,
  kind: CallbackKind = "before",
  name = "",
): () => unknown {
  const template = callTemplate(filter, kind, name);

  return () => template(target, block);
}

/** Rails' `make_lambda` — the filter as something awaitable. */
export function makeLambda<T>(
  filter: Filter<T>,
  kind: CallbackKind = "before",
  name = "",
): (target: T, block?: () => Promise<unknown>) => Promise<unknown> {
  const template = callTemplate(filter, kind, name);

  return async (target, block) => await template(target, block);
}

/**
 * Rails' `inverted_lambda` — the filter, negated.
 *
 * Its own function rather than `!await makeLambda(...)` at the call site,
 * because `unless` and a conditional skip both need it and both would otherwise
 * negate separately — and a condition negated in one place and not the other is
 * a callback that runs exactly when it should not.
 */
export function invertedLambda<T>(
  filter: Filter<T>,
  kind: CallbackKind = "before",
  name = "",
): (target: T) => Promise<boolean> {
  const lambda = makeLambda(filter, kind, name);

  return async (target) => !(await lambda(target));
}

/** Resolves a method name against the target, or calls the function. */
async function invokeFilter<T>(
  target: T,
  filter: Filter<T>,
  block?: () => Promise<unknown>,
  kind: CallbackKind = "before",
  name = "",
): Promise<unknown> {
  return await callTemplate(filter, kind, name)(target, block);
}

async function conditionHolds<T>(target: T, condition: Condition<T>): Promise<boolean> {
  const result = await makeLambda(condition as Filter<T>)(target);
  return Boolean(result);
}

async function matches<T>(env: Env<T>, callback: Callback<T>): Promise<boolean> {
  for (const condition of callback.conditions.if) {
    if (!(await conditionHolds(env.target, condition))) return false;
  }
  for (const condition of callback.conditions.unless) {
    if (!(await invertedLambda(condition as Filter<T>)(env.target))) return false;
  }
  return true;
}

/**
 * Rails' `normalize_callback_params` — the filters and the options, separated.
 *
 * A declaration reads `setCallback("save", "before", filterA, filterB, { if })`
 * and the options are the last argument only when they are not a filter. The
 * ambiguity is real — a plain object is a legitimate filter — so an object is
 * treated as options only when it has no callback method for this chain and
 * carries at least one of the keys options have.
 */
export function normalizeCallbackParams<T>(
  args: readonly unknown[],
  kind: CallbackKind = "before",
  name = "",
): { filters: Filter<T>[]; options: SetCallbackOptions<T> } {
  const last = args.at(-1);
  const isOptions =
    typeof last === "object" &&
    last !== null &&
    typeof (last as CallbackObject)[callbackMethodName(kind, name)] !== "function" &&
    ["if", "unless", "prepend"].some((key) => key in (last as object));

  return {
    filters: (isOptions ? args.slice(0, -1) : [...args]) as Filter<T>[],
    options: (isOptions ? last : {}) as SetCallbackOptions<T>,
  };
}

/**
 * Rails' `merge_conditional_options` — the conditions of a conditional skip.
 *
 * The conditions swap sides. `skipCallback(..., { if: draft })` means "do not
 * run this when it is a draft", which is the same callback with `unless:
 * draft` added — so the skip's `if` becomes the callback's `unless` and the
 * skip's `unless` becomes its `if`. Copying them across unchanged would skip
 * the callback exactly when it was meant to keep running.
 */
export function mergeConditionalOptions<T>(
  existing: { if: Condition<T>[]; unless: Condition<T>[] },
  skip: { if?: Condition<T> | Condition<T>[]; unless?: Condition<T> | Condition<T>[] },
): { if: Condition<T>[]; unless: Condition<T>[] } {
  return {
    if: [...existing.if, ...toArray(skip.unless)],
    unless: [...existing.unless, ...toArray(skip.if)],
  };
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
  drainDecorated(klass);
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

/**
 * Removes a previously registered callback, or narrows it.
 *
 * With `if` or `unless`, the callback is *kept* and made conditional rather
 * than removed — `skipCallback(Post, "save", "before", "audit", { if: draft })`
 * means "do not audit drafts", not "never audit". Removing it outright would
 * turn a narrowing into a deletion, and the auditing would stop in production
 * because a test wanted it off.
 */
export function skipCallback<T>(
  klass: object,
  name: string,
  kind: CallbackKind,
  filter: Filter<T>,
  {
    raise = true,
    ...conditions
  }: {
    raise?: boolean;
    if?: Condition<T> | Condition<T>[];
    unless?: Condition<T> | Condition<T>[];
  } = {},
): void {
  drainDecorated(klass);
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

  const callback = chain!.callbacks[index]!;

  if (conditions.if !== undefined || conditions.unless !== undefined) {
    chain!.callbacks[index] = {
      ...callback,
      conditions: mergeConditionalOptions(callback.conditions, conditions) as {
        if: Condition<unknown>[];
        unless: Condition<unknown>[];
      },
    };

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
        env.halted = await terminator(target, () =>
          invokeFilter(target, callback.filter, undefined, callback.kind, name),
        );
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
      await invokeFilter(
        target,
        callback.filter,
        async () => {
          inner = true;
          await invoke(index + 1);

          return env.value;
        },
        callback.kind,
        name,
      );
      // An around callback that never yields still has to let the chain unwind,
      // but the block and everything nested stay unrun — the same shape Rails
      // gets from a filter that does not call `yield`.
      if (!inner) env.halted = true;
      return;
    }

    await invoke(index + 1);
    if (!env.halted || !skipAfterCallbacksIfTerminated) {
      if (await matches(env, callback)) {
        await invokeFilter(target, callback.filter, undefined, callback.kind, name);
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
