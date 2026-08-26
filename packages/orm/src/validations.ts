/**
 * Validations, ported from `ActiveModel::Validations`.
 *
 * Declared on the class, as in Rails:
 *
 *     class Post extends Model<PostAttributes>("posts") {
 *       static {
 *         this.validates("title", { presence: true, length: { minimum: 3 } })
 *         this.validates("email", { uniqueness: true })
 *       }
 *     }
 *
 * Rails' messages are reproduced verbatim, because applications display them
 * and a port that reworded them would break every translated view.
 *
 * A schema validator is the better tool for checking the shape of a request
 * body — that lives on `Parameters.validate`. These exist for the rules that
 * need the record and the database: uniqueness, confirmation, conditional
 * validation on a persisted row.
 */

import { isBlank, t } from "@altair/support";
import { humanAttributeName } from "./active_model.js";

export interface LengthOptions {
  minimum?: number;
  maximum?: number;
  is?: number;
}

export interface NumericalityOptions {
  onlyInteger?: boolean;
  greaterThan?: number;
  greaterThanOrEqualTo?: number;
  lessThan?: number;
  lessThanOrEqualTo?: number;
  equalTo?: number;
  otherThan?: number;
  odd?: boolean;
  even?: boolean;
}

/**
 * What a value is compared against. Rails 7's `validates_comparison_of`.
 *
 * A number, a string or a date, and — the reason the validator exists —
 * another attribute: an end date after a start date, a maximum above a
 * minimum. Written as a function of the record rather than Rails' symbol,
 * because a function is checked by the compiler and a symbol is not.
 */
export type ComparisonTarget = unknown | ((record: never) => unknown);

export interface ComparisonOptions {
  greaterThan?: ComparisonTarget;
  greaterThanOrEqualTo?: ComparisonTarget;
  lessThan?: ComparisonTarget;
  lessThanOrEqualTo?: ComparisonTarget;
  equalTo?: ComparisonTarget;
  otherThan?: ComparisonTarget;
}

/**
 * How each comparison decides. Kept as a table so the validator reads as a
 * loop rather than six branches that differ by one character.
 */
const COMPARISONS: Record<string, (value: unknown, against: unknown) => boolean> = {
  greaterThan: (value, against) => (value as number) > (against as number),
  greaterThanOrEqualTo: (value, against) => (value as number) >= (against as number),
  lessThan: (value, against) => (value as number) < (against as number),
  lessThanOrEqualTo: (value, against) => (value as number) <= (against as number),
  equalTo: (value, against) => value === against || Number(value) === Number(against),
  otherThan: (value, against) => !(value === against || Number(value) === Number(against)),
};

export interface ValidationOptions {
  presence?: boolean;
  absence?: boolean;
  length?: LengthOptions;
  /**
   * Compares against a value or another attribute. Rails' `comparison:`.
   *
   *     this.validates("ends_on", { comparison: { greaterThan: (r) => r.starts_on } })
   *
   * Separate from `numericality` because it compares whatever the values are —
   * dates and strings included — rather than turning them into numbers first.
   */
  comparison?: ComparisonOptions;
  format?: { with?: RegExp; without?: RegExp };
  inclusion?: { in: readonly unknown[] };
  exclusion?: { in: readonly unknown[] };
  numericality?: boolean | NumericalityOptions;
  uniqueness?: boolean | { scope?: string | string[] };
  confirmation?: boolean;
  acceptance?: boolean;
  /** Rails' `allow_nil`. */
  allowNil?: boolean;
  /** Rails' `allow_blank`. */
  allowBlank?: boolean;
  /** Override the message for every rule in this declaration. */
  message?: string;
  /**
   * Only validate when this says so. Rails' `if:`.
   *
   * Takes the record, so a rule can depend on another attribute — the card
   * number that is only required when the order was paid by card.
   */
  if?: (record: never) => boolean | Promise<boolean>;
  /** The other way round. Rails' `unless:`. */
  unless?: (record: never) => boolean | Promise<boolean>;
  /**
   * Only validate in this context. Rails' `on:`.
   *
   * `"create"` and `"update"` are decided by whether the record has been
   * saved; anything else is a name a caller passes to `validate(context)`.
   * A password required on create and not on update is the reason this
   * exists, and there was no way to say it.
   */
  on?: string;
}

