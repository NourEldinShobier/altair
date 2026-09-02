/**
 * Finding a class by its name, ported from `ActiveSupport::Autoload`,
 * `ActiveSupport::Dependencies` and the reloading half of
 * `ActiveSupport::Dependencies::Interlock`.
 *
 * The convention is one line long — `Admin::PostsController` lives in
 * `admin/posts_controller` — and everything else here exists because of what
 * follows from taking it seriously:
 *
 * - **A name is resolved to a path, never a path scanned for names.** Scanning
 *   means reading every file at boot to find out what is in it, which is the
 *   cost autoloading exists to avoid. It also means two files defining the
 *   same constant is a silent race rather than an error.
 * - **Loading is exclusive; running is shared.** Requests run concurrently and
 *   share the interlock; a reload takes it alone. Without that, a request can
 *   observe a constant halfway through being redefined — a class that exists
 *   with none of its methods, which fails as a `NoMethodError` on a method the
 *   file plainly defines.
 * - **Eager loading in production is the point of the whole arrangement.**
 *   Autoloading defers work in development, where a boot happens on every
 *   edit. In production it would leave the first request to touch each
 *   constant paying for it, and worse, would make constant resolution happen
 *   under concurrency forever rather than once at boot.
 *
 * `execution.ts` owns the interlock itself. This is the naming half plus the
 * unload lifecycle, and it calls into that lock rather than keeping a second
 * one.
 */

import { NameError } from "./class_attributes.js";
import { camelize, underscore } from "./inflector.js";
import { loadInterlock, type Reloader } from "./execution.js";
import { FileUpdateChecker, type FileStats } from "./file_update_checker.js";

// --- names and paths ----------------------------------------------------------

/**
 * Rails' `Dependencies.search_for_file` — the relative path a constant lives at.
 *
 * `Admin::PostsController` becomes `admin/posts_controller`. Nesting becomes
 * directories rather than a flat underscored name, so a namespace can be moved
 * by moving a directory.
 */
export function searchForFile(constantName: string): string {
  return constantName
    .split("::")
    .map((part) => underscore(part))
    .join("/");
}

/**
 * The constant a path defines. Rails' `Dependencies.loadable_constants_for_path`.
 *
 * The inverse of `searchForFile` — exactly, for every name whose casing the
 * inflector can reconstruct. `API::V1::Base` is the exception and the reason
 * `inflections().acronym` exists: `api` reconstructs as `Api` unless something
 * declared `API` an acronym, so an application with an acronym in a namespace
 * has to say so or the constant it defines and the constant Rails looks for
 * differ by two letters.
 */
export function constantForPath(path: string): string {
  return path
    .replace(/\.[^./]+$/, "")
    .split("/")
    .filter((part) => part !== "")
    .map((part) => camelize(part))
    .join("::");
}

/** Rails' `Dependencies.autoload_paths` expansion. */
export function expand(root: string, relative: string): string {
  if (relative.startsWith("/")) return relative;

  return `${root.replace(/\/+$/, "")}/${relative.replace(/^\.\//, "")}`;
}

/**
 * Rails' `File.absolute_path?` check on a load path entry.
 *
 * A relative entry resolves against the working directory, which is where the
 * process was started rather than where the application lives — so an
 * application autoloads correctly from its own directory and fails from
 * anywhere else, including most process managers.
 */
export function absolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[/\\]/.test(path);
}

// --- what is registered for autoloading ---------------------------------------

export interface AutoloadEntry {
  constantName: string;
  path: string;
  eager: boolean;
}

/** The registry a namespace builds up. Rails' `@_autoloads`. */
export interface AutoloadRegistry {
  under?: string;
  at?: string;
  entries: Map<string, AutoloadEntry>;
}

export function newAutoloadRegistry(): AutoloadRegistry {
  return { entries: new Map() };
}

/**
 * Rails' `autoload` — register a constant and where to find it.
 *
 * Registration rather than loading: the file is read the first time something
 * names the constant, which is the whole feature. A framework declaring every
 * constant it might define costs one map entry each at boot instead of one
 * file read each.
 */
