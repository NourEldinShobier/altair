/**
 * How much of Rails' public API surface exists here.
 *
 *     bun run tools/feature-coverage.ts [path-to-rails-clone]
 *
 * Read the caveats before quoting the number. It overcounts us — any
 * identifier in our source matches, so a coincidental name collision scores —
 * and undercounts us where JavaScript already provides something, where we
 * named it differently, or where one method here replaces several there.
 * Useful for tracking a direction, not for a claim on a README.
 *
 * Not test parity — that is a different and much lower number. This asks: of
 * the methods Rails documents as public, how many can a person call here?
 *
 * Method names are matched after converting Rails' snake_case to camelCase,
 * and `?`/`!` suffixes are dropped, since neither is legal in JavaScript.
 */

import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const RAILS =
  process.argv.slice(2).find((one) => !one.startsWith("--")) ??
  join(process.cwd(), "..", "research", "rails");
const OURS = join(process.cwd(), "packages");

/**
 * Names that are not features.
 *
 * Ruby object protocol, gem plumbing, and the hooks Rails uses to assemble
 * itself. Counting these against us would say we are missing `inspect`, which
 * JavaScript spells differently and nobody chose.
 */
const NOISE = new Set([
  "initialize",
  "initializeDup",
  "initializeClone",
  "inspect",
  "toS",
  "toStr",
  "toParam",
  "toAry",
  "toProc",
  "dup",
  "clone",
  "freeze",
  "frozen",
  "hash",
  "eql",
  "equal",
  "methodMissing",
  "respondToMissing",
  "respondTo",
  "instanceMethod",
  "included",
  "extended",
  "inherited",
  "prepended",
  "deprecator",
  "gemVersion",
  "version",
  "eagerLoad",
  "railtieHelpers",
  "railtieNamespace",
  "useRelativeModelNaming",
  "withoutModules",
  "coder",
  "encodeWith",
  "initWith",
  "marshalDump",
  "marshalLoad",
  "pretty_print",
  "prettyPrint",
]);

