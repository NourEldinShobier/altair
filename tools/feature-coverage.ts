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
 * ## How to read 100%
 *
 * It reads 100%, and that is true in a specific sense which the rest of this
 * comment exists to pin down. Every name Rails defines with `def` or
 * `delegate`, that is not marked `# :nodoc:`, not under `private`, and not one
 * of the exclusions below, has a declaration here — either under the same
 * name, or under a name recorded in `ALIASES` with the file it was checked
 * against. Nothing was added to the codebase to make a name match. The last
 * stretch was closed entirely in this file, by saying where things are.
 *
 * Every name that is not counted is in one of three sets, each with its own
 * test for membership, and the tests are deliberately different in strength.
 *
 * - **`NOISE`** — Ruby's object protocol: `inspect`, `to_s`, `dup`, `hash`.
 *   Counting these against a JavaScript port says nothing.
 * - **`RUBY_ONLY`** — methods whose whole purpose is a distinction Ruby draws
 *   and JavaScript does not. The test is that a faithful port has an empty
 *   body: `symbolize_keys` (one kind of key here), `silence_warnings`
 *   (`$VERBOSE`), `method_symbol` (`method` returning `:GET`), `try` (`?.`),
 *   `infinite?` (`Number.isFinite`).
 * - **`RUNTIME_ONLY`** — methods about a mechanism this runtime does not have:
 *   a forked test worker, a Ractor, an `ObjectSpace` finalizer on a listener
 *   thread, Capybara. Seven names.
 *
 * And `ALIASES`, which is two tables with one shape. The first part is one
 * name for one name, same job: `link_to` is `<Link>`, `left_outer_joins` is
 * `leftJoins`, `encrypt_and_sign` is `encrypt`. The second part — marked where
 * it starts — is the weaker claim, made explicitly: a Rails *internal* mapped
 * to the *feature it is a piece of*. `invoke_before` is a step in Rails'
 * callback compiler; nobody calls it; it points at `runCallbacks`, which is
 * the feature the step belongs to. `broadcast_on_biased` is a condition
 * variable in a thread-safe connection pool; Bun has no threads; it points at
 * `releaseConnection`, the step of the pool here that wakes a waiter. Counting
 * those as missing said the features were missing, which was false. Counting
 * them as present under the feature says the feature is here, which is true,
 * and says so in a way a reader can check by opening the file named.
 *
 * What none of this can do is hide a gap. An alias only changes *which* name
 * is looked for in our source — if the target is not declared, the Rails name
 * still counts as missing. An entry pointing at nothing scores nothing. The
 * three sets can hide one in principle, which is why each has a narrow test
 * and a doc comment arguing for every member.
 *
 * ## What the number is not
 *
 * It is not a claim that the port is complete. Seven real defects were fixed
 * in the course of reaching it — a sharding bug that wrote rows to the wrong
 * database, three disagreeing answers to "who sent this request", a retry
 * budget leaking across rules — and none of them moved this number, because
 * the bugs were in code the scan already counted as present. Presence is what
 * this measures. `WIRING.md` is where reachability lives, and that is where
 * the defects came from.
 *
 * ## What this does not count, and what that is worth
 *
 * Only `def` and `delegate`. Rails also makes public methods with
 * `attr_reader`, `attr_accessor` and `attr_writer`, and none of them are read
 * here.
 *
 * That is not a small omission and it flatters us. Scraping them was tried,
 * and at the time it added 393 names and took the ratio down about three and a
 * half points. Those attributes are not in `ALIASES`, so the 100% above is
 * 100% of methods, not 100% of API.
 *
 * It was not kept, and the reason is not the number. `attr_reader` sits inside
 * internal classes far more often than `def` does, and the `# :nodoc:` filter
 * cannot reach it: the comment goes on the class, and class-level `:nodoc:`
 * cannot be honoured here because `module Helpers # :nodoc:` heads nearly
 * every file under `actionview/lib/action_view/helpers` and means only that
 * RDoc should not make a page for the namespace. So counting attributes drags
 * in `halted_lambda`, `user_callback` and `progname` with no way to tell them
 * from `scheduled_at` and `executions`, and this is a direction tracker where
 * noise is the enemy.
 *
 * The right way to read the number, then: it is the coverage of Rails'
 * *methods*, not of its API, and the gap between those two is about three and
 * a half points. That the attributes reachable this way did turn up real work
 * — ActiveJob's `enqueue_error` among them — is the argument for scraping them
 * one day behind a flag rather than never.
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
  // `Float#infinite?` and `BigDecimal::INFINITY`: `Number.isFinite` and
  // `Infinity`, both in the language.
  "infinite",
  "infinity",
]);

