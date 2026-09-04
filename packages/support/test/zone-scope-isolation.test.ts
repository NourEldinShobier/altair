/**
 * The zone a block sets, held to that block.
 *
 * Rails keeps `Time.zone` per fiber, in `ActiveSupport::IsolatedExecutionState`.
 * Here it was a module-level variable swapped on the way in and put back in a
 * `finally`, so a request rendering in one zone put every request rendering
 * beside it in the same zone.
 *
 * That is the worst kind of wrong answer: the timestamp is plausible, the zone
 * is not printed, and the reader has no way to tell that the page is showing
 * them somebody else's afternoon.
 *
 * The comment that used to sit on `useZone` worried about a test that throws
 * leaving the zone set — the failure one thread can have — which is why the
 * other one went unseen.
 */

import { describe, expect, it } from "bun:test";
import { currentZoneName, useZone } from "../src/zoned-arithmetic.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("a zone in force", () => {
  it("holds inside the block", () => {
    useZone("Asia/Tokyo", () => {
      expect(currentZoneName()).toBe("Asia/Tokyo");
    });
  });

  it("is over when the block is", () => {
    useZone("Asia/Tokyo", () => undefined);

    expect(currentZoneName()).toBeUndefined();
  });

  /** The regression. */
  it("does not reach work running beside it", async () => {
    let seen: string | undefined | "unset" = "unset";

    await Promise.all([
      useZone("Asia/Tokyo", async () => {
        await tick();
        await tick();
      }),
      (async () => {
        await tick();
        seen = currentZoneName();
      })(),
    ]);

    expect(seen).toBeUndefined();
  });

  it("reaches work running inside it, across an await", async () => {
    let seen: string | undefined;

    await useZone("Asia/Tokyo", async () => {
      await tick();
      seen = currentZoneName();
    });

    expect(seen).toBe("Asia/Tokyo");
  });

  it("keeps two blocks apart", async () => {
    const [first, second] = await Promise.all([
      useZone("Asia/Tokyo", async () => {
        await tick();

        return currentZoneName();
      }),
      useZone("Europe/Paris", async () => {
        await tick();

        return currentZoneName();
      }),
    ]);

    expect(first).toBe("Asia/Tokyo");
    expect(second).toBe("Europe/Paris");
  });

  it("nests", () => {
    useZone("Asia/Tokyo", () => {
      useZone("Europe/Paris", () => {
        expect(currentZoneName()).toBe("Europe/Paris");
      });

      expect(currentZoneName()).toBe("Asia/Tokyo");
    });
  });

  it("is over even when the block throws", () => {
    expect(() =>
      useZone("Asia/Tokyo", () => {
        throw new Error("from the body");
      }),
    ).toThrow("from the body");

    expect(currentZoneName()).toBeUndefined();
  });
});
