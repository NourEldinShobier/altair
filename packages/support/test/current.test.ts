/**
 * Current attributes suite.
 *
 * Mirrors activesupport/test/current_attributes_test.rb. The isolation cases
 * matter most: the whole point is that two requests in flight cannot see each
 * other's state, and a module-level variable would pass every single-request
 * test while failing that.
 */

import { describe, expect, it } from "bun:test";
import { NoCurrentScope, currentAttributes } from "../src/current.js";

interface Attributes {
  user?: string;
  requestId?: string;
  locale?: string;
}

function build() {
  return currentAttributes<Attributes>();
}

describe("scope", () => {
  it("carries values through the block", async () => {
    const Current = build();

    await Current.run({ user: "ada" }, () => {
      expect(Current.user).toBe("ada");
    });
  });

  it("returns the block's value", async () => {
    const Current = build();
    expect(await Current.run({}, () => "done")).toBe("done");
  });

  it("awaits an async block", async () => {
    const Current = build();

    const result = await Current.run({ user: "ada" }, async () => {
      await Bun.sleep(1);
      return Current.user;
    });

    expect(result).toBe("ada");
  });

  // The store follows the async call chain, which is the reason for using
  // AsyncLocalStorage rather than a variable.
  it("survives awaits deep in the call chain", async () => {
    const Current = build();

    async function deep(): Promise<string | undefined> {
      await Bun.sleep(1);
      await Promise.resolve();
      return Current.user;
    }

    await Current.run({ user: "ada" }, async () => {
      expect(await deep()).toBe("ada");
    });
  });

  it("is empty outside a block", () => {
    const Current = build();
    expect(Current.user).toBeUndefined();
    expect(Current.isActive).toBe(false);
  });

  it("reports an active scope", async () => {
    const Current = build();
    await Current.run({}, () => {
      expect(Current.isActive).toBe(true);
    });
  });
});

describe("isolation", () => {
  // This is the case a module-level variable gets wrong, and it is the only
  // reason this file exists.
  it("keeps concurrent scopes apart", async () => {
    const Current = build();
    const seen: (string | undefined)[] = [];

    async function request(user: string, delay: number): Promise<void> {
      await Current.run({ user }, async () => {
        await Bun.sleep(delay);
        seen.push(Current.user);
      });
    }

    await Promise.all([request("ada", 20), request("alan", 5), request("grace", 10)]);

    expect(seen.sort()).toEqual(["ada", "alan", "grace"]);
  });

  it("does not leak a value out of its block", async () => {
    const Current = build();

    await Current.run({ user: "ada" }, () => {});
    expect(Current.user).toBeUndefined();
  });

  it("nests, with the inner scope winning", async () => {
    const Current = build();

    await Current.run({ user: "ada" }, async () => {
      await Current.run({ user: "alan" }, () => {
        expect(Current.user).toBe("alan");
      });
      expect(Current.user).toBe("ada");
    });
  });

  it("gives each Current class its own store", async () => {
    const First = build();
    const Second = build();

    await First.run({ user: "ada" }, async () => {
      await Second.run({ user: "alan" }, () => {
        expect(First.user).toBe("ada");
        expect(Second.user).toBe("alan");
      });
    });
  });
});

describe("writing", () => {
  it("assigns an attribute inside the block", async () => {
    const Current = build();

    await Current.run({}, () => {
      Current.user = "ada";
      expect(Current.user).toBe("ada");
    });
  });

  it("sets several at once", async () => {
    const Current = build();

    await Current.run({}, () => {
      Current.set({ user: "ada", locale: "en" });
      expect(Current.attributes).toEqual({ user: "ada", locale: "en" });
    });
  });

  it("resets without leaving the scope", async () => {
    const Current = build();

    await Current.run({ user: "ada" }, () => {
      Current.reset();
      expect(Current.user).toBeUndefined();
      expect(Current.isActive).toBe(true);
    });
  });

  it("reads through get", async () => {
    const Current = build();
    await Current.run({ requestId: "abc" }, () => {
      expect(Current.get("requestId")).toBe("abc");
    });
  });

  // Reading with no scope is undefined so a log helper does not crash, but
  // writing is a mistake worth surfacing: the value would go nowhere.
  it("throws when writing outside a block", () => {
    const Current = build();
    expect(() => {
      Current.user = "ada";
    }).toThrow(NoCurrentScope);
  });

  it("throws when reading the whole store outside a block", () => {
    const Current = build();
    expect(() => Current.attributes).toThrow(NoCurrentScope);
  });
});
