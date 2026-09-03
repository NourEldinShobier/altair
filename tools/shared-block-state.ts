/**
 * Finds state that belongs to a block being kept where the process can see it.
 *
 * The shape:
 *
 *     let preventing = 0;
 *
 *     export async function whilePreventingWrites(body) {
 *       preventing += 1;
 *       try {
 *         return await body();
 *       } finally {
 *         preventing -= 1;
 *       }
 *     }
 *
 * Correct for one thread and wrong for concurrent work. The block does not
 * cover its body — it covers everything running while its body runs. One
 * request's `whilePreventingWrites` made every concurrent request fail its
 * writes; one request's `withoutEncryption` turned encryption off for the
 * requests beside it; one render's `withViewPaths` handed a concurrent render
 * a plugin's template instead of the application's.
 *
 * Nine of these were found by hand and every one was a defect. The comment on
 * each said the same thing — restored in a `finally`, because a body that
 * throws must not leave it set — which is the failure a single thread can
 * have, and the reason the other one went unseen. `AsyncLocalStorage` answers
 * both: the store follows the work rather than the clock, there is nothing to
 * restore, and a body that throws leaves nothing behind.
 *
 * What it looks for is the restore, not the save: an assignment to
 * module-level state inside a `finally`. A save without a restore is a leak
 * rather than this, and a restore is the half that cannot be written any other
 * way.
 *
 * Some shared state is shared on purpose, and it says so where it is
 * declared:
 *
 *     // shared-block-state: deduplicating across callers is the point
 *     const recomputing = new Set<string>();
 *
 * The marker needs a reason after it, because the reason is the whole
 * exemption: every one of the nine defects could have carried a bare marker
 * and none of them could have carried a sentence.
 *
 *     bun run tools/shared-block-state.ts
 *     bun run tools/shared-block-state.ts --package=orm
 *
 * Exits non-zero when it finds one, so `verify.sh` can hold the line.
 */

import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

const PACKAGES = join(import.meta.dir, "..", "packages");

/** A module-level `let`, which is the only kind that can be reassigned. */
const MODULE_LET = /^let\s+([A-Za-z_$][\w$]*)/gm;

/**
 * A module-level `const` holding something mutable.
 *
 * `const collected: string[] = []` is not reassignable and is shared all the
 * same: `collected.splice(0, collected.length, ...held)` in a `finally` is the
 * same restore written around the outside of the binding.
 */
const MODULE_MUTABLE = /^const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:\[\]|new (?:Map|Set)\b)/gm;

interface Finding {
  path: string;
  name: string;
  line: number;
  statement: string;
}

/**
 * The body of every `finally { … }` in the source, with its offset.
 *
 * Braces are counted rather than matched with a regex, because a `finally`
 * body holds braces of its own — an object literal, a nested block — and a
 * lazy match stops at the first one.
 */
function finallyBodies(source: string): { body: string; at: number }[] {
  const bodies: { body: string; at: number }[] = [];

  for (const match of source.matchAll(/\bfinally\s*\{/g)) {
    const open = match.index + match[0].length;
    let depth = 1;
    let index = open;

    while (index < source.length && depth > 0) {
      const character = source[index];

      if (character === "{") depth += 1;
      else if (character === "}") depth -= 1;

      index += 1;
    }

    bodies.push({ body: source.slice(open, index - 1), at: open });
  }

  return bodies;
}

/** Comments out, so a `finally` described in prose is not read as one. */
function withoutProse(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, " ").replaceAll(/^[ \t]*\/\/.*$/gm, "");
}

/**
 * The names marked as deliberately shared, read from the source with its
 * comments still in it.
 *
 * On the declaration or on the line above it, which is where a reader looks
 * to find out why a variable is the way it is.
 */
