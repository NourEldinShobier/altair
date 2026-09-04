/**
 * A persisted model declaring an attribute's type, ported from
 * `activerecord/test/cases/attributes_test.rb`.
 *
 * `attributes.ts` already had this for a model with no table. This is the half
 * with a table behind it, where the interesting case is a declaration that
 * disagrees with the column: a legacy schema storing a number in a varchar, a
 * boolean kept as "Y"/"N". Without it the application compares strings
 * everywhere, and one comparison eventually forgets.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Model, SchemaStatements, setConnection } from "../src/index.js";
import type { Connection } from "../src/connection.js";
import { isSqlite, testConnection } from "./support/database.js";

interface ProductRow {
  id: number;
  name: string;
  /** Deliberately a varchar holding a number, as a legacy schema would. */
  price: string;
  stock: number;
}

class Product extends Model<ProductRow>("products") {}

let connection: Connection;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  Product.resetColumnInformation();
  Product.declaredAttributes = {};

  await new SchemaStatements(connection).createTable("products", (t) => {
    t.string("name");
    t.string("price");
    t.integer("stock");
  });
});

afterEach(async () => {
  Product.declaredAttributes = {};

  if (isSqlite) await connection.close();
});

describe("declaring an attribute", () => {
  it("records it", () => {
    Product.attribute("price", "integer");

    expect(Product.declaredAttributeNames()).toEqual(["price"]);
  });

  it("keeps the name it was declared with", async () => {
    Product.attribute("price", "integer");

    expect(await Product.typeForAttribute("price")).toBe("integer");
  });

  /**
   * Answering with the column's type after a declaration overrode it would be
   * reporting the storage rather than the model.
   */
  it("wins over the column's own type", async () => {
    expect(await Product.typeForAttribute("price")).toBe("string");

    Product.attribute("price", "integer");

    expect(await Product.typeForAttribute("price")).toBe("integer");
  });

  it("leaves other columns reporting their own type", async () => {
    Product.attribute("price", "integer");

    expect(await Product.typeForAttribute("stock")).toBe("integer");
    expect(await Product.typeForAttribute("name")).toBe("string");
  });

  it("gives a Type that casts", () => {
    Product.attribute("price", "integer");

    expect(Product.declaredTypeFor("price")?.cast("42")).toBe(42);
  });

  /** Refused at the declaration, not on the first row that comes back. */
  it("refuses a type nobody registered", () => {
    expect(() => {
      Product.attribute("price", "quantum");
    }).toThrow();
  });

  it("does not register one it refused", () => {
    try {
      Product.attribute("price", "quantum");
    } catch {
      // expected
    }

    expect(Product.declaredAttributeNames()).toEqual([]);
  });
});

describe("casting what comes back", () => {
  /** The whole point: the column says varchar, the application says number. */
  it("reads a column through the declared type", async () => {
    Product.attribute("price", "integer");

    await connection.execute(
      "INSERT INTO products (name, price, stock) VALUES ('a', '1999', 5)",
      [],
    );

    const found = await Product.first();

    expect(found?.price).toBe(1999 as never);
  });

  it("leaves an undeclared column alone", async () => {
    Product.attribute("price", "integer");

    await connection.execute("INSERT INTO products (name, price, stock) VALUES ('a', '10', 5)", []);

    const found = await Product.first();

    expect(found?.name).toBe("a");
    expect(found?.stock).toBe(5);
  });
});

describe("defaults", () => {
  /**
   * A database default only applies once the row is written, so a form
   * rendered from an unsaved record shows an empty field for a value that is
   * about to become 0.
   */
  it("is there before the record is saved", () => {
    Product.attribute("stock", "integer", { default: 0 });

    expect(Product.build({ name: "a" }).stock).toBe(0);
  });

  it("gives way to a value the caller passed", () => {
    Product.attribute("stock", "integer", { default: 0 });

    expect(Product.build({ name: "a", stock: 7 }).stock).toBe(7);
  });

  it("is not applied to a record loaded from the database", async () => {
    await connection.execute("INSERT INTO products (name, price, stock) VALUES ('a', '1', 5)", []);

    Product.attribute("stock", "integer", { default: 99 });

    expect((await Product.first())?.stock).toBe(5);
  });

  /**
   * The case the guard is actually for. A stored NULL is a value the row
   * has; filling it with the default would report a number the database does
   * not hold, and the next save would write it.
   */
  it("does not fill a stored null with the default", async () => {
    await connection.execute("INSERT INTO products (name, price) VALUES ('a', '1')", []);

    Product.attribute("stock", "integer", { default: 99 });

    expect((await Product.first())?.stock).toBeNull();
  });

  /**
   * A record loaded with only some columns has not got the others, and a
   * default filled in here reads as a value the row holds — which the next
   * save would then write over whatever is actually stored.
   */
  it("does not invent a value for a column that was not selected", async () => {
    await connection.execute("INSERT INTO products (name, price, stock) VALUES ('a', '1', 5)", []);

    Product.attribute("stock", "integer", { default: 99 });

    const partial = await Product.all().select("id", "name").first();

    expect(partial?.stock).toBeUndefined();
  });

  it("survives a save", async () => {
    Product.attribute("stock", "integer", { default: 3 });

    const product = await Product.create({ name: "a", price: "1" });

    expect(product.stock).toBe(3);
  });

  /**
   * A value shared by every record built from this class is a bug that shows
   * up as one record's change appearing on another.
   */
  it("calls a function default per record", () => {
    let calls = 0;

    Product.attribute("stock", "integer", {
      default: () => {
        calls += 1;

        return calls;
      },
    });

    expect(Product.build({}).stock).toBe(1);
    expect(Product.build({}).stock).toBe(2);
  });

  it("does not give two records the same object", () => {
    Product.attribute("name", "string", { default: () => ({ tags: [] }) as never });

    const first = Product.build({}) as unknown as { name: { tags: string[] } };
    const second = Product.build({}) as unknown as { name: { tags: string[] } };

    first.name.tags.push("x");

    expect(second.name.tags).toEqual([]);
  });

  it("leaves an attribute with no default undefined", () => {
    Product.attribute("stock", "integer");

    expect(Product.build({ name: "a" }).stock).toBeUndefined();
  });
});

describe("subclasses", () => {
  /** Copy on write, or a declaration on a subclass appears on its parent. */
  it("do not declare on their parent", () => {
    class Special extends Product {}

    Special.attribute("price", "integer");

    expect(Product.declaredAttributeNames()).toEqual([]);
    expect(Special.declaredAttributeNames()).toEqual(["price"]);
  });

  it("inherit what the parent declared", () => {
    Product.attribute("price", "integer");

    class Special extends Product {}

    expect(Special.declaredAttributeNames()).toEqual(["price"]);
  });
});
