/**
 * Resolving which database a task or model talks to, ported from
 * `activerecord/test/cases/database_configurations_test.rb`,
 * `activerecord/test/cases/database_configurations/hash_config_test.rb` and
 * the multi-database cases in `activerecord/test/cases/connection_handling_test.rb`.
 *
 * The question these mostly ask is not "which database" but "which of these
 * does `db:migrate` touch", because that is the one whose wrong answers are
 * destructive rather than merely wrong.
 */

import { describe, expect, it } from "bun:test";
import {
  type DatabaseConfiguration,
  DatabaseConfigurations,
  PRIMARY_NAME,
  UnknownDatabaseConfiguration,
  connectionSpecificationName,
  databaseTasks,
  isPrimary,
  migrationsPaths,
  replica,
  roleNames,
  schemaDumpPath,
  sharded,
  shardKeys,
  skipTransactionalTestsForDatabase,
  typeCastConfigToBoolean,
  typeCastConfigToInteger,
  useForeignKeys,
  useMetadataTable,
  useTransactionalTestsForDatabase,
  validateDefaultTimezone,
} from "../src/database_configurations.js";

const config = (overrides: Partial<DatabaseConfiguration> = {}): DatabaseConfiguration => ({
  env: "production",
  name: PRIMARY_NAME,
  adapter: "postgresql",
  ...overrides,
});

const FILE = {
  development: { adapter: "sqlite3", database: "db/dev.sqlite3" },
  production: {
    primary: { adapter: "postgresql", database: "app" },
    primary_replica: { adapter: "postgresql", database: "app", replica: true },
    animals: { adapter: "postgresql", database: "animals" },
    reporting: { adapter: "postgresql", database: "reporting", databaseTasks: false },
  },
};

describe("which entries a task touches", () => {
  it("touches an ordinary one", () => {
    expect(databaseTasks(config())).toBe(true);
  });

  /**
   * DDL on a follower is not a slower migration — it is DDL on a server whose
   * contents come from somewhere else, and replication either undoes it or
   * stops.
   */
  it("never touches a replica", () => {
    expect(databaseTasks(config({ replica: true }))).toBe(false);
  });

  it("does not touch a replica even when the file says to", () => {
    expect(databaseTasks(config({ replica: true, databaseTasks: true }))).toBe(false);
  });

  it("honours an explicit opt-out", () => {
    expect(databaseTasks(config({ databaseTasks: false }))).toBe(false);
  });

  it("says which entries are replicas", () => {
    expect(replica(config({ replica: true }))).toBe(true);
    expect(replica(config())).toBe(false);
  });

  it("says which is primary", () => {
    expect(isPrimary(config())).toBe(true);
    expect(isPrimary(config({ name: "animals" }))).toBe(false);
  });
});

describe("reading a configuration file", () => {
  /**
   * Rails accepts both shapes. Reading the flat one as a map of names would
   * make `adapter` and `database` two database names, and the failure surfaces
   * far from the file.
   */
  it("reads a single database written flat", () => {
    const configs = DatabaseConfigurations.from(FILE);

    expect(configs.names("development")).toEqual([PRIMARY_NAME]);
    expect(configs.findDbConfig("development").database).toBe("db/dev.sqlite3");
  });

  it("reads several written as a map", () => {
    expect(DatabaseConfigurations.from(FILE).names("production")).toEqual([
      "primary",
      "primary_replica",
      "animals",
      "reporting",
    ]);
  });

  it("lists the environments", () => {
    expect(DatabaseConfigurations.from(FILE).envNames()).toEqual(["development", "production"]);
  });

  it("reads nothing from nothing", () => {
    expect(DatabaseConfigurations.from({}).size).toBe(0);
  });
});

