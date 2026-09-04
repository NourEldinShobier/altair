/**
 * Transactions inside transactions.
 *
 * Mirrors activerecord/test/cases/transactions_test.rb's nested cases, and
 * departs from them on purpose.
 *
 * Rails *flattens* a nested block by default: the inner one joins the outer,
 * `requires_new: true` is what asks for a savepoint, and the famous
 * consequence is that `raise ActiveRecord::Rollback` inside a nested block
 * does nothing at all. Here every nesting is a savepoint, so there is nothing
 * to opt into.
 *
 * None of this was tested before, and the comment in the source claimed the
 * behaviour matched Rails, which it does not. The claim is what sent me
 * looking; the behaviour turned out to be the better of the two.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Model, SchemaStatements, setConnection } from "../src/index.js";
import type { Connection } from "../src/connection.js";
import { testConnection } from "./support/database.js";

interface NoteRow {
  id: number;
  body: string;
}

class Note extends Model<NoteRow>("notes") {}

let connection: Connection;

const bodies = async (): Promise<string[]> =>
  (await Note.all().order("id")).map((note) => String(note.body));

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);
  Note.resetColumnInformation();

  const schema = new SchemaStatements(connection);
  await schema.dropTable("notes", { ifExists: true });
  await schema.createTable("notes", (t) => t.string("body"));
});

describe("a transaction on its own", () => {
  it("commits what it did", async () => {
    await Note.transaction(async () => {
      await Note.create({ body: "kept" });
    });

    expect(await bodies()).toEqual(["kept"]);
  });

  it("undoes everything when it throws", async () => {
    await Note.transaction(async () => {
      await Note.create({ body: "gone" });
      throw new Error("no");
    }).catch(() => undefined);

    expect(await bodies()).toEqual([]);
  });
});

describe("an inner block that fails", () => {
  // The whole point of a savepoint: a model method that opens a transaction
  // can be called from inside another one, and its failure is its own.
  it("undoes only its own work", async () => {
    await Note.transaction(async () => {
      await Note.create({ body: "outer" });

      await Note.transaction(async () => {
        await Note.create({ body: "inner" });
        throw new Error("inner failed");
      }).catch(() => undefined);

      await Note.create({ body: "after" });
    });

    expect(await bodies()).toEqual(["outer", "after"]);
  });

  it("leaves the outer transaction able to carry on", async () => {
    await Note.transaction(async () => {
      await Note.transaction(async () => {
        throw new Error("inner failed");
      }).catch(() => undefined);

      await Note.create({ body: "still working" });
    });

    expect(await bodies()).toEqual(["still working"]);
  });

  // Which is what Rails does not do, and is the reason for the divergence.
  it("does not take the outer transaction down with it", async () => {
    await Note.transaction(async () => {
      await Note.create({ body: "survives" });

      await Note.transaction(async () => {
        throw new Error("inner failed");
      }).catch(() => undefined);
    });

    expect(await bodies()).toEqual(["survives"]);
  });
});

describe("an outer block that fails", () => {
  it("undoes the inner work as well", async () => {
    await Note.transaction(async () => {
      await Note.create({ body: "a" });

      await Note.transaction(async () => {
        await Note.create({ body: "b" });
      });

      throw new Error("outer failed");
    }).catch(() => undefined);

    expect(await bodies()).toEqual([]);
  });

  it("undoes it even though the inner block succeeded", async () => {
    let innerFinished = false;

    await Note.transaction(async () => {
      await Note.transaction(async () => {
        await Note.create({ body: "committed to the savepoint" });
        innerFinished = true;
      });

      throw new Error("outer failed");
    }).catch(() => undefined);

    expect(innerFinished).toBe(true);
    expect(await bodies()).toEqual([]);
  });
});

describe("three deep", () => {
  it("unwinds only as far as the block that failed", async () => {
    await Note.transaction(async () => {
      await Note.create({ body: "1" });

      await Note.transaction(async () => {
        await Note.create({ body: "2" });

        await Note.transaction(async () => {
          await Note.create({ body: "3" });
          throw new Error("deepest failed");
        }).catch(() => undefined);
      });
    });

    expect(await bodies()).toEqual(["1", "2"]);
  });

  it("names each savepoint separately, so releasing one does not release another", async () => {
    await Note.transaction(async () => {
      await Note.transaction(async () => {
        await Note.create({ body: "a" });
      });

      await Note.transaction(async () => {
        await Note.create({ body: "b" });
        throw new Error("second failed");
      }).catch(() => undefined);
    });

    expect(await bodies()).toEqual(["a"]);
  });
});

describe("the error itself", () => {
  it("reaches the caller rather than being swallowed", () => {
    expect(
      Note.transaction(async () => {
        await Note.transaction(async () => {
          throw new Error("the reason");
        });
      }),
    ).rejects.toThrow("the reason");
  });
});
