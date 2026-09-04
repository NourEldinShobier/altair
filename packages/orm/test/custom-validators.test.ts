/**
 * Rules an application writes for itself, ported from
 * `activemodel/test/cases/validations/with_validation_test.rb` and
 * `validates_each_test.rb`.
 *
 * The declared rules cover what every application needs. These cover what one
 * application needs — a VAT number, a booking that cannot overlap another, a
 * password refused because it appears in a breach list — and they are classes
 * rather than callbacks because the same rule on six models should be written
 * once. A callback copied six times is one that gets fixed five times.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Model, SchemaStatements, setConnection } from "../src/index.js";
import type { Connection } from "../src/connection.js";
import { generateMessage, type ValidationTarget } from "../src/validations.js";
import { isSqlite, testConnection } from "./support/database.js";

interface PostRow {
  id: number;
  title: string;
  body: string;
  status: string;
}

class Post extends Model<PostRow>("posts") {}

let connection: Connection;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  Post.resetColumnInformation();
  Post.validations = [];
  Post.customValidations = [];

  await new SchemaStatements(connection).createTable("posts", (t) => {
    t.string("title");
    t.string("body");
    t.string("status");
  });
});

afterEach(async () => {
  Post.validations = [];
  Post.customValidations = [];

  if (isSqlite) await connection.close();
});

function build(values: Partial<PostRow> = {}): Post {
  return Post.build({ title: "t", body: "b", status: "draft", ...values });
}

describe("validatesWith", () => {
  it("runs a rule the application wrote", async () => {
    Post.validatesWith({
      validate: (record) => {
        record.errors.add("title", "is never right");
      },
    });

    const post = build();

    expect(await post.validate()).toBe(false);
    expect(post.errors.fullMessages()).toContain("Title is never right");
  });

  it("leaves a record alone when the rule is happy", async () => {
    Post.validatesWith({ validate: () => undefined });

    expect(await build().validate()).toBe(true);
  });

  it("sees the whole record, which is the point of a record-level rule", async () => {
    Post.validatesWith({
      validate: (record) => {
        const post = record as unknown as PostRow;

        if (post.status === "published" && post.body === "") {
          record.errors.add("body", "cannot be empty once published");
        }
      },
    });

    expect(await build({ status: "published", body: "" }).validate()).toBe(false);
    expect(await build({ status: "draft", body: "" }).validate()).toBe(true);
  });

  it("waits for an async rule", async () => {
    Post.validatesWith({
      validate: async (record) => {
        await Promise.resolve();
        record.errors.add("title", "checked elsewhere");
      },
    });

    expect(await build().validate()).toBe(false);
  });

  it("runs several in the order declared", async () => {
    const order: string[] = [];

    Post.validatesWith({ validate: () => void order.push("first") });
    Post.validatesWith({ validate: () => void order.push("second") });

    await build().validate();

    expect(order).toEqual(["first", "second"]);
  });

  /**
   * A model whose only rule is a validator object has no attribute
   * declarations, and an early return on those would skip the single thing it
   * declared.
   */
  it("runs on a model with no declared attribute rules", async () => {
    Post.validatesWith({
      validate: (record) => {
        record.errors.add("base", "nope");
      },
    });

    expect(Post.validations).toHaveLength(0);
    expect(await build().validate()).toBe(false);
  });

  it("runs alongside declared rules", async () => {
    Post.validates("title", { presence: true });
    Post.validatesWith({
      validate: (record) => {
        record.errors.add("body", "also wrong");
      },
    });

    const post = build({ title: "" });

    expect(await post.validate()).toBe(false);
    expect(post.errors.count).toBe(2);
  });

  /** A custom rule must not be the one that runs where nothing else does. */
  it("honours on:", async () => {
    Post.validatesWith(
      {
        validate: (record) => {
          record.errors.add("title", "only on update");
        },
      },
      { on: "update" },
    );

    expect(await build().validate()).toBe(true);
  });

  it("honours if:", async () => {
    Post.validatesWith(
      {
        validate: (record) => {
          record.errors.add("title", "conditional");
        },
      },
      { if: (record: ValidationTarget) => record.status === "published" },
    );

    expect(await build({ status: "draft" }).validate()).toBe(true);
    expect(await build({ status: "published" }).validate()).toBe(false);
  });

  /**
   * Checked when declared rather than when it runs, so a rule configured
   * wrongly says so on the first request rather than the first time a record
   * happens to reach it — months, for a rare branch.
   */
  it("refuses a validator that says it is misconfigured", () => {
    expect(() => {
      Post.validatesWith({
        validate: () => undefined,
        checkValidity: () => {
          throw new Error("needs a column");
        },
      });
    }).toThrow("needs a column");
  });

  it("does not register one it refused", () => {
    try {
      Post.validatesWith({
        validate: () => undefined,
        checkValidity: () => {
          throw new Error("needs a column");
        },
      });
    } catch {
      // expected
    }

    expect(Post.customValidations).toHaveLength(0);
  });
});

