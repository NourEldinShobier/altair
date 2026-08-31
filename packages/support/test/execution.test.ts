/**
 * The lock that stops code being swapped underneath a request, ported from
 * `activesupport/test/concurrency/share_lock_test.rb`,
 * `execution_wrapper_test.rb` and `reloader_test.rb`.
 *
 * The bugs this prevents do not reproduce: they need a reload to land inside a
 * request rather than between two. So the tests drive the ordering directly —
 * hold a share, start an exclusive, and assert it waited.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  Executor,
  Reloader,
  ShareLock,
  loadInterlock,
  onLoad,
  permitConcurrentLoads,
  resetLoadHooks,
  runInterlock,
  runLoadHooks,
  unloadInterlock,
} from "../src/execution.js";

afterEach(() => {
  resetLoadHooks();
});

/** Lets pending promises run, so "did it wait?" is answerable. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("sharing", () => {
  it("lets several hold it at once", async () => {
    const lock = new ShareLock();

    await lock.startSharing();
    await lock.startSharing();

    expect(lock.shareCount).toBe(2);
  });

  it("counts them back down", async () => {
    const lock = new ShareLock();
    await lock.startSharing();
    await lock.startSharing();

    lock.stopSharing();

    expect(lock.shareCount).toBe(1);
  });

  it("refuses a release by something that was not holding it", () => {
    expect(() => new ShareLock().stopSharing()).toThrow("not sharing");
  });

  it("runs a block holding it", async () => {
    const lock = new ShareLock();

    const seen = await lock.sharing(async () => lock.shareCount);

    expect(seen).toBe(1);
    expect(lock.shareCount).toBe(0);
  });

  it("releases it even when the block throws", async () => {
    const lock = new ShareLock();

    await expect(
      lock.sharing(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(lock.shareCount).toBe(0);
  });
});

describe("exclusivity", () => {
  it("takes it when nobody is holding it", async () => {
    const lock = new ShareLock();

    expect(await lock.startExclusive()).toBe(true);
    expect(lock.isExclusive).toBe(true);
  });

  /**
   * The whole point: a reload must not begin while a request is running, or
   * that request finishes against modules nothing else refers to.
   */
  it("waits for the shared holders to finish", async () => {
    const lock = new ShareLock();
    await lock.startSharing();

    let taken = false;
    const exclusive = lock.startExclusive().then(() => {
      taken = true;
    });

    await settle();

    expect(taken).toBe(false);

    lock.stopSharing();
    await exclusive;

    expect(taken).toBe(true);
  });

  it("waits for every one of them, not just the first", async () => {
    const lock = new ShareLock();
    await lock.startSharing();
    await lock.startSharing();

    let taken = false;
    const exclusive = lock.startExclusive().then(() => {
      taken = true;
    });

    lock.stopSharing();
    await settle();

    expect(taken).toBe(false);

    lock.stopSharing();
    await exclusive;

    expect(taken).toBe(true);
  });

  /** And the other direction: a request must not start mid-reload. */
  it("makes a new sharer wait while it is held", async () => {
    const lock = new ShareLock();
    await lock.startExclusive();

    let sharing = false;
    const share = lock.startSharing().then(() => {
      sharing = true;
    });

    await settle();

    expect(sharing).toBe(false);

    lock.stopExclusive();
    await share;

    expect(sharing).toBe(true);
  });

  /**
   * For a file watcher that would otherwise queue a reload behind a long
   * request and apply it much later, against files that have changed again.
   */
  it("gives up rather than waiting when told not to", async () => {
    const lock = new ShareLock();
    await lock.startSharing();

    expect(await lock.startExclusive({ noWait: true })).toBe(false);
    expect(lock.isExclusive).toBe(false);
  });

  it("takes it with noWait when nothing is in the way", async () => {
    expect(await new ShareLock().startExclusive({ noWait: true })).toBe(true);
  });

  it("runs a block holding it alone", async () => {
    const lock = new ShareLock();

    const seen = await lock.exclusive(async () => lock.isExclusive);

    expect(seen).toBe(true);
    expect(lock.isExclusive).toBe(false);
  });

  it("releases it even when the block throws", async () => {
    const lock = new ShareLock();

    await expect(
      lock.exclusive(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(lock.isExclusive).toBe(false);
  });

  it("does not run the block at all when it could not take it", async () => {
    const lock = new ShareLock();
    await lock.startSharing();
    let ran = false;

    const result = await lock.exclusive(
      async () => {
        ran = true;
      },
      { noWait: true },
    );

    expect(ran).toBe(false);
    expect(result).toBeUndefined();
  });

  it("reports what it is doing", async () => {
    const lock = new ShareLock();
    await lock.startSharing();

    expect(lock.rawState()).toEqual({ sharing: 1, exclusive: false, waitingForExclusive: 0 });
  });
});

