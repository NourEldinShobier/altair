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
 *
 * ## What the last few percent are
 *
 * The remaining names were read rather than counted, across every component.
 * Almost none of them is a feature that is missing.
 *
 * - **A different shape for the same thing**, and this is most of it. Rails'
 *   view layer is helper functions and this one is JSX components, so
 *   `form_with` is `<FormWith>` and `form_tag`'s family is `TextFieldTag` and
 *   its neighbours. `content_for` is `provide` and `yieldContent`, because
 *   writing and reading through one name is a Ruby-block trick with no
 *   JavaScript spelling. ActionMailbox's one missing name, `routing`, is
 *   `MailboxRouter.route`. The twenty-two that are one name for one name are
 *   in `ALIASES` below, each with the file it was checked against; the rest
 *   are one-to-many and have nowhere to be written down but here.
 * - **Rails internals.** `addLeftAssociation`, `typeCastForDatabase`,
 *   `attributesBuilder`. Public in the sense that Ruby has no private, not in
 *   the sense that anybody calls them. The ones Rails marks `# :nodoc:` are no
 *   longer counted at all — that comment is Rails answering this tool's own
 *   question — which took 394 names out of the total and 359 out of the ones
 *   we scored, so it moved the ratio by half a point and the noise by a lot
 *   more. What is left in this bullet is the plumbing Rails never got round to
 *   marking.
 * - **Ruby, not a feature**, and no longer counted: `symbolize_keys` and the
 *   `with_indifferent_access` family, which a language that tells `:name` from
 *   `"name"` needs and this one cannot; `silence_warnings` and its
 *   neighbours, which set `$VERBOSE`; `method_symbol`, which is `method`
 *   returning `:GET`; `try`, which is `?.`. The test is in `RUBY_ONLY` below
 *   and it is narrow: ported faithfully, each of these has an empty body.
 * - **Scraper artifacts**, now two: `pp` and `fmod` are real Ruby methods
 *   nobody would want here, and both stay counted against us, which is the
 *   honest way for them to read. The interpolated halves — `build_`,
 *   `create_`, `reload_`, `reset_` — and the `self` and `str` that came from
 *   `def self.[]` and `def str.inspect` are no longer counted, because Rails
 *   defines no method by any of those names.
 * - **Deliberately not ported.** `form_for` is Rails' own legacy form
 *   builder, superseded by `form_with` in its documentation.
 *
 * So the number is close to its ceiling, and the way to raise it from here is
 * to add second names for things that already work. That is worth saying
 * plainly, because 96% reads like four points of work left and it is not.
 *
 * Every remaining name was matched to the Rails line that defines it. The
 * ones Rails documents with an RDoc comment above the `def` — its own
 * statement that this is API — were read one at a time, and every one of them
 * is accounted for in a bullet above. The rest have no comment at all, which
 * is the weaker form of the signal `# :nodoc:` gives, and were read in batches
 * by the file that defines them. None of them turned out to be a feature a
 * person could want and could not have here.
 *
 * What is left is in `WIRING.md`: whether the code that exists is reachable.
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

/**
 * Methods whose whole purpose is a distinction Ruby draws and JavaScript does
 * not.
 *
 * The set above is the object protocol — `inspect`, `to_s`, `dup`. This one is
 * the type system, and the test for membership is narrow on purpose: not "we
 * do it differently" and not "JavaScript has something like it", but *there is
 * nothing here for the method to do*. Every name below is a method that, ported
 * faithfully, would have an empty body.
 *
 * Two families and three strays.
 *
 * `symbolize_keys` and the whole `with_indifferent_access` family exist
 * because a Ruby hash tells `:name` and `"name"` apart, so a params hash built
 * from a query string cannot be read with the symbol the code wants to write.
 * An object here has string keys and only string keys, which means every
 * object already has indifferent access and there is no second kind of key to
 * convert to. Porting `symbolize_keys` gets you the identity function.
 *
 * `silence_warnings`, `enable_warnings` and `with_warnings` set `$VERBOSE`, a
 * Ruby global that turns the interpreter's own warnings on and off. There is
 * no such switch to flip.
 *
 * `method_symbol` and `request_method_symbol` are `method` and `request_method`
 * returning `:GET` instead of `"GET"`. Here they would return the same string
 * twice, under two names.
 *
 * `try` is `receiver&.method`, which JavaScript spells `?.` and has in the
 * language. Rails wrote it because Ruby did not have `&.` until 2.3.
 *
 * `to_time` and `to_datetime` were considered and left out. Ruby has two time
 * classes and this has one, so the pair of names has nothing to distinguish —
 * but converting a string to a date is a real operation somebody wants, and
 * "the language provides it" is a wider door than this set should open.
 */
const RUBY_ONLY = new Set([
  "symbolizeKeys",
  "deepSymbolizeKeys",
  "withIndifferentAccess",
  "nestedUnderIndifferentAccess",
  "asIndifferentHash",
  "readHashWithIndifferentAccess",
  "writeHashWithIndifferentAccess",
  "silenceWarnings",
  "enableWarnings",
  "withWarnings",
  "methodSymbol",
  "requestMethodSymbol",
  "try",
]);