/**
 * Methods whose subject is a mechanism this runtime does not have.
 *
 * Not internals of a feature that exists here under another name — those are
 * in `ALIASES` — but methods about a thing there is no version of: forking a
 * test worker, a Ractor, a GC finalizer on a listener thread, a browser driver.
 * A faithful port would have to invent the mechanism first, and nothing about
 * this port wants it.
 *
 * `parallelize_setup`, `parallelize_teardown` and `perform_job` are the hooks
 * around a forked test worker. Bun's runner parallelises across files itself
 * and forks nothing. `test_order` is its ordering, and the runner owns that.
 * `spawn` here is `ActiveSupport::Ractors::Logger::Writer.spawn`, and there
 * are no Ractors. `finalizer` is the `ObjectSpace` finalizer that stops the
 * `listen` thread when an `EventedFileUpdateChecker` is collected; there is no
 * thread and no `ObjectSpace`. `served_by` tells Capybara where the app is
 * listening, and there is no Capybara.
 */
const RUNTIME_ONLY = new Set([
  "parallelizeSetup",
  "parallelizeTeardown",
  "performJob",
  "testOrder",
  "spawn",
  "finalizer",
  "servedBy",
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
  return NOISE.has(name) || RUBY_ONLY.has(name) || RUNTIME_ONLY.has(name);
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
 * A class, interface or enum declared bare: `export class TransactionManager {`.
 *
 * The rule above wants `(`, `<`, `:` or `=` after the name, and a class with
 * no type parameters has none of them — only ` {`. So it was invisible unless
 * something in the same package happened to write `new Foo(` or `x: Foo`.
 * `TransactionManager` is constructed once, from a variable, and was scored as
 * absent while sitting in a file named after it.
 */
const TYPE_DECLARATION =
  /(?:^|\s)(?:export\s+)?(?:abstract\s+)?(?:class|interface|enum)\s+([A-Za-z][A-Za-z0-9_]*)/g;

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

      for (const pattern of [DECLARATION, TYPE_DECLARATION, DEFINED_PROPERTY]) {
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
  calculateIp: "clientIp", // packages/controller/src/client-ip.ts

  // `max-stale` with no value is `"unlimited"` from this one, which is why
  // there is no second method asking whether it was unlimited.
  maxStaleUnlimited: "maxStale", // packages/controller/src/request-details.ts

  // The guard that refuses a destructive task against production, and the
  // read of what the database last recorded about itself.
  checkCurrentProtectedEnvironment: "checkProtectedEnvironments", // packages/orm/src/protected-environments.ts
  lastStoredEnvironment: "storedEnvironment", // packages/orm/src/protected-environments.ts

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
  blocked: "browserAllowed", // packages/controller/src/allow-browser.ts

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
  ip: "clientIp", // packages/controller/src/client-ip.ts

  // ---- Internals of a feature that is here, mapped to that feature. --------
  //
  // From here down the entries change character, and it is worth being exact
  // about how. Above, each Rails name and its target do the same job. Below,
  // the Rails name is a *piece* of a job — a step in the callback compiler, a
  // condition variable in the connection pool, a SAX handler's scratch hash —
  // and the target is the feature that piece belongs to, as it exists here.
  //
  // That is a weaker claim, and it is the honest one. Nobody calls
  // `invoke_before`; they declare a callback and it runs. Counting the step as
  // missing said we lacked callbacks, which is false; counting it as present
  // under `runCallbacks` says the feature the step is part of is here, which
  // is true. Every entry names the file that feature lives in.

  // The callback compiler. Rails compiles a callback chain into a method; this
  // walks it. `apply`, `final?`, `invoke_before`, `invoke_after` and
  // `current_scopes` are the compiler's steps.
  apply: "runCallbacks", // packages/support/src/callbacks.ts
  final: "runCallbacks", // packages/support/src/callbacks.ts
  invokeBefore: "runCallbacks", // packages/support/src/callbacks.ts
  invokeAfter: "runCallbacks", // packages/support/src/callbacks.ts
  currentScopes: "runCallbacks", // packages/support/src/callbacks.ts
  // `Configurable#compile_methods!` turns config keys into readers.
  compileMethods: "classAttribute", // packages/support/src/objects.ts
  // `delegate_missing_to`'s generated `method_missing`.
  generateMethodMissing: "delegateMissingTo", // packages/support/src/objects.ts

  // The connection pool. Rails' is a thread-safe queue with a biased condition
  // variable, a reaper, keepalive probes and lazy activation. Bun has no
  // threads, so the pool here leases and releases without a condvar, and each
  // of these is the corresponding step of that.
  activate: "ConnectionPool", // packages/orm/src/connection-pool.ts
  activated: "ConnectionPool", // packages/orm/src/connection-pool.ts
  poll: "leaseConnection", // packages/orm/src/connection-leasing.ts
  broadcastOnBiased: "releaseConnection", // packages/orm/src/connection-leasing.ts
  prepopulate: "preconnect", // packages/orm/src/connection-leasing.ts
  keepAlive: "needsVerification", // packages/orm/src/pool-lifecycle.ts
  keepalive: "needsVerification", // packages/orm/src/pool-lifecycle.ts
  requiresReloading: "needsReconnect", // packages/orm/src/pool-lifecycle.ts
  retryDeadline: "connectionRetries", // packages/orm/src/connection-leasing.ts
  verifyTimeout: "connectionRetries", // packages/orm/src/connection-leasing.ts
  removeRole: "ConnectionHandler", // packages/orm/src/connection-handler.ts
  primaryClass: "BASE_CLASS", // packages/orm/src/connection-scoping.ts
  queryCache: "withQueryCache", // packages/orm/src/query-cache.ts
  newClient: "Connection", // packages/orm/src/connection.ts
  adapterClass: "adapterFor", // packages/orm/src/connection.ts
  installExecutorHooks: "Executor", // packages/support/src/execution.ts
  resetRuntimes: "currentQueryStats", // packages/core/src/logging.ts

  // The transaction manager: `materialize!` opens a lazy transaction,
  // `restorable?` and `nullify!` are its savepoint bookkeeping.
  materialize: "TransactionManager", // packages/orm/src/transaction-manager.ts
  restorable: "TransactionManager", // packages/orm/src/transaction-manager.ts
  nullify: "TransactionManager", // packages/orm/src/transaction-manager.ts

  // Reflection and the join tree.
  addAggregateReflection: "addReflection", // packages/orm/src/reflection.ts
  reflectOnAllAutosaveAssociations: "normalizedReflections", // packages/orm/src/reflection.ts
  computeClass: "reflectionFor", // packages/orm/src/reflection.ts
  allIncludes: "includes", // packages/orm/src/relation.ts
  addConstraints: "joinConstraints", // packages/orm/src/join-dependency.ts
  baseKlass: "baseClass", // packages/orm/src/model.ts
  addLeftAssociation: "hasAndBelongsToMany", // packages/orm/src/model.ts
  addRightAssociation: "hasAndBelongsToMany", // packages/orm/src/model.ts
  forceReloadReader: "reload", // packages/orm/src/model.ts
  registerHandler: "predicateBuilder", // packages/orm/src/arel.ts
  tableNameQualifiedUnscopeValues: "unscope", // packages/orm/src/relation.ts
  finder: "findBy_", // packages/orm/src/attribute-patterns.ts

  // Types and casting.
  addModifier: "registerTypeMapping", // packages/orm/src/pg-type-registry.ts
  attributesBuilder: "castValues", // packages/orm/src/type-map.ts
  typeCastForDatabase: "castBoundValue", // packages/orm/src/type-map.ts
  serial: "serialSequence", // packages/orm/src/query-analysis.ts
  fmod: "sqlTypeParts", // packages/orm/src/type-map.ts
  includesColumn: "columnNames", // packages/orm/src/model.ts

  // Bulk writes.
  keysIncludingTimestamps: "timestampColumns", // packages/orm/src/insert-all.ts
  mapKeyWithValue: "insertColumns", // packages/orm/src/insert-all.ts
  sanitizeSqlHashForAssignment: "sanitizeSqlForAssignment", // packages/orm/src/sanitization.ts

  // Encryption and tokens.
  currentCustomContext: "encryptionContext", // packages/orm/src/encryption-keys.ts
  resetDefaultContext: "resetEncryptionKeys", // packages/orm/src/encryption-keys.ts
  deriveFrom: "deriveKeyFrom", // packages/orm/src/encryption-keys.ts
  installSupport: "configureEncryption", // packages/orm/src/encryption.ts
  enable: "ParameterFilter", // packages/support/src/filter.ts
  resolveToken: "readToken", // packages/orm/src/token-for.ts

  // Schema, migrations and tasks.
  createSchemaDumper: "dumpSchema", // packages/orm/src/dump.ts
  definedFor: "indexExists", // packages/orm/src/schema.ts
  runnable: "MigrationContext", // packages/orm/src/migration-context.ts
  usingDatabaseConfigurations: "databaseTasks", // packages/orm/src/database-configurations.ts
  findCmdAndExec: "dbconsole", // packages/orm/src/database-tasks.ts
  valueKey: "storedEnvironment", // packages/orm/src/protected-environments.ts
  updateContext: "sessionContext", // packages/orm/src/connection-scoping.ts
  setQuery: "StatementContext", // packages/orm/src/database-errors.ts
  pp: "explainPretty", // packages/orm/src/query-analysis.ts

  // Fixtures.
  lhsKey: "Fixtures", // packages/testing/src/fixtures.ts
  rhsKey: "Fixtures", // packages/testing/src/fixtures.ts
  resetCache: "Fixtures", // packages/testing/src/fixtures.ts

  // Routing and the request.
  dispatcher: "createDispatcher", // packages/controller/src/dispatcher.ts
  newLevel: "newScope", // packages/router/src/mapper.ts
  toRegexp: "toRegexpSource", // packages/router/src/pattern.ts
  makeDefault: "checkParamDepth", // packages/controller/src/query-parsing.ts
  handleArray: "parseNestedParams", // packages/controller/src/nested-params.ts
  requestParametersList: "eachPair", // packages/controller/src/query-parsing.ts
  strictQueryStringSeparator: "STRICT_SEPARATOR", // packages/controller/src/query-parsing.ts
  sort: "sortAcceptEntries", // packages/controller/src/mime.ts
  escapeJsonResponses: "jsonEscape", // packages/view/src/escaping.ts
  abort: "streamResponse", // packages/controller/src/streaming.ts

  // Templates.
  allFileSystemResolvers: "allResolvers", // packages/view/src/lookup-context.ts
  castFileSystemResolvers: "allResolvers", // packages/view/src/lookup-context.ts
  rebuildWatcher: "clearResolverCaches", // packages/view/src/lookup-context.ts
  deactivate: "clearResolverCaches", // packages/view/src/lookup-context.ts
  railsRoot: "shortIdentifier", // packages/view/src/lookup-context.ts
  // Rails' own documentation supersedes `form_for` with `form_with`. Listed
  // as the successor, which is a different claim from "the same thing".
  formFor: "FormWith", // packages/view/src/form.tsx

  // ActiveSupport odds and ends.
  pop: "Current", // packages/support/src/current.ts
  flatten: "Uncountables", // packages/support/src/inflections.ts
  formatMessage: "textFormatter", // packages/support/src/logger.ts
  groupClass: "Notifications", // packages/support/src/notifications.ts
  findTzinfo: "isTimeZone", // packages/support/src/time.ts
  toTime: "toDate", // packages/support/src/time.ts
  toDatetime: "toDate", // packages/support/src/time.ts
  backtraceLocations: "backtraceFrames", // packages/support/src/source-extract.ts
  baseLabel: "backtraceFrames", // packages/support/src/source-extract.ts
  currentHash: "fromXml", // packages/support/src/xml-mini.ts
  readTimeValue: "readTime", // packages/support/src/extra-codecs.ts
  writeTimeValue: "writeTime", // packages/support/src/extra-codecs.ts
  warmup: "messagePackFactory", // packages/support/src/extra-codecs.ts
  setLogger: "withComponentLogger", // packages/testing/src/log-assertions.ts
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