export function autoload(
  registry: AutoloadRegistry,
  constantName: string,
  path?: string,
): AutoloadRegistry {
  const under = registry.under === undefined ? "" : `${searchForFile(registry.under)}/`;
  const resolved = path ?? registry.at ?? `${under}${searchForFile(constantName)}`;

  registry.entries.set(constantName, { constantName, path: resolved, eager: false });

  return registry;
}

/**
 * Rails' `autoload_under` — a prefix for the declarations inside a block.
 *
 * `autoload_under "middleware"` so `autoload :Static` finds
 * `middleware/static`. The alternative is repeating the directory on every
 * line, which is how one of them ends up spelled differently from the rest.
 */
export function autoloadUnder(
  registry: AutoloadRegistry,
  directory: string,
  block: (registry: AutoloadRegistry) => void,
): AutoloadRegistry {
  const held = registry.under;
  registry.under = directory;

  try {
    block(registry);
  } finally {
    // Restored rather than cleared, so nesting works and a throwing block does
    // not leave every later declaration prefixed.
    registry.under = held;
  }

  return registry;
}

/** Rails' `autoload_at` — several constants defined by one file. */
export function autoloadAt(
  registry: AutoloadRegistry,
  path: string,
  block: (registry: AutoloadRegistry) => void,
): AutoloadRegistry {
  const held = registry.at;
  registry.at = path;

  try {
    block(registry);
  } finally {
    registry.at = held;
  }

  return registry;
}

/**
 * Rails' `eager_autoload` — the declarations inside are also loaded eagerly.
 *
 * Separate from `autoload` because eager loading in production is what turns
 * constant resolution from something happening under concurrency forever into
 * something that happened once at boot. A constant not marked here is still
 * autoloadable; it is just resolved by whichever request first names it.
 */
export function eagerAutoload(
  registry: AutoloadRegistry,
  block: (registry: AutoloadRegistry) => void,
): AutoloadRegistry {
  const before = new Set(registry.entries.keys());

  block(registry);

  for (const [name, entry] of registry.entries) {
    if (!before.has(name)) entry.eager = true;
  }

  return registry;
}

/** The entries eager loading has to walk. Rails' `eager_load!`. */
export function eagerLoadEntries(registry: AutoloadRegistry): AutoloadEntry[] {
  return [...registry.entries.values()].filter((entry) => entry.eager);
}

// --- resolving a name ----------------------------------------------------------

/**
 * The message a failed autoload gets.
 *
 * Names both the constant and the file that was expected to define it: from
 * the constant alone the two usual causes are indistinguishable — the file is
 * missing, or it exists and defines something spelled differently.
 */
function uninitializedConstant(constantName: string, detail: string): NameError {
  return new NameError(
    constantName,
    [],
    `Uninitialized constant ${constantName}. Expected ${searchForFile(constantName)} to define ` +
      `it; ${detail}.`,
  );
}

/**
 * Rails' `Module#const_missing` hook — resolve a name that is not loaded yet.
 *
 * Raises `class_attributes.ts`'s `NameError` rather than a second error type
 * of its own: a rescue around a constant lookup should not have to know which
 * of the two ways of resolving a name was used.
 */
export function constMissing(
  registry: AutoloadRegistry,
  constantName: string,
  load: (path: string) => unknown,
): unknown {
  const entry = registry.entries.get(constantName);
  const path = entry?.path ?? searchForFile(constantName);
  const loaded = load(path);

  if (loaded === undefined) {
    throw uninitializedConstant(
      constantName,
      entry === undefined
        ? "nothing declared it for autoloading either"
        : `${path} loaded without defining it`,
    );
  }

  return loaded;
}

/** Rails' `Dependencies.load_class`. */
export function loadClass(
  registry: AutoloadRegistry,
  constantName: string,
  load: (path: string) => unknown,
): unknown {
  return constMissing(registry, constantName, load);
}

/**
 * Rails' `require_dependency` — load a file, tracking it for unloading.
 *
 * Distinct from a plain require because a plain one is remembered permanently:
 * a reload that unloaded the constants but left the file marked as required
 * would not read it again, so the class would simply be gone.
 */
export function requireDependency(
  loaded: Set<string>,
  path: string,
  load: (path: string) => unknown,
): unknown {
  loaded.add(path);

  return load(path);
}

