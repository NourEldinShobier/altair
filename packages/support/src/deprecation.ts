/**
 * Telling people a thing is going away, ported from
 * `ActiveSupport::Deprecation`.
 *
 *     const deprecator = new Deprecator("2.0", "Altair")
 *     deprecator.warn("Post.findAll is going away; use Post.all")
 *
 * The point is not the message — a comment says that — it is that the warning
 * is *routable*. A library cannot know whether its user wants deprecations on
 * stderr, in a log, reported to an error tracker, or raised outright so a test
 * suite fails on them; and the answer differs between an application's
 * development and its CI. So the warning names itself and the behaviour is the
 * application's to choose.
 *
 * Each library gets its own `Deprecator`, so an application can raise on its
 * own deprecations while only logging a dependency's — which is what makes
 * "fail the build on deprecations" a usable policy rather than one that stalls
 * on somebody else's schedule.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { notifications } from "./notifications.js";

/** Thrown by the `raise` behaviour. */
export class DeprecationException extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeprecationException";
  }
}

/** What a behaviour is handed. */
export type DeprecationBehavior = (
  message: string,
  callstack: string[],
  deprecator: Deprecator,
) => void;

/** The behaviours Rails ships, under the names it gives them. */
export type BehaviorName = "raise" | "stderr" | "log" | "silence" | "notify" | "report";

/**
 * Silencing follows the async call chain rather than being a flag on the
 * object.
 *
 * Rails scopes `silence` to the current thread, so one request silencing a
 * warning cannot silence another request's. `AsyncLocalStorage` is the same
 * idea for the same reason: without it, `await` inside a silenced block would
 * leak the silence to whatever ran while it was suspended.
 */
const silencing = new AsyncLocalStorage<boolean>();

/** Where the `log` behaviour writes. Replaceable, so a test can read it. */
export type DeprecationLogger = (message: string) => void;

const BEHAVIORS: Record<BehaviorName, DeprecationBehavior> = {
  raise(message, callstack) {
    const error = new DeprecationException(message);
    error.stack = [message, ...callstack].join("\n");
    throw error;
  },

  stderr(message, callstack, deprecator) {
    process.stderr.write(
      `DEPRECATION WARNING: ${message} ${deprecator.formatCallstack(callstack)}\n`,
    );
  },

  log(message, callstack, deprecator) {
    deprecator.logger(`DEPRECATION WARNING: ${message} ${deprecator.formatCallstack(callstack)}`);
  },

  silence() {},

  notify(message, callstack, deprecator) {
    notifications.publish(`deprecation.${deprecator.eventName}`, {
      message,
      callstack,
      deprecationHorizon: deprecator.deprecationHorizon,
      gemName: deprecator.gemName,
    });
  },

  report(message, callstack) {
    // Reported rather than thrown: the application keeps running, and the
    // error tracker gets a warning-severity entry it can count over releases.
    // Counting is what makes a deprecation actionable — one occurrence is a
    // curiosity, ten thousand is a migration.
    notifications.publish("error.reported", {
      error: new DeprecationException(message),
      severity: "warning",
      handled: true,
      source: "application",
      callstack,
    });
  },
};

export class Deprecator {
  /** The release the deprecated thing is removed in. */
  deprecationHorizon: string;
  /** Whose deprecation this is, so a message says where to look. */
  gemName: string;
  /** Where the `log` behaviour writes. */
  logger: DeprecationLogger = (message) => {
    console.warn(message);
  };

  #behavior: DeprecationBehavior[] = [BEHAVIORS.stderr];
  #disallowedBehavior: DeprecationBehavior[] = [BEHAVIORS.raise];
  #disallowed: (string | RegExp)[] = [];
  #silenced = false;

  constructor(deprecationHorizon = "next release", gemName = "Application") {
    this.deprecationHorizon = deprecationHorizon;
    this.gemName = gemName;
  }

  /**
   * The event name `notify` publishes under, from the library's name.
   *
   * `MyGem::Custom` becomes `my_gem_custom`, exactly as Rails derives it, so a
   * subscriber written against Rails' convention works unchanged.
   */
  get eventName(): string {
    return this.gemName
      .replace(/::/g, "_")
      .replace(/([a-z\d])([A-Z])/g, "$1_$2")
      .toLowerCase();
  }

  get behavior(): DeprecationBehavior[] {
    return this.#behavior;
  }

  /**
   * Sets the behaviour, by name, by function, or by a list of either.
   *
   * A list because more than one answer is often right at once: log it *and*
   * notify, so the deprecation is both visible now and countable later.
   * `null` is ignored rather than treated as silence — Rails does the same,
   * since an unset configuration should not quietly turn warnings off.
   */
  set behavior(
    value: BehaviorName | DeprecationBehavior | (BehaviorName | DeprecationBehavior)[] | null,
  ) {
    this.#behavior = value === null ? this.#behavior : resolveBehaviors(value);
  }

  get disallowedBehavior(): DeprecationBehavior[] {
    return this.#disallowedBehavior;
  }

  set disallowedBehavior(
    value: BehaviorName | DeprecationBehavior | (BehaviorName | DeprecationBehavior)[] | null,
  ) {
    this.#disallowedBehavior = value === null ? this.#disallowedBehavior : resolveBehaviors(value);
  }