/**
 * Whether a declaration applies to this record right now.
 *
 * Read before the rules rather than inside each one: `if` and `on` are about
 * whether to look at all, and a rule that ran and then discarded its own
 * result would still have done the work — a uniqueness check is a query.
 */
export async function declarationApplies(
  options: ValidationOptions,
  record: object,
  context: string,
): Promise<boolean> {
  if (options.on !== undefined && options.on !== context) return false;

  if (
    options.if &&
    !(await (options.if as (value: object) => boolean | Promise<boolean>)(record))
  ) {
    return false;
  }

  if (
    options.unless &&
    (await (options.unless as (value: object) => boolean | Promise<boolean>)(record))
  ) {
    return false;
  }

  return true;
}

export interface ValidationDeclaration {
  attribute: string;
  options: ValidationOptions;
}

/**
 * The messages Rails produces, kept word for word — and now looked up rather
 * than hard-coded, so a translated application gets translated validations.
 *
 * Getters rather than constants: the locale is per request, so the message has
 * to be resolved when it is asked for, not when this module loaded.
 */
export const MESSAGES = {
  get blank() {
    return t("errors.messages.blank");
  },
  get present() {
    return t("errors.messages.present");
  },
  tooShort: (count: number) => t("errors.messages.too_short", { count }),
  tooLong: (count: number) => t("errors.messages.too_long", { count }),
  wrongLength: (count: number) => t("errors.messages.wrong_length", { count }),
  get invalid() {
    return t("errors.messages.invalid");
  },
  get inclusion() {
    return t("errors.messages.inclusion");
  },
  get exclusion() {
    return t("errors.messages.exclusion");
  },
  get notANumber() {
    return t("errors.messages.not_a_number");
  },
  get notAnInteger() {
    return t("errors.messages.not_an_integer");
  },
  greaterThan: (count: number) => t("errors.messages.greater_than", { count }),
  greaterThanOrEqualTo: (count: number) => t("errors.messages.greater_than_or_equal_to", { count }),
  lessThan: (count: number) => t("errors.messages.less_than", { count }),
  lessThanOrEqualTo: (count: number) => t("errors.messages.less_than_or_equal_to", { count }),
  equalTo: (count: number) => t("errors.messages.equal_to", { count }),
  otherThan: (count: number) => t("errors.messages.other_than", { count }),
  get odd() {
    return t("errors.messages.odd");
  },
  get even() {
    return t("errors.messages.even");
  },
  get taken() {
    return t("errors.messages.taken");
  },
  confirmation: (attribute: string) => t("errors.messages.confirmation", { attribute }),
  get required() {
    return t("errors.messages.required");
  },
  get accepted() {
    return t("errors.messages.accepted");
  },
};

export { isBlank };

export interface ValidationTarget {
  errors: { add: (attribute: string, message: string) => void };
  [key: string]: unknown;
}

/** What a uniqueness check needs to reach the database. */
export interface UniquenessProbe {
  /** Counts matching rows, optionally ignoring the record being validated. */
  exists: (conditions: Record<string, unknown>, excludeId?: unknown) => Promise<boolean>;
  isPersisted: boolean;
  id: unknown;
}

/**
 * Runs one declaration against a record.
 *
 * Each rule adds its own message, so a value can fail several at once, exactly
 * as Rails reports it.
 */