/** Rails' `NameError#missing_name?` — whether an error is about this constant. */
export function isMissing(error: unknown, constantName: string): boolean {
  if (!(error instanceof NameError)) return false;

  // Exact rather than a substring: `Post` is a substring of `PostsController`,
  // and a rescue matching loosely swallows an error about a different constant
  // and retries a load that will fail the same way.
  return error.constantName === constantName;
}

/**
 * Rails' `determine_constant_from_test_name`.
 *
 * `PostsControllerTest` names `PostsController`. Trailing segments are dropped
 * one at a time so `Admin::PostsControllerTest` finds `Admin::PostsController`
 * rather than giving up at the namespace.
 */
export function determineConstantFromTestName(
  testName: string,
  resolve: (name: string) => unknown,
): unknown {
  let name = testName.replace(/Test$/, "");

  while (name !== "") {
    const found = resolve(name);

    if (found !== undefined) return found;

    const parts = name.split("::");
    parts.pop();
    name = parts.join("::");
  }

  return undefined;
}

// --- unloading -----------------------------------------------------------------

/**
 * Rails' `require_unload_lock!`.
 *
 * Taken before anything is unloaded, and held until it is all back. A request
 * running through a half-unloaded set of constants sees a class that exists
 * with none of its methods, which fails as a `NoMethodError` on a method the
 * file plainly defines — and the file is right, so nobody finds it by reading.
 */
export function requireUnloadLock(options: { noWait?: boolean } = {}): Promise<boolean> {
  return loadInterlock().startExclusive(options);
}

/** Rails' `release_unload_lock!`. */
export function releaseUnloadLock(): void {
  loadInterlock().stopExclusive();
}

let unloading = false;

/** Rails' `start_unloading` bookkeeping. */
export function startUnloading(): void {
  unloading = true;
}

/** Rails' `done_unloading`. */
export function doneUnloading(): void {
  unloading = false;
}

export function currentlyUnloading(): boolean {
  return unloading;
}

/**
 * Rails' `clear` — forget what was loaded so it is read again.
 *
 * Everything, not the changed files only. A file whose constants reference
 * another file's is stale as soon as that other one changes, and working out
 * which ones is the dependency graph Rails deliberately stopped maintaining:
 * getting it wrong leaves a class holding a reference to a version of another
 * class that no longer exists anywhere else.
 */
export function clearContext(loaded: Set<string>): number {
  const count = loaded.size;
  loaded.clear();

  return count;
}

const prepareHooks: (() => void)[] = [];

/**
 * Rails' `to_prepare` — run before each request in development, once in
 * production.
 *
 * Where anything holding a reference to an autoloaded constant re-reads it. A
 * reference captured at boot points at the class from before the reload, and
 * the two are different objects that both answer to the same name — which is
 * how `instance_of?` starts returning false for an object plainly of that
 * class.
 */
export function toPrepare(hook: () => void): void {
  prepareHooks.push(hook);
}

export function runPrepareHooks(): number {
  for (const hook of prepareHooks) hook();

  return prepareHooks.length;
}

export function resetPrepareHooks(): void {
  prepareHooks.length = 0;
}

// --- watching for changes -------------------------------------------------------

/**
 * Rails' `directories_to_watch`.
 *
 * The autoload paths, minus any nested inside another. A directory watched
 * twice reports every change twice, and a reloader that reloads twice per edit
 * doubles the slowest part of development.
 */
export function directoriesToWatch(paths: readonly string[]): string[] {
  const normalized = [...new Set(paths.map((path) => path.replace(/\/+$/, "")))].sort();

  return normalized.filter(
    (path) => !normalized.some((other) => other !== path && path.startsWith(`${other}/`)),
  );
}

/**
 * Rails' `watched_dirs_with_extensions`.
 *
 * Extensions per directory rather than globally, because a directory of
 * templates and a directory of source files change for different reasons: a
 * template edit should not unload every class in the application.
 */
export function watchedDirsWithExtensions(
  paths: readonly string[],
  extensions: readonly string[] = ["ts", "tsx"],
): Record<string, string[]> {
  return Object.fromEntries(directoriesToWatch(paths).map((path) => [path, [...extensions]]));
}

