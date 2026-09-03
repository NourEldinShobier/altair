/**
 * Comparing one value against another, ported from
 * `activemodel/test/cases/validations/comparison_validation_test.rb` and the
 * numericality cases beside it.
 *
 * Rails 7 added `validates_comparison_of` for the thing `numericality` cannot
 * do: compare against another attribute, and compare things that are not
 * numbers. An end date after a start date is the case it was added for.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Model, SchemaStatements, setConnection } from "../src/index.js";
import type { Connection } from "../src/connection.js";
import { isSqlite, testConnection } from "./support/database.js";

interface EventRow {
  id: number;
  starts_on: string | null;
  ends_on: string | null;
  seats: number | null;
  floor: number | null;
}

let connection: Connection;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  await new SchemaStatements(connection).createTable("events", (t) => {
    t.string("starts_on");
    t.string("ends_on");
    t.integer("seats");
    t.integer("floor");
  });
});

afterEach(async () => {
  if (isSqlite) await connection.close();
});

/** A model carrying one validation, so each case reads on its own. */
const modelWith = (attribute: string, options: object) => {
  class Subject extends Model<EventRow>("events") {
    static {
      this.validates(attribute, options as never);
    }
  }

  Subject.resetColumnInformation();

  return Subject;
};

const errorsFor = async (
  Subject: ReturnType<typeof modelWith>,
  values: Partial<EventRow>,
): Promise<string[]> => {
  const record = new Subject(values);
  await record.validate();

  return record.errors.fullMessages();
};

/**
 * The case the validator exists for. `numericality` cannot express it: there
 * is no number to compare, and the thing being compared against is on the
 * record.
 */
describe("comparing against another attribute", () => {
  const Event = () =>
    modelWith("ends_on", {
      comparison: { greaterThan: (record: EventRow) => record.starts_on },
    });

  it("accepts an end after the start", async () => {
    expect(await errorsFor(Event(), { starts_on: "2026-01-01", ends_on: "2026-01-02" })).toEqual(
      [],
    );
  });

  it("refuses one before it", async () => {
    expect(
      await errorsFor(Event(), { starts_on: "2026-01-02", ends_on: "2026-01-01" }),
    ).toHaveLength(1);
  });

  it("refuses one on the same day", async () => {
    expect(
      await errorsFor(Event(), { starts_on: "2026-01-01", ends_on: "2026-01-01" }),
    ).toHaveLength(1);
  });

  // Nothing to compare against is not a failure of this validation. Saying the
  // start date is missing is `presence`'s job.
  it("says nothing when there is nothing to compare against", async () => {
    expect(await errorsFor(Event(), { starts_on: null, ends_on: "2026-01-01" })).toEqual([]);
  });

  it("says nothing when the value itself is missing", async () => {
    expect(await errorsFor(Event(), { starts_on: "2026-01-01", ends_on: null })).toEqual([]);
  });
});

describe("comparing against a fixed value", () => {
  it("takes each of the six comparisons", async () => {
    const cases: [object, Partial<EventRow>, number][] = [
      [{ greaterThan: 10 }, { seats: 10 }, 1],
      [{ greaterThan: 10 }, { seats: 11 }, 0],
      [{ greaterThanOrEqualTo: 10 }, { seats: 10 }, 0],
      [{ lessThan: 10 }, { seats: 10 }, 1],
      [{ lessThanOrEqualTo: 10 }, { seats: 10 }, 0],
      [{ equalTo: 10 }, { seats: 11 }, 1],
      [{ otherThan: 10 }, { seats: 10 }, 1],
    ];

    for (const [comparison, values, expected] of cases) {
      const errors = await errorsFor(modelWith("seats", { comparison }), values);

      expect([comparison, errors.length]).toEqual([comparison, expected]);
    }
  });

  it("says what it wanted", async () => {
    expect(
      await errorsFor(modelWith("seats", { comparison: { greaterThan: 10 } }), { seats: 5 }),
    ).toEqual(["Seats must be greater than 10"]);
  });

  // Strings compare as strings, which is the point of not going through
  // Number: "2026-01-02" > "2026-01-01" is the comparison a date needs.
  it("compares strings without turning them into numbers", async () => {
    const Subject = modelWith("ends_on", { comparison: { greaterThan: "2026-01-01" } });

    expect(await errorsFor(Subject, { ends_on: "2026-01-02" })).toEqual([]);
    expect(await errorsFor(Subject, { ends_on: "2025-12-31" })).toHaveLength(1);
  });
});

/**
 * The numericality rules Rails has that were missing here. `equal_to` and
 * `other_than` for exact values, and the parity pair.
 */
describe("the numericality rules that were missing", () => {
  it("checks equality", async () => {
    const Subject = modelWith("floor", { numericality: { equalTo: 0 } });

    expect(await errorsFor(Subject, { floor: 0 })).toEqual([]);
    expect(await errorsFor(Subject, { floor: 1 })).toEqual(["Floor must be equal to 0"]);
  });

  it("checks inequality", async () => {
    const Subject = modelWith("floor", { numericality: { otherThan: 13 } });

    expect(await errorsFor(Subject, { floor: 13 })).toEqual(["Floor must be other than 13"]);
    expect(await errorsFor(Subject, { floor: 12 })).toEqual([]);
  });

  it("checks odd and even", async () => {
    expect(
      await errorsFor(modelWith("floor", { numericality: { even: true } }), { floor: 3 }),
    ).toEqual(["Floor must be even"]);
    expect(
      await errorsFor(modelWith("floor", { numericality: { odd: true } }), { floor: 3 }),
    ).toEqual([]);
  });

  // Rails checks parity on an integer, so 2.5 is neither and fails whichever
  // was asked for.
  it("calls a fraction neither odd nor even", async () => {
    expect(
      await errorsFor(modelWith("floor", { numericality: { even: true } }), {
        floor: 2.5 as never,
      }),
    ).toHaveLength(1);
    expect(
      await errorsFor(modelWith("floor", { numericality: { odd: true } }), {
        floor: 2.5 as never,
      }),
    ).toHaveLength(1);
  });

  it("counts a negative odd number as odd", async () => {
    expect(
      await errorsFor(modelWith("floor", { numericality: { odd: true } }), { floor: -3 }),
    ).toEqual([]);
  });
});
