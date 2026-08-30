/**
 * What each adapter can do, ported from the `supports_*?` predicates in
 * `activerecord/lib/active_record/connection_adapters/abstract_adapter.rb` and
 * their per-adapter overrides.
 *
 * The tests worth having here are not "postgres supports views". They are the
 * rows where the three disagree, because those are the ones a caller gets
 * wrong by reaching for `adapter === "postgres"` instead of the question it
 * actually meant.
 */

import { describe, expect, it } from "bun:test";
import {
  ADAPTERS,
  capabilitiesFor,
  maxIdentifierLength,
  nativeDatabaseTypes,
} from "../src/capabilities.js";

describe("the table", () => {
  it("answers for every adapter", () => {
    for (const adapter of ADAPTERS) {
      expect(capabilitiesFor(adapter)).toBeDefined();
    }
  });

  it("gives every adapter the same set of questions", () => {
    const keys = ADAPTERS.map((adapter) => Object.keys(capabilitiesFor(adapter)).sort());

    expect(keys[1]).toEqual(keys[0]!);
    expect(keys[2]).toEqual(keys[0]!);
  });

  it("answers every question with a boolean", () => {
    for (const adapter of ADAPTERS) {
      for (const [name, value] of Object.entries(capabilitiesFor(adapter))) {
        expect(typeof value, `${adapter}.${name}`).toBe("boolean");
      }
    }
  });
});

describe("where the three disagree", () => {
  /** The one that already had a predicate, and the reason it existed. */
  it("has RETURNING everywhere but MySQL", () => {
    expect(capabilitiesFor("postgres").returning).toBe(true);
    expect(capabilitiesFor("sqlite").returning).toBe(true);
    expect(capabilitiesFor("mysql").returning).toBe(false);
  });

  /**
   * The one that costs a half-applied migration. MySQL commits each DDL
   * statement as it goes, so a migration that fails on its third statement
   * leaves the first two in place.
   */
  it("rolls DDL back everywhere but MySQL", () => {
    expect(capabilitiesFor("postgres").ddlTransactions).toBe(true);
    expect(capabilitiesFor("sqlite").ddlTransactions).toBe(true);
    expect(capabilitiesFor("mysql").ddlTransactions).toBe(false);
  });

  /** No advisory lock means nothing stops two processes migrating at once. */
  it("has no advisory locks on SQLite", () => {
    expect(capabilitiesFor("sqlite").advisoryLocks).toBe(false);
    expect(capabilitiesFor("postgres").advisoryLocks).toBe(true);
    expect(capabilitiesFor("mysql").advisoryLocks).toBe(true);
  });

  /** SQLite has more than its reputation suggests. */
  it("gives SQLite partial and expression indexes", () => {
    expect(capabilitiesFor("sqlite").partialIndex).toBe(true);
    expect(capabilitiesFor("sqlite").expressionIndex).toBe(true);
  });

  it("gives SQLite generated columns and CTEs", () => {
    expect(capabilitiesFor("sqlite").virtualColumns).toBe(true);
    expect(capabilitiesFor("sqlite").commonTableExpressions).toBe(true);
  });

  /** And less than its reputation suggests where a migration cares. */
  it("does not give SQLite a bulk ALTER TABLE", () => {
    expect(capabilitiesFor("sqlite").bulkAlter).toBe(false);
  });

  it("keeps partial indexes away from MySQL", () => {
    expect(capabilitiesFor("mysql").partialIndex).toBe(false);
  });

  it("keeps exclusion constraints to PostgreSQL", () => {
    expect(capabilitiesFor("postgres").exclusionConstraints).toBe(true);
    expect(capabilitiesFor("mysql").exclusionConstraints).toBe(false);
    expect(capabilitiesFor("sqlite").exclusionConstraints).toBe(false);
  });

  it("keeps schema comments away from SQLite", () => {
    expect(capabilitiesFor("sqlite").comments).toBe(false);
  });

  /** A conflict target is what makes upsert-on-one-key possible. */
  it("gives every adapter some ON CONFLICT, but not every one a target", () => {
    for (const adapter of ADAPTERS) {
      expect(capabilitiesFor(adapter).insertOnConflict, adapter).toBe(true);
    }

    expect(capabilitiesFor("mysql").insertConflictTarget).toBe(false);
  });
});

describe("identifier length", () => {
  /**
   * PostgreSQL does not error on a name past its limit — it truncates,
   * silently, and two generated index names can then collide as one.
   */
  it("is 63 on PostgreSQL", () => {
    expect(maxIdentifierLength("postgres")).toBe(63);
  });

  it("is 64 on MySQL", () => {
    expect(maxIdentifierLength("mysql")).toBe(64);
  });

  it("is effectively unbounded on SQLite", () => {
    expect(maxIdentifierLength("sqlite")).toBeGreaterThan(1000);
  });
});

describe("native types", () => {
  it("names a primary key for every adapter", () => {
    for (const adapter of ADAPTERS) {
      expect(nativeDatabaseTypes(adapter).primaryKey, adapter).toBeTruthy();
    }
  });

  it("spells binary the way each server does", () => {
    expect(nativeDatabaseTypes("postgres").binary).toBe("bytea");
    expect(nativeDatabaseTypes("mysql").binary).toBe("blob");
    expect(nativeDatabaseTypes("sqlite").binary).toBe("blob");
  });

  it("reaches for jsonb on PostgreSQL", () => {
    expect(nativeDatabaseTypes("postgres").json).toBe("jsonb");
  });

  /** MySQL has no boolean; tinyint(1) is what the driver reads back as one. */
  it("spells boolean as tinyint(1) on MySQL", () => {
    expect(nativeDatabaseTypes("mysql").boolean).toBe("tinyint(1)");
  });
});
