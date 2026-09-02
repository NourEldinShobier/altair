/**
 * Modules nothing else in `src` calls.
 *
 * `feature-coverage.ts` counts declarations: a name exists, so the feature is
 * ported. That is the right question for parity and the wrong question for
 * whether an application gets the benefit. A module can be complete, correct
 * and thoroughly tested while no code path in the framework routes through it
 * — and the coverage number cannot tell the difference.
 *
 * This asks the other question. For every module it collects the names it
 * exports, then looks for any of them in every *other* source file across
 * every package. Cross-package use counts, because a package's `index.ts`
 * re-exports everything and an importer names the symbol either way. An
 * `index.ts` is never counted as a caller: re-exporting a thing is not using
 * it.
 *
 * A hit here is not automatically a defect. Three things land in the list and
 * only two of them are problems:
 *
 * - **Public API**, which application code calls and framework code has no
 *   reason to. Every test helper, view component and migration DSL is here,
 *   and correctly so.
 * - **A parallel implementation** of something the framework already does
 *   another way. Two implementations of preloading, or of building SQL, means
 *   one of them is what runs and the other is what gets maintained.
 * - **A feature with nothing to attach to**, ported ahead of the thing it
 *   serves.
 *
 * Telling those apart needs judgement, so this prints the list and stops.
 *
 * Comments are stripped before the search, and that is not tidiness: this tool
 * reported `preloader.ts` as called because another module *mentioned it in a
 * sentence*. A false positive here is the expensive direction — it claims a
 * module is wired when it is not, which is the exact thing being looked for.
 * A name the other module declares for itself is discounted for the same
 * reason.
 *
 * It is a heuristic and says so. It matches names, and two modules can own the
 * same name: `arel.ts` exports a `toSql` and `relation.ts` has a method called
 * one, so `arel.ts` reads as called and is not in the list even though nothing
 * calls it. A declaration of the same name is already discounted; a *method* of
 * the same name is not, because telling `foo() {` in a class from `foo();` in a
 * function body needs a parser rather than a regex. That direction hides
 * findings, so `--why` exists: it prints every match with the file it came
 * from, and a collision takes seconds to dismiss by looking.
 *
 *     bun run tools/unwired-modules.ts
 *     bun run tools/unwired-modules.ts --package=orm
 *     bun run tools/unwired-modules.ts --why=orm/src/arel.ts
 */

import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

const PACKAGES = "packages";

/** A declaration this module offers to the rest of the codebase. */
const EXPORTED =
  /^export\s+(?:async\s+)?(?:function|class|const|let|interface|type|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;

interface Module {
  path: string;
  package: string;
  exports: string[];
  source: string;
}

async function modules(): Promise<Module[]> {
  const found: Module[] = [];

  for await (const relative of new Glob("*/src/**/*.{ts,tsx}").scan({
    cwd: PACKAGES,
    onlyFiles: true,
  })) {
    const path = join(PACKAGES, relative).replaceAll("\\", "/");

    // An index re-exports its package; it is not a caller and not a module
    // anything is expected to call directly.
    if (basename(path) === "index.ts") continue;

    const source = readFileSync(path, "utf8");
    const exports = [...source.matchAll(EXPORTED)].map((match) => match[1] as string);

    found.push({
      path,
      package: relative.split(/[\\/]/)[0] as string,
      exports,
      source: withoutComments(source),
    });
  }

  return found;
}

/**
 * The source with its prose removed.
 *
 * Block comments go entirely; a line comment goes only when it starts its own
 * line. Anything after code on the same line is left alone, because a `//`
 * inside a string is far more often a URL than a comment, and cutting there
 * would corrupt the code this is searching.
 */
function withoutComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, " ").replaceAll(/^[ \t]*\/\/.*$/gm, "");
}

/**
 * Whether anything but the module itself names one of its exports.
 *
 * A name the other module *declares for itself* does not count. `relation.ts`
 * has its own `WhereClause` interface and `arel.ts` exports one too; matching
 * on the name alone read that collision as a call and hid a module nothing
 * uses. Two modules owning the same name is worth knowing about on its own,
 * but it is not evidence that either calls the other.
 */
function called(module: Module, all: readonly Module[]): boolean {
  if (module.exports.length === 0) return false;

  return all.some((other) => {
    if (other.path === module.path) return false;

    return module.exports.some(
      (name) => new RegExp(`\\b${escape(name)}\\b`).test(other.source) && !declares(other, name),
    );
  });
}

/** Whether a module introduces this name itself, rather than borrowing it. */
function declares(module: Module, name: string): boolean {
  return new RegExp(
    `(?:^|\\n)\\s*(?:export\\s+)?(?:declare\\s+)?(?:abstract\\s+)?(?:async\\s+)?` +
      `(?:function|class|const|let|var|interface|type|enum)\\s+${escape(name)}\\b`,
  ).test(module.source);
}

function escape(name: string): string {
  return name.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

const why = process.argv.find((argument) => argument.startsWith("--why="))?.slice(6);

if (why !== undefined) {
  const all = await modules();
  const subject = all.find((module) => module.path.endsWith(why));

  if (subject === undefined) {
    console.log(`No module matching ${why}.`);
    process.exit(1);
  }

  // Every match, so a collision can be dismissed by looking rather than by
  // trusting the heuristic. This is the answer to "the tool says it is called
  // — by what?", which is the only way to tell a caller from a name two
  // modules happen to share.
  const matches = all.flatMap((other) =>
    other.path === subject.path
      ? []
      : subject.exports
          .filter(
            (name) =>
              new RegExp(`\\b${escape(name)}\\b`).test(other.source) && !declares(other, name),
          )
          .map((name) => `${name}  ${other.path}`),
  );

  console.log(
    matches.length === 0
      ? `Nothing names an export of ${subject.path}.`
      : `${String(matches.length)} matches for exports of ${subject.path}:\n\n${matches.join("\n")}`,
  );
  process.exit(0);
}

const only = process.argv.find((argument) => argument.startsWith("--package="))?.slice(10);
const all = await modules();
const unwired = all
  .filter((module) => module.exports.length > 0 && !called(module, all))
  .filter((module) => only === undefined || module.package === only)
  .sort((a, b) => b.source.length - a.source.length);

console.log(
  `${String(unwired.length)} of ${String(all.length)} modules export names that nothing else in src mentions.\n`,
);

for (const module of unwired) {
  console.log(
    `${String(module.source.length).padStart(6)}  ${String(module.exports.length).padStart(3)} exports  ${module.path}`,
  );
}

// A module with no exports at all is not reported: it is either a side-effect
// file or a work in progress, and neither is what this is looking for.
