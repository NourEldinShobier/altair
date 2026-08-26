/**
 * `altair credentials:edit` and `credentials:show`.
 *
 * Mirrors railties/test/commands/credentials_test.rb. The editor is a
 * parameter, so the whole flow runs without a terminal: what matters here is
 * what is on disk before, during and after, not that a process was spawned.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Credentials, credentialsFor } from "@altair/core";
import { editCredentials, ignoreMasterKey, showCredentials } from "../src/credentials.js";

let root: string;

const read = () => credentialsFor("development", root, {}).file.read();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "altair-cli-credentials-"));
  mkdirSync(join(root, "config"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("editing for the first time", () => {
  it("creates the key and the file", async () => {
    const result = await editCredentials({
      root,
      env: "development",
      edit: (path) => writeFileSync(path, "stripe:\n  secret_key: sk_test\n"),
    });

    expect(existsSync(join(root, "config", "master.key"))).toBe(true);
    expect(existsSync(join(root, "config", "credentials.yml.enc"))).toBe(true);
    expect(result.keyCreated).toBe(join(root, "config", "master.key"));
  });

  // The one command needed on a fresh checkout has to say the thing that,
  // if missed, makes the whole scheme pointless.
  it("says to keep the key out of the repository", async () => {
    const result = await editCredentials({
      root,
      env: "development",
      edit: (path) => writeFileSync(path, "a: 1"),
    });

    expect(result.output).toContain("out of the repository");
    expect(result.output).toContain("ALTAIR_MASTER_KEY");
  });

  it("starts from a template with a secret already in it", async () => {
    let shown = "";
    await editCredentials({
      root,
      env: "development",
      edit: (path) => {
        shown = readFileSync(path, "utf8");
        writeFileSync(path, `${shown}extra: 1\n`);
      },
    });

    expect(shown).toContain("secret_key_base:");
    // 64 bytes, base64url. Well past the 32 characters `Secrets` insists on.
    const secret = credentialsFor("development", root, {}).get<string>("secret_key_base");
    expect(secret!.length).toBeGreaterThan(64);
  });

  it("encrypts what the editor left behind", async () => {
    await editCredentials({
      root,
      env: "development",
      edit: (path) => writeFileSync(path, "stripe:\n  secret_key: sk_live_treasure\n"),
    });

    expect(readFileSync(join(root, "config", "credentials.yml.enc"), "utf8")).not.toContain(
      "treasure",
    );
    expect(read()).toContain("sk_live_treasure");
  });
});

describe("editing again", () => {
  const seed = async () =>
    await editCredentials({
      root,
      env: "development",
      edit: (path) => writeFileSync(path, "a: 1\n"),
    });

  it("shows the editor what is already there", async () => {
    await seed();

    let shown = "";
    await editCredentials({
      root,
      env: "development",
      edit: (path) => {
        shown = readFileSync(path, "utf8");
        writeFileSync(path, "a: 2\n");
      },
    });

    expect(shown).toBe("a: 1\n");
    expect(read()).toBe("a: 2\n");
  });

  it("keeps the key it already had", async () => {
    await seed();
    const key = readFileSync(join(root, "config", "master.key"), "utf8");

    const result = await editCredentials({
      root,
      env: "development",
      edit: (path) => writeFileSync(path, "a: 3\n"),
    });

    expect(readFileSync(join(root, "config", "master.key"), "utf8")).toBe(key);
    expect(result.keyCreated).toBeUndefined();
  });

  // Re-encrypting produces different ciphertext every time, so writing on an
  // edit that changed nothing would put noise in the history.
  it("writes nothing when nothing changed", async () => {
    await seed();
    const before = readFileSync(join(root, "config", "credentials.yml.enc"), "utf8");

    const result = await editCredentials({ root, env: "development", edit: () => {} });

    expect(readFileSync(join(root, "config", "credentials.yml.enc"), "utf8")).toBe(before);
    expect(result.output).toContain("No changes");
  });
});

describe("the plaintext", () => {
  it("does not survive the edit", async () => {
    let scratch = "";

    await editCredentials({
      root,
      env: "development",
      edit: (path) => {
        scratch = path;
        writeFileSync(path, "a: 1\n");
      },
    });

    expect(existsSync(scratch)).toBe(false);
  });

  // Even when the editor blew up: the file is the secret, and it is on disk.
  it("does not survive an editor that failed", async () => {
    let scratch = "";

    await editCredentials({
      root,
      env: "development",
      edit: (path) => {
        scratch = path;
        throw new Error("editor crashed");
      },
    }).catch(() => undefined);

    expect(scratch).not.toBe("");
    expect(existsSync(scratch)).toBe(false);
  });
});

describe("showing them", () => {
  it("prints the decrypted file", async () => {
    await editCredentials({
      root,
      env: "development",
      edit: (path) => writeFileSync(path, "a: 1\n"),
    });

    expect(showCredentials({ root, env: "development" }).output).toBe("a: 1\n");
  });

  it("says how to make them when there are none", () => {
    expect(showCredentials({ root, env: "development" }).output).toContain("credentials:edit");
  });
});

describe("per environment", () => {
  it("edits the file for the environment it was given", async () => {
    // A scoped file only takes precedence once it exists, so it has to be
    // created through its own path first.
    const scoped = new Credentials({
      contentPath: join(root, "config", "credentials", "production.yml.enc"),
      keyPath: join(root, "config", "credentials", "production.key"),
      env: {},
    });
    scoped.file.ensureKey();
    scoped.write("from: production\n");

    await editCredentials({
      root,
      env: "production",
      edit: (path) => writeFileSync(path, `${readFileSync(path, "utf8")}extra: 1\n`),
    });

    expect(credentialsFor("production", root, {}).get<number>("extra")).toBe(1);
    expect(credentialsFor("development", root, {}).exists).toBe(false);
  });

  /**
   * The CLI used to read only ALTAIR_ENV here while the application read both,
   * so `NODE_ENV=production altair credentials:show` printed the development
   * credentials — the two disagreeing about which environment they were in,
   * silently, over the one file where being wrong matters most.
   */
  it("reads the same environment the application would", () => {
    const previous = { altair: process.env.ALTAIR_ENV, node: process.env.NODE_ENV };
    delete process.env.ALTAIR_ENV;
    process.env.NODE_ENV = "production";

    try {
      const scoped = new Credentials({
        contentPath: join(root, "config", "credentials", "production.yml.enc"),
        keyPath: join(root, "config", "credentials", "production.key"),
        env: {},
      });
      scoped.file.ensureKey();
      scoped.write("who: production\n");

      expect(showCredentials({ root }).output).toContain("who: production");
    } finally {
      if (previous.altair === undefined) delete process.env.ALTAIR_ENV;
      else process.env.ALTAIR_ENV = previous.altair;
      if (previous.node === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous.node;
    }
  });
});

describe("the gitignore", () => {
  it("adds the key when it is not ignored", () => {
    writeFileSync(join(root, ".gitignore"), "node_modules/\n");

    expect(ignoreMasterKey(root)).toBe(true);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain("config/master.key");
  });

  it("leaves it alone when it already is", () => {
    writeFileSync(join(root, ".gitignore"), "config/master.key\n");

    expect(ignoreMasterKey(root)).toBe(false);
  });

  it("creates one when there is none", () => {
    expect(ignoreMasterKey(root)).toBe(true);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain("config/master.key");
  });
});
