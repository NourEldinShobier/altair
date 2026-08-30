/**
 * Protected environments, ported from the protected-environment cases in
 * `activerecord/test/cases/tasks/database_tasks_test.rb`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { setConnection } from "../src/index.js";
import type { Connection } from "../src/connection.js";
import { isSqlite, testConnection } from "./support/database.js";
import {
  ProtectedEnvironmentError,
  checkProtectedEnvironments,
  currentEnvironmentMatches,
  isProtectedEnvironment,
  protectedEnvironments,
  setProtectedEnvironments,
  storeEnvironment,
  storedEnvironment,
} from "../src/protected_environments.js";

let connection: Connection;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);
  setProtectedEnvironments("production");
});

afterEach(async () => {
  if (isSqlite) await connection.close();
  setProtectedEnvironments("production");
});

describe("which environments are protected", () => {
  it("protects production by default", () => {
    expect(isProtectedEnvironment("production")).toBe(true);
    expect(isProtectedEnvironment("development")).toBe(false);
    expect(protectedEnvironments()).toEqual(["production"]);
  });

  it("takes a list of its own", () => {
    setProtectedEnvironments("production", "staging");

    expect(isProtectedEnvironment("staging")).toBe(true);
    expect(protectedEnvironments().sort()).toEqual(["production", "staging"]);
  });

  it("can protect nothing at all", () => {
    setProtectedEnvironments();

    expect(isProtectedEnvironment("production")).toBe(false);
  });
});

describe("the stored environment", () => {
  it("is undefined before anything records it", async () => {
    expect(await storedEnvironment(connection).catch(() => undefined)).toBeUndefined();
  });

  it("round-trips", async () => {
    await storeEnvironment(connection, "development");

    expect(await storedEnvironment(connection)).toBe("development");
  });

  it("replaces rather than accumulating", async () => {
    await storeEnvironment(connection, "development");
    await storeEnvironment(connection, "test");

    expect(await storedEnvironment(connection)).toBe("test");
  });
});

describe("checkProtectedEnvironments", () => {
  it("allows a task in an unprotected environment", async () => {
    await storeEnvironment(connection, "development");

    await expect(
      checkProtectedEnvironments(connection, { environment: "development", task: "db:drop" }),
    ).resolves.toBeUndefined();
  });

  it("refuses when the process thinks it is production", async () => {
    await expect(
      checkProtectedEnvironments(connection, { environment: "production", task: "db:drop" }),
    ).rejects.toThrow(ProtectedEnvironmentError);
  });

  /**
   * The case that actually loses data: a development process pointed at the
   * production database, which a check trusting the process alone cannot see.
   */
  it("refuses when the database says production even if the process does not", async () => {
    await storeEnvironment(connection, "production");

    await expect(
      checkProtectedEnvironments(connection, { environment: "development", task: "db:drop" }),
    ).rejects.toThrow(ProtectedEnvironmentError);
  });

  it("names the task and the environment", async () => {
    await expect(
      checkProtectedEnvironments(connection, { environment: "production", task: "db:schema:load" }),
    ).rejects.toThrow(/db:schema:load.*production/s);
  });

  it("says how to override", async () => {
    await expect(
      checkProtectedEnvironments(connection, { environment: "production", task: "db:drop" }),
    ).rejects.toThrow(/DISABLE_DATABASE_ENVIRONMENT_CHECK/);
  });

  /** Deliberate, and not something anybody types by accident. */
  it("allows it when overridden", async () => {
    await expect(
      checkProtectedEnvironments(connection, {
        environment: "production",
        task: "db:drop",
        override: true,
      }),
    ).resolves.toBeUndefined();
  });

  it("carries the environment and task on the error", async () => {
    try {
      await checkProtectedEnvironments(connection, { environment: "production", task: "db:drop" });
      expect.unreachable();
    } catch (error) {
      expect((error as ProtectedEnvironmentError).environment).toBe("production");
      expect((error as ProtectedEnvironmentError).task).toBe("db:drop");
    }
  });

  it("allows everything once nothing is protected", async () => {
    setProtectedEnvironments();
    await storeEnvironment(connection, "production");

    await expect(
      checkProtectedEnvironments(connection, { environment: "production", task: "db:drop" }),
    ).resolves.toBeUndefined();
  });
});

describe("currentEnvironmentMatches", () => {
  it("agrees when they match", async () => {
    await storeEnvironment(connection, "test");

    expect(await currentEnvironmentMatches(connection, "test")).toBe(true);
  });

  /**
   * Worth reporting even when neither side is protected: a test suite pointed
   * at the development database passes and then wipes it.
   */
  it("disagrees when they do not", async () => {
    await storeEnvironment(connection, "development");

    expect(await currentEnvironmentMatches(connection, "test")).toBe(false);
  });

  it("agrees when the database has recorded nothing", async () => {
    expect(await currentEnvironmentMatches(connection, "test")).toBe(true);
  });
});
