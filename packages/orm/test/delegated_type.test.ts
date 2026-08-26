/**
 * Delegated types, ported from `activerecord/test/cases/delegated_type_test.rb`.
 *
 * A polymorphic `belongsTo` says "this points at one of several things" and
 * leaves the caller to ask which. A delegated type adds the three questions
 * everybody writes by hand afterwards: which one is it, give me it if it is
 * that one, and give me every record that is.
 *
 * The trade is that the set of types is closed and written down. That is what
 * makes the predicates and the scopes possible.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Connection, Model, Relation, SchemaStatements, setConnection } from "../src/index.js";

interface MessageRow {
  id: number;
  subject: string;
}

interface CommentRow {
  id: number;
  body: string;
}

interface EntryRow {
  id: number;
  entryable_type: string;
  entryable_id: number;
}

class Message extends Model<MessageRow>("messages") {}
class Comment extends Model<CommentRow>("comments") {}

class Entry extends Model<EntryRow>("entries") {
  // Defined at run time, so the compiler is told about them the same way it is
  // told about an association accessor.
  declare entryable: () => Promise<Message | Comment | null>;
  declare message: () => Promise<Message | null>;
  declare comment: () => Promise<Comment | null>;
  declare isMessage: boolean;
  declare isComment: boolean;
  declare entryableName: string | null;

  declare static messages: () => Relation<Entry>;
  declare static comments: () => Relation<Entry>;

  static {
    this.delegatedType("entryable", { Message: () => Message, Comment: () => Comment });
  }
}

let connection: Connection;

beforeEach(async () => {
  connection = new Connection("sqlite://:memory:");
  setConnection(connection);

  for (const model of [Message, Comment, Entry]) {
    model.columnCache = undefined;
    model.columnTypeCache = undefined;
  }

  const schema = new SchemaStatements(connection);

  await schema.createTable("messages", (t) => t.string("subject"));
  await schema.createTable("comments", (t) => t.string("body"));
  await schema.createTable("entries", (t) => {
    t.string("entryable_type");
    t.integer("entryable_id");
  });
});

afterEach(async () => {
  await connection.close();
});

/** An entry over a message, and an entry over a comment. */
const both = async () => {
  const message = await Message.create({ subject: "Hello" });
  const comment = await Comment.create({ body: "Nice" });

  return {
    message,
    comment,
    messageEntry: await Entry.create({ entryable_type: "Message", entryable_id: message.id }),
    commentEntry: await Entry.create({ entryable_type: "Comment", entryable_id: comment.id }),
  };
};

describe("asking which one it is", () => {
  it("answers for the type it is", async () => {
    const { messageEntry } = await both();

    expect(messageEntry.isMessage).toBe(true);
    expect(messageEntry.isComment).toBe(false);
  });

  it("answers for the other one too", async () => {
    const { commentEntry } = await both();

    expect(commentEntry.isComment).toBe(true);
    expect(commentEntry.isMessage).toBe(false);
  });

  // Reading a column this record already has, so it should not look like a
  // query — which is why it is a getter and the accessors are not.
  it("names the type without being asked twice", async () => {
    const { messageEntry, commentEntry } = await both();

    expect(messageEntry.entryableName).toBe("Message");
    expect(commentEntry.entryableName).toBe("Comment");
  });
});

describe("reaching the record", () => {
  it("hands back the one it points at", async () => {
    const { message, messageEntry } = await both();

    expect((await messageEntry.message())?.id).toBe(message.id);
    expect((await messageEntry.message())?.subject).toBe("Hello");
  });

  /**
   * Null rather than throwing: asking a comment for its message is how a
   * caller finds out it is a comment, and a branch that has to be wrapped in
   * a try is a branch nobody writes.
   */
  it("answers null when it points at something else", async () => {
    const { commentEntry } = await both();

    expect(await commentEntry.message()).toBeNull();
    expect((await commentEntry.comment())?.body).toBe("Nice");
  });

  // The polymorphic association underneath still works, and is what a caller
  // uses when it does not care which type it got.
  it("still answers the association itself", async () => {
    const { messageEntry, commentEntry } = await both();

    expect(((await messageEntry.entryable()) as Message).subject).toBe("Hello");
    expect(((await commentEntry.entryable()) as Comment).body).toBe("Nice");
  });
});

describe("the scopes", () => {
  it("finds every record of one type", async () => {
    const { messageEntry } = await both();

    const messages = await Entry.messages();

    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe(messageEntry.id);
  });

  it("finds the other type separately", async () => {
    await both();

    expect(await Entry.comments()).toHaveLength(1);
  });

  // A relation rather than an array, so it composes with everything else.
  it("stays chainable", async () => {
    const { message } = await both();
    await Entry.create({ entryable_type: "Message", entryable_id: message.id });

    expect(await Entry.messages().count()).toBe(2);
    expect(await Entry.messages().where({ entryable_id: message.id }).count()).toBe(2);
    expect(await Entry.comments().count()).toBe(1);
  });
});

describe("the class behind a name", () => {
  it("resolves without the caller reaching into the types", () => {
    expect(Entry.delegatedClassFor("entryable", "Message")).toBe(Message);
    expect(Entry.delegatedClassFor("entryable", "Comment")).toBe(Comment);
  });

  it("is undefined for a type nobody declared", () => {
    expect(Entry.delegatedClassFor("entryable", "Invoice")).toBeUndefined();
  });
});

/**
 * A delegated type is declared on one model, and declaring it must not reach
 * the others — the same rule the callback chains and the associations follow.
 */
describe("another model", () => {
  it("does not gain the predicates", () => {
    expect("isMessage" in Message.prototype).toBe(false);
    expect("messages" in Comment).toBe(false);
  });
});
