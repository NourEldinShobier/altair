/**
 * Noticing that a file changed, ported from `ActiveSupport::FileUpdateChecker`
 * and the matching half of `EventedFileUpdateChecker`.
 *
 * `autoloading.ts` knows how to unload and reload; nothing there knows *when*
 * to. This is that: the question "has anything under these directories changed
 * since I last looked", asked once per request in development and answered
 * without reading a single file's contents.
 *
 * Three details are the whole of it, and each exists because the obvious
 * version is wrong in a way nobody notices until a reload silently stops
 * happening:
 *
 * - **A count that changed is a change.** Comparing the newest mtime alone
 *   misses a deletion entirely — removing a file lowers nothing, and the
 *   remaining files still have their old timestamps — so a deleted model keeps
 *   being autoloadable until the next unrelated edit.
 * - **An mtime in the future is ignored.** A clock set forward by hand, a file
 *   copied from a machine whose clock is ahead, a container with a skewed
 *   host: any of them pins the recorded high-water mark somewhere no real edit
 *   will reach, and reloading stops for the rest of the session with no error
 *   and nothing in the log.
 * - **The scan `updated()` did is the scan `execute()` records.** Rescanning
 *   in `execute` would record the state as of *after* the reload — so an edit
 *   made in the moment between the two is swallowed, permanently, and the file
 *   on disk and the code in memory disagree until something else changes.
 */

import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/** What the checker needs from a filesystem. Injectable so a test is not one. */
export interface FileStats {
  exists(path: string): boolean;
  /** Modification time in milliseconds, or undefined if it is not there. */
  mtime(path: string): number | undefined;
  /** Every file under a directory, recursively. Absolute paths. */
  entries(dir: string): string[];
  /** The path with symlinks resolved, or the path itself if it does not exist. */
  realpath(path: string): string;
}

/** The real one. */
export const nodeFileStats: FileStats = {
  exists: (path) => existsSync(path),
  mtime(path) {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return undefined;
    }
  },
  entries(dir) {
    try {
      return readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => join(entry.parentPath, entry.name));
    } catch {
      return [];
    }
  },
  realpath(path) {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  },
};

/**
 * What to watch.
 *
 * Directories carry the extensions that count, because a view directory holds
 * templates *and* whatever an editor leaves behind — swap files, `.orig` from
 * a merge, a `.DS_Store` — and reloading the application because vim wrote a
 * lock file is a reload for nothing on every keystroke.
 *
 * An empty extension list means every file, which is what a watched
 * `config/` wants.
 */
export interface WatchedPaths {
  files?: readonly string[];
  dirs?: Readonly<Record<string, readonly string[]>>;
}

interface Snapshot {
  count: number;
  newest: number;
}

export class FileUpdateChecker {
  #files: string[];
  #dirs: Map<string, Set<string>>;
  #block: () => void;
  #stats: FileStats;

  /** The scan `updated()` took, held so `execute` records that one and not a newer one. */
  #pending: Snapshot | undefined;
  #last: Snapshot;

  constructor(watched: WatchedPaths, block: () => void, stats: FileStats = nodeFileStats) {
    this.#stats = stats;
    this.#block = block;
    this.#files = (watched.files ?? []).map((file) => resolve(file));
    this.#dirs = new Map(
      Object.entries(watched.dirs ?? {}).map(([dir, extensions]) => [
        resolve(dir),
        new Set(extensions.map(normalizeExtension)),
      ]),
    );

    this.normalizeDirs();
    this.#last = this.#scan();
  }

  /**
   * Resolves each watched directory through its symlinks. Rails'
   * `normalize_dirs!`.
   *
   * A change is reported against the path the filesystem knows, which is the
   * real one. Watching `app/views` when it is a symlink to `../shared/views`
   * means every event arrives naming a directory that is not in the map, and
   * `watching` answers false for a file that plainly changed.
   *
   * A directory that does not exist yet keeps the path it was written with,
   * which is what `realpath` answers for something that is not there. `tmp/`
   * is created on the first boot that needs it, and a watcher that decided at
   * construction that it was not there would never see it.
   */
  normalizeDirs(): void {
    this.#dirs = new Map(
      [...this.#dirs].map(([dir, extensions]) => [this.#stats.realpath(dir), extensions]),
    );
  }

  /**
   * Whether a path is one of the ones being watched. Rails' `watching?`.
   *
   * The directory match walks up from the file rather than comparing prefixes
   * as strings, because `app/views` is a prefix of `app/views_old` and a
   * string check would watch both.
   */
  watching(file: string): boolean {
    const path = resolve(file);

    if (this.#files.includes(path)) return true;

    for (const [dir, extensions] of this.#dirs) {
      const within = relative(dir, path);

      // `..` at the front means the path climbed out of the directory, which
      // is how a sibling with a longer name is refused.
      if (within === "" || within.startsWith(`..${sep}`) || within === "..") continue;

      if (extensions.size === 0 || extensions.has(extensionOf(path))) return true;
    }

    return false;
  }

  /**
   * Whether anything changed since the last `execute`.
   *
   * The scan is kept, not thrown away: `execute` records this one. Scanning
   * again there would record the state after the reload, and an edit made in
   * between would be swallowed for good.
   */
  updated(): boolean {
    const current = this.#scan();

    // A count that changed is a change. Comparing only the newest mtime misses
    // a deletion, since removing a file lowers nothing.
    if (current.count !== this.#last.count || current.newest > this.#last.newest) {
      this.#pending = current;

      return true;
    }

    return false;
  }

  /** Runs the block and records what was on disk when the change was noticed. */
  execute(): void {
    this.#last = this.#pending ?? this.#scan();
    this.#pending = undefined;

    this.#block();
  }

  /**
   * Runs the block only if something changed, and says whether it did.
   *
   * The whole per-request shape: a development middleware calls this and pays
   * one directory scan, not one reload.
   */
  executeIfUpdated(): boolean {
    if (!this.updated()) return false;

    this.execute();

    return true;
  }

  #scan(): Snapshot {
    // A time from the machine's own clock, so a file written a moment ago is
    // not read as being from the future by a millisecond.
    const now = Date.now();
    const seen = new Set<string>();
    let newest = 0;

    for (const file of this.#files) {
      if (this.#stats.exists(file)) seen.add(file);
    }

    for (const dir of this.#dirs.keys()) {
      for (const entry of this.#stats.entries(dir)) {
        if (this.watching(entry)) seen.add(resolve(entry));
      }
    }

    for (const path of seen) {
      const mtime = this.#stats.mtime(path);

      // Ignored rather than clamped: a file dated next year would otherwise
      // set a high-water mark no real edit reaches, and reloading would stop
      // for the rest of the session with nothing in the log to say why.
      if (mtime !== undefined && mtime <= now && mtime > newest) newest = mtime;
    }

    return { count: seen.size, newest };
  }
}

function normalizeExtension(extension: string): string {
  return extension.startsWith(".") ? extension : `.${extension}`;
}

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf(sep) + 1);
  const dot = name.lastIndexOf(".");

  // `.gitignore` is a name, not an extension — a dot at the front is not a
  // separator, and treating it as one would watch every dotfile under a
  // directory that asked for `.rb`.
  return dot <= 0 ? "" : name.slice(dot);
}
