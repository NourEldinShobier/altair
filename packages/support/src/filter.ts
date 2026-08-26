/**
 * Keeping secrets out of logs, ported from `ActiveSupport::ParameterFilter`.
 *
 * Rails filters `password` out of every logged parameter hash by default, and
 * this did not — so a sign-in request wrote the password into the log, and a
 * card number went wherever the log went. Not a leak an application can be
 * expected to notice: everything works, and the evidence is in a file nobody
 * reads until they have to.
 *
 *     const filter = new ParameterFilter(["password", "token"])
 *     filter.filter({ user: { password: "hunter2" } })
 *     // { user: { password: "[FILTERED]" } }
 *
 * A name matches anywhere in the key, as Rails matches: `password` catches
 * `password_confirmation` and `user[password]` without either being listed.
 */

/** What Rails writes in place of a filtered value. */
export const FILTERED = "[FILTERED]";

/**
 * The keys Rails filters out of a new application, and the ones worth having
 * before anybody thinks to add their own.
 */
export const DEFAULT_FILTERS: readonly (string | RegExp)[] = [
  "passw",
  "email",
  "secret",
  "token",
  "_key",
  "crypt",
  "salt",
  "certificate",
  "otp",
  "ssn",
  "cvv",
  "cvc",
];

export class ParameterFilter {
  #matchers: RegExp[];

  constructor(filters: readonly (string | RegExp)[] = DEFAULT_FILTERS) {
    this.#matchers = filters.map((filter) =>
      typeof filter === "string"
        ? // Anywhere in the key, case-insensitively: `passw` has to catch
          // `password`, `password_confirmation` and `PasswordDigest`, and
          // listing every spelling is how one gets missed.
          new RegExp(escapeRegExp(filter), "i")
        : filter,
    );
  }

  /** Whether a key names something that should not be written down. */
  matches(key: string): boolean {
    return this.#matchers.some((matcher) => matcher.test(key));
  }

  /**
   * A copy with every secret replaced.
   *
   * A copy rather than an edit in place: the thing being filtered is usually
   * the parameters the request is still using, and filtering them for the log
   * must not change what the controller reads.
   */
  filter<T>(value: T): T {
    return this.#walk(value, false) as T;
  }

  #walk(value: unknown, insideFiltered: boolean): unknown {
    if (Array.isArray(value)) return value.map((one) => this.#walk(one, insideFiltered));

    if (
      value !== null &&
      typeof value === "object" &&
      Object.getPrototypeOf(value) === Object.prototype
    ) {
      return Object.fromEntries(
        Object.entries(value as object).map(([key, one]) => {
          // A filtered key filters everything under it. `credentials: { aws:
          // { secret } }` should not leak because the inner key was spelled
          // differently.
          const filtered = insideFiltered || this.matches(key);

          if (filtered && (one === null || typeof one !== "object")) return [key, FILTERED];

          return [key, this.#walk(one, filtered)];
        }),
      );
    }

    return insideFiltered ? FILTERED : value;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