/** `find_by_token!` -> `findByToken` */
function camel(name: string): string {
  return name.replace(/[?!=]$/, "").replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Rails' own mark for "not part of the public API".
 *
 * RDoc reads it and leaves the method out of the documentation, which is the
 * same question this tool asks. Ruby has no `private` that a subclass can
 * still call, so a great deal of the framework's plumbing is public in the
 * language and internal in fact, and this comment is the only place that
 * difference is written down. The header above already counted these as a
 * miscount; this stops counting them.
 */
const NODOC = /#\s*:nodoc:/;

/**
 * Whether a `def` line names a method, given what follows the name.
 *
 * Two shapes read as one and are not, and both were being counted against us
 * as API we lack.
 *
 * `def build_#{name}(*args)` defines a method per association at run time, and
 * the pattern stops at the `#`, so it captured the prefix `build_`. Rails has
 * no method called `build_`; it has `build_author`, and this cannot know the
 * association names. Four of these were in the ActiveRecord list —
 * `build_`, `create_`, `reload_`, `reset_`.
 *
 * `def self.[](version)` and `def str.inspect` both leave the pattern with a
 * `.` after what it captured, because the real name is an operator in the
 * first and the receiver is a local variable in the second. Both captured
 * literally the words `self` and `str`.
 */
function namesAMethod(name: string, next: string): boolean {
  // Interpolated: `def build_#{…}` is a prefix, not a name.
  if (next === "#") return false;

  // A receiver, not a name: `def self.[]`, `def str.inspect`.
  return next !== ".";
}

/**
 * Public methods in a Rails component.
 *
 * Everything after a `private`/`protected` keyword in a file is skipped, and
 * so are the `_`-prefixed internals Rails uses for framework plumbing.
 */
/** Not a feature, for either of the two reasons above. */
function excluded(name: string): boolean {
  return NOISE.has(name) || RUBY_ONLY.has(name);
}

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

        const method = /^def\s+(?:self\.)?([a-z_][a-zA-Z0-9_]*[?!=]?)(.?)/.exec(trimmed);
        if (
          method &&
          !NODOC.test(trimmed) &&
          namesAMethod(method[1] as string, method[2] as string)
        ) {
          const name = method[1] as string;
          if (!name.startsWith("_") && !excluded(camel(name))) names.add(camel(name));
        }

        // `delegate :foo, :bar, to: :baz` is public API too.
        const delegated = /^delegate\s+(.+?),\s*to:/.exec(trimmed);
        if (delegated) {
          for (const one of delegated[1]!.split(",")) {
            const clean = one
              .trim()
              .replace(/^:/, "")
              .replace(/[?!=]$/, "");
            if (
              /^[a-z_][a-zA-Z0-9_]*$/.test(clean) &&
              !clean.startsWith("_") &&
              !excluded(camel(clean))
            ) {
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

/**
 * A name bound by destructuring, or listed in an export.
 *
 * `const { before: beforeValidation } = callbackDecorators("validation")` is
 * how the ORM builds its callback decorators, and `export { beforeValidation }`
 * is how they leave the module. Neither is followed by `(`, `<`, `:` or `=`,
 * so the rule above cannot see either — and `beforeValidation` was being
 * counted as missing while being the documented way to write one.
 *
 * Deliberately only these two shapes rather than "an identifier before a comma
 * or a brace": that wider rule would read the *values* of an object literal as
 * declarations, so `{ from: options.to }` would claim `to` is implemented.
 * Counting something we have not written is a worse failure for this tool than
 * missing something we have.
 */
const BOUND_NAMES = /(?:export\s*|(?:const|let|var)\s*)\{([^}]*)\}(?=\s*(?:=|from|;|$))/gm;

/** The name a destructuring or export entry actually binds: the half after `:` or `as`. */
function boundName(entry: string): string | undefined {
  const parts = entry.split(/:|\bas\b/);
  const last = parts[parts.length - 1]?.trim();

  return last !== undefined && /^[a-zA-Z][a-zA-Z0-9_]*$/.test(last) ? last : undefined;
}

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

      for (const match of source.matchAll(BOUND_NAMES)) {
        for (const entry of (match[1] as string).split(",")) {
          const name = boundName(entry);

          if (name !== undefined) names.add(key(name));
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

/**
 * Rails names this port spells differently, and where the thing they name is.
 *
 * The tool matches by name, so `link_to` reads as missing while `<Link>` sits
 * in `packages/view/src/links.tsx` doing exactly what `link_to` does. The
 * header has always said so in prose; this says it where the counting happens.
 *
 * This cannot hide a gap. An entry only changes *which* name is looked for in
 * our source — if the name on the right is not there, the Rails name is still
 * counted as missing. So an entry pointing at nothing scores nothing, and the
 * only thing an entry can do is stop a rename from reading as an absence.
 *
 * The bar for adding one: the file and line, read, doing the same job. Not
 * "something similar exists". `form_for` is deliberately absent from this
 * table — Rails' own documentation supersedes it with `form_with`, so it is a
 * feature this port declined rather than one it renamed.
 */
const ALIASES: Record<string, string> = {
  // ActionView is JSX here rather than helper methods, so the whole helper
  // surface is components. Two that the camelCase rule cannot reach:
  linkTo: "Link", // packages/view/src/links.tsx
  currentPage: "isCurrentPage", // packages/view/src/assets.tsx

  // Rails' two names for one encryptor: the pair that signs and the pair that
  // does not exists there because `MessageVerifier` is a separate class. Here
  // there is one class whose messages are always authenticated, so the names
  // that distinguish them have nothing to distinguish.
  encryptAndSign: "encrypt", // packages/support/src/messages.ts
  decryptAndVerify: "decrypt", // packages/support/src/messages.ts

  // `LEFT OUTER JOIN` is what it emits; `leftJoins` is Rails' own shorter
  // alias for the same method.
  leftOuterJoins: "leftJoins", // packages/orm/src/relation.ts

  // Rails reads `database.yml` into `configurations` and then a model calls
  // `establish_connection` against a key in it. One function takes the same
  // configuration here, and `connectsTo` binds a class to a key in it.
  establishConnection: "configureDatabases", // packages/orm/src/databases.ts
  configurations: "configureDatabases", // packages/orm/src/databases.ts

  // `Module#deprecate` is Rails' shorthand for `deprecate_methods` on the
  // default deprecator; the method it forwards to is the one here.
  deprecate: "deprecateMethods", // packages/support/src/deprecation.ts

  // `each_record` is what `in_batches` returns an enumerator of; iterating one
  // record at a time in batches is `findEach`.
  eachRecord: "findEach", // packages/orm/src/relation.ts

  // Generated per association — `post.commentIds()` and `post.setCommentIds()`
  // — so there is no method by either name to find. The one that writes them
  // is what the reader should be sent to.
  idsReader: "defineCollectionIds", // packages/orm/src/model.ts
  idsWriter: "defineCollectionIds", // packages/orm/src/model.ts

  // Rails' `RemoteIp::GetIp#calculate_ip`, trusted-proxy list and all.
  calculateIp: "clientIp", // packages/controller/src/client_ip.ts

  // `max-stale` with no value is `"unlimited"` from this one, which is why
  // there is no second method asking whether it was unlimited.
  maxStaleUnlimited: "maxStale", // packages/controller/src/request_details.ts

  // The guard that refuses a destructive task against production, and the
  // read of what the database last recorded about itself.
  checkCurrentProtectedEnvironment: "checkProtectedEnvironments", // packages/orm/src/protected_environments.ts
  lastStoredEnvironment: "storedEnvironment", // packages/orm/src/protected_environments.ts

  // Rails swaps the digest by handing over a class; there is no class to hand
  // over here, so it takes the algorithm's name.
  hashDigestClass: "setHashDigestAlgorithm", // packages/support/src/digest.ts

  // Rails has both because its plain `subscribe` hands the block wall-clock
  // times, which jump when NTP or a daylight-saving change moves the clock,
  // and a duration computed across one of those is wrong. `subscribe` here
  // times with `performance.now()` and always has, so the guarantee
  // `monotonic_subscribe` exists to offer is the only one on offer.
  monotonicSubscribe: "subscribe", // packages/support/src/notifications.ts

  // Same decision, asked the other way round: whether this user agent is one
  // `allowBrowser` turns away.
  blocked: "browserAllowed", // packages/controller/src/allow_browser.ts

  // Rails wraps a Rack response for assertions with a factory; here the class
  // is constructed directly, because it needs the already-read body and a
  // factory that cannot get it would be a factory that lies.
  fromResponse: "TestResponse", // packages/testing/src/request.ts

  // Generated per flash type, like the collection id readers above:
  // `flash.alert` exists because `alert` is in the list, so the list is what
  // the reader should be sent to.
  alert: "flashTypes", // packages/controller/src/controller.ts

  // Rails keeps `ip` and `remote_ip` apart because `remote_ip` reads the
  // forwarded header by default, so the two disagree behind a proxy. Here the
  // default trusts no proxy at all — a deliberate choice, argued at length in
  // the file — which makes `clientIp()` with nothing declared exactly the
  // socket address, and leaves the second name nothing to name. Established by
  // mutation rather than by reading: an `ip` accessor returning
  // `this.clientIp()` broke no test, because it was correct.
  ip: "clientIp", // packages/controller/src/client_ip.ts
};

console.log("component        rails   ours   covered   missing (a sample)");
console.log("-".repeat(96));

let totalRails = 0;
let totalCovered = 0;

for (const [label, component, subdirs, _packages] of AREAS) {
  const rails = await railsMethods(component, subdirs);
  const here = (name: string): boolean => {
    const alias = ALIASES[name];

    return all.has(key(name)) || (alias !== undefined && all.has(key(alias)));
  };
  const covered = [...rails].filter(here);
  const missing = [...rails].filter((name) => !here(name));

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