export async function runValidation(
  record: ValidationTarget,
  declaration: ValidationDeclaration,
  probe?: UniquenessProbe,
): Promise<void> {
  const { attribute, options } = declaration;
  const value = record[attribute];
  const fail = (message: string) => record.errors.add(attribute, options.message ?? message);

  if (options.presence && isBlank(value)) fail(MESSAGES.blank);
  if (options.absence && !isBlank(value)) fail(MESSAGES.present);

  // Rails skips the remaining rules for a nil or blank value when told to.
  if (options.allowNil && (value === null || value === undefined)) return;
  if (options.allowBlank && isBlank(value)) return;

  // Blank is not skipped here, and Rails does not skip it either. A length
  // validator that ignored an empty value would let `minimum: 3` through on
  // "" — which is the case it most obviously exists to catch. `allowNil` and
  // `allowBlank` above are how a caller asks for the other behaviour.
  if (options.length) {
    const length = String(value ?? "").length;
    const { minimum, maximum, is } = options.length;
    if (minimum !== undefined && length < minimum) fail(MESSAGES.tooShort(minimum));
    if (maximum !== undefined && length > maximum) fail(MESSAGES.tooLong(maximum));
    if (is !== undefined && length !== is) fail(MESSAGES.wrongLength(is));
  }

  // Nor here. `validates("email", { format: { with: /@/ } })` accepted an
  // empty string and a null, so a form submitted with the field left blank —
  // which sends "" rather than nothing — passed a validation written to stop
  // exactly that.
  if (options.format) {
    const text = String(value ?? "");
    if (options.format.with && !options.format.with.test(text)) fail(MESSAGES.invalid);
    if (options.format.without && options.format.without.test(text)) fail(MESSAGES.invalid);
  }

  if (options.inclusion && !options.inclusion.in.includes(value)) fail(MESSAGES.inclusion);
  if (options.exclusion && options.exclusion.in.includes(value)) fail(MESSAGES.exclusion);

  if (options.numericality && !isBlank(value)) {
    const numeric = Number(value);
    if (Number.isNaN(numeric)) {
      fail(MESSAGES.notANumber);
    } else {
      const rules = options.numericality === true ? {} : options.numericality;
      if (rules.onlyInteger && !Number.isInteger(numeric)) fail(MESSAGES.notAnInteger);
      if (rules.greaterThan !== undefined && numeric <= rules.greaterThan) {
        fail(MESSAGES.greaterThan(rules.greaterThan));
      }
      if (rules.greaterThanOrEqualTo !== undefined && numeric < rules.greaterThanOrEqualTo) {
        fail(MESSAGES.greaterThanOrEqualTo(rules.greaterThanOrEqualTo));
      }
      if (rules.lessThan !== undefined && numeric >= rules.lessThan) {
        fail(MESSAGES.lessThan(rules.lessThan));
      }
      if (rules.lessThanOrEqualTo !== undefined && numeric > rules.lessThanOrEqualTo) {
        fail(MESSAGES.lessThanOrEqualTo(rules.lessThanOrEqualTo));
      }
      if (rules.equalTo !== undefined && numeric !== rules.equalTo) {
        fail(MESSAGES.equalTo(rules.equalTo));
      }
      if (rules.otherThan !== undefined && numeric === rules.otherThan) {
        fail(MESSAGES.otherThan(rules.otherThan));
      }
      // 2.5 is neither odd nor even and fails whichever was asked for, which
      // the remainder already says: 2.5 % 2 is 0.5, and that is neither 0 nor
      // 1. An `Number.isInteger` guard beside this changed no answer.
      if (rules.odd && Math.abs(numeric % 2) !== 1) fail(MESSAGES.odd);
      if (rules.even && numeric % 2 !== 0) fail(MESSAGES.even);
    }
  }

  if (options.comparison) {
    // Whatever the values are, rather than numbers: this is what compares two
    // dates, and `new Date(a) > new Date(b)` is the comparison people actually
    // need. A missing value has nothing to compare, and saying so is
    // `presence`'s job rather than this one's.
    if (!isBlank(value)) {
      for (const [rule, target] of Object.entries(options.comparison)) {
        if (target === undefined) continue;

        const against =
          typeof target === "function" ? (target as (r: object) => unknown)(record) : target;
        if (against === null || against === undefined) continue;

        const ok = COMPARISONS[rule as keyof ComparisonOptions]?.(value, against);
        if (ok === false) fail(MESSAGES[rule as keyof ComparisonOptions](against as number));
      }
    }
  }

  if (options.confirmation) {
    const confirmation = record[`${attribute}_confirmation`];
    if (confirmation !== undefined && confirmation !== value) {
      fail(MESSAGES.confirmation(humanAttributeName(attribute)));
    }
  }

  if (options.acceptance && value !== true && value !== 1 && value !== "1") {
    fail(MESSAGES.accepted);
  }

  if (options.uniqueness && probe && !isBlank(value)) {
    const conditions: Record<string, unknown> = { [attribute]: value };

    const scope = options.uniqueness === true ? undefined : options.uniqueness.scope;
    for (const column of scope === undefined ? [] : Array.isArray(scope) ? scope : [scope]) {
      conditions[column] = record[column];
    }

    // A persisted record must not collide with itself, so it is excluded by id.
    const taken = await probe.exists(conditions, probe.isPersisted ? probe.id : undefined);

    if (taken) fail(MESSAGES.taken);
  }
}
