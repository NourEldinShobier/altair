/**
 * Caching, ported from `ActiveSupport::Cache`.
 *
 * Rails' cache is 3,951 lines across several stores. The interface is the part
 * that matters — `fetch` with a block is the pattern applications actually use,
 * and it is what makes a cache a cache rather than a hash:
 *
 *     const posts = await cache.fetch("posts/recent", { expiresIn: 300 }, () =>
 *       Post.order("created_at", "desc").limit(10),
 *     )
 *
 * Redis is reached through `Bun.RedisClient`, which the runtime ships, so the
 * store is a thin adapter rather than a driver.
 */

export interface CacheEntryOptions {
  /** Seconds until the entry expires. Rails' `expires_in`. */
  expiresIn?: number;
}

export interface CacheStore {
  read<T = unknown>(key: string): Promise<T | null>;
  write(key: string, value: unknown, options?: CacheEntryOptions): Promise<void>;
  delete(key: string): Promise<boolean>;
  exists(key: string): Promise<boolean>;
  clear(): Promise<void>;
  /** Rails' `increment`, used for counters and rate limits. */
  increment(key: string, amount?: number): Promise<number>;
  decrement(key: string, amount?: number): Promise<number>;
}

/**
 * Normalizes a cache key.
 *
 * Rails calls this `expanded_key`: an array becomes a path, and an object with
 * a `cacheKey` gets to name itself, which is how a record's key includes its
 * updated_at and so invalidates itself on write.
 */
export function expandKey(key: unknown): string {
  if (typeof key === "string") return key;
  if (Array.isArray(key)) return key.map((part) => expandKey(part)).join("/");

  if (key !== null && typeof key === "object") {
    const record = key as { cacheKey?: () => string; id?: unknown; updated_at?: unknown };
    if (typeof record.cacheKey === "function") return record.cacheKey();
    if ("id" in record) {
      const stamp = record.updated_at ? `-${String(record.updated_at)}` : "";
      return `${String(record.id)}${stamp}`;
    }
  }

  return String(key);
}

interface Entry {
  value: unknown;
  /** Epoch milliseconds, or null for no expiry. */
  expiresAt: number | null;
}

function entryFor(value: unknown, options: CacheEntryOptions = {}): Entry {
  return {
    value,
    expiresAt: options.expiresIn === undefined ? null : Date.now() + options.expiresIn * 1000,
  };
}

function isExpired(entry: Entry): boolean {
  return entry.expiresAt !== null && entry.expiresAt <= Date.now();
}

/**
 * The default store: a Map in this process.
 *
 * Rails' MemoryStore, with the same caveat — it is per-process, so it is right
 * for development and tests and wrong for more than one server.
 */
export class MemoryStore implements CacheStore {
  readonly #entries = new Map<string, Entry>();

  constructor(private readonly maxEntries = 10_000) {}

  async read<T = unknown>(key: string): Promise<T | null> {
    const entry = this.#entries.get(key);
    if (!entry) return null;

    if (isExpired(entry)) {
      this.#entries.delete(key);
      return null;
    }
    return entry.value as T;
  }

  async write(key: string, value: unknown, options: CacheEntryOptions = {}): Promise<void> {
    // ponytail: evicts the oldest key when full, which is insertion order
    // rather than least-recently-used. Swap for an LRU if hit rate matters.
    if (this.#entries.size >= this.maxEntries && !this.#entries.has(key)) {
      const oldest = this.#entries.keys().next().value;
      if (oldest !== undefined) this.#entries.delete(oldest);
    }
    this.#entries.set(key, entryFor(value, options));
  }

  async delete(key: string): Promise<boolean> {
    return this.#entries.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return (await this.read(key)) !== null;
  }

  async clear(): Promise<void> {
    this.#entries.clear();
  }

  /**
   * Adds to a counter, atomically.
   *
   * No `await` between reading and writing, which on one event loop is what
   * atomic means: three callers incrementing at once would otherwise each read
   * zero and each write one. Everything built on this — rate limits, and the
   * lock that keeps a schedule from running on every server at once — is
   * counting on exactly that.
   */
  async increment(key: string, amount = 1): Promise<number> {
    const existing = this.#entries.get(key);
    const live = existing && !isExpired(existing) ? existing : undefined;

    const next = Number(live?.value ?? 0) + amount;

    // Keeping the expiry is the other half: a rate limit whose window is reset
    // on every request is a limit that never lifts. Redis' INCR leaves the TTL
    // alone for the same reason.
    this.#entries.set(key, { value: next, expiresAt: live?.expiresAt ?? null });

    return next;
  }

  async decrement(key: string, amount = 1): Promise<number> {
    return await this.increment(key, -amount);
  }

  /** Entry count, ignoring expiry. Introspection for tests. */
  get size(): number {
    return this.#entries.size;
  }
}