describe("asking for entries", () => {
  const configs = DatabaseConfigurations.from(FILE);

  it("filters by environment", () => {
    expect(configs.configsFor({ env: "development" })).toHaveLength(1);
  });

  it("filters by name", () => {
    expect(configs.configsFor({ env: "production", name: "animals" })).toHaveLength(1);
  });

  /** The list a task iterates leaves out replicas and opted-out entries. */
  it("leaves out what tasks must not touch", () => {
    expect(configs.configsFor({ env: "production" }).map((each) => each.name)).toEqual([
      "primary",
      "animals",
    ]);
  });

  /**
   * Hidden means untouched by tasks, not unreachable — a model can still point
   * at one, and filtering it everywhere would make the setting unusable.
   */
  it("includes them when asked", () => {
    expect(configs.configsFor({ env: "production", includeHidden: true })).toHaveLength(4);
  });

  it("finds one by name", () => {
    expect(configs.findDbConfig("production", "animals").database).toBe("animals");
  });

  it("finds a hidden one by name", () => {
    expect(configs.findDbConfig("production", "reporting").database).toBe("reporting");
  });

  /** For anything destructive, a fallback is the wrong database entirely. */
  it("refuses a name nothing configures", () => {
    expect(() => configs.findDbConfig("production", "animls")).toThrow(
      UnknownDatabaseConfiguration,
    );
  });

  it("says what is configured there", () => {
    expect(() => configs.findDbConfig("production", "animls")).toThrow("animals");
  });

  it("refuses an environment nothing configures", () => {
    expect(() => configs.findDbConfig("staging")).toThrow(UnknownDatabaseConfiguration);
  });

  it("finds the primary", () => {
    expect(configs.primary("production").name).toBe(PRIMARY_NAME);
  });

  /** What makes a single-database file work without anybody writing "primary". */
  it("falls back to the first entry when nothing is named primary", () => {
    const single = DatabaseConfigurations.from({
      test: { animals: { adapter: "sqlite3", database: "x" } },
    });

    expect(single.primary("test").name).toBe("animals");
  });
});

describe("shards and roles", () => {
  /** Guessing from names would make an unrelated `shard_report` a shard. */
  it("takes the shards a model declares", () => {
    expect(shardKeys({ default: {}, shard_one: {} })).toEqual(["default", "shard_one"]);
  });

  it("says nothing is sharded with one entry", () => {
    expect(sharded({ default: {} })).toBe(false);
    expect(sharded(undefined)).toBe(false);
  });

  it("says two are", () => {
    expect(sharded({ default: {}, shard_one: {} })).toBe(true);
  });

  it("takes the roles a model declares", () => {
    expect(roleNames({ writing: {}, reading: {} })).toEqual(["writing", "reading"]);
  });

  /**
   * All three parts: a key missing the role sends a write to a replica, one
   * missing the shard sends a query for one tenant to another's database.
   */
  it("keys a connection by name, role and shard", () => {
    expect(connectionSpecificationName("primary", "reading", "shard_one")).toBe(
      "primary/reading/shard_one",
    );
  });

  it("separates two roles", () => {
    expect(connectionSpecificationName("primary", "writing")).not.toBe(
      connectionSpecificationName("primary", "reading"),
    );
  });

  it("separates two shards", () => {
    expect(connectionSpecificationName("primary", "writing", "one")).not.toBe(
      connectionSpecificationName("primary", "writing", "two"),
    );
  });
});