describe("yielding a share", () => {
  /**
   * For a request about to wait on something slow and unrelated, where holding
   * the lock would block a reload for no reason.
   */
  it("lets an exclusive through while the block runs", async () => {
    const lock = new ShareLock();
    await lock.startSharing();

    let taken = false;

    await lock.yieldShares(async () => {
      const exclusive = lock.startExclusive().then(() => {
        taken = true;
      });

      await exclusive;
      lock.stopExclusive();
    });

    expect(taken).toBe(true);
  });

  it("takes the share back afterwards", async () => {
    const lock = new ShareLock();
    await lock.startSharing();

    await lock.yieldShares(async () => undefined);

    expect(lock.shareCount).toBe(1);
  });

  it("takes it back even when the block throws", async () => {
    const lock = new ShareLock();
    await lock.startSharing();

    await expect(
      lock.yieldShares(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(lock.shareCount).toBe(1);
  });
});

describe("the interlock", () => {
  it("is shared by requests", async () => {
    const seen = await runInterlock(async () => loadInterlock().shareCount);

    expect(seen).toBe(1);
  });

  it("is held alone by a reload", async () => {
    const seen = await unloadInterlock(async () => loadInterlock().isExclusive);

    expect(seen).toBe(true);
  });

  it("gives a share up for the duration", async () => {
    const seen = await runInterlock(async () =>
      permitConcurrentLoads(async () => loadInterlock().shareCount),
    );

    expect(seen).toBe(0);
  });

  it("leaves nothing held afterwards", async () => {
    await runInterlock(async () => undefined);

    expect(loadInterlock().shareCount).toBe(0);
    expect(loadInterlock().isExclusive).toBe(false);
  });
});

describe("the executor", () => {
  it("runs the opening hooks", async () => {
    const ran: string[] = [];
    const executor = new Executor();
    executor.toRun(() => void ran.push("run"));

    await executor.run();

    expect(ran).toEqual(["run"]);
    expect(executor.active).toBe(true);
  });

  it("runs the closing hooks", async () => {
    const ran: string[] = [];
    const executor = new Executor();
    executor.toComplete(() => void ran.push("complete"));

    await executor.complete();

    expect(ran).toEqual(["complete"]);
    expect(executor.active).toBe(false);
  });

  it("wraps a unit of work in both", async () => {
    const ran: string[] = [];
    const executor = new Executor();
    executor.toRun(() => void ran.push("run"));
    executor.toComplete(() => void ran.push("complete"));

    await executor.wrap(async () => void ran.push("body"));

    expect(ran).toEqual(["run", "body", "complete"]);
  });

  /** The unit that threw is the one whose state most needs clearing. */
  it("closes even when the body throws", async () => {
    const ran: string[] = [];
    const executor = new Executor();
    executor.toComplete(() => void ran.push("complete"));

    await expect(
      executor.wrap(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(ran).toEqual(["complete"]);
  });

  /**
   * A teardown that stops halfway leaves exactly the state it was supposed to
   * clear, and the failure appears in whichever unit runs next.
   */
  it("runs every closing hook even when one throws", async () => {
    const ran: string[] = [];
    const executor = new Executor();
    executor.toComplete(() => {
      throw new Error("first hook");
    });
    executor.toComplete(() => void ran.push("second"));

    await expect(executor.complete()).rejects.toThrow("first hook");

    expect(ran).toEqual(["second"]);
  });

  it("reports the first failure, not the last", async () => {
    const executor = new Executor();
    executor.toComplete(() => {
      throw new Error("first");
    });
    executor.toComplete(() => {
      throw new Error("second");
    });

    await expect(executor.complete()).rejects.toThrow("first");
  });

  it("gives back what the body returned", async () => {
    expect(await new Executor().wrap(async () => "done")).toBe("done");
  });

  /**
   * An inner hook's teardown runs before an outer one's: the connection is
   * the outer one, and the hooks before it may still need to query.
   */
  it("closes inner hooks before outer ones", async () => {
    const ran: string[] = [];
    const executor = new Executor();
    executor.registerHook({ complete: () => void ran.push("connection") }, { outer: true });
    executor.registerHook({ complete: () => void ran.push("query cache") });

    await executor.complete();

    expect(ran).toEqual(["query cache", "connection"]);
  });

  it("registers both halves at once", async () => {
    const ran: string[] = [];
    const executor = new Executor();
    executor.registerHook({
      run: () => void ran.push("run"),
      complete: () => void ran.push("done"),
    });

    await executor.wrap(async () => undefined);

    expect(ran).toEqual(["run", "done"]);
  });

  it("takes a cleanup-only hook", async () => {
    const ran: string[] = [];
    const executor = new Executor();
    executor.runCleanupHook(() => void ran.push("cleanup"));

    await executor.runCleanup();

    expect(ran).toEqual(["cleanup"]);
  });

  it("counts what will run", () => {
    const executor = new Executor();
    executor.toRun(() => undefined);
    executor.toRun(() => undefined);

    expect(executor.runOrder).toBe(2);
  });
});

describe("the reloader", () => {
  it("does nothing when nothing changed", async () => {
    const reloader = new Reloader();
    reloader.check(() => false);
    let reloaded = false;

    expect(await reloader.executeIfUpdated(async () => void (reloaded = true))).toBe(false);
    expect(reloaded).toBe(false);
  });

  /** The check is cheap and the reload is not, which is what makes a watcher survivable. */
  it("reloads when something did", async () => {
    const reloader = new Reloader();
    reloader.check(() => true);
    let reloaded = false;

    expect(await reloader.executeIfUpdated(async () => void (reloaded = true))).toBe(true);
    expect(reloaded).toBe(true);
    expect(reloader.reloaded).toBe(true);
  });

  it("changes when any check says so", async () => {
    const reloader = new Reloader();
    reloader.check(() => false);
    reloader.check(() => true);

    expect(reloader.updated()).toBe(true);
  });

  it("runs the unload hooks around it", async () => {
    const ran: string[] = [];
    const reloader = new Reloader();
    reloader.check(() => true);
    reloader.beforeClassUnload(() => void ran.push("before"));
    reloader.afterClassUnload(() => void ran.push("after"));

    await reloader.executeIfUpdated(async () => void ran.push("swap"));

    expect(ran).toEqual(["before", "swap", "after"]);
  });

  /** A reload landing inside a request leaves it holding modules nothing refers to. */
  it("holds the interlock alone while it swaps", async () => {
    const reloader = new Reloader();
    let heldAlone = false;

    await reloader.classUnload(async () => {
      heldAlone = loadInterlock().isExclusive;
    });

    expect(heldAlone).toBe(true);
    expect(loadInterlock().isExclusive).toBe(false);
  });

  it("says while it is unloading", async () => {
    const reloader = new Reloader();
    let during = false;

    await reloader.classUnload(async () => {
      during = reloader.unloading;
    });

    expect(during).toBe(true);
    expect(reloader.unloading).toBe(false);
  });

  it("stops unloading even when the swap throws", async () => {
    const reloader = new Reloader();

    await expect(
      reloader.classUnload(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(reloader.unloading).toBe(false);
    expect(loadInterlock().isExclusive).toBe(false);
  });
});

describe("load hooks", () => {
  it("runs one when the thing loads", () => {
    const seen: unknown[] = [];
    onLoad("active_record", (base) => seen.push(base));

    runLoadHooks("active_record", "the base");

    expect(seen).toEqual(["the base"]);
  });

  /**
   * Otherwise the order of imports decides whether a hook runs at all, which
   * appears as a setting silently not applying.
   */
  it("runs one registered after the thing already loaded", () => {
    const seen: unknown[] = [];
    runLoadHooks("active_record", "the base");

    onLoad("active_record", (base) => seen.push(base));

    expect(seen).toEqual(["the base"]);
  });

  it("runs every hook for a name", () => {
    let count = 0;
    onLoad("x", () => (count += 1));
    onLoad("x", () => (count += 1));

    runLoadHooks("x");

    expect(count).toBe(2);
  });

  it("keeps names apart", () => {
    let ran = false;
    onLoad("one", () => (ran = true));

    runLoadHooks("two");

    expect(ran).toBe(false);
  });

  it("runs a hook once per load", () => {
    let count = 0;
    onLoad("x", () => (count += 1));

    runLoadHooks("x");
    runLoadHooks("x");

    expect(count).toBe(2);
  });
});
