/**
 * `altair credentials:edit` and `credentials:show`, ported from Rails'
 * `credentials` commands.
 *
 * Editing means: decrypt to a temporary file, open it in the editor, encrypt
 * whatever came back, delete the temporary file. The plaintext exists on disk
 * only while someone is looking at it, which is the same bargain Rails makes —
 * an editor cannot edit something that is not a file.
 *
 * The launching is a parameter, so the whole flow is testable without a
 * terminal and an editor. Rails' own tests shell out to `cat`; this does not
 * have to.
 */

import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  credentialsFor,
  CREDENTIALS_TEMPLATE,
  MASTER_KEY_ENV,
  type Credentials,
  type Environment,
} from "@altair/core";
import { currentEnvironment, secureToken } from "@altair/support";

export interface CredentialsCommandOptions {
  root?: string;
  env?: Environment;
  /** Injected so a test does not need an editor. */
  edit?: (path: string) => void | Promise<void>;
}

/** What the CLI prints after a command, so the caller does the printing. */
export interface CredentialsResult {
  output: string;
  /** Set when a key was written, so the CLI can say to keep it out of git. */
  keyCreated?: string;
}

function credentials(options: CredentialsCommandOptions): Credentials {
  // Through the shared reader, which honours NODE_ENV too. Reading only
  // ALTAIR_ENV meant `NODE_ENV=production altair credentials:show` printed the
  // development credentials while the application read the production ones.
  const env = options.env ?? currentEnvironment();
  return credentialsFor(env, options.root ?? process.cwd());
}

/** Opens `$VISUAL` or `$EDITOR`, as Rails does. */
async function launchEditor(path: string): Promise<void> {
  const editor = process.env.VISUAL ?? process.env.EDITOR;

  if (!editor) {
    throw new Error(
      "No editor. Set EDITOR (or VISUAL) to the command that opens a file and waits, " +
        'for example `export EDITOR="code --wait"`.',
    );
  }

  // Split rather than run through a shell: the value is a command the person
  // set, and passing it to a shell would make their editor argument a place
  // where shell syntax runs.
  const [command, ...args] = editor.split(/\s+/) as [string, ...string[]];
  const result = Bun.spawnSync([command, ...args, path], {
    stdio: ["inherit", "inherit", "inherit"],
  });

  if (!result.success) throw new Error(`${editor} exited with ${result.exitCode}.`);
}

/**
 * Decrypts, edits, re-encrypts.
 *
 * Creates the key and a starting file when there are none, which is what makes
 * `credentials:edit` the one command needed on a fresh checkout.
 */
export async function editCredentials(
  options: CredentialsCommandOptions = {},
): Promise<CredentialsResult> {
  const file = credentials(options);
  const hadKey = file.file.hasKey;

  file.file.ensureKey();

  const existing = file.exists
    ? file.file.read()
    : CREDENTIALS_TEMPLATE.replace("%{secret}", secureToken(64));

  const directory = mkdtempSync(join(tmpdir(), "altair-credentials-"));
  const scratch = join(directory, "credentials.yml");

  try {
    writeFileSync(scratch, existing, { mode: 0o600 });
    await (options.edit ?? launchEditor)(scratch);

    const edited = readFileSync(scratch, "utf8");

    // Nothing changed is not a reason to rewrite the file: re-encrypting
    // produces different ciphertext every time, and a diff on every edit that
    // changed nothing is noise in the history.
    if (edited === existing) {
      return { output: `No changes to ${file.file.contentPath}.` };
    }

    file.write(edited);
  } finally {
    // The plaintext goes even if the editor failed or the file was unwritable.
    rmSync(directory, { recursive: true, force: true });
  }

  const output = [`Encrypted ${file.file.contentPath}.`];

  if (!hadKey) {
    output.push(
      "",
      `Wrote ${file.file.keyPath}. Keep it out of the repository — it is the one`,
      `thing that is not committed. On a server, set ${MASTER_KEY_ENV} instead.`,
    );
  }

  return { output: output.join("\n"), keyCreated: hadKey ? undefined : file.file.keyPath };
}

/** Prints the decrypted file. Rails' `credentials:show`. */
export function showCredentials(options: CredentialsCommandOptions = {}): CredentialsResult {
  const file = credentials(options);

  if (!file.exists) {
    return {
      output: `No credentials yet. Create them with \`altair credentials:edit\`.`,
    };
  }

  return { output: file.file.read() };
}

/**
 * Adds `config/master.key` to `.gitignore` if it is not already ignored.
 *
 * The whole scheme rests on one file staying out of the repository, and the
 * moment it does not, everything committed alongside it is readable.
 */
export function ignoreMasterKey(root: string): boolean {
  const path = join(root, ".gitignore");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";

  if (/^config\/master\.key$/m.test(existing)) return false;

  writeFileSync(
    path,
    `${existing}${existing.endsWith("\n") || !existing ? "" : "\n"}config/master.key\nconfig/credentials/*.key\n`,
  );
  return true;
}
