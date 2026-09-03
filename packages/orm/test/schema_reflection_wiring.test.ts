/**
 * A model reading its columns from a loaded schema cache, ported from
 * `activerecord/test/cases/schema_dumper_test.rb`'s cache cases and
 * `railties/test/application/rake/dbs_test.rb`'s `db:schema:cache:dump`.
 *
 * The dump exists to remove a boot cost: without it every model asks the
 * database for its own columns, which is a round trip per model before the
 * process can serve anything. The rule that matters is that it changes nothing
 * until somebody loads one.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Connection, setConnection } from "../src/connection.js";
import { isSqlite, testConnection } from "./support/database.js";
import { SchemaStatements } from "../src/schema.js";
import { Model } from "../src/model.js";
import {
  SchemaCache,
  SchemaReflection,
  resetSchemaReflection,
  schemaReflection,
  setSchemaReflection,
} from "../src/schema_cache.js";

interface WidgetRow {
  id: number;
  name: string;
  size: number;
}

class Widget extends Model<WidgetRow>("widgets") {}

let connection: Connection;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  Widget.resetColumnInformation();

  await new SchemaStatements(connection).createTable("widgets", (t) => {
    t.string("name");
    t.integer("size");
  });
});

afterEach(() => {
  resetSchemaReflection();
});

describe("the reflection this process reads from", () => {
  it("starts empty", () => {
    expect(schemaReflection().schemaLoaded).toBe(false);
  });

  it("is whatever was installed", () => {
    const reflection = new SchemaReflection();

    setSchemaReflection(reflection);

    expect(schemaReflection()).toBe(reflection);
  });

  it("goes back to empty on a reset", () => {
    setSchemaReflection(new SchemaReflection(loadedCache()));
    resetSchemaReflection();

    expect(schemaReflection().schemaLoaded).toBe(false);
  });
});

/** A cache holding a dump, so `schemaLoaded` is true without touching a file. */
function loadedCache(): SchemaCache {
  return SchemaCache.fromDump({
    version: null,
    columns: { widgets: [] },
    indexes: { widgets: [] },
    dataSources: ["widgets"],
  });
}

describe("a model with no dump loaded", () => {
  /**
   * The whole design: a schema cache that changed behaviour by existing would
   * be one nobody could add to a running application without a deploy to think
   * about.
   */
  it("asks the database, exactly as before", async () => {
    expect(await Widget.columnNames()).toEqual(expect.arrayContaining(["name", "size"]));
  });

  it("reads the types too", async () => {
    expect((await Widget.columnTypes())["size"]).toBe("integer");
  });

  /**
   * And does not fill a shared cache nobody asked for. A model's own cache is
   * per class and a test can clear it; a process-wide one it never opted into
   * would keep answering after that.
   */
  it("leaves the empty cache empty", async () => {
    await Widget.columnNames();

    expect(schemaReflection().schemaCache.cached("widgets")).toBe(false);
  });
});

describe("a model with a dump loaded", () => {
  /** A dump that disagrees with the table, so using it is observable. */
  function dumpSaying(columns: { name: string; type: string }[]): SchemaCache {
    return SchemaCache.fromDump({
      version: null,
      columns: {
        widgets: columns.map((column) => ({
          ...column,
          nullable: true,
          default: null,
          primaryKey: false,
        })),
      },
      indexes: { widgets: [] },
      dataSources: ["widgets"],
    });
  }

  it("takes its columns from the cache rather than the table", async () => {
    setSchemaReflection(new SchemaReflection(dumpSaying([{ name: "name", type: "varchar" }])));

    expect(await Widget.columnNames()).toEqual(["name"]);
  });

  /** The dump holds the database's own type name, which still has to be mapped. */
  it("maps the type the dump recorded", async () => {
    setSchemaReflection(new SchemaReflection(dumpSaying([{ name: "name", type: "varchar" }])));

    expect((await Widget.columnTypes())["name"]).toBe("string");
  });

  it("keeps what it read, so the second ask costs nothing", async () => {
    setSchemaReflection(new SchemaReflection(dumpSaying([{ name: "name", type: "varchar" }])));

    await Widget.columnTypes();

    expect(Widget.columnTypeCache).toEqual({ name: "string" });
  });

  it("agrees with the table when the dump was taken from it", async () => {
    const cache = new SchemaCache();

    await cache.addAll(connection);
    setSchemaReflection(new SchemaReflection(cache));

    expect(await Widget.columnNames()).toEqual(expect.arrayContaining(["name", "size"]));
    expect((await Widget.columnTypes())["size"]).toBe("integer");
  });

  /**
   * A table added since the dump was written still has to work. The cache
   * reads through for one it does not hold, which is what makes a stale dump a
   * slow boot rather than a broken one.
   */
  it("reads through for a table the dump does not hold", async () => {
    setSchemaReflection(new SchemaReflection(loadedCache()));

    await new SchemaStatements(connection).createTable("gadgets", (t) => {
      t.string("label");
    });

    class Gadget extends Model<{ id: number; label: string }>("gadgets") {}

    expect(await Gadget.columnNames()).toEqual(expect.arrayContaining(["label"]));
  });
});

describe("a generated column", () => {
  /**
   * SQLite's `PRAGMA table_info` omits generated columns. The model read them
   * that way and so could not see one — every read would leave it out, and
   * every write would think it could set it. `introspect.ts` was fixed for the
   * schema dump; this is the model's own reader, which had the same hole.
   */
  it.skipIf(!isSqlite)("is a column the model knows about", async () => {
    const schema = new SchemaStatements(connection);

    await schema.dropTable("people", { ifExists: true });
    await schema.createTable("people", (t) => {
      t.string("first_name");
      t.virtual("shouty", { type: "string", as: "upper(first_name)", stored: true });
    });

    class Person extends Model<{ id: number; first_name: string; shouty: string }>("people") {}

    expect(await Person.columnNames()).toContain("shouty");
  });

  it.skipIf(!isSqlite)("does not pick up an fts5 index's internals", async () => {
    await connection.execute(`CREATE VIRTUAL TABLE docs USING fts5(title, body)`);

    class Doc extends Model<{ title: string; body: string }>("docs") {}

    expect(await Doc.columnNames()).toEqual(["title", "body"]);
  });
});
