/**
 * Encrypted credentials.
 *
 * Mirrors railties/test/application/configuration/credentials_test.rb and
 * activesupport/test/encrypted_file_test.rb. Real files in a real temporary
 * directory: this is a feature about files on disk, and stubbing the disk
 * would leave the interesting half untested.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildConfig,
  credentialsFor,
  Credentials,
  EncryptedFile,
  generateMasterKey,
  InvalidKey,
  MASTER_KEY_ENV,
  MissingKey,
} from "../src/index.js";

let root: string;

const paths = (name = "credentials") => ({
  contentPath: join(root, "config", `${name}.yml.enc`),
  keyPath: join(root, "config", "master.key"),
});

/** A file with a key already in place. */
const withKey = (env: Record<string, string | undefined> = {}) => {
  const file = new EncryptedFile({ ...paths(), env });
  file.ensureKey();
  return file;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "altair-credentials-"));
  mkdirSync(join(root, "config"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the key", () => {
  it("is 32 bytes of hex, which is what AES-256-GCM takes", () => {
    expect(generateMasterKey()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is a different one every time", () => {
    expect(generateMasterKey()).not.toBe(generateMasterKey());
  });

  it("is written once and kept", () => {
    const file = new EncryptedFile({ ...paths(), env: {} });

    const first = file.ensureKey();
    expect(file.ensureKey()).toBe(first);
    expect(readFileSync(paths().keyPath, "utf8").trim()).toBe(first);
  });

  // A deploy should not need a file on the box.
  it("comes from the environment before the file", () => {
    const fromFile = new EncryptedFile({ ...paths(), env: {} });
    fromFile.ensureKey();

    const key = generateMasterKey();
    const fromEnv = new EncryptedFile({ ...paths(), env: { [MASTER_KEY_ENV]: key } });

    expect(fromEnv.key()).toBe(key);
    expect(fromEnv.key()).not.toBe(fromFile.key());
  });

  it("says where to put it when there is none", () => {
    const file = new EncryptedFile({ ...paths(), env: {} });

    expect(() => file.key()).toThrow(MissingKey);
    expect(() => file.key()).toThrow(new RegExp(MASTER_KEY_ENV));
  });

  it("refuses one that is not a key", () => {
    const file = new EncryptedFile({ ...paths(), env: { [MASTER_KEY_ENV]: "hunter2" } });

    expect(() => file.write("x: 1")).toThrow(/64 hex characters/);
  });
});

describe("the encrypted file", () => {
  it("round-trips what was written", () => {
    const file = withKey();
    file.write("secret_key_base: abc\n");

    expect(file.read()).toBe("secret_key_base: abc\n");
  });

  // The point of the whole scheme: the committed file gives nothing away.
  it("stores nothing readable", () => {
    const file = withKey();
    file.write("stripe_key: sk_live_treasure");

    expect(readFileSync(paths().contentPath, "utf8")).not.toContain("treasure");
  });

  it("is empty before anything is written", () => {
    expect(withKey().exists).toBe(false);
    expect(withKey().read()).toBe("");
  });

  it("keeps what was typed, comments and all", () => {
    const file = withKey();
    const written = "# a note\n\nkey: value   # trailing\n";
    file.write(written);

    expect(file.read()).toBe(written);
  });

  it("is different ciphertext each time, for the same text", () => {
    const file = withKey();
    file.write("a: 1");
    const first = readFileSync(paths().contentPath, "utf8");

    file.write("a: 1");
    expect(readFileSync(paths().contentPath, "utf8")).not.toBe(first);
  });

  it("refuses to open with the wrong key", () => {
    withKey().write("a: 1");

    const wrong = new EncryptedFile({
      ...paths(),
      env: { [MASTER_KEY_ENV]: generateMasterKey() },
    });

    expect(() => wrong.read()).toThrow(InvalidKey);
  });

  // The ciphertext is authenticated, so a changed byte fails rather than
  // decrypting into something unexpected.
  it("refuses a file that was edited by hand", () => {
    const file = withKey();
    file.write("a: 1");

    // Changed to something the first character definitely is not. Replacing
    // it with a fixed letter left the file untouched whenever the ciphertext
    // already began with that letter — a one-in-sixty-four flake, which CI
    // duly found.
    const stored = readFileSync(paths().contentPath, "utf8");
    const tampered = (stored.startsWith("Z") ? "Y" : "Z") + stored.slice(1);
    writeFileSync(paths().contentPath, tampered);

    expect(() => file.read()).toThrow(InvalidKey);
  });
});

describe("reading them", () => {
  const write = (yaml: string) => {
    const credentials = new Credentials({ ...paths(), env: {} });
    credentials.file.ensureKey();
    credentials.write(yaml);
    return credentials;
  };

  it("parses the YAML", () => {
    const credentials = write("secret_key_base: abc\nstripe:\n  secret_key: sk_test\n");

    expect(credentials.config()).toEqual({
      secret_key_base: "abc",
      stripe: { secret_key: "sk_test" },
    });
  });

  it("reads a nested value by a dotted path", () => {
    const credentials = write("aws:\n  s3:\n    bucket: uploads\n");

    expect(credentials.get<string>("aws.s3.bucket")).toBe("uploads");
  });

  // The common case is a key the application has not set yet.
  it("answers undefined for a key that is not there", () => {
    const credentials = write("a: 1");

    expect(credentials.get("nothing")).toBeUndefined();
    expect(credentials.get("a.b.c")).toBeUndefined();
  });

  it("treats an empty file as no credentials", () => {
    expect(write("").config()).toEqual({});
    expect(write("# only a comment\n").config()).toEqual({});
  });

  it("refuses something that is not a mapping", () => {
    expect(() => write("- one\n- two\n").config()).toThrow(/mapping/);
  });

  it("decrypts once", () => {
    const credentials = write("a: 1");
    expect(credentials.config()).toBe(credentials.config());
  });

  it("decrypts again after a write", () => {
    const credentials = write("a: 1");
    expect(credentials.get<number>("a")).toBe(1);

    credentials.write("a: 2");
    expect(credentials.get<number>("a")).toBe(2);
  });
});

describe("choosing the file for an environment", () => {
  const writeScoped = (env: string) => {
    mkdirSync(join(root, "config", "credentials"), { recursive: true });

    const file = new EncryptedFile({
      contentPath: join(root, "config", "credentials", `${env}.yml.enc`),
      keyPath: join(root, "config", "credentials", `${env}.key`),
      env: {},
    });

    file.ensureKey();
    file.write(`from: ${env}\n`);
  };

  it("falls back to the shared one", () => {
    const shared = new Credentials({ ...paths(), env: {} });
    shared.file.ensureKey();
    shared.write("from: shared\n");

    expect(credentialsFor("production", root, {}).get<string>("from")).toBe("shared");
  });

  // Production secrets can then be held by fewer people than development ones,
  // which is the only reason to have more than one file.
  it("prefers a file for that environment", () => {
    const shared = new Credentials({ ...paths(), env: {} });
    shared.file.ensureKey();
    shared.write("from: shared\n");
    writeScoped("production");

    expect(credentialsFor("production", root, {}).get<string>("from")).toBe("production");
    expect(credentialsFor("development", root, {}).get<string>("from")).toBe("shared");
  });
});

describe("booting with them", () => {
  const previous = process.env.SECRET_KEY_BASE;

  afterEach(() => {
    // Deleted rather than assigned back: assigning undefined to a process.env
    // key stores the string "undefined", which is truthy, and left every later
    // test in the run believing there was a secret. Caught by CI, where the
    // whole suite runs in one process.
    if (previous === undefined) delete process.env.SECRET_KEY_BASE;
    else process.env.SECRET_KEY_BASE = previous;

    delete process.env[MASTER_KEY_ENV];
  });

  it("takes the secret from the credentials", () => {
    const credentials = new Credentials({ ...paths(), env: {} });
    const key = credentials.file.ensureKey();
    credentials.write(`secret_key_base: ${"z".repeat(64)}\n`);

    delete process.env.SECRET_KEY_BASE;
    process.env[MASTER_KEY_ENV] = key;

    expect(buildConfig({ env: "production", root }).secretKeyBase).toBe("z".repeat(64));
  });

  // The environment is the last word, because that is what a deploy sets.
  it("lets the environment win", () => {
    const credentials = new Credentials({ ...paths(), env: {} });
    const key = credentials.file.ensureKey();
    credentials.write(`secret_key_base: ${"z".repeat(64)}\n`);

    process.env.SECRET_KEY_BASE = "y".repeat(64);
    process.env[MASTER_KEY_ENV] = key;

    expect(buildConfig({ env: "production", root }).secretKeyBase).toBe("y".repeat(64));
  });

  it("still refuses to boot production with no secret anywhere", () => {
    delete process.env.SECRET_KEY_BASE;

    expect(() => buildConfig({ env: "production", root })).toThrow(/credentials:edit/);
  });

  // An application that keeps its secrets in the environment has no
  // credentials file, and should not have to explain that to the framework.
  it("is quiet when there is no file", () => {
    delete process.env.SECRET_KEY_BASE;

    expect(buildConfig({ env: "development", root }).secretKeyBase).toBeTruthy();
  });
});