describe("validatesEach", () => {
  it("runs the rule for each attribute named", async () => {
    const seen: string[] = [];

    Post.validatesEach(["title", "body"], (_record, attribute) => {
      seen.push(attribute);
    });

    await build().validate();

    expect(seen).toEqual(["title", "body"]);
  });

  it("is given each attribute's value", async () => {
    const seen: unknown[] = [];

    Post.validatesEach(["title", "body"], (_record, _attribute, value) => {
      seen.push(value);
    });

    await build({ title: "a", body: "c" }).validate();

    expect(seen).toEqual(["a", "c"]);
  });

  it("adds errors against the attribute it was checking", async () => {
    Post.validatesEach(["title", "body"], (record, attribute, value) => {
      if (typeof value === "string" && value.includes("\t")) {
        record.errors.add(attribute, "cannot contain tabs");
      }
    });

    const post = build({ title: "a\tb", body: "fine" });

    expect(await post.validate()).toBe(false);
    expect(post.errors.messagesFor("title")).toEqual(["cannot contain tabs"]);
    expect(post.errors.messagesFor("body")).toEqual([]);
  });

  it("takes a single attribute name", async () => {
    const seen: string[] = [];

    Post.validatesEach("title", (_record, attribute) => {
      seen.push(attribute);
    });

    await build().validate();

    expect(seen).toEqual(["title"]);
  });

  /**
   * Applying a bespoke check to every column is never what somebody meant, and
   * would run it against created_at.
   */
  it("refuses to be declared with no attributes", () => {
    expect(() => {
      Post.validatesEach([], () => undefined);
    }).toThrow("at least one attribute");
  });

  it("honours if:", async () => {
    Post.validatesEach(
      ["title"],
      (record, attribute) => {
        record.errors.add(attribute, "conditional");
      },
      { if: (record: ValidationTarget) => record.status === "published" },
    );

    expect(await build({ status: "draft" }).validate()).toBe(true);
    expect(await build({ status: "published" }).validate()).toBe(false);
  });

  it("waits for an async body", async () => {
    Post.validatesEach(["title"], async (record, attribute) => {
      await Promise.resolve();
      record.errors.add(attribute, "checked elsewhere");
    });

    expect(await build().validate()).toBe(false);
  });
});

describe("subclasses", () => {
  /** Copy on write, or a rule on a subclass would appear on its parent. */
  it("do not add rules to their parent", async () => {
    class Draft extends Post {}

    Draft.validatesWith({
      validate: (record) => {
        record.errors.add("title", "drafts only");
      },
    });

    expect(Post.customValidations).toHaveLength(0);
    expect(Draft.customValidations).toHaveLength(1);
  });
});

describe("generateMessage", () => {
  /**
   * A custom validator writing its own English string is one that stays
   * English in a translated application, and nothing about it looks wrong
   * until somebody reads the French.
   */
  it("gives the message for a known kind", () => {
    expect(generateMessage("blank")).toBe("can't be blank");
  });

  it("prefers a message the declaration gave", () => {
    expect(generateMessage("blank", { message: "is required" })).toBe("is required");
  });

  it("falls back for a kind it does not know", () => {
    expect(generateMessage("something_bespoke")).toBe("is invalid");
  });
});
