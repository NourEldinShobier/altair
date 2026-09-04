/**
 * Secure passwords, ported from `ActiveModel::SecurePassword`.
 *
 * Rails' `has_secure_password` needs bcrypt, which is a native gem. Bun hashes
 * passwords in the runtime, and its default is argon2id rather than bcrypt —
 * the algorithm that won the password hashing competition and the one current
 * guidance names first, because it is memory-hard and so costs an attacker
 * with a warehouse of graphics cards far more than it costs a login form.
 *
 *     class User extends Model<UserRow>("users") {
 *       declare password: string
 *       static { hasSecurePassword(this) }
 *     }
 *
 *     const user = await User.create({ email, password: "correct horse" })
 *     await user.authenticate("correct horse")   // the user, or null
 *
 * The plain password is never written to a column. It lives on the record long
 * enough to be hashed and validated, and the digest is what is stored.
 */

import { t } from "@altair/support";
import { humanAttributeName } from "./active-model.js";
import { Model } from "./model.js";

/** Rails' minimum. Long enough to matter, short enough that people comply. */
export const MINIMUM_PASSWORD_LENGTH = 8;

/**
 * bcrypt silently truncates at 72 bytes, which turns a long passphrase into
 * its first 72 bytes without saying so. Argon2 has no such limit; the cap is
 * here because accepting a megabyte of "password" is a way to be kept busy.
 */
export const MAXIMUM_PASSWORD_LENGTH = 256;

export interface SecurePasswordOptions {
  /** The attribute holding the plain password. Rails' `password`. */
  attribute?: string;
  /** The column the digest is stored in. */
  digestColumn?: string;
  /** Whether a record must have one. Rails validates presence by default. */
  validate?: boolean;
  /** argon2id unless told otherwise. bcrypt is there for an existing corpus. */
  algorithm?: "argon2id" | "argon2i" | "argon2d" | "bcrypt";
}

/** Hashes a password. */
export async function hashPassword(
  password: string,
  algorithm: SecurePasswordOptions["algorithm"] = "argon2id",
): Promise<string> {
  return await Bun.password.hash(password, { algorithm });
}

/**
 * Checks a password against a digest.
 *
 * Never throws for a bad digest: a row with a corrupt or empty one should fail
 * to authenticate, not fail the request. The algorithm is read from the digest
 * itself, so a corpus half-migrated from bcrypt keeps working.
 */
export async function verifyPassword(password: string, digest: string): Promise<boolean> {
  if (!digest) return false;

  try {
    return await Bun.password.verify(password, digest);
  } catch {
    return false;
  }
}

const PLAIN = Symbol("altair.model.plainPassword");

interface PasswordRecord {
  [PLAIN]?: string;
  attributes(): Record<string, unknown>;
  errors: { add(attribute: string, message: string): void };
}

type ModelClass = abstract new (...args: never[]) => object;

/**
 * Rails' `has_secure_password`.
 *
 * Adds a setter that hashes, an `authenticate` that verifies, and the
 * validations Rails adds: present, long enough, and confirmed if a
 * confirmation was given.
 */
/**
 * Something to verify against when no record was found.
 *
 * A real digest of a value nobody knows, hashed once at load rather than per
 * failed login — the point is to spend the same time as a real check, not to
 * spend it twice.
 */
const DUMMY_DIGEST = Bun.password.hashSync(crypto.randomUUID(), "argon2id");