describe("coercing configuration values", () => {
  /** `"false"` is truthy in JavaScript, so reading it raw turns the setting on. */
  it("reads a false written as a string", () => {
    for (const value of ["false", "0", "no", "off", "FALSE"]) {
      expect(typeCastConfigToBoolean(value)).toBe(false);
    }
  });

  it("reads a true written as a string", () => {
    for (const value of ["true", "1", "yes", "on"]) {
      expect(typeCastConfigToBoolean(value)).toBe(true);
    }
  });

  it("passes a real boolean through", () => {
    expect(typeCastConfigToBoolean(false)).toBe(false);
    expect(typeCastConfigToBoolean(true)).toBe(true);
  });

  it("reports nothing for an absent value", () => {
    expect(typeCastConfigToBoolean(undefined)).toBeUndefined();
    expect(typeCastConfigToBoolean("")).toBeUndefined();
  });

  it("reports nothing for something it cannot read", () => {
    expect(typeCastConfigToBoolean("maybe")).toBeUndefined();
  });

  it("reads an integer from a string", () => {
    expect(typeCastConfigToInteger("5")).toBe(5);
    expect(typeCastConfigToInteger(" 12 ")).toBe(12);
  });

  /**
   * `NaN` reaching a pool size makes every comparison against it false, so the
   * pool silently behaves as though it had no limit.
   */
  it("reports nothing rather than NaN", () => {
    expect(typeCastConfigToInteger("many")).toBeUndefined();
    expect(typeCastConfigToInteger(Number.NaN)).toBeUndefined();
  });

  it("truncates a fractional one", () => {
    expect(typeCastConfigToInteger(5.9)).toBe(5);
  });

  it("takes a database timezone", () => {
    expect(validateDefaultTimezone("utc")).toBe("utc");
    expect(validateDefaultTimezone("local")).toBe("local");
  });

  /** Picking the wrong one shifts every stored time by the machine's offset. */
  it("refuses anything else", () => {
    expect(() => validateDefaultTimezone("UTC")).toThrow("utc");
    expect(() => validateDefaultTimezone(undefined)).toThrow();
  });
});

describe("what a task does with an entry", () => {
  it("keeps a metadata table by default", () => {
    expect(useMetadataTable(config())).toBe(true);
    expect(useMetadataTable(config({ useMetadataTable: false }))).toBe(false);
  });

  it("dumps foreign keys by default", () => {
    expect(useForeignKeys(config())).toBe(true);
    expect(useForeignKeys(config({ useForeignKeys: false }))).toBe(false);
  });

  it("dumps the primary schema to the usual place", () => {
    expect(schemaDumpPath(config())).toBe("db/schema.rb");
  });

  /**
   * Per entry, not per application. Two databases dumping to one file is how
   * the second overwrites the first and a schema load recreates half a schema.
   */
  it("gives another database its own file", () => {
    expect(schemaDumpPath(config({ name: "animals" }))).toBe("db/animals_schema.rb");
  });

  it("takes the sql format", () => {
    expect(schemaDumpPath(config(), "sql")).toBe("db/structure.sql");
  });

  it("takes an explicit path", () => {
    expect(schemaDumpPath(config({ schemaDump: "db/custom.rb" }))).toBe("db/custom.rb");
  });

  it("dumps nothing when told not to", () => {
    expect(schemaDumpPath(config({ schemaDump: false }))).toBeUndefined();
  });

  it("defaults the migrations path", () => {
    expect(migrationsPaths(config())).toEqual(["db/migrate"]);
  });

  it("takes one path or several", () => {
    expect(migrationsPaths(config({ migrationsPaths: "db/animals" }))).toEqual(["db/animals"]);
    expect(migrationsPaths(config({ migrationsPaths: ["a", "b"] }))).toEqual(["a", "b"]);
  });

  /**
   * A rollback on a database another service is writing to would discard
   * whatever else was in flight.
   */
  it("does not wrap a replica's tests in a transaction", () => {
    expect(useTransactionalTestsForDatabase(config({ replica: true }))).toBe(false);
    expect(skipTransactionalTestsForDatabase(config({ replica: true }))).toBe(true);
  });

  it("does not wrap a shared database either", () => {
    expect(useTransactionalTestsForDatabase(config({ shared: true }))).toBe(false);
  });

  it("wraps an ordinary one", () => {
    expect(useTransactionalTestsForDatabase(config())).toBe(true);
    expect(skipTransactionalTestsForDatabase(config())).toBe(false);
  });
});
