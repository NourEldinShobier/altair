/**
 * Decorators for callback chains.
 *
 * Rails declares callbacks away from the method they name:
 *
 *     before_save :normalize_title
 *
 * The method name is a symbol, so nothing checks that `normalize_title`
 * exists, renaming it silently breaks the hook, and "find usages" never points
 * at the declaration. Those are real costs Rails pays for the macro.
 *
 * TypeScript can do better without changing the model. A decorator sits on the
 * method itself, so the compiler resolves it, an IDE rename updates it, and the
 * declaration is where the code is:
 *
 *     class Post extends Model {
 *       @beforeSave
 *       normalizeTitle() { this.slug ??= slugify(this.title) }
 *     }
 *
 * The chain machinery underneath is unchanged — this registers exactly what
 * `setCallback` would.
 */

import {
  type CallbackKind,
  PENDING,
  type PendingCallback,
  type SetCallbackOptions,
} from "./callbacks.js";

type MetadataHolder = Record<PropertyKey, unknown>;

/**
 * Decorator metadata prototype-chains from the parent class, so a plain `??=`
 * would append a subclass's callbacks onto the parent's array. Each class gets
 * its own list; inheritance is handled by the chain itself.
 */
function pendingFor(metadata: MetadataHolder): PendingCallback[] {
  if (!Object.hasOwn(metadata, PENDING)) metadata[PENDING] = [];
  return metadata[PENDING] as PendingCallback[];
}

/** Builds a decorator that registers the method it annotates on a chain. */
function callbackDecorator<This extends object>(
  chain: string,
  kind: CallbackKind,
  options: SetCallbackOptions<This>,
) {
  return function decorate(_value: unknown, context: ClassMethodDecoratorContext<This>): void {
    if (context.static) {
      throw new TypeError(`@${kind}("${chain}") cannot be used on a static method`);
    }
    if (!context.metadata) {
      throw new TypeError(
        "Decorator metadata is unavailable. Ensure Symbol.metadata is defined before class definition.",
      );
    }
    pendingFor(context.metadata as MetadataHolder).push({
      chain,
      kind,
      method: String(context.name),
      options: options as SetCallbackOptions<unknown>,
    });
  };
}

/**
 * A decorator usable bare or called with options.
 *
 * Both forms read naturally, and the overloads keep `this` typed inside a
 * conditional so `{ if: "isPublished" }` is checked against the class.
 */
export interface CallbackDecorator {
  <This extends object>(value: unknown, context: ClassMethodDecoratorContext<This>): void;
  <This extends object>(
    options: SetCallbackOptions<This>,
  ): (value: unknown, context: ClassMethodDecoratorContext<This>) => void;
}

function makeDecorator(chain: string, kind: CallbackKind): CallbackDecorator {
  return function decorator(
    valueOrOptions: unknown,
    context?: ClassMethodDecoratorContext<object>,
  ): unknown {
    if (context) {
      return callbackDecorator(chain, kind, {})(valueOrOptions, context);
    }
    return callbackDecorator(chain, kind, (valueOrOptions ?? {}) as SetCallbackOptions<object>);
  } as CallbackDecorator;
}

/**
 * Creates the three decorators for a chain.
 *
 *     const { before: beforeSave, after: afterSave } = callbacksFor("save")
 *
 * The ORM and the controller layer each export their own named set, so an app
 * writes `@beforeSave` rather than `@before("save")`.
 */
export function callbackDecorators(chain: string): {
  before: CallbackDecorator;
  around: CallbackDecorator;
  after: CallbackDecorator;
} {
  return {
    before: makeDecorator(chain, "before"),
    around: makeDecorator(chain, "around"),
    after: makeDecorator(chain, "after"),
  };
}

/** `@before("save")` — the generic form, for chains without named sugar. */
export function before<This extends object>(chain: string, options: SetCallbackOptions<This> = {}) {
  return callbackDecorator<This>(chain, "before", options);
}

/** `@around("save")` — the annotated method receives the block to wrap. */
export function around<This extends object>(chain: string, options: SetCallbackOptions<This> = {}) {
  return callbackDecorator<This>(chain, "around", options);
}

/** `@after("save")` */
export function after<This extends object>(chain: string, options: SetCallbackOptions<This> = {}) {
  return callbackDecorator<This>(chain, "after", options);
}

/**
 * The decorators a set of events gets, named the way Rails names them.
 *
 * A mapped type rather than `Record<string, …>`, so a destructured
 * `beforeCreate` is a decorator rather than one that might be undefined — and
 * so a mistyped `beforeCraete` is a compile error rather than a callback that
 * never runs.
 */
export type ModelCallbackDecorators<Event extends string, Kind extends CallbackKind> = {
  [E in Event as `${Kind}${Capitalize<E>}`]: CallbackDecorator;
};

/**
 * Declares a lifecycle event and hands back the decorators for it. Rails'
 * `define_model_callbacks`.
 *
 *     const { beforeCreate, afterCreate } = defineModelCallbacks("create")
 *
 *     class Signup {
 *       @beforeCreate
 *       normalise() { this.email = this.email.trim() }
 *
 *       async create() {
 *         await runCallbacks(this, "create", () => save(this))
 *       }
 *     }
 *
 * Two things in one call, because they are useless apart. `defineCallbacks`
 * gives a class a chain with nothing to put on it, and `callbackDecorators`
 * gives decorators for a chain that may not exist — declaring an event means
 * doing both, and doing them separately is how they come to disagree about
 * the name, which fails as a callback that silently never runs.
 *
 * No class, and that is the one place this cannot follow Rails. Rails calls
 * this inside the class body, where `self` is the class; a TypeScript
 * decorator is evaluated *before* the class binding exists, so a caller who
 * wants the decorators cannot yet name the class they belong to. It needs
 * none: the first callback added creates the chain, which is what
 * `setCallback` has always done. An event that needs a terminator or
 * `skipAfterCallbacksIfTerminated` declares it with `defineCallbacks`, which
 * takes the class and the configuration together.
 *
 * `only` narrows which kinds are made, as Rails' does. An event with no
 * `around` is one a caller cannot wrap, which is worth being able to say:
 * `around` is the kind that can swallow the block.
 *
 * Names are camel-cased into the decorator — `create` gives `beforeCreate` —
 * while the chain keeps the name it was given, because that is what
 * `runCallbacks` is called with.
 */
export function defineModelCallbacks<
  const Event extends string,
  const Kind extends CallbackKind = CallbackKind,
>(
  names: Event | readonly Event[],
  options: { only?: readonly Kind[] } = {},
): ModelCallbackDecorators<Event, Kind> {
  const wanted =
    options.only ?? (["before", "around", "after"] as readonly CallbackKind[] as readonly Kind[]);
  const events = typeof names === "string" ? [names] : names;
  const decorators: Record<string, CallbackDecorator> = {};

  for (const event of events) {
    const capitalised = `${event.charAt(0).toUpperCase()}${event.slice(1)}`;

    for (const kind of wanted) decorators[`${kind}${capitalised}`] = makeDecorator(event, kind);
  }

  return decorators as ModelCallbackDecorators<Event, Kind>;
}