/** The subset of `Bun.RedisClient` this store uses. */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string): Promise<number>;
  exists(key: string): Promise<boolean | number>;
  expire?(key: string, seconds: number): Promise<unknown>;
  incrby?(key: string, amount: number): Promise<number>;
}

/**
 * A cache in Redis, over `Bun.RedisClient`.
 *
 * Expiry is Redis' own, not a timestamp we check, so an expired key costs
 * nothing to read and the memory is actually reclaimed.
 */
export class RedisStore implements CacheStore {
  constructor(
    private readonly client: RedisLike,
    private readonly namespace = "altair",
  ) {}

  #key(key: string): string {
    return `${this.namespace}:${key}`;
  }

  async read<T = unknown>(key: string): Promise<T | null> {
    const raw = await this.client.get(this.#key(key));
    if (raw === null) return null;

    try {
      return JSON.parse(raw) as T;
    } catch {
      // A value written by something else is not a cache hit we can use.
      return null;
    }
  }

  async write(key: string, value: unknown, options: CacheEntryOptions = {}): Promise<void> {
    const namespaced = this.#key(key);
    await this.client.set(namespaced, JSON.stringify(value));

    if (options.expiresIn !== undefined) {
      await this.client.expire?.(namespaced, Math.ceil(options.expiresIn));
    }
  }

  async delete(key: string): Promise<boolean> {
    return (await this.client.del(this.#key(key))) > 0;
  }

  async exists(key: string): Promise<boolean> {
    return Boolean(await this.client.exists(this.#key(key)));
  }

  async clear(): Promise<void> {
    throw new Error(
      "RedisStore.clear() is not implemented: flushing a shared Redis would drop keys this application does not own.",
    );
  }

  async increment(key: string, amount = 1): Promise<number> {
    const namespaced = this.#key(key);
    if (this.client.incrby) return await this.client.incrby(namespaced, amount);

    const current = Number((await this.read(namespaced)) ?? 0);
    const next = current + amount;
    await this.write(key, next);
    return next;
  }

  async decrement(key: string, amount = 1): Promise<number> {
    return await this.increment(key, -amount);
  }
}

/**
 * The cache applications use.
 *
 * Wraps a store so `fetch` and key expansion work the same whichever store is
 * configured.
 */
export class Cache {
  constructor(readonly store: CacheStore = new MemoryStore()) {}

  async read<T = unknown>(key: unknown): Promise<T | null> {
    return await this.store.read<T>(expandKey(key));
  }

  async write(key: unknown, value: unknown, options?: CacheEntryOptions): Promise<void> {
    await this.store.write(expandKey(key), value, options);
  }

  async delete(key: unknown): Promise<boolean> {
    return await this.store.delete(expandKey(key));
  }

  async exists(key: unknown): Promise<boolean> {
    return await this.store.exists(expandKey(key));
  }

  async clear(): Promise<void> {
    await this.store.clear();
  }

  async increment(key: unknown, amount = 1): Promise<number> {
    return await this.store.increment(expandKey(key), amount);
  }

  async decrement(key: unknown, amount = 1): Promise<number> {
    return await this.store.decrement(expandKey(key), amount);
  }

  /**
   * Rails' `fetch`: read, or compute and write.
   *
   * A stored `null` is a hit, not a miss — otherwise "this query returns
   * nothing" is the one answer the cache can never remember, and the expensive
   * query runs on every request.
   */
  async fetch<T>(key: unknown, compute: () => T | Promise<T>): Promise<T>;
  async fetch<T>(
    key: unknown,
    options: CacheEntryOptions & { force?: boolean },
    compute: () => T | Promise<T>,
  ): Promise<T>;
  async fetch<T>(
    key: unknown,
    optionsOrCompute: (CacheEntryOptions & { force?: boolean }) | (() => T | Promise<T>),
    maybeCompute?: () => T | Promise<T>,
  ): Promise<T> {
    const options = typeof optionsOrCompute === "function" ? {} : optionsOrCompute;
    const compute = typeof optionsOrCompute === "function" ? optionsOrCompute : maybeCompute!;

    const expanded = expandKey(key);

    if (!options.force) {
      const hit = await this.store.read<{ value: T }>(expanded);
      if (hit !== null) return hit.value;
    }

    const value = await compute();
    // The value is boxed so a cached null is distinguishable from a miss.
    await this.store.write(expanded, { value }, options);
    return value;
  }

  /** Reads several keys at once. Rails' `read_multi`. */
  async readMulti<T = unknown>(...keys: unknown[]): Promise<Record<string, T | null>> {
    const entries = await Promise.all(
      keys.map(async (key) => {
        const expanded = expandKey(key);
        return [expanded, await this.store.read<T>(expanded)] as const;
      }),
    );
    return Object.fromEntries(entries);
  }

  /** Writes several keys at once. Rails' `write_multi`. */
  async writeMulti(values: Record<string, unknown>, options?: CacheEntryOptions): Promise<void> {
    await Promise.all(
      Object.entries(values).map(([key, value]) => this.store.write(key, value, options)),
    );
  }
}
