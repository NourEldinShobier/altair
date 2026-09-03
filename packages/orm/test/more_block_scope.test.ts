/**
 * The rest of the block-scoped settings, held to the work that opened them.
 *
 * The last of the shape #219, #220 and #221 removed: a module-level variable
 * swapped on the way into a block and put back in a `finally`. Found by a
 * check that looks for the restore rather than the save — an assignment to
 * module-level state inside a `finally` — which turned up ten more sites than
 * reading `let` declarations by hand had.
 */

import { describe, expect, it } from "bun:test";
import {
  poolTransactionIsolationLevel,
  withPoolTransactionIsolationLevel,
} from "../src/transaction_outcome.js";
import {
  registerAttachmentRenderer,
  rendererFor,
  withRenderer,
} from "../src/rich_text_rendering.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("a transaction's isolation level", () => {
  it("holds inside the block", async () => {
    await withPoolTransactionIsolationLevel("serializable", async () => {
      await tick();

      expect(poolTransactionIsolationLevel()).toBe("serializable");
    });
  });

  /**
   * The level is the one setting a concurrent transaction most needs to be its
   * own: read committed quietly becoming serializable deadlocks, and the
   * reverse loses the guarantee the transaction was opened for.
   */
  it("does not reach a transaction running beside it", async () => {
    let seen: string | undefined | "unset" = "unset";

    await Promise.all([
      withPoolTransactionIsolationLevel("serializable", async () => {
        await tick();
        await tick();
      }),
      (async () => {
        await tick();
        seen = poolTransactionIsolationLevel();
      })(),
    ]);

    expect(seen).toBeUndefined();
  });

  it("keeps two blocks apart", async () => {
    const [first, second] = await Promise.all([
      withPoolTransactionIsolationLevel("serializable", async () => {
        await tick();

        return poolTransactionIsolationLevel();
      }),
      withPoolTransactionIsolationLevel("read committed", async () => {
        await tick();

        return poolTransactionIsolationLevel();
      }),
    ]);

    expect(first).toBe("serializable");
    expect(second).toBe("read committed");
  });

  it("is over even when the block throws", async () => {
    await expect(
      withPoolTransactionIsolationLevel("serializable", () => {
        throw new Error("from the body");
      }),
    ).rejects.toThrow("from the body");

    expect(poolTransactionIsolationLevel()).toBeUndefined();
  });
});

describe("a replacement attachment renderer", () => {
  const replacement = () => "<replaced>";

  it("holds inside the block", () => {
    withRenderer(replacement, () => {
      expect(rendererFor(undefined)).toBe(replacement);
    });
  });

  /**
   * Swapping handed the replacement to every render happening beside the
   * block, so a request rendering rich text got somebody else's renderer —
   * and the attachment came out wrong rather than missing.
   */
  it("does not reach a render running beside it", async () => {
    let seen: unknown;

    await Promise.all([
      (async () => {
        withRenderer(replacement, () => {
          expect(rendererFor(undefined)).toBe(replacement);
        });
        await tick();
      })(),
      (async () => {
        seen = rendererFor(undefined);
        await tick();
      })(),
    ]);

    expect(seen).not.toBe(replacement);
  });

  it("is over when the block is", () => {
    withRenderer(replacement, () => undefined);

    expect(rendererFor(undefined)).not.toBe(replacement);
  });

  it("is over even when the block throws", () => {
    expect(() =>
      withRenderer(replacement, () => {
        throw new Error("from the body");
      }),
    ).toThrow("from the body");

    expect(rendererFor(undefined)).not.toBe(replacement);
  });

  /** A registered renderer for the type still wins; the fallback is the fallback. */
  it("does not displace a renderer registered for the type", () => {
    const registered = () => "<image>";

    registerAttachmentRenderer("image/png", registered);

    withRenderer(replacement, () => {
      expect(rendererFor("image/png")).toBe(registered);
      expect(rendererFor("text/plain")).toBe(replacement);
    });
  });
});