/** What a reloader watches, and what it forgets when something changes. */
export interface ChangeWatch {
  /** The autoload paths. Nested ones are watched once; see `directoriesToWatch`. */
  paths: readonly string[];
  /** What an edit has to be to count. A template is not a class. */
  extensions?: readonly string[];
  /** Files watched by name rather than by directory — a routes file, a schema. */
  files?: readonly string[];
  /** The set of loaded constants to forget. Rails' `Dependencies.loaded`. */
  loaded: Set<string>;
  stats?: FileStats;
}

/**
 * Points a reloader at the filesystem. Rails' `Rails.application.reloader`
 * setup in the `active_support.set_configs` initializer.
 *
 * Both halves of this already existed and nothing joined them.
 * `file_update_checker.ts` answers "has anything changed since I last looked";
 * `Reloader` in `execution.ts` knows how to take the interlock alone, unload,
 * and put everything back. `directoriesToWatch` and `watchedDirsWithExtensions`
 * above exist for exactly this and had no caller. This is the joint.
 *
 * `directoriesToWatch` collapses a path nested inside another. That matters
 * for a watcher fed by filesystem events, where a directory watched twice
 * reports every change twice; the scan here would deduplicate anyway, and the
 * helper is used because the day this is backed by events is not the day to
 * find that out.
 *
 * The check goes on as a `check` rather than as the checker's own block,
 * because the checker is deliberately synchronous — it is a directory scan,
 * paid once per request in development — and a reload is not. Making the cheap
 * "nothing changed" answer wait on a promise would put the cost on every
 * request instead of on the ones that edited something.
 *
 * The forgetting happens in `beforeClassUnload`, so the constants are gone
 * before the body re-reads them and before any prepare hook runs — a hook that
 * re-reads a constant which has not been forgotten yet gets back the version
 * being replaced, which is the whole failure a reload exists to avoid.
 *
 * The scan is recorded alongside it. Where in the sequence that happens turns
 * out not to matter, because `execute` records the scan `updated` took rather
 * than a fresh one — an edit made while the reload runs is seen by the next
 * check either way. It is here because this is where the reload is decided.
 */
export function watchForChanges(reloader: Reloader, watch: ChangeWatch): FileUpdateChecker {
  const checker = new FileUpdateChecker(
    {
      files: watch.files,
      dirs: watchedDirsWithExtensions(watch.paths, watch.extensions),
    },
    () => undefined,
    watch.stats,
  );

  reloader.check(() => checker.updated());

  reloader.beforeClassUnload(() => {
    checker.execute();
    clearContext(watch.loaded);
  });

  // After, not before: a prepare hook re-reads a constant, and re-reading one
  // that has not been forgotten yet gives back the version being replaced.
  reloader.afterClassUnload(() => {
    runPrepareHooks();
  });

  return checker;
}

// --- deprecating a constant -------------------------------------------------------

/**
 * Rails' `deprecate_constant`.
 *
 * The old name keeps working and says so, rather than being removed. A
 * constant is referenced from application code the framework cannot see, so
 * removing one turns an upgrade into a `NameError` at the first request that
 * touches it — usually in production, since a name only some code path uses is
 * exactly the name tests miss.
 */
export function deprecateConstant(
  registry: Map<string, unknown>,
  oldName: string,
  newName: string,
  warn: (message: string) => void,
): unknown {
  const value = registry.get(newName);

  warn(
    `${oldName} is deprecated; use ${newName}. The old name still resolves, so nothing breaks ` +
      `today — but it will be removed, and a name only one code path uses is exactly the name ` +
      `tests miss.`,
  );

  return value;
}

/**
 * Rails' `logger_outputs_to?` — whether a logger writes to a given stream.
 *
 * Used to decide whether the framework should add its own console logger. Two
 * loggers on one stream duplicates every line, which makes a development log
 * twice as long and every grep of it twice as confusing.
 */
export function loggerOutputsTo(
  logger: { destination?: unknown } | undefined,
  ...streams: readonly unknown[]
): boolean {
  if (logger === undefined) return false;

  return streams.includes(logger.destination);
}
