/**
 * Encrypted credentials, ported from `Rails::Application::Credentials` and
 * `ActiveSupport::EncryptedFile`.
 *
 * The problem this solves: an application needs an API key, a Stripe secret
 * and a database password, and none of them can go in the repository. The
 * usual answer is a `.env` file that is never committed, which means every new
 * machine starts by asking someone to send it over a chat window, and nothing
 * records what the file is supposed to contain.
 *
 * Rails' answer is to commit the secrets encrypted and keep exactly one thing
 * out of the repository: the key.
 *
 *     config/credentials.yml.enc   committed, useless without the key
 *     config/master.key            never committed, or ALTAIR_MASTER_KEY
 *
 *     app.credentials.get("stripe.secret_key")
 *
 * Per environment, as Rails does: `config/credentials/production.yml.enc`
 * with `config/credentials/production.key` takes precedence when it exists, so
 * production secrets can be held by fewer people than development ones.
 *
 * Reading is synchronous. Boot needs the secret key base before it can build
 * anything, and a promise there would make every caller of `buildConfig`
 * async for a file read that takes microseconds.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { MessageEncryptor } from "@altair/support";
import type { Environment } from "./config.js";

/** The environment variable the key can come from instead of a file. */
export const MASTER_KEY_ENV = "ALTAIR_MASTER_KEY";

/** Raised when the file is there and the key is not. */
export class MissingKey extends Error {
  constructor(keyPath: string) {
    super(
      `Cannot read the credentials: no key. Put it in ${keyPath} or set ${MASTER_KEY_ENV}. ` +
        `The key is the one thing that is not in the repository, so a fresh checkout has to be given it.`,
    );
    this.name = "MissingKey";
  }
}

/** Raised when the key does not decrypt the file. */
export class InvalidKey extends Error {
  constructor(contentPath: string) {
    super(
      `The key does not decrypt ${contentPath}. It is the wrong key, or the file was edited by hand ` +
        `— the ciphertext is authenticated, so a changed byte fails rather than decrypting to nonsense.`,
    );
    this.name = "InvalidKey";
  }
}

/** A new master key: 32 bytes, hex, which is what AES-256-GCM takes. */
export function generateMasterKey(): string {
  return randomBytes(32).toString("hex");
}

export interface EncryptedFileOptions {
  /** The `.enc` file. Committed. */
  contentPath: string;
  /** The key file. Not committed. */
  keyPath: string;
  /** An environment variable to read the key from instead. */
  envKey?: string;
  env?: Record<string, string | undefined>;
}

/**
 * A file whose contents are encrypted at rest.
 *
 * The contents are text, not a parsed structure: what someone typed is what is
 * stored, comments and blank lines included. Re-serializing on every save
 * would rewrite a person's file every time they touched it.
 */
export class EncryptedFile {
  readonly contentPath: string;
  readonly keyPath: string;

  #envKey: string;
  #env: Record<string, string | undefined>;

  constructor(options: EncryptedFileOptions) {
    this.contentPath = options.contentPath;
    this.keyPath = options.keyPath;
    this.#envKey = options.envKey ?? MASTER_KEY_ENV;
    this.#env = options.env ?? process.env;
  }

  get exists(): boolean {
    return existsSync(this.contentPath);
  }

  /** The key, from the environment first so a deploy needs no file. */
  key(): string {
    const fromEnv = this.#env[this.#envKey];
    if (fromEnv) return fromEnv.trim();

    if (!existsSync(this.keyPath)) throw new MissingKey(this.keyPath);
    return readFileSync(this.keyPath, "utf8").trim();
  }

  get hasKey(): boolean {
    return Boolean(this.#env[this.#envKey]) || existsSync(this.keyPath);
  }

  #encryptor(): MessageEncryptor {
    const key = this.key();

    if (!/^[0-9a-f]{64}$/i.test(key)) {
      throw new Error(
        `The key in ${this.keyPath} is not 64 hex characters. Generate one with \`altair credentials:edit\`.`,
      );
    }

    return new MessageEncryptor(Buffer.from(key, "hex"));
  }

  /** The decrypted contents, or an empty string when there is no file yet. */
  read(): string {
    if (!this.exists) return "";

    const contents = this.#encryptor().decrypt<string>(
      readFileSync(this.contentPath, "utf8").trim(),
    );

