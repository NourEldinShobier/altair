/**
 * `withOptions`, ported from `Object#with_options` in
 * `activesupport/lib/active_support/core_ext/object/with_options.rb` and
 * `ActiveSupport::OptionMerger` in
 * `activesupport/lib/active_support/option_merger.rb`.
 *
 * An option repeated across a run of calls is duplication that only ever gets
 * worse:
 *
 *     Account.hasMany("customers", () => Customer, { foreignKey, dependent: "destroy" })
 *     Account.hasMany("products", () => Product, { foreignKey, dependent: "destroy" })
 *     Account.hasMany("invoices", () => Invoice, { foreignKey, dependent: "destroy" })
 *
 * The failure is not the typing. It is the fourth association, added a year
 * later by somebody reading the three above as a shape rather than as four
 * independent decisions, who leaves `dependent` off. Nothing breaks that day.
 * The rows are orphaned from then on, and the bug surfaces as a report that
 * counts more invoices than accounts.
 *
 *     const assoc = withOptions(Account, { dependent: "destroy" })
 *     assoc.hasMany("customers", () => Customer, { foreignKey })
 *     assoc.hasMany("products", () => Product, { foreignKey })
 *
 * Now the option is stated once, and the fourth association gets it by being
 * written in the same place as the others.
 *
 * The block form Rails takes is left out. It exists there because a block can
 * be `instance_eval`'d, which gives the implicit-receiver form; there is no
 * implicit receiver to give here, so a block would be a pair of braces around
 * calls that read the same without them.
 */

import { deepMerge } from "./hash.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;

  const prototype: unknown = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

/**
 * What a call's arguments become once the defaults are folded in.
 *
 * Three shapes, and the order matters. Rails' `method_missing` decides in the
 * same order for the same reasons.
 */
function withDefaults(args: readonly unknown[], defaults: Record<string, unknown>): unknown[] {
  // A lone function is a value produced later — a scope's body — so the
  // defaults have to reach what it returns rather than sit beside it.
  if (args.length === 1 && typeof args[0] === "function") {
    const body = args[0] as (...inner: unknown[]) => Record<string, unknown>;

    return [(...inner: unknown[]) => deepMerge(defaults, body(...inner))];
  }

  const last = args.at(-1);

  // The call's own options win, which is what makes a default a default: the
  // one association that must not cascade says so and is obeyed.
  if (isPlainObject(last)) return [...args.slice(0, -1), deepMerge(defaults, last)];

  // A fresh object every call, never `defaults` itself. A method that keeps
  // what it was handed — every association declaration does — would otherwise
  // share one object with every other call through this merger, and the first
  // one to write to it changes the rest.
  return [...args, deepMerge(defaults, {})];
}

/**
 * `context` with `defaults` folded into the options of every call made through
 * it.
 *
 * Nesting needs no support of its own: the result is a context like any other,
 * so `withOptions(withOptions(x, a), b)` merges `b` and then hands the call to
 * the merger holding `a`. Deeper defaults survive, nearer ones win.
 */
export function withOptions<T extends object>(context: T, defaults: Record<string, unknown>): T {
  return new Proxy(context, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);

      if (typeof value !== "function") return value;

      // Applied to `target`, not to the proxy: the receiver a method sees has
      // to be the real object, or a private field read inside it throws.
      return (...args: unknown[]) =>
        (value as (this: T, ...a: unknown[]) => unknown).apply(
          target,
          withDefaults(args, defaults),
        );
    },
  });
}
