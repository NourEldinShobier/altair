/**
 * Aggregates, ported from `activerecord/test/cases/calculations_test.rb`.
 *
 * Written by running ours against Rails' cases rather than by reading the
 * code, which is how three of these turned up: a grouped `sum` answering with
 * one group's total, a grouped `count` answering with one group's count, and
 * `limit(2).count()` answering with every row. All three returned a number
 * that looked exactly like the right answer.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Model, SchemaStatements, setConnection } from "../src/index.js";
import type { Connection } from "../src/connection.js";
import { isSqlite, testConnection } from "./support/database.js";

interface AccountRow {
  id: number;
  firm_id: number | null;
  credit_limit: number | null;
}

class Account extends Model<AccountRow>("accounts") {}

let connection: Connection;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  Account.resetColumnInformation();

  await new SchemaStatements(connection).createTable("accounts", (t) => {
    t.integer("firm_id");
    t.integer("credit_limit");
  });

  // Rails' accounts fixture, near enough: six accounts across four firms, one
  // of them with no firm at all.
  for (const [firm_id, credit_limit] of [
    [1, 50],
    [1, 50],
    [2, 50],
    [6, 50],
    [9, 53],
    [null, 60],
  ] as [number | null, number][]) {
    await Account.create({ firm_id, credit_limit });
  }
});

afterEach(async () => {
  if (isSqlite) await connection.close();
});

describe("a value over everything", () => {
  it("sums a column", async () => {
    expect(await Account.all().sum("credit_limit")).toBe(313);
  });

  it("averages one", async () => {
    expect(await Account.all().average("credit_limit")).toBeCloseTo(52.166, 2);
  });

  it("takes the largest and the smallest", async () => {
    expect(await Account.all().maximum("credit_limit")).toBe(60);
    expect(await Account.all().minimum("credit_limit")).toBe(50);
  });

  it("counts", async () => {
    expect(await Account.all().count()).toBe(6);
  });
});

/**
 * Rails' `should_return_nil_as_average` and the empty-set cases around it. The
 * distinction is deliberate there and worth keeping: a sum over nothing is
 * zero, and an average over nothing is not a number at all.
 */
describe("over nothing", () => {
  const none = () => Account.where({ firm_id: 9999 });

  it("sums to zero", async () => {
    expect(await none().sum("credit_limit")).toBe(0);
  });

  it("averages to null rather than zero", async () => {
    expect(await none().average("credit_limit")).toBeNull();
  });

  it("has no largest or smallest", async () => {
    expect(await none().maximum("credit_limit")).toBeNull();
    expect(await none().minimum("credit_limit")).toBeNull();
  });

  it("counts zero", async () => {
    expect(await none().count()).toBe(0);
  });
});

/**
 * Rails' `limit_should_apply_before_count` and `should_limit_calculation`.
 *
 * This answered with every row. `LIMIT 2` beside `COUNT(*)` limits the rows the
 * count comes back in, not the rows being counted, so the limit did nothing and
 * the number looked right.
 */
describe("with a limit", () => {
  it("counts what the limit allows", async () => {
    expect(await Account.all().limit(2).count()).toBe(2);
  });

  it("sums what the limit allows", async () => {
    expect(await Account.all().order("credit_limit").limit(2).sum("credit_limit")).toBe(100);
  });

  it("counts from where the offset starts", async () => {
    expect(await Account.all().offset(4).count()).toBe(2);
  });

  it("honours both together", async () => {
    expect(await Account.all().limit(2).offset(4).count()).toBe(2);
    expect(await Account.all().limit(5).offset(4).count()).toBe(2);
  });

  it("still counts everything without one", async () => {
    expect(await Account.all().count()).toBe(6);
  });
});

/**
 * Rails' `should_group_by_field` and `should_group_by_summed_field`, where
 * `Model.group(:firm_id).count` answers a hash.
 *
 * Ours answered with one group's number — indistinguishable from a total, and
 * wrong in a way nothing would notice.
 */
describe("a value per group", () => {
  it("counts each group", async () => {
    const counts = await Account.all().group("firm_id").countByGroup();

    expect(counts.get(1)).toBe(2);
    expect(counts.get(2)).toBe(1);
    expect(counts.get(9)).toBe(1);
  });

  it("sums each group", async () => {
    const sums = await Account.all().group("firm_id").sumByGroup("credit_limit");

    expect(sums.get(1)).toBe(100);
    expect(sums.get(9)).toBe(53);
  });

  it("takes the largest and smallest of each", async () => {
    expect((await Account.all().group("firm_id").maximumByGroup("credit_limit")).get(1)).toBe(50);
    expect((await Account.all().group("firm_id").minimumByGroup("credit_limit")).get(9)).toBe(53);
  });

  it("averages each", async () => {
    const averages = await Account.all().group("firm_id").averageByGroup("credit_limit");

    expect(averages.get(1)).toBeCloseTo(50, 5);
  });

  it("keeps a group for rows with nothing in the column", async () => {
    expect((await Account.all().group("firm_id").countByGroup()).get(null)).toBe(1);
  });

  it("narrows with the conditions it was given", async () => {
    const counts = await Account.where({ credit_limit: 50 }).group("firm_id").countByGroup();

    expect(counts.get(1)).toBe(2);
    expect(counts.has(9)).toBe(false);
  });

  it("keys by the tuple when there is more than one column", async () => {
    const counts = await Account.all().group("firm_id", "credit_limit").countByGroup();

    expect(counts.get(JSON.stringify([1, 50]))).toBe(2);
  });

  it("answers nothing for a relation that matches nothing", async () => {
    expect((await Account.all().none().group("firm_id").countByGroup()).size).toBe(0);
  });
});

/**
 * A scalar over a grouped relation used to answer for one group. Rails answers
 * a hash; TypeScript would have to type that as a union of a number and a map,
 * so the grouped answer has its own method and the scalar says which.
 */
describe("asking for one number when there are several", () => {
  it("refuses rather than answering for one group", async () => {
    await expect(Account.all().group("firm_id").count()).rejects.toThrow(/countByGroup/);
    await expect(Account.all().group("firm_id").sum("credit_limit")).rejects.toThrow(/sumByGroup/);
  });

  it("names the columns it was grouped by", async () => {
    await expect(Account.all().group("firm_id").average("credit_limit")).rejects.toThrow(
      /grouped by firm_id/,
    );
  });

  it("refuses a value per group when nothing is grouped", async () => {
    await expect(Account.all().countByGroup()).rejects.toThrow(/Nothing is grouped/);
  });
});

describe("with distinct", () => {
  it("counts the rows that survive it", async () => {
    // Five distinct (firm_id, credit_limit) pairs across six accounts.
    expect(await Account.all().select("firm_id", "credit_limit").distinct().count()).toBe(5);
  });
});

/**
 * An offset with no limit in front of it.
 *
 * SQLite and MySQL both refuse `OFFSET 4` on its own — it is a syntax error,
 * not a quirk — so this threw rather than skipping rows. Turned up while
 * porting the limit cases above, and it is not about counting at all: reading
 * with an offset and no limit was broken too.
 */
describe("skipping rows without a limit", () => {
  it("reads the rest of them", async () => {
    expect(await Account.all().order("id").offset(4).toArray()).toHaveLength(2);
  });

  it("skips past everything when there is nothing left", async () => {
    expect(await Account.all().offset(99).toArray()).toEqual([]);
  });

  it("still takes a limit alongside", async () => {
    expect(await Account.all().order("id").offset(1).limit(2).toArray()).toHaveLength(2);
  });
});
