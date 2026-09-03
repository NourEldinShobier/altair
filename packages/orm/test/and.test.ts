/**
 * `and` and `structurallyCompatible`, ported from `and` and
 * `structurally_compatible?` in
 * `activerecord/lib/active_record/relation/query_methods.rb`, with the cases
 * from `activerecord/test/cases/relation/and_test.rb` and
 * `activerecord/test/cases/relation/structural_compatibility_test.rb`.
 *
 * `or` was here and `and` was not, which reads like an oversight and is not
 * quite one: `where` already ANDs, so the gap only shows when neither relation
 * knows about the other. A filter object folding together whichever scopes a
 * request named has two relations in hand and no way to say "both", because
 * `merge` — the obvious reach — lets the later condition on a column replace
 * the earlier one. That is right for a scope refining another and wrong here:
 * it widens the result to rows the caller ruled out.
 *
 * `structurallyCompatible` is the question `or` and `and` answer with an
 * exception. The same filter object cannot rescue its way out of it, because a
 * rescue around a query catches the failures that are not about compatibility
 * along with the one that is.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Connection, setConnection } from "../src/connection.js";
import { testConnection } from "./support/database.js";
import { SchemaStatements } from "../src/schema.js";
import { Model } from "../src/model.js";

interface AuthorRow {
  id: number;
  name: string;
  city: string;
}

class Author extends Model<AuthorRow>("authors") {
  declare id: number;
  declare name: string;
  declare city: string;
}

let connection: Connection;

const names = async (relation: { toArray(): Promise<Author[]> }): Promise<string[]> =>
  (await relation.toArray()).map((author) => author.name);

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);
  Author.resetColumnInformation();

  await new SchemaStatements(connection).createTable("authors", (t) => {
    t.string("name");
    t.string("city");
  });

  await Author.create({ name: "david", city: "London" });
  await Author.create({ name: "mary", city: "Paris" });
  await Author.create({ name: "bob", city: "London" });
});

describe("and", () => {
  /** Rails' own `test_and`: the overlap of two id sets, and only the overlap. */
  it("keeps the rows both relations match", async () => {
    const davidAndMary = Author.where({ name: ["david", "mary"] });
    const maryAndBob = Author.where({ name: ["mary", "bob"] });

    expect(await names(davidAndMary.and(maryAndBob))).toEqual(["mary"]);
  });

  it("keeps both conditions in the statement", () => {
    const { sql } = Author.where({ city: "London" })
      .and(Author.where({ name: "bob" }))
      .toSql();

    expect(sql).toContain("city");
    expect(sql).toContain("name");
  });

  /**
   * The difference from `merge`, which is why this exists. Two conditions on
   * one column both hold; the later does not replace the earlier.
   */
  it("does not let one condition on a column replace another", async () => {
    const inLondon = Author.where({ city: "London" });
    const inParis = Author.where({ city: "Paris" });

    expect(await names(inLondon.and(inParis))).toEqual([]);
    expect(await names(inLondon.merge(inParis))).toEqual(["mary"]);
  });

  it("takes conditions from a relation with none", async () => {
    expect(await names(Author.all().and(Author.where({ name: "bob" })))).toEqual(["bob"]);
    expect(await names(Author.where({ name: "bob" }).and(Author.all()))).toEqual(["bob"]);
  });

  /**
   * Rails unions the predicates rather than concatenating them: `published`
   * and `published` is `published`, and saying it twice changes nothing but
   * the length of the statement.
   */
  it("keeps a condition on both sides once", () => {
    const published = Author.where({ city: "London" });
    const { sql, bindings } = published.and(published).toSql();

    expect(sql.match(/city/g)).toHaveLength(1);
    expect(bindings).toEqual(["London"]);
  });

  /**
   * Same statement, different value, so not the same condition. Collapsing
   * these would drop a condition the caller wrote.
   */
  it("keeps two conditions that differ only in their value", async () => {
    const { bindings } = Author.where({ city: "London" })
      .and(Author.where({ city: "Paris" }))
      .toSql();

    expect(bindings).toEqual(["London", "Paris"]);
  });

  /**
   * A `having` is a condition too, and the one relation that carries one is
   * usually the one nobody looked at. Dropping it turns "cities with more than
   * one author" into "cities".
   */
  it("keeps both sets of group conditions", async () => {
    const busy = Author.all().group("city").having("COUNT(*) > ?", 1);
    const quiet = Author.all().group("city").having("COUNT(*) < ?", 3);

    const { sql, bindings } = busy.and(quiet).toSql();

    expect(sql.match(/COUNT\(\*\)/g)).toHaveLength(2);
    expect(bindings).toEqual([1, 3]);
  });

  it("leaves both relations as they were", async () => {
    const left = Author.where({ city: "London" });
    const right = Author.where({ name: "bob" });

    await left.and(right).toArray();

    expect(await names(left)).toEqual(["david", "bob"]);
    expect(await names(right)).toEqual(["bob"]);
  });

  it("refuses a pair that differs in more than its conditions", () => {
    expect(() => Author.all().limit(10).and(Author.all().limit(5))).toThrow(/limit/);
  });

  it("says what they differ in", () => {
    expect(() => Author.all().limit(10).and(Author.all().offset(10))).toThrow(/limit, offset/);
  });
});

describe("structurallyCompatible", () => {
  it("is true for two relations differing only in their conditions", () => {
    expect(Author.where({ id: 1 }).structurallyCompatible(Author.where({ id: 2 }))).toBe(true);
  });

  it("is false when one is distinct and the other is not", () => {
    expect(
      Author.all()
        .distinct()
        .structurallyCompatible(Author.where({ id: 2 })),
    ).toBe(false);
  });

  it("is false when the limits differ", () => {
    expect(Author.all().limit(1).structurallyCompatible(Author.all().limit(2))).toBe(false);
  });

  /** The point of asking: the answer is otherwise an exception. */
  it("agrees with what or and and will accept", () => {
    const left = Author.all().limit(1);
    const right = Author.all().limit(2);

    expect(left.structurallyCompatible(right)).toBe(false);
    expect(() => left.and(right)).toThrow();
    expect(() => left.or(right)).toThrow();
  });

  it("answers rather than throwing", () => {
    expect(() => Author.all().limit(1).structurallyCompatible(Author.all().limit(2))).not.toThrow();
  });
});
