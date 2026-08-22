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
