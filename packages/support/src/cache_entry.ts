/**
 * What a cache actually stores, ported from `ActiveSupport::Cache::Entry`.
 *
 * A store keeps entries, not values, and the difference is the three things a
 * bare value cannot carry:
 *
 *   - **when it expires**, so a store with no TTL of its own still honours one
 *   - **which version it is**, so a stale entry is detected rather than served
 *   - **whether it was compressed**, so a large value costs less to hold
 *
 * The version is the one worth dwelling on. Keying a fragment on `posts/1`
 * alone means an edit has to remember to delete it; keying on the record's
 * updated_at means the old entry is simply never read again. Rails calls that
 * recyclable cache keys, and it is why `fetch` takes a version rather than
 * expecting callers to build one into the key.
 */

import { gunzipSync, gzipSync } from "node:zlib";

export interface EntryOptions {
  /** Seconds until it expires. Rails' `expires_in`. */
  expiresIn?: number;
  /** An absolute expiry, when that is what the caller has. Rails' `expires_at`. */
  expiresAt?: number;
  /** What this entry was built from. Rails' `version`. */
  version?: string;
  /** Compress above this many bytes. Rails' `compress_threshold`. */
  compressThreshold?: number;
}

/** Rails compresses above 1KB by default; below it the header costs more than it saves. */
export const DEFAULT_COMPRESS_THRESHOLD = 1024;

export class Entry {
  readonly createdAt: number;
  readonly expiresAt: number | undefined;
  readonly version: string | undefined;

  #payload: string | Buffer;
  #compressed: boolean;

  constructor(value: unknown, options: EntryOptions = {}, now = Date.now()) {
    this.createdAt = now;
    this.version = options.version;
    this.expiresAt =
      options.expiresAt ??
      (options.expiresIn === undefined ? undefined : now + options.expiresIn * 1000);

    const serialized = JSON.stringify(value ?? null);
    const threshold = options.compressThreshold ?? DEFAULT_COMPRESS_THRESHOLD;

    // Compressed only when it pays. Below the threshold the gzip header is
    // larger than the saving, so a small entry would come out bigger.
    this.#compressed = Buffer.byteLength(serialized) > threshold;
    this.#payload = this.#compressed ? gzipSync(serialized) : serialized;
  }

  /** Whether the payload is held compressed. */
  get compressed(): boolean {
    return this.#compressed;
  }

  /** How many bytes the payload takes. Rails' `bytesize`. */
  get bytesize(): number {
    return typeof this.#payload === "string"
      ? Buffer.byteLength(this.#payload)
      : this.#payload.length;
  }

  /** The value back. */
  get value(): unknown {
    const text = this.#compressed
      ? gunzipSync(this.#payload as Buffer).toString("utf8")
      : (this.#payload as string);

    return JSON.parse(text) as unknown;
  }

  /** Whether the entry is past its expiry. Rails' `expired?`. */
  expired(now = Date.now()): boolean {
    return this.expiresAt !== undefined && this.expiresAt <= now;
  }

  /**
   * Whether the entry was built from a different version. Rails'
   * `mismatched?`.
   *
   * A caller asking without a version gets false: not every entry is
   * versioned, and treating an unversioned entry as mismatched would make the
   * cache never hit for anybody who did not opt in.
   */
  mismatched(version: string | undefined): boolean {
    if (version === undefined || this.version === undefined) return false;

    return this.version !== version;
  }

  /** Whether this entry can be served for a request at this version. */
  usable(version?: string, now = Date.now()): boolean {
    return !this.expired(now) && !this.mismatched(version);
  }

  /** Seconds until it expires, or undefined when it does not. */
  secondsUntilExpiry(now = Date.now()): number | undefined {
    return this.expiresAt === undefined ? undefined : (this.expiresAt - now) / 1000;
  }
}

/**
 * A cache built out of entries, holding them in this process.
 *
 * Separate from the plain MemoryStore because the entry protocol is what a
 * custom store implements — read, write, delete and their batch forms — and
 * having one worked example makes the contract concrete rather than described.
 */
export class EntryStore {
  #entries = new Map<string, Entry>();

  constructor(private readonly maxEntries = 10_000) {}

  /** Rails' `read_entry`. */
  readEntry(key: string, version?: string): Entry | null {
    const entry = this.#entries.get(key);
    if (!entry) return null;

    // An unusable entry is dropped on read rather than swept on a timer: a key
    // nobody asks about costs nothing, and a sweep is a background job for a
    // benefit the read already delivers.
    if (!entry.usable(version)) {
      this.#entries.delete(key);
      return null;
    }

    return entry;
  }

  /** Rails' `write_entry`. */
  writeEntry(key: string, entry: Entry): void {
    // Oldest first when full, which is what makes a cache a cache rather than
    // a leak. Rails' memory store prunes by size; this is the same idea at the
    // granularity a Map gives cheaply.
    if (this.#entries.size >= this.maxEntries && !this.#entries.has(key)) {
      const oldest = this.#entries.keys().next().value;
      if (oldest !== undefined) this.#entries.delete(oldest);
    }

    this.#entries.set(key, entry);
  }

  /** Rails' `delete_entry`. */
  deleteEntry(key: string): boolean {
    return this.#entries.delete(key);
  }

  /** Rails' `read_multi_entries`. */
  readMultiEntries(keys: readonly string[], version?: string): Map<string, Entry> {
    const found = new Map<string, Entry>();

    for (const key of keys) {
      const entry = this.readEntry(key, version);
      if (entry) found.set(key, entry);
    }

    return found;
  }

  /** Rails' `write_multi_entries`. */
  writeMultiEntries(entries: Map<string, Entry>): void {
    for (const [key, entry] of entries) this.writeEntry(key, entry);
  }

  /** Rails' `delete_matched`, over keys rather than values. */
  deleteMatchedEntries(pattern: RegExp): number {
    let deleted = 0;
    // Snapshotted, because the loop deletes from the map it is walking.
    const keys = [...this.#entries.keys()];

    for (const key of keys) {
      if (pattern.test(key)) {
        this.#entries.delete(key);
        deleted += 1;
      }
    }

    return deleted;
  }

  /**
   * Drops every expired entry. Rails' `cleanup`.
   *
   * Not needed for correctness — reads drop what they find — but a cache
   * holding a million expired entries is still holding them, and something has
   * to be able to say so.
   */
  cleanup(now = Date.now()): number {
    let dropped = 0;
    // Snapshotted, because the loop deletes from the map it is walking.
    const held = [...this.#entries];

    for (const [key, entry] of held) {
      if (entry.expired(now)) {
        this.#entries.delete(key);
        dropped += 1;
      }
    }

    return dropped;
  }

  /** Every key held, expired or not. */
  get keys(): string[] {
    return [...this.#entries.keys()];
  }

  get size(): number {
    return this.#entries.size;
  }

  /** How many bytes the held payloads take. */
  get bytesize(): number {
    return [...this.#entries.values()].reduce((total, entry) => total + entry.bytesize, 0);
  }

  clearAll(): void {
    this.#entries.clear();
  }
}
