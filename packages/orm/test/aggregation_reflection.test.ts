/**
 * Aggregation and rich text reflection, ported from the `composed_of` cases in
 * `activerecord/test/cases/aggregations_test.rb` and
 * `actiontext/test/unit/model_test.rb`.
 *
 * The same question association reflection answers, for the same reason: what
 * a model holds should be discoverable from the model rather than restated in
 * every serializer, form builder and admin page.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Model, SchemaStatements, setConnection } from "../src/index.js";
import type { Connection } from "../src/connection.js";
import { isSqlite, testConnection } from "./support/database.js";
import {
  hasRichText,
  hasRichTextField,
  resetRichTextReflections,
  richTextAssociationNames,
  withAllRichText,
} from "../src/rich_text.js";

interface CustomerRow {
  id: number;
  street: string | null;
  city: string | null;
  postcode: string | null;
  name: string;
}

class Address {
  constructor(
    readonly street: string,
    readonly city: string,
  ) {}
}

let connection: Connection;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);
  resetRichTextReflections();

  await new SchemaStatements(connection).createTable("customers", (t) => {
    t.string("street");
    t.string("city");
    t.string("postcode");
    t.string("name");
  });
});

afterEach(async () => {
  if (isSqlite) await connection.close();
  resetRichTextReflections();
});

function customerClass() {
  class Customer extends Model<CustomerRow>("customers") {
    declare address: Address | null;
  }
  Customer.resetColumnInformation();
  return Customer;
}

describe("aggregation reflection", () => {
  function composed() {
    const Customer = customerClass();
    Customer.composedOf<Address, { street: string; city: string }>("address", {
      mapping: { street: "street", city: "city" },
      from: (parts) => new Address(parts.street, parts.city),
      to: (value) => ({ street: value.street, city: value.city }),
    });
    return Customer;
  }

  it("records the declaration", () => {
    expect(composed().aggregationNames()).toEqual(["address"]);
  });

  /** Otherwise street, city and postcode look like three independent fields. */
  it("names the columns the value object is built from", () => {
    expect(composed().reflectOnAggregation("address")?.columns).toEqual(["street", "city"]);
  });

  it("keeps the mapping", () => {
    expect(composed().reflectOnAggregation("address")?.mapping).toEqual({
      street: "street",
      city: "city",
    });
  });

  it("records whether an all-null set answers null", () => {
    expect(composed().reflectOnAggregation("address")?.allowNil).toBe(true);
  });

  it("gives undefined for one that was never declared", () => {
    expect(composed().reflectOnAggregation("billing")).toBeUndefined();
  });

  it("lists them all", () => {
    expect(composed().reflectOnAllAggregations()).toHaveLength(1);
  });

  it("gives nothing for a model with none", () => {
    expect(customerClass().reflectOnAllAggregations()).toEqual([]);
  });

  /** Copy on write, as everywhere else a subclass declares onto a parent. */
  it("does not leak a subclass's declaration onto its parent", () => {
    const Customer = composed();
    class Vip extends Customer {}
    Vip.composedOf<Address, { street: string; city: string }>("billing", {
      mapping: { street: "street", city: "city" },
      from: (parts) => new Address(parts.street, parts.city),
      to: (value) => ({ street: value.street, city: value.city }),
    });

    expect(Vip.aggregationNames().sort()).toEqual(["address", "billing"]);
    expect(Customer.aggregationNames()).toEqual(["address"]);
  });

  /** The declaration still has to work, not merely be recorded. */
  it("still builds the value object", async () => {
    const Customer = composed();
    const customer = Customer.build({ street: "Main St", city: "Springfield" });

    expect(customer.address).toBeInstanceOf(Address);
    expect(customer.address?.city).toBe("Springfield");
  });
});

describe("rich text reflection", () => {
  it("records a declared field", () => {
    class Article extends Model<{ id: number }>("articles") {
      declare content: unknown;
    }
    hasRichText(Article, "content");

    expect(richTextAssociationNames(Article)).toEqual(["content"]);
    expect(hasRichTextField(Article, "content")).toBe(true);
  });

  it("records several", () => {
    class Article extends Model<{ id: number }>("articles") {
      declare content: unknown;
      declare summary: unknown;
    }
    hasRichText(Article, "content");
    hasRichText(Article, "summary");

    expect(richTextAssociationNames(Article).sort()).toEqual(["content", "summary"]);
  });

  it("does not repeat one declared twice", () => {
    class Article extends Model<{ id: number }>("articles") {
      declare content: unknown;
    }
    hasRichText(Article, "content");
    hasRichText(Article, "content");

    expect(richTextAssociationNames(Article)).toEqual(["content"]);
  });

  it("gives nothing for a model with none", () => {
    class Tag extends Model<{ id: number }>("tags") {}

    expect(richTextAssociationNames(Tag)).toEqual([]);
    expect(hasRichTextField(Tag, "content")).toBe(false);
  });

  /** The N+1 that hurts most: one extra table lookup per row in a list. */
  it("names what a caller should preload", () => {
    class Article extends Model<{ id: number }>("articles") {
      declare content: unknown;
    }
    hasRichText(Article, "content");

    expect(withAllRichText(Article)).toEqual(["content"]);
  });

  it("keeps two models' fields apart", () => {
    class Article extends Model<{ id: number }>("articles") {
      declare content: unknown;
    }
    class Note extends Model<{ id: number }>("notes") {
      declare body: unknown;
    }
    hasRichText(Article, "content");
    hasRichText(Note, "body");

    expect(richTextAssociationNames(Article)).toEqual(["content"]);
    expect(richTextAssociationNames(Note)).toEqual(["body"]);
  });
});
