/**
 * Modules nothing else in `src` calls.
 *
 * `feature-coverage.ts` counts declarations: a name exists, so the feature is
 * ported. That is the right question for parity and the wrong question for
 * whether an application gets the benefit. A module can be complete, correct
 * and thoroughly tested while no code path in the framework routes through it
 * — and the coverage number cannot tell the difference.
 *
 * This asks the other question, in two ways depending on how far the caller
 * would be. Inside a package it reads the relative imports — which names, from
 * which file — and that is exact. Across packages there is no path to follow,
 * because a caller reaches through the package index, so it falls back to
 * looking for the name. An `index.ts` is never counted as a caller:
 * re-exporting a thing is not using it.
 *
 * A hit here is not automatically a defect. Four things land in the list and
 * only two of them are problems:
 *
 * - **Public API**, which application code calls and framework code has no
 *   reason to. Every test helper, view component and migration DSL is here,
 *   and correctly so.
 * - **An export that should be private**, used only inside its own module.
 *   `isEachValidator` is one: the validator runner calls it and nothing else
 *   ever should. Harmless, and worth narrowing when the file is next touched.
 * - **A parallel implementation** of something the framework already does
 *   another way. Two implementations of preloading, or of building SQL, means
 *   one of them is what runs and the other is what gets maintained.
 * - **A feature with nothing to attach to**, ported ahead of the thing it
 *   serves.
 *
 * Telling those apart needs judgement, so this prints the list and stops.
 *
 * Three things are removed before a name is looked for, and each was a real
 * false positive rather than a precaution. Comments go, because `preloader.ts`
 * read as called on the strength of another module *mentioning it in a
 * sentence*. Module specifiers go, because `introspect.ts` exports an
 * `introspect` and every file importing anything from it carries the string
 * `"./introspect.js"`. And a name the other module declares for itself is
 * discounted, because `relation.ts` has its own `WhereClause`. A false
 * positive is the expensive direction here: it claims a module is wired when
 * it is not, which is the exact thing being looked for.
 *
 * It is a heuristic where it falls back to names, and says so. Two modules can
 * own the same name, and across a package boundary there is nothing to tell
 * them apart: a declaration of the same name is discounted, a *method* of the
 * same name is not, because telling `foo() {` in a class from `foo();` in a
 * function body needs a parser rather than a regex. That direction hides
 * findings, so `--why` exists: it prints every match with the file it came
 * from, and a collision takes seconds to dismiss by looking.
 *
 * A module is too coarse a unit, and that is not a theory either.
 * `predicate-builder.ts` never appeared in this list because one of its
 * exports is called — and `rangePredicateFor` sat unused beside it, so a
 * `where` given a range bound it as an object and matched nothing. One wired
 * export hides every unwired one beside it. `--exports` asks the finer
 * question, and the first thing it said was that `arrayPredicateFor` was
 * unused too: `where({ parent_id: [1, null] })` was dropping the roots,
 * because `IN (1, NULL)` never matches a null.
 *
 * Most of what `--exports` lists is public API — a type, an error class, a
 * helper meant for callers — so it is a thing to read module by module rather
 * than a list to work through.
 *
 *     bun run tools/unwired-modules.ts
 *     bun run tools/unwired-modules.ts --package=orm
 *     bun run tools/unwired-modules.ts --exports
 *     bun run tools/unwired-modules.ts --exports --package=orm
 *     bun run tools/unwired-modules.ts --dead
 *     bun run tools/unwired-modules.ts --why=orm/src/arel.ts
 */

import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const PACKAGES = "packages";