  /**
   * Warnings that are past being warnings.
   *
   * A deprecation nobody acted on for two releases needs to stop being
   * skippable, and this is how it escalates without escalating every warning
   * at once: name the ones whose time is up, and they take the disallowed
   * behaviour — raising, by default — while the rest keep logging.
   */
  get disallowedWarnings(): (string | RegExp)[] {
    return this.#disallowed;
  }

  set disallowedWarnings(value: (string | RegExp)[]) {
    this.#disallowed = value;
  }

  get silenced(): boolean {
    return this.#silenced || (silencing.getStore() ?? false);
  }

  set silenced(value: boolean) {
    this.#silenced = value;
  }

  /**
   * Runs the block with warnings off, and returns whatever it returned.
   *
   * Scoped rather than a flag you set and unset: an error inside the block
   * must not leave the process silenced, and `AsyncLocalStorage` restores it
   * without a `finally` that a future edit can drop.
   */
  silence<T>(body: () => T): T {
    return silencing.run(true, body);
  }

  /** Emits a deprecation warning through the configured behaviour. */
  warn(
    message = "You are using deprecated behavior which will be removed in the next major release.",
    callstack?: string[],
  ): void {
    if (this.silenced) return;

    const full = `${message} (called from ${this.gemName}; removed in ${this.deprecationHorizon})`;
    const stack = callstack ?? currentCallstack();
    const behaviors = this.#isDisallowed(message) ? this.#disallowedBehavior : this.#behavior;

    for (const behavior of behaviors) behavior(full, stack, this);
  }

  #isDisallowed(message: string): boolean {
    return this.#disallowed.some((one) =>
      typeof one === "string" ? message.includes(one) : one.test(message),
    );
  }

  /**
   * The warning a deprecated method emits. Rails' `deprecation_warning`.
   *
   * Named separately from `warn` so the common case reads as one call and
   * still produces Rails' phrasing — which matters because people grep their
   * logs for it.
   */
  deprecationWarning(name: string, alternative?: string, callstack?: string[]): void {
    const advice = alternative ? ` (use ${alternative} instead)` : "";

    this.warn(`${name} is deprecated and will be removed${advice}`, callstack);
  }

  /**
   * Wraps methods so calling one warns first. Rails' `deprecate_methods`.
   *
   * The wrapper delegates rather than replacing, so the deprecated method keeps
   * working — which is the whole difference between a deprecation and a
   * removal, and the reason a caller has a release to act in.
   */
  deprecateMethods(
    target: object,
    methods: Record<string, string | undefined> | readonly string[],
  ): void {
    const entries = Array.isArray(methods)
      ? methods.map((name) => [name, undefined] as const)
      : Object.entries(methods as Record<string, string | undefined>);

    for (const [name, alternative] of entries) {
      const original = (target as Record<string, unknown>)[name];
      if (typeof original !== "function") continue;

      Object.defineProperty(target, name, {
        configurable: true,
        writable: true,
        value: (...args: unknown[]): unknown => {
          this.deprecationWarning(name, alternative ?? undefined);
          return (original as (...rest: unknown[]) => unknown).apply(target, args);
        },
      });
    }
  }

  /** How a callstack is written into a message. */
  formatCallstack(callstack: string[]): string {
    return callstack.length > 0 ? `(called from ${callstack[0]})` : "";
  }
}

function resolveBehaviors(
  value: BehaviorName | DeprecationBehavior | (BehaviorName | DeprecationBehavior)[],
): DeprecationBehavior[] {
  const list = Array.isArray(value) ? value : [value];

  return list.map((one) => {
    if (typeof one === "function") return one;

    const behavior = BEHAVIORS[one];
    // Named rather than ignored: a typo in configuration that silently kept
    // the old behaviour would be found only by noticing warnings had stopped.
    if (!behavior) {
      throw new TypeError(
        `Unknown deprecation behavior "${String(one)}". ` +
          `Use one of: ${Object.keys(BEHAVIORS).join(", ")}, or a function.`,
      );
    }

    return behavior;
  });
}

function currentCallstack(): string[] {
  const { stack } = new Error();

  return (stack ?? "")
    .split("\n")
    .slice(3)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * The deprecators an application knows about, by name. Rails' `Deprecators`.
 *
 * What makes a single policy possible: an application sets `behavior` once
 * across every library that registered one, rather than hunting for each
 * library's own configuration hook.
 */
export class Deprecators {
  #all = new Map<string, Deprecator>();

  set(name: string, deprecator: Deprecator): void {
    this.#all.set(name, deprecator);
  }

  get(name: string): Deprecator | undefined {
    return this.#all.get(name);
  }

  get names(): string[] {
    return [...this.#all.keys()];
  }

  /** Applies one behaviour to every registered deprecator. */
  set behavior(value: BehaviorName | DeprecationBehavior | (BehaviorName | DeprecationBehavior)[]) {
    for (const deprecator of this.#all.values()) deprecator.behavior = value;
  }

  set silenced(value: boolean) {
    for (const deprecator of this.#all.values()) deprecator.silenced = value;
  }

  set disallowedWarnings(value: (string | RegExp)[]) {
    for (const deprecator of this.#all.values()) deprecator.disallowedWarnings = value;
  }

  /** Silences every registered deprecator for the block. */
  silence<T>(body: () => T): T {
    return silencing.run(true, body);
  }
}

/** The framework's own deprecator, and the registry an application configures. */
export const deprecator = new Deprecator();
export const deprecators = new Deprecators();

deprecators.set("altair", deprecator);
