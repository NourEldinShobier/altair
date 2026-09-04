/**
 * Fixture naming, identity and caching, ported from
 * `activerecord/test/cases/fixtures_test.rb`.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { UUID_NAMESPACES, uuidV5 } from "@altair/support";
import {
  cacheFixtures,
  cachedFixtureNames,
  cachedFixtures,
  defaultFixtureModelName,
  defaultFixtureTableName,
  fixtureClassFor,
  fixtureIsCached,
  fixturesPath,
  identify,
  ignoreFixtures,
  ignoredFixtures,
  isIgnoredFixture,
  resetFixtureCache,
  setFixtureClass,
  setFixturesPath,
} from "../src/fixture-set.js";

afterEach(() => {
  resetFixtureCache();
  setFixturesPath("test/fixtures");
});

describe("identify", () => {
  /** What lets `author: ada` resolve without anybody assigning ids by hand. */
  it("is the same number for the same label", () => {
    expect(identify("ada")).toBe(identify("ada"));
  });

  it("differs for different labels", () => {
    expect(identify("ada")).not.toBe(identify("grace"));
  });

  it("is a number", () => {
    expect(typeof identify("ada")).toBe("number");
  });

  /** A signed 32-bit column has to hold it, so the top bit stays clear. */
  it("fits in a signed 32-bit integer", () => {
    for (const label of ["ada", "grace", "a".repeat(200), "", "post_1"]) {
      const id = identify(label) as number;

      expect(id, label).toBeGreaterThanOrEqual(0);
      expect(id, label).toBeLessThan(2 ** 31);
    }
  });

  it("copes with an empty label", () => {
    expect(typeof identify("")).toBe("number");
  });

  it("gives a UUID when the key is one", () => {
    expect(identify("ada", "uuid")).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  });

  it("gives the same UUID for the same label", () => {
    expect(identify("ada", "uuid")).toBe(identify("ada", "uuid"));
  });

  /**
   * Version 5 under the OID namespace, which is what Rails derives — and the
   * only thing that makes a fixture id portable. Derived any other way it is
   * still stable and still the right shape, so a suite passes and the ids
   * simply are not the ones Rails would have written, which is found out when a
   * fixture file is shared with a Rails application or a dump is loaded into
   * one.
   */
  it("is the uuid Rails derives for the same label", () => {
    expect(identify("ada", "uuid")).toBe(uuidV5(UUID_NAMESPACES.oid, "ada"));
    expect(identify("ada", "uuid")).not.toBe(identify("mary", "uuid"));
    expect(String(identify("ada", "uuid"))[14]).toBe("5");
  });

  /** Two labels in a realistic set must not collide. */
  it("keeps a thousand labels distinct", () => {
    const ids = new Set(Array.from({ length: 1000 }, (_, index) => identify(`fixture_${index}`)));

    expect(ids.size).toBe(1000);
  });
});

describe("naming", () => {
  it("derives a model name from a set name", () => {
    expect(defaultFixtureModelName("posts")).toBe("Post");
    expect(defaultFixtureModelName("admin_users")).toBe("AdminUser");
  });

  it("handles a namespaced set", () => {
    expect(defaultFixtureModelName("admin/users")).toBe("AdminUser");
  });

  it("derives a table name", () => {
    expect(defaultFixtureTableName("posts")).toBe("posts");
    expect(defaultFixtureTableName("admin/users")).toBe("admin_users");
  });

  /** The convention holds until a table is named for something the model is not. */
  it("takes an explicit class for a set", () => {
    class LegacyRecord {}
    setFixtureClass({ tbl_legacy: LegacyRecord });

    expect(fixtureClassFor("tbl_legacy")).toBe(LegacyRecord);
    expect(fixtureClassFor("posts")).toBeUndefined();
  });
});

describe("the path", () => {
  it("has a default", () => {
    expect(fixturesPath()).toBe("test/fixtures");
  });

  it("can be set", () => {
    setFixturesPath("spec/fixtures");

    expect(fixturesPath()).toBe("spec/fixtures");
  });
});

describe("ignoring a set", () => {
  /** For a fragment other files reference and that would fail on its own. */
  it("records what to skip", () => {
    ignoreFixtures("shared_defaults");

    expect(isIgnoredFixture("shared_defaults")).toBe(true);
    expect(isIgnoredFixture("posts")).toBe(false);
    expect(ignoredFixtures()).toContain("shared_defaults");
  });
});

describe("the cache", () => {
  it("holds what it was given", () => {
    const fixtures = { one: 1 };
    cacheFixtures("posts", fixtures);

    expect(fixtureIsCached("posts")).toBe(true);
    expect(cachedFixtures("posts")).toBe(fixtures);
  });

  it("reports a miss", () => {
    expect(fixtureIsCached("absent")).toBe(false);
    expect(cachedFixtures("absent")).toBeUndefined();
  });

  it("lists what it holds", () => {
    cacheFixtures("posts", {});
    cacheFixtures("users", {});

    expect(cachedFixtureNames().sort()).toEqual(["posts", "users"]);
  });

  /**
   * Without a reset the second suite silently gets the first's rows, and the
   * failures point at the tests rather than at the loading.
   */
  it("forgets everything on reset", () => {
    cacheFixtures("posts", {});
    resetFixtureCache();

    expect(fixtureIsCached("posts")).toBe(false);
    expect(cachedFixtureNames()).toEqual([]);
  });
});
