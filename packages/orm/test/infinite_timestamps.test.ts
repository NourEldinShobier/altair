/**
 * PostgreSQL's `infinity` and `-infinity`, ported from the `cast_value`
 * handling in
 * `activerecord/lib/active_record/connection_adapters/postgresql/oid/date_time.rb`
 * and `date.rb`.
 *
 * A timestamp with no end is how you say "this subscription does not expire"
 * without a nullable column that also means "nobody has decided yet".
 *
 * Bun's driver returns them as the *numbers* `Infinity` and `-Infinity`, where
 * every other row in the same column arrives as a `Date`. Nothing here
 * noticed, so the number went into the attribute unchanged, and the first
 * `new Date(row.expiresAt)` produced `Invalid Date` — or a `TypeError` from
 * `.toISOString()`, at a call site with no clue where the value came from.
 *
 * Runs against PostgreSQL only, because it is the only adapter with the
 * literals. Skipped elsewhere rather than faked: a test that pretends to cover
 * an adapter it never ran on is worse than one that says it did not.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Connection, setConnection } from "../src/connection.js";
import { testConnection, TEST_ADAPTER } from "./support/database.js";
import { SchemaStatements } from "../src/schema.js";
import { DISTANT_FUTURE, DISTANT_PAST, Model, isInfiniteTime, serialize } from "../src/model.js";

const onPostgres = TEST_ADAPTER === "postgres" ? describe : describe.skip;

interface SubscriptionRow {
  id: number;
  expires_at: Date | string | null;
}

class Subscription extends Model<SubscriptionRow>("subscriptions") {
  declare id: number;
  declare expires_at: string | null;
}

let connection: Connection;

beforeEach(async () => {
  if (TEST_ADAPTER !== "postgres") return;

  connection = await testConnection();
  setConnection(connection);
  Subscription.resetColumnInformation();

  await connection.execute("DROP TABLE IF EXISTS subscriptions");
  await new SchemaStatements(connection).createTable("subscriptions", (t) => {
    t.datetime("expires_at");
  });
});

describe("the two instants", () => {
  it("are real, parseable dates", () => {
    expect(Number.isNaN(new Date(DISTANT_FUTURE).getTime())).toBe(false);
    expect(Number.isNaN(new Date(DISTANT_PAST).getTime())).toBe(false);
  });

  /** The whole point: a subscription that never ends has not expired. */
  it("compare the way a caller needs them to", () => {
    expect(new Date(DISTANT_FUTURE) > new Date()).toBe(true);
    expect(new Date(DISTANT_PAST) < new Date()).toBe(true);
  });

  it("are recognised as infinite", () => {
    expect(isInfiniteTime(DISTANT_FUTURE)).toBe(true);
    expect(isInfiniteTime(DISTANT_PAST)).toBe(true);
  });

  it("do not catch an ordinary timestamp", () => {
    expect(isInfiniteTime(new Date().toISOString())).toBe(false);
    expect(isInfiniteTime(null)).toBe(false);
  });
});

describe("writing", () => {
  /**
   * Back to the literal, not to the instant. Written as the instant, the
   * column holds a timestamp in the year 275760 — which orders the same way
   * and means something quite different to anyone reading the table.
   */
  it("sends the literal the database understands", () => {
    expect(serialize(DISTANT_FUTURE)).toBe("infinity");
    expect(serialize(DISTANT_PAST)).toBe("-infinity");
  });

  it("leaves an ordinary timestamp alone", () => {
    const at = new Date("2020-01-01T00:00:00.000Z");

    expect(serialize(at.toISOString())).toBe(at.toISOString());
  });
});

onPostgres("against the database", () => {
  it("reads infinity as a date rather than a number", async () => {
    await connection.execute("INSERT INTO subscriptions (expires_at) VALUES ('infinity')");

    const found = await Subscription.first();

    expect(found?.expires_at).toBe(DISTANT_FUTURE);
    expect(typeof found?.expires_at).toBe("string");
  });

  it("reads -infinity the same way", async () => {
    await connection.execute("INSERT INTO subscriptions (expires_at) VALUES ('-infinity')");

    expect((await Subscription.first())?.expires_at).toBe(DISTANT_PAST);
  });

  /** The failure this fixes: a number where the caller expects a timestamp. */
  it("gives a value that survives new Date()", async () => {
    await connection.execute("INSERT INTO subscriptions (expires_at) VALUES ('infinity')");

    const found = await Subscription.first();

    expect(Number.isNaN(new Date(found?.expires_at as string).getTime())).toBe(false);
    expect(new Date(found?.expires_at as string) > new Date()).toBe(true);
  });

  it("round-trips through a save", async () => {
    const made = await Subscription.create({ expires_at: DISTANT_FUTURE } as never);

    expect((await Subscription.find(made.id)).expires_at).toBe(DISTANT_FUTURE);
  });

  it("stores the literal, not a timestamp in the far future", async () => {
    await Subscription.create({ expires_at: DISTANT_FUTURE } as never);

    const [row] = await connection.query<{ text: string }>(
      "SELECT expires_at::text AS text FROM subscriptions",
    );

    expect(row?.text).toBe("infinity");
  });

  it("leaves an ordinary timestamp untouched", async () => {
    const at = "2020-01-01T00:00:00.000Z";
    const made = await Subscription.create({ expires_at: at } as never);

    expect(new Date((await Subscription.find(made.id)).expires_at as string).toISOString()).toBe(
      at,
    );
  });

  it("still reads a null as a null", async () => {
    await connection.execute("INSERT INTO subscriptions (expires_at) VALUES (NULL)");

    expect((await Subscription.first())?.expires_at).toBeNull();
  });
});
