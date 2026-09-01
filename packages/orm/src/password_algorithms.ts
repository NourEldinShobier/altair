/**
 * Which algorithm hashed a password, ported from
 * `ActiveModel::SecurePassword`'s algorithm registry.
 *
 * `secure_password.ts` owns the declaration and the length limits. This is the
 * part that exists so an application can *change* algorithm — which it will,
 * because every password hash in production was chosen against hardware that
 * no longer exists.
 *
 * The rule that makes a migration possible: **a stored digest says which
 * algorithm made it.** bcrypt's `$2a$`, argon2's `$argon2id$`, scrypt's
 * `$scrypt$` — each carries its own parameters too. So an application can
 * verify an old digest with the old algorithm and rewrite it with the new one
 * at the next successful sign-in, and the rewrite takes as long as people take
 * to come back rather than requiring everybody to reset.
 *
 * Without that, changing algorithm means every existing password stops
 * verifying at once.
 *
 * Verification itself is not here — `secure_password.ts`'s `verifyPassword`
 * already reads the algorithm out of the digest through the runtime. What that
 * cannot answer is which algorithm *should* be used now, and whether a digest
 * that verified is one worth rewriting; that is what this registry is for.
 */

export interface PasswordAlgorithm {
  name: string;
  /** The prefix a digest of this algorithm starts with. */
  prefix: string;
  /** Whether new passwords should use it. */
  preferred: boolean;
  hash(password: string, salt: string): string;
  verify(password: string, digest: string): boolean;
}

const algorithms = new Map<string, PasswordAlgorithm>();

/**
 * Rails' `register_algorithm`.
 *
 * Refuses a second registration under one name rather than replacing. A
 * replaced algorithm makes every digest it wrote unverifiable, and the failure
 * is "wrong password" for people whose password is right — which is
 * indistinguishable from an attack and gets investigated as one.
 */
export function registerAlgorithm(algorithm: PasswordAlgorithm): void {
  const held = algorithms.get(algorithm.name);

  if (held !== undefined && held !== algorithm) {
    throw new Error(
      `An algorithm named ${JSON.stringify(algorithm.name)} is already registered. Replacing it ` +
        `would make every digest it wrote unverifiable, and the failure is "wrong password" for ` +
        `people whose password is right.`,
    );
  }

  algorithms.set(algorithm.name, algorithm);
}

export function algorithmRegistry(): Map<string, PasswordAlgorithm> {
  return new Map(algorithms);
}

export function resetAlgorithms(): void {
  algorithms.clear();
}

/**
 * Rails' `algorithm_name` — which algorithm wrote a digest.
 *
 * Read from the digest's own prefix rather than from configuration, because
 * configuration says what to write *now* and a stored digest is whatever was
 * configured when it was written. Reading configuration would make every
 * password from before the last change fail to verify.
 */
export function algorithmName(digest: string): string | undefined {
  for (const algorithm of algorithms.values()) {
    if (digest.startsWith(algorithm.prefix)) return algorithm.name;
  }

  return undefined;
}

export class UnknownPasswordAlgorithm extends Error {
  constructor(digest: string) {
    super(
      `No registered algorithm recognises this digest (it begins ` +
        `${JSON.stringify(digest.slice(0, 8))}). Treating an unrecognised digest as a failed ` +
        `password would lock out everybody whose hash was written by an algorithm this ` +
        `deployment forgot to register — which looks like a compromise rather than a ` +
        `configuration mistake.`,
    );
    this.name = "UnknownPasswordAlgorithm";
  }
}

/**
 * Rails' `lookup_algorithm` — the algorithm for a digest, or an error.
 *
 * Raises rather than returning nothing. An unrecognised digest treated as a
 * failed password locks out everybody whose hash an algorithm this deployment
 * forgot to register wrote — and that reads as a compromise rather than as a
 * configuration mistake, so it is investigated as one.
 */
export function lookupAlgorithm(digest: string): PasswordAlgorithm {
  const name = algorithmName(digest);
  const algorithm = name === undefined ? undefined : algorithms.get(name);

  if (algorithm === undefined) throw new UnknownPasswordAlgorithm(digest);

  return algorithm;
}

/** The algorithm new passwords are written with. */
export function preferredAlgorithm(): PasswordAlgorithm {
  for (const algorithm of algorithms.values()) {
    if (algorithm.preferred) return algorithm;
  }

  throw new Error(
    "No algorithm is marked preferred, so there is nothing to hash a new password with. This is " +
      "refused rather than defaulted: a default would be whichever registered first, which is " +
      "load order.",
  );
}

/**
 * Rails' `password_salt`.
 *
 * A fresh salt per password, never reused and never derived from anything
 * about the user. A salt derived from an id or an email means two people with
 * the same password have the same digest — so a leaked table shows which
 * accounts share one, and a precomputed table can be built against a known
 * address.
 */
export function passwordSalt(
  random: (bytes: number) => Uint8Array = (bytes) => crypto.getRandomValues(new Uint8Array(bytes)),
  bytes = 16,
): string {
  if (bytes < 16) {
    throw new Error(
      `A ${bytes}-byte salt is short enough that two of them collide in a table of ordinary size, ` +
        `and two identical salts are what a precomputed table needs.`,
    );
  }

  return [...random(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Whether a digest should be rewritten after a successful sign-in.
 *
 * True when it was written by anything but the preferred algorithm. This is
 * what makes a migration possible at all: the rewrite takes as long as people
 * take to come back, rather than requiring everybody to reset.
 */
export function needsRehash(digest: string): boolean {
  const name = algorithmName(digest);

  if (name === undefined) return false;

  return algorithms.get(name)?.preferred !== true;
}

/**
 * Rails' `cast_types` — the value a password attribute accepts.
 *
 * A string or nothing. A number assigned to a password field would be hashed
 * as its decimal form, so `1234` and `"1234"` produce the same digest and a
 * caller that meant one gets the other — which only matters when somebody
 * later compares against the string.
 */
export function castTypes(value: unknown): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;

  if (typeof value !== "string") {
    throw new TypeError(
      `A password has to be a string, not ${typeof value}. Coercing would hash the decimal form ` +
        `of a number, so 1234 and "1234" would produce one digest for two different values.`,
    );
  }

  return value;
}