function exempted(source: string): Set<string> {
  const names = new Set<string>();
  // Split on either ending. With a CRLF left in place, a `$` anchor has a
  // carriage return in front of it and the marker matched nothing — silently,
  // which for an exemption means the check keeps failing on something that
  // has already been explained.
  const lines = source.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    const marker = /shared-block-state:\s*(\S.*)$/.exec(line);

    if (!marker) continue;

    // The next declaration after the marker, within the doc comment it is
    // probably sitting in. Far enough to reach past a closing `*/`, near
    // enough that a marker cannot claim a variable further down the file.
    for (const candidate of lines.slice(index, index + 10)) {
      const declaration = /^(?:let|const)\s+([A-Za-z_$][\w$]*)/.exec(candidate);

      if (declaration) {
        names.add(declaration[1] as string);
        break;
      }
    }
  }

  return names;
}

function declaredAtModuleLevel(
  source: string,
  skip: Set<string>,
): { reassignable: Set<string>; mutable: Set<string> } {
  const named = (matches: RegExpStringIterator<RegExpExecArray>) =>
    new Set([...matches].map((match) => match[1] as string).filter((name) => !skip.has(name)));

  return {
    reassignable: named(source.matchAll(MODULE_LET)),
    mutable: named(source.matchAll(MODULE_MUTABLE)),
  };
}

/** Whether this `finally` body puts one of those names back. */
function restoresIn(body: string, names: { reassignable: Set<string>; mutable: Set<string> }) {
  const found: { name: string; statement: string }[] = [];

  for (const name of names.reassignable) {
    // `x =`, `x +=`, `x -=`, and not `x ==` or `x ===`.
    const assignment = new RegExp(String.raw`\b${name}\s*(?:[+\-*/|&]?=(?!=))`);
    const hit = assignment.exec(body);

    if (hit) found.push({ name, statement: statementAround(body, hit.index) });
  }

  for (const name of names.mutable) {
    // The ways a shared collection is put back without being reassigned.
    const mutation = new RegExp(
      String.raw`\b${name}\s*\.\s*(?:clear|splice|push|delete|set|add)\b|\b${name}\s*\.\s*length\s*=`,
    );
    const hit = mutation.exec(body);

    if (hit) found.push({ name, statement: statementAround(body, hit.index) });
  }

  return found;
}

function statementAround(body: string, index: number): string {
  const start = body.lastIndexOf("\n", index) + 1;
  const end = body.indexOf("\n", index);

  return body.slice(start, end === -1 ? undefined : end).trim();
}

const only = process.argv.find((argument) => argument.startsWith("--package="))?.slice(10);
const findings: Finding[] = [];

for await (const relative of new Glob("*/src/**/*.{ts,tsx}").scan({
  cwd: PACKAGES,
  onlyFiles: true,
})) {
  const packageName = relative.split(/[\\/]/)[0] as string;

  if (only !== undefined && packageName !== only) continue;

  const path = join(PACKAGES, relative).replaceAll("\\", "/");

  if (basename(path) === "index.ts") continue;

  const original = readFileSync(path, "utf8");
  const source = withoutProse(original);
  const names = declaredAtModuleLevel(source, exempted(original));

  if (names.reassignable.size === 0 && names.mutable.size === 0) continue;

  for (const { body, at } of finallyBodies(source)) {
    for (const { name, statement } of restoresIn(body, names)) {
      findings.push({
        path: path.slice(path.indexOf("packages")),
        name,
        line: source.slice(0, at).split("\n").length,
        statement,
      });
    }
  }
}

if (findings.length === 0) {
  console.log("No block-scoped state is being kept where the process can see it.");
  process.exit(0);
}

console.log(
  `${String(findings.length)} restore${findings.length === 1 ? "" : "s"} of module-level state in a finally.\n`,
);

for (const finding of findings) {
  console.log(`${finding.path}:${String(finding.line)}  ${finding.name}`);
  console.log(`  ${finding.statement}`);
  console.log(
    `  This runs on a clock, not on the work. Hold it in an AsyncLocalStorage so the\n` +
      `  block covers its own body rather than everything running beside it.\n`,
  );
}

process.exit(1);