/** `find_by_token!` -> `findByToken` */
function camel(name: string): string {
  return name.replace(/[?!=]$/, "").replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Public methods in a Rails component.
 *
 * Everything after a `private`/`protected` keyword in a file is skipped, and
 * so are the `_`-prefixed internals Rails uses for framework plumbing.
 */
async function railsMethods(component: string, subdirs: string[]): Promise<Set<string>> {
  const names = new Set<string>();

  for (const subdir of subdirs) {
    const root = join(RAILS, component, "lib", subdir);

    for await (const file of new Glob("**/*.rb").scan({ cwd: root, onlyFiles: true })) {
      const source = readFileSync(join(root, file), "utf8");
      let visible = true;

      for (const line of source.split("\n")) {
        const trimmed = line.trim();

        if (trimmed === "private" || trimmed === "protected") visible = false;
        if (/^(public|def self\.|class |module )/.test(trimmed) && trimmed !== "private") {
          if (trimmed === "public") visible = true;
        }
        if (/^(class|module)\s/.test(trimmed)) visible = true;

        if (!visible) continue;

        const method = /^def\s+(?:self\.)?([a-z_][a-zA-Z0-9_]*[?!=]?)/.exec(trimmed);
        if (method) {
          const name = method[1] as string;
          if (!name.startsWith("_") && !NOISE.has(camel(name))) names.add(camel(name));
        }

        // `delegate :foo, :bar, to: :baz` is public API too.
        const delegated = /^delegate\s+(.+?),\s*to:/.exec(trimmed);
        if (delegated) {
          for (const one of delegated[1]!.split(",")) {
            const clean = one
              .trim()
              .replace(/^:/, "")
              .replace(/[?!=]$/, "");
            if (/^[a-z_][a-zA-Z0-9_]*$/.test(clean) && !clean.startsWith("_")) {
              names.add(camel(clean));
            }
          }
        }
      }
    }
  }

  return names;
}

/**
 * Lowercases the first letter, so a JSX component matches the Rails helper it
 * replaces: `TextFieldTag` is how `text_field_tag` is spelled here, and a
 * component is the idiomatic form rather than a different feature.
 */
function key(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

/**
 * A declaration written the ordinary way: `name(`, `name<`, `name:`, `name=`.
 *
 * `\??` is there because an optional property — `perFormCsrfTokens?: boolean` —
 * is a declaration exactly as much as a required one. Without it the whole
 * configuration surface of every subsystem read as missing, which made a batch
 * that shipped real behaviour score nothing and pointed the work away from
 * config-shaped features for no reason but a spelling.
 */
const DECLARATION =
  /(?:^|\s)(?:static\s+|async\s+|get\s+|set\s+|export\s+function\s+|export\s+const\s+)?\*?\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\??\s*[(<:=]/g;

/**
 * A method installed at runtime: `Object.defineProperty(model, "authenticateBy", …)`.
 *
 * The pattern the ORM uses to add methods to a model class, and invisible to
 * the rule above because the name is a string rather than an identifier.
 * `authenticateBy` has been implemented and tested here for some time and was
 * still being counted as missing.
 */
const DEFINED_PROPERTY = /defineProperty\(\s*[^,]+,\s*["']([a-zA-Z][a-zA-Z0-9]*)["']/g;

/** Every identifier that appears as a declaration in our source. */
async function ourNames(packages: string[]): Promise<Set<string>> {
  const names = new Set<string>();

  for (const pkg of packages) {
    const root = join(OURS, pkg, "src");

    for await (const file of new Glob("**/*.{ts,tsx}").scan({ cwd: root, onlyFiles: true })) {
      const source = readFileSync(join(root, file), "utf8");

      for (const pattern of [DECLARATION, DEFINED_PROPERTY]) {
        for (const match of source.matchAll(pattern)) {
          names.add(key(match[1] as string));
        }
      }
    }
  }

  return names;
}

const AREAS: [string, string, string[], string[]][] = [
  ["ActiveRecord", "activerecord", ["active_record"], ["orm"]],
  ["ActiveModel", "activemodel", ["active_model"], ["orm", "support"]],
  ["ActionPack", "actionpack", ["action_controller", "action_dispatch"], ["controller", "router"]],
  ["ActionView", "actionview", ["action_view"], ["view"]],
  ["ActiveSupport", "activesupport", ["active_support"], ["support"]],
  ["ActiveJob", "activejob", ["active_job"], ["jobs"]],
  ["ActionMailer", "actionmailer", ["action_mailer"], ["mailer"]],
  ["ActiveStorage", "activestorage", ["active_storage"], ["storage"]],
  ["ActionCable", "actioncable", ["action_cable"], ["cable"]],
  ["ActionText", "actiontext", ["action_text"], ["view", "orm"]],
  ["ActionMailbox", "actionmailbox", ["action_mailbox"], ["mailer"]],
];

const only = process.argv.find((a) => a.startsWith("--only="))?.split("=")[1];

const all = await ourNames([
  "orm",
  "support",
  "controller",
  "router",
  "view",
  "jobs",
  "mailer",
  "storage",
  "cable",
  "core",
  "cli",
  "testing",
]);

console.log("component        rails   ours   covered   missing (a sample)");
console.log("-".repeat(96));

let totalRails = 0;
let totalCovered = 0;

for (const [label, component, subdirs, _packages] of AREAS) {
  const rails = await railsMethods(component, subdirs);
  const covered = [...rails].filter((name) => all.has(key(name)));
  const missing = [...rails].filter((name) => !all.has(key(name)));

  totalRails += rails.size;
  totalCovered += covered.length;

  const share = ((covered.length / rails.size) * 100).toFixed(0);

  if (only && label.toLowerCase() !== only.toLowerCase()) continue;

  if (only) {
    console.log(`${label}: ${missing.length} missing
`);
    console.log(missing.sort().join(" "));
    continue;
  }

  console.log(
    `${label.padEnd(16)} ${String(rails.size).padStart(5)} ${String(covered.length).padStart(6)} ${(share + "%").padStart(8)}   ${missing.slice(0, 6).join(", ")}`,
  );
}

console.log("-".repeat(96));
console.log(
  `${"TOTAL".padEnd(16)} ${String(totalRails).padStart(5)} ${String(totalCovered).padStart(6)} ${((totalCovered / totalRails) * 100).toFixed(1).padStart(7)}%`,
);
