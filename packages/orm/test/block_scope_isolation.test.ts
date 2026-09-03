/**
 * The remaining block-scoped settings, held to the work that opened them.
 *
 * Rails keeps all of these in `ActiveSupport::IsolatedExecutionState`, which
 * is per-fiber. Each of these was a module-level variable saved and restored
 * in a `finally`, which is the right shape for a single thread and the wrong
 * one for concurrent work: the block covers whatever else happens to be
 * running while it does.
 *
 * `switching_isolation.test.ts` covers the first two of these to be found.
 * These are the rest, and one of them fails in the other direction as well —
 * `withEncryptionContext` takes a synchronous body, so a body that returned a
 * promise had the context restored the moment the promise was *created*, and
 * the block covered nothing at all.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  derivedKeyProvider,
  encryptionContext,
  resetEncryptionKeys,
  setKeyProvider,
  supportUnencryptedData,
  withEncryptionContext,
  withoutEncryption,
} from "../src/encryption_keys.js";
import { collectingQueriesForExplain, recordForExplain, uncached } from "../src/query_analysis.js";
import { isCaching, withQueryCache } from "../src/query_cache.js";
import {
  preserveLockVersionOnTouch,
  preservingLockVersionOnTouch,
  setPreserveLockVersionOnTouch,
} from "../src/locking_and_timestamps.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("running without encryption", () => {
  beforeEach(() => {
    setKeyProvider(derivedKeyProvider(["a secret long enough to derive a key from"]));
  });

  afterEach(() => {
    resetEncryptionKeys();
  });

  it("holds inside the block", () => {
    withEncryptionContext({ encrypting: false }, () => {
      expect(encryptionContext().encrypting).toBe(false);
    });
  });

  it("is over when the block is", () => {
    withEncryptionContext({ encrypting: false }, () => undefined);

    expect(encryptionContext().encrypting).toBe(true);
  });

  /**
   * The regression that matters most here: turning encryption off is the
   * setting the block's own comment calls the one you would least like to
   * leave on by accident, and it was on for everything running beside it.
   */
  it("does not reach work running beside it", async () => {
    let seen: boolean | undefined;

    await Promise.all([
      withEncryptionContext({ encrypting: false }, async () => {
        await tick();
        await tick();
      }),
      (async () => {
        await tick();
        seen = encryptionContext().encrypting;
      })(),
    ]);

    expect(seen).toBe(true);
  });

  /**
   * The other direction, and the one a single-threaded reading misses. The
   * body is synchronous and returns a promise, so restoring in a `finally`
   * restored before the promise had done anything — a `withoutEncryption`
   * around an async save covered none of it.
   */
  it("reaches an async body it wraps", async () => {
    let seen: boolean | undefined;

    await withEncryptionContext({ encrypting: false }, async () => {
      await tick();
      seen = encryptionContext().encrypting;
    });

    expect(seen).toBe(false);
  });

  it("carries the other setting across an await too", async () => {
    let seen: boolean | undefined;

    await withoutEncryption(async () => {
      await tick();
      seen = supportUnencryptedData();
    });

    expect(seen).toBe(true);
    expect(supportUnencryptedData()).toBe(false);
  });

  it("nests", () => {
    withEncryptionContext({ encrypting: false }, () => {
      withEncryptionContext({ supportUnencryptedData: true }, () => {
        expect(encryptionContext().encrypting).toBe(false);
        expect(encryptionContext().supportUnencryptedData).toBe(true);
      });

      expect(encryptionContext().supportUnencryptedData).toBe(false);
    });
  });

  it("is over even when the block throws", () => {
    expect(() =>
      withEncryptionContext({ encrypting: false }, () => {
        throw new Error("from the body");
      }),
    ).toThrow("from the body");

    expect(encryptionContext().encrypting).toBe(true);
  });
});