    if (contents === null) throw new InvalidKey(this.contentPath);
    return contents;
  }

  write(contents: string): void {
    mkdirSync(dirname(this.contentPath), { recursive: true });
    writeFileSync(this.contentPath, this.#encryptor().encrypt(contents));
  }

  /** Writes the key file if it is not there yet, and returns the key. */
  ensureKey(): string {
    if (this.hasKey) return this.key();

    const key = generateMasterKey();
    mkdirSync(dirname(this.keyPath), { recursive: true });
    writeFileSync(this.keyPath, `${key}\n`);

    return key;
  }
}

/** What a fresh credentials file starts as. Rails' template, near enough. */
export const CREDENTIALS_TEMPLATE = `# Anything in here is encrypted at rest and committed with the repository.
# The key that reads it is not: keep config/master.key out of git, or set
# ALTAIR_MASTER_KEY in the environment.
#
# Read it back with:
#
#   app.credentials.get("stripe.secret_key")

# Signs and encrypts cookies and sessions. Losing it logs everybody out.
secret_key_base: %{secret}
`;

export interface CredentialsOptions extends EncryptedFileOptions {}

/**
 * The credentials themselves: an encrypted YAML file, read as a structure.
 *
 * YAML rather than JSON because this is a file people edit by hand, and a
 * format with comments is worth more here than one with fewer rules.
 */
export class Credentials {
  readonly file: EncryptedFile;

  #cache: Record<string, unknown> | undefined;

  constructor(options: CredentialsOptions) {
    this.file = new EncryptedFile(options);
  }

  get exists(): boolean {
    return this.file.exists;
  }

  /** Everything, parsed. Read once; a boot should not decrypt repeatedly. */
  config(): Record<string, unknown> {
    if (this.#cache) return this.#cache;

    const contents = this.file.read();
    if (!contents.trim()) return (this.#cache = {});

    // A file of nothing but comments parses to null, and means no credentials
    // rather than a broken file — which is what a freshly created one is.
    const parsed = (Bun.YAML.parse(contents) ?? {}) as unknown;
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${this.file.contentPath} does not decrypt to a YAML mapping.`);
    }

    return (this.#cache = parsed as Record<string, unknown>);
  }

  /**
   * One value, by a dotted path. Rails writes `credentials.aws.access_key_id`.
   *
   * Returns undefined rather than throwing, because the common case is a key
   * an application has not set yet and can fall back for.
   */
  get<T = unknown>(path: string): T | undefined {
    let value: unknown = this.config();

    for (const segment of path.split(".")) {
      if (value === null || typeof value !== "object") return undefined;
      value = (value as Record<string, unknown>)[segment];
    }

    return value as T | undefined;
  }

  write(contents: string): void {
    this.file.write(contents);
    this.#cache = undefined;
  }

  /** Forgets the parsed copy, so the next read decrypts again. */
  reload(): void {
    this.#cache = undefined;
  }
}

/**
 * The credentials for an environment, following Rails' precedence.
 *
 * A per-environment file wins when it exists, so the production secrets can be
 * held by fewer people than the development ones — which is the point of
 * having more than one file.
 */
export function credentialsFor(
  env: Environment,
  root: string,
  environment: Record<string, string | undefined> = process.env,
): Credentials {
  const scoped = {
    contentPath: join(root, "config", "credentials", `${env}.yml.enc`),
    keyPath: join(root, "config", "credentials", `${env}.key`),
    env: environment,
  };

  if (existsSync(scoped.contentPath)) return new Credentials(scoped);

  return new Credentials({
    contentPath: join(root, "config", "credentials.yml.enc"),
    keyPath: join(root, "config", "master.key"),
    env: environment,
  });
}

/**
 * The secret key base from the credentials, or undefined.
 *
 * Quiet when there is no file or no key: credentials are one of several places
 * a secret can come from, and an application configured entirely through the
 * environment should not fail to boot over a file it does not use. Loud when
 * there is a file and the key does not open it, because that is a mistake, and
 * "SECRET_KEY_BASE is required" would be the wrong thing to say about it.
 */
export function secretKeyBaseFromCredentials(
  env: Environment,
  root: string,
  environment: Record<string, string | undefined> = process.env,
): string | undefined {
  const credentials = credentialsFor(env, root, environment);
  if (!credentials.exists || !credentials.file.hasKey) return undefined;

  const secret = credentials.get<string>("secret_key_base");
  return typeof secret === "string" ? secret : undefined;
}