export function hasSecurePassword<M extends ModelClass>(
  model: M,
  options: SecurePasswordOptions = {},
): void {
  const attribute = options.attribute ?? "password";
  const digestColumn = options.digestColumn ?? `${attribute}_digest`;
  const confirmation = `${attribute}Confirmation`;
  const algorithm = options.algorithm ?? "argon2id";
  const validate = options.validate ?? true;

  const target = model as unknown as typeof Model & {
    prototype: PasswordRecord;
    setCallback(name: string, kind: string, filter: unknown): void;
  };

  // A property rather than an attribute: the plain password must never reach
  // the column list, or it would be written to the table beside its own hash.
  Object.defineProperty(model.prototype, attribute, {
    configurable: true,
    get(this: PasswordRecord) {
      return this[PLAIN];
    },
    set(this: PasswordRecord, value: string | undefined) {
      this[PLAIN] = value;
    },
  });

  Object.defineProperty(model.prototype, confirmation, {
    configurable: true,
    writable: true,
    value: undefined,
  });

  /** Rails' `authenticate`: the record when it matches, null when it does not. */
  Object.defineProperty(model.prototype, "authenticate", {
    configurable: true,
    value: async function (this: PasswordRecord, password: string) {
      const digest = this.attributes()[digestColumn];
      if (typeof digest !== "string") return null;

      return (await verifyPassword(password, digest)) ? this : null;
    },
  });

  /**
   * Rails 7.1's `authenticate_by`: find by the other attributes, then check the
   * password — in constant time either way.
   *
   *     const user = await User.authenticateBy({ email, password })
   *
   * Written this way rather than as `findBy(...)` then `authenticate(...)`
   * because of what the two cost. Finding nothing is fast; finding a record and
   * verifying an argon2 hash is deliberately slow. So the obvious version
   * answers a wrong email in a millisecond and a wrong password in a hundred,
   * and anyone who can time the login form can read off which addresses have
   * accounts — one request each, no lockout, nothing in the logs to see.
   *
   * When no record matches, this verifies the given password against a digest
   * of its own so the work is done anyway and the two answers take the same
   * time.
   */
  Object.defineProperty(model, "authenticateBy", {
    configurable: true,
    value: async function (this: M, attributes: Record<string, unknown>) {
      const given = attributes[attribute];

      if (typeof given !== "string" || given.length === 0) {
        throw new Error(
          `authenticateBy needs a "${attribute}". Without one there is nothing to check, and returning a record would be a login with no password.`,
        );
      }

      const conditions: Record<string, unknown> = { ...attributes };
      delete conditions[attribute];

      if (Object.keys(conditions).length === 0) {
        throw new Error(
          `authenticateBy needs something to look the record up by besides "${attribute}".`,
        );
      }

      const record = (await (
        this as unknown as {
          findBy(where: Record<string, unknown>): Promise<PasswordRecord | null>;
        }
      ).findBy(conditions)) as PasswordRecord | null;

      if (!record) {
        // The whole point. Hashing something throwaway costs what verifying a
        // real digest costs, so "no such user" and "wrong password" take the
        // same time and the form stops answering the question.
        await verifyPassword(given, DUMMY_DIGEST);
        return null;
      }

      return await (
        record as unknown as { authenticate(password: string): Promise<unknown> }
      ).authenticate(given);
    },
  });

  if (validate) {
    target.setCallback("validation", "before", async function (this: PasswordRecord) {
      const plain = this[PLAIN];
      const digest = this.attributes()[digestColumn];

      // Absent and unchanged is fine: a record loaded and saved again should
      // not have to be given its password back.
      if (plain === undefined) {
        if (typeof digest !== "string" || digest === "") {
          this.errors.add(attribute, t("errors.messages.blank"));
        }
        return;
      }

      if (plain.length === 0) {
        this.errors.add(attribute, t("errors.messages.blank"));
        return;
      }

      if (plain.length < MINIMUM_PASSWORD_LENGTH) {
        this.errors.add(
          attribute,
          t("errors.messages.too_short", { count: MINIMUM_PASSWORD_LENGTH }),
        );
      }

      if (plain.length > MAXIMUM_PASSWORD_LENGTH) {
        this.errors.add(
          attribute,
          t("errors.messages.too_long", { count: MAXIMUM_PASSWORD_LENGTH }),
        );
      }

      const given = (this as unknown as Record<string, unknown>)[confirmation];
      if (given !== undefined && given !== plain) {
        this.errors.add(
          `${attribute}Confirmation`,
          t("errors.messages.confirmation", { attribute: humanAttributeName(attribute) }),
        );
      }
    });
  }

  // Hashed on the way to the database, not when it is assigned: hashing is
  // deliberately slow, and doing it on every assignment would make building a
  // record in a loop cost seconds.
  target.setCallback("save", "before", async function (this: PasswordRecord) {
    const plain = this[PLAIN];
    if (plain === undefined || plain === "") return;

    const record = this as unknown as Record<string, unknown>;
    record[digestColumn] = await hashPassword(plain, algorithm);
  });
}