/** A declaration this module offers to the rest of the codebase. */
const EXPORTED =
  /^export\s+(?:async\s+)?(?:function|class|const|let|interface|type|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;

interface Module {
  path: string;
  package: string;
  exports: string[];
  /** Comments and module specifiers removed: what a name is looked for in. */
  source: string;
  /** Comments removed only. Import specifiers are still here to be read. */
  imports: string;
}

/**
 * A relative import and the names it takes.
 *
 * Within a package this is exact, which is the point: matching on names alone
 * says `predicate-builder.ts` is called because somebody wrote `tableName`
 * somewhere, and then every unused export beside the one real caller is
 * invisible. An import says which names, from which file, with no guessing.
 *
 * The clause cannot hold a `;` or a `"`, and both exclusions are load-bearing.
 * With `[\s\S]*?` the match started at an *earlier* import and ran to this
 * one's specifier, so the names captured belonged to the wrong statement:
 * `job.ts` imports `InlineQueue` from `./worker.js` and the clause read for it
 * was the tail of the `@altair/support` import above. Every import with
 * another one before it was attributed wrongly, which is most of them, and the
 * cross-package fallback quietly covered for it.
 */
const RELATIVE_IMPORT = /import\s+(?:type\s+)?([^;"]*?)\s+from\s+"(\.[^"]*)\.js"/g;

interface Uses {
  /** Names imported from a sibling module, by that module's path. */
  byPath: Map<string, Set<string>>;
  /** Modules imported wholesale (`import * as x`), where every export counts. */
  whole: Set<string>;
}

function usesOf(all: readonly Module[]): Uses {
  const byPath = new Map<string, Set<string>>();
  const whole = new Set<string>();

  for (const module of all) {
    for (const [, clause, relative] of module.imports.matchAll(RELATIVE_IMPORT)) {
      const target = resolveImport(module.path, relative as string, all);

      if (target === undefined) continue;

      if ((clause as string).includes("*")) {
        whole.add(target);
        continue;
      }

      const names = byPath.get(target) ?? new Set<string>();

      for (const name of namesIn(clause as string)) names.add(name);

      byPath.set(target, names);
    }
  }

  return { byPath, whole };
}

/** The module a relative specifier points at, if it is one this scan holds. */
function resolveImport(from: string, relative: string, all: readonly Module[]): string | undefined {
  const target = join(dirname(from), relative).replaceAll("\\", "/");

  return all.find((module) => module.path === `${target}.ts` || module.path === `${target}.tsx`)
    ?.path;
}

/** The bindings an import clause introduces, ignoring how they were spelled. */
function namesIn(clause: string): string[] {
  const braced = /\{([\s\S]*)\}/.exec(clause);
  const parts = braced === null ? [clause] : (braced[1] as string).split(",");

  return parts
    .map((part) => {
      const halves = part.split(/\bas\b/);

      return (halves[0] as string).replace(/\btype\b/, "").trim();
    })
    .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
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
      source: searchable(source),
      imports: withoutProse(source),
    });
  }

  return found;
}

/**
 * The source with everything that is not code removed.
 *
 * Block comments go entirely; a line comment goes only when it starts its own
 * line. Anything after code on the same line is left alone, because a `//`
 * inside a string is far more often a URL than a comment, and cutting there
 * would corrupt the code this is searching.
 *
 * Module specifiers go too, and that one is not cosmetic. `introspect.ts`
 * exports an `introspect`, and every file importing *anything* from it carries
 * the string `"./introspect.js"` — so the name matched the path, and the
 * export read as used by files that never touched it. An export named after
 * its own module is common enough that this was hiding a class of finding.
 */
function searchable(source: string): string {
  return withoutProse(source).replaceAll(/\bfrom\s+"[^"]*"/g, 'from ""');
}

/**
 * Comments gone, module specifiers kept.
 *
 * The import reader needs the specifiers — they are how it knows which file a
 * name came from — so the two views are separate rather than one stripped
 * source used for both.
 */
function withoutProse(source: string): string {
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
function called(module: Module, all: readonly Module[], uses: Uses): boolean {
  if (uses.whole.has(module.path)) return true;
  if ((uses.byPath.get(module.path)?.size ?? 0) > 0) return true;

  if (module.exports.length === 0) return false;

  // Within the package an import is exact and the checks above are the whole
  // answer. Across packages there is no path to follow — a caller reaches
  // through the package index — so the name is all there is, and a common word
  // is still a collision there. That is why this stays a floor.
  return module.exports.some((name) => namedInAnotherPackage(module, name, all));
}

/**
 * Whether anything but this module uses one particular export.
 *
 * An import inside the package is exact. Across packages it falls back to the
 * name, because a cross-package caller reaches through the package index and
 * there is no path to follow — so a common word is still a collision there,
 * and this stays a floor rather than a total.
 */
function usedElsewhere(module: Module, name: string, all: readonly Module[], uses: Uses): boolean {
  if (uses.whole.has(module.path)) return true;
  if (uses.byPath.get(module.path)?.has(name) === true) return true;

  return namedInAnotherPackage(module, name, all);
}

/** The cross-package fallback: the name, in a module of a different package. */
function namedInAnotherPackage(module: Module, name: string, all: readonly Module[]): boolean {
  const wanted = new RegExp(String.raw`\b${escape(name)}\b`);

  return all.some(
    (other) =>
      other.package !== module.package && wanted.test(other.source) && !declares(other, name),
  );
}

/** Whether a module introduces this name itself, rather than borrowing it. */
function declares(module: Module, name: string): boolean {
  return new RegExp(
    `(?:^|\\n)\\s*(?:export\\s+)?(?:declare\\s+)?(?:abstract\\s+)?(?:async\\s+)?` +
      `(?:function|class|const|let|var|interface|type|enum)\\s+${escape(name)}\\b`,
  ).test(module.source);
}

/**
 * Whether the module that exports this name also uses it, which splits the
 * `--exports` list in two. `beginningOfDay` is called all over `dates.ts` and
 * exported for applications; `SQLITE_GENERATED` is exported and then not even
 * read at home. The first is public API and the second is either dead or
 * waiting to be wired, and only the second is a worklist.
 *
 * Counting mentions is enough because the declaration is one of them: a name
 * appearing once appears only where it is introduced. An overload signature
 * makes two and reads as used, which errs towards the quiet answer.
 */
function usedAtHome(module: Module, name: string): boolean {
  const mentions = module.source.match(new RegExp(String.raw`\b${escape(name)}\b`, "g"));

  return (mentions?.length ?? 0) > 1;
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
const uses = usesOf(all);
const inPackage = (module: Module) => only === undefined || module.package === only;

const dead = process.argv.includes("--dead");

if (process.argv.includes("--exports") || dead) {
  // Only the modules something *does* call: a module nothing calls at all is
  // the other report, and listing every one of its exports here would bury
  // the finding this one exists for.
  const partial = all
    .filter((module) => module.exports.length > 0 && called(module, all, uses) && inPackage(module))
    .map((module) => ({
      module,
      unused: module.exports
        .filter((name) => !usedElsewhere(module, name, all, uses))
        .filter((name) => !dead || !usedAtHome(module, name)),
    }))
    .filter((entry) => entry.unused.length > 0)
    .sort((a, b) => b.unused.length - a.unused.length);

  const total = partial.reduce((sum, entry) => sum + entry.unused.length, 0);

  console.log(
    dead
      ? `${String(total)} exports of ${String(partial.length)} otherwise-called modules are used nowhere, not even at home.`
      : `${String(total)} exports of ${String(partial.length)} otherwise-called modules are named nowhere else.`,
  );

  for (const { module, unused } of partial) {
    console.log(module.path);

    for (const name of unused) console.log(`  ${name}`);

    console.log("");
  }

  process.exit(0);
}
const unwired = all
  .filter((module) => module.exports.length > 0 && !called(module, all, uses))
  .filter(inPackage)
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