describe("running uncached", () => {
  /**
   * Against the cache that runs — `query_cache.ts`'s, the one
   * `Connection.query` consults. These used to assert on this file's own
   * cache, which nothing calls, so they held while `uncached` did nothing.
   */
  it("holds inside the block", async () => {
    await withQueryCache(async () => {
      await uncached(async () => {
        await tick();

        expect(isCaching()).toBe(false);
      });
    });
  });

  /** Only performance is at stake, and it is the same shape as the rest. */
  it("does not reach work running beside it", async () => {
    let seen: boolean | undefined;

    await withQueryCache(async () => {
      await Promise.all([
        uncached(async () => {
          await tick();
          await tick();
        }),
        (async () => {
          await tick();
          seen = isCaching();
        })(),
      ]);
    });

    expect(seen).toBe(true);
  });

  it("is over even when the block throws", async () => {
    await withQueryCache(async () => {
      await expect(
        uncached(() => {
          throw new Error("from the body");
        }),
      ).rejects.toThrow("from the body");

      expect(isCaching()).toBe(true);
    });
  });
});

describe("collecting queries to explain", () => {
  it("collects what its own block ran", async () => {
    const { queries } = await collectingQueriesForExplain(async () => {
      recordForExplain("SELECT 1");
      await tick();
      recordForExplain("SELECT 2");
    });

    expect(queries).toEqual(["SELECT 1", "SELECT 2"]);
  });

  /**
   * A shared list collected every concurrent request's statements and handed
   * them back as the queries this block ran — an explain of somebody else's
   * work, in an output whose whole purpose is to say what this code did.
   */
  it("does not collect what ran beside it", async () => {
    const [mine] = await Promise.all([
      collectingQueriesForExplain(async () => {
        recordForExplain("SELECT mine");
        await tick();
        await tick();
      }),
      (async () => {
        await tick();
        recordForExplain("SELECT theirs");
      })(),
    ]);

    expect(mine.queries).toEqual(["SELECT mine"]);
  });

  it("collects nothing outside a block", () => {
    expect(() => recordForExplain("SELECT 1")).not.toThrow();
  });

  it("still leaves writes out", async () => {
    const { queries } = await collectingQueriesForExplain(() => {
      recordForExplain("SELECT 1");
      recordForExplain("UPDATE posts SET title = 'x'");
    });

    expect(queries).toEqual(["SELECT 1"]);
  });

  it("keeps two blocks apart", async () => {
    const [first, second] = await Promise.all([
      collectingQueriesForExplain(async () => {
        recordForExplain("SELECT first");
        await tick();
      }),
      collectingQueriesForExplain(async () => {
        recordForExplain("SELECT second");
        await tick();
      }),
    ]);

    expect(first.queries).toEqual(["SELECT first"]);
    expect(second.queries).toEqual(["SELECT second"]);
  });
});

describe("preserving the lock version across a touch", () => {
  afterEach(() => {
    setPreserveLockVersionOnTouch(false);
  });

  it("holds inside the block", async () => {
    await preservingLockVersionOnTouch(async () => {
      await tick();

      expect(preserveLockVersionOnTouch()).toBe(true);
    });
  });

  /**
   * What this turns off is conflict detection, so a concurrent save that
   * should have failed as stale would instead have succeeded and overwritten
   * somebody's edit.
   */
  it("does not reach work running beside it", async () => {
    let seen: boolean | undefined;

    await Promise.all([
      preservingLockVersionOnTouch(async () => {
        await tick();
        await tick();
      }),
      (async () => {
        await tick();
        seen = preserveLockVersionOnTouch();
      })(),
    ]);

    expect(seen).toBe(false);
  });

  it("still answers the process-wide setting outside a block", () => {
    setPreserveLockVersionOnTouch(true);

    expect(preserveLockVersionOnTouch()).toBe(true);
  });

  it("is over even when the block throws", async () => {
    await expect(
      preservingLockVersionOnTouch(() => {
        throw new Error("from the body");
      }),
    ).rejects.toThrow("from the body");

    expect(preserveLockVersionOnTouch()).toBe(false);
  });
});
