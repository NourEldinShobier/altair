/**
 * Joins, dependent destruction, and secure passwords.
 *
 * Mirrors activerecord/test/cases/associations/join_dependency_test.rb,
 * dependent_test.rb, and activemodel/test/cases/secure_password_test.rb. Each
 * of the three is a thing an application reaches for on its first day.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Connection, setConnection } from "../src/connection.js";
import { testConnection } from "./support/database.js";
import { SchemaStatements } from "../src/schema.js";
import { DeleteRestricted, Model, type BelongsTo, type HasMany } from "../src/model.js";
import {
  hashPassword,
  hasSecurePassword,
  MINIMUM_PASSWORD_LENGTH,
  verifyPassword,
} from "../src/secure_password.js";

interface AuthorRow {
  id: number;
  name: string;
}
interface PostRow {
  id: number;
  title: string;
  author_id: number | null;
  published: number;
}
interface CommentRow {
  id: number;
  body: string;
  post_id: number | null;
  approved: number;
}

class Author extends Model<AuthorRow>("authors") {
  declare posts: HasMany<Post>;
}
class Post extends Model<PostRow>("posts") {
  declare author: BelongsTo<Author>;
  declare comments: HasMany<Comment>;
}
class Comment extends Model<CommentRow>("comments") {
  declare post: BelongsTo<Post>;
}

Author.hasMany("posts", () => Post);
Post.belongsTo("author", () => Author, { optional: true });
Post.hasMany("comments", () => Comment);
Comment.belongsTo("post", () => Post, { optional: true });

let connection: Connection;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);
  for (const model of [Author, Post, Comment]) {
    model.resetColumnInformation();
  }

  const schema = new SchemaStatements(connection);
  await schema.createTable("authors", (t) => t.string("name"));
  await schema.createTable("posts", (t) => {
    t.string("title");
    t.references("author");
    t.integer("published", { default: 0 });
  });
  await schema.createTable("comments", (t) => {
    t.text("body");
    t.references("post");
    t.integer("approved", { default: 0 });
  });
});

/** A model pinned to SQLite, for assertions about the SQL text itself. */
function sqliteArticles() {
  class Article extends Model<PostRow>("posts", {
    connection: new Connection("sqlite://:memory:"),
  }) {
    declare author: BelongsTo<Author>;
    declare comments: HasMany<Comment>;

    static {
      this.belongsTo("author", () => Author, { optional: true });
      this.hasMany("comments", () => Comment, { foreignKey: "post_id" });
    }
  }

  return Article;
}

describe("joining", () => {
  beforeEach(async () => {
    const ada = await Author.create({ name: "Ada" });
    const alan = await Author.create({ name: "Alan" });

    const discussed = await Post.create({ title: "Discussed", author_id: ada.id });
    await Post.create({ title: "Quiet", author_id: alan.id });

    await Comment.create({ body: "first", post_id: discussed.id, approved: 1 });
    await Comment.create({ body: "second", post_id: discussed.id, approved: 0 });
  });

  // An inner join is what makes this mean "posts that have comments".
  it("drops records with none of the association", async () => {
    const posts = await Post.all().joins("comments").distinct();

    expect(posts.map((post) => post.title)).toEqual(["Discussed"]);
  });

  it("keeps them on a left join", async () => {
    const posts = await Post.all().leftJoins("comments").distinct().order("title");

    expect(posts.map((post) => post.title)).toEqual(["Discussed", "Quiet"]);
  });

  it("joins the other way, through a belongsTo", async () => {
    const posts = await Post.all().joins("author").where({ "authors.name": "Ada" });

    expect(posts.map((post) => post.title)).toEqual(["Discussed"]);
  });

  it("filters on the joined table", async () => {
    const posts = await Post.all().joins("comments").where({ "comments.approved": 1 });

    expect(posts).toHaveLength(1);
  });

  // The generated text is quoted differently per adapter, so it is asserted
  // against one rather than whichever the suite happens to be running against.
  it("writes the join into the SQL", () => {
    const { sql } = sqliteArticles().all().joins("comments").toSql();

    expect(sql).toContain('INNER JOIN "comments" ON "posts"."id" = "comments"."post_id"');
  });

  it("writes a left join as one", () => {
    expect(Post.all().leftJoins("comments").toSql().sql).toContain("LEFT OUTER JOIN");
  });

  // Joining the same table twice is a cross product, and nobody means that.
  it("joins a table once however many times it is asked", () => {
    const { sql } = Post.all().joins("comments").joins("comments").toSql();

    expect(sql.match(/INNER JOIN/g)).toHaveLength(1);
  });

  it("joins more than one association", () => {
    const { sql } = sqliteArticles().all().joins("author", "comments").toSql();

    expect(sql).toContain('INNER JOIN "authors"');
    expect(sql).toContain('INNER JOIN "comments"');
  });

  // A condition naming a table the query does not join would be silently
  // wrong, or a syntax error a long way from the mistake.
  it("refuses a condition on a table it did not join", () => {
    expect(() => Post.all().where({ "comments.approved": 1 }).toSql()).toThrow(
      'does not join "comments"',
    );
  });

  it("still counts through a join", async () => {
    expect(await Post.all().joins("comments").where({ "comments.approved": 1 }).count()).toBe(1);
  });

  it("says when an association cannot be joined", () => {
    expect(() => Post.joinFor("nothing")).toThrow();
  });
});

// Without this, destroying a post leaves comments pointing at a row that is
// gone — rows nothing will read and nothing will delete.
describe("dependent children", () => {
  it("are left alone by default", async () => {
    const post = await Post.create({ title: "Hello" });
    await Comment.create({ body: "orphan", post_id: post.id });

    await post.destroy();

    expect(await Comment.count()).toBe(1);
  });

  it("are destroyed when told to", async () => {
    class Article extends Model<PostRow>("posts") {
      declare comments: HasMany<Comment>;
      static {
        this.hasMany("comments", () => Comment, { foreignKey: "post_id", dependent: "destroy" });
      }
    }

    const article = await Article.create({ title: "Hello" });
    await Comment.create({ body: "one", post_id: article.id });
    await Comment.create({ body: "two", post_id: article.id });

    await article.destroy();

    expect(await Comment.count()).toBe(0);
  });

  // Destroying each one is what runs its callbacks and its own dependents; a
  // bulk delete would skip both.
  it("run their own callbacks when destroyed", async () => {
    const seen: string[] = [];

    class Remark extends Model<CommentRow>("comments") {
      static {
        this.setCallback("destroy", "before", function (this: Remark) {
          seen.push(String((this as unknown as CommentRow).body));
        });
      }
    }

    class Article extends Model<PostRow>("posts") {
      declare remarks: HasMany<Remark>;
      static {
        this.hasMany("remarks", () => Remark, { foreignKey: "post_id", dependent: "destroy" });
      }
    }

    const article = await Article.create({ title: "Hello" });
    await Remark.create({ body: "one", post_id: article.id });

    await article.destroy();
    expect(seen).toEqual(["one"]);
  });

  it("are nullified when told to", async () => {
    class Article extends Model<PostRow>("posts") {
      declare comments: HasMany<Comment>;
      static {
        this.hasMany("comments", () => Comment, { foreignKey: "post_id", dependent: "nullify" });
      }
    }

    const article = await Article.create({ title: "Hello" });
    await Comment.create({ body: "kept", post_id: article.id });

    await article.destroy();

    expect(await Comment.count()).toBe(1);
    expect((await Comment.all())[0]!.post_id).toBeNull();
  });

  // Failing loudly beats quietly removing records someone still needs.
  it("refuse the delete when told to restrict", async () => {
    class Article extends Model<PostRow>("posts") {
      declare comments: HasMany<Comment>;
      static {
        this.hasMany("comments", () => Comment, { foreignKey: "post_id", dependent: "restrict" });
      }
    }

    const article = await Article.create({ title: "Hello" });
    await Comment.create({ body: "still here", post_id: article.id });

    await expect(article.destroy()).rejects.toThrow(DeleteRestricted);
    expect(await Article.count()).toBe(1);
  });

  it("allow the delete when there are none", async () => {
    class Article extends Model<PostRow>("posts") {
      declare comments: HasMany<Comment>;
      static {
        this.hasMany("comments", () => Comment, { foreignKey: "post_id", dependent: "restrict" });
      }
    }

    const article = await Article.create({ title: "Hello" });
    expect(await article.destroy()).toBe(true);
  });
});

describe("password hashing", () => {
  // Argon2id is memory-hard, which is what costs an attacker with a warehouse
  // of graphics cards far more than it costs a login form.
  it("uses argon2id by default", async () => {
    expect(await hashPassword("correct horse")).toStartWith("$argon2id$");
  });

  it("hashes bcrypt when asked, for an existing corpus", async () => {
    expect(await hashPassword("correct horse", "bcrypt")).toStartWith("$2");
  });

  it("gives the same password a different hash each time", async () => {
    expect(await hashPassword("same")).not.toBe(await hashPassword("same"));
  });

  it("verifies", async () => {
    const digest = await hashPassword("correct horse");

    expect(await verifyPassword("correct horse", digest)).toBe(true);
    expect(await verifyPassword("wrong horse", digest)).toBe(false);
  });

  it("reads the algorithm from the digest, so a half-migrated corpus works", async () => {
    expect(await verifyPassword("x", await hashPassword("x", "bcrypt"))).toBe(true);
  });

  // A row with a corrupt digest should fail to authenticate, not fail the
  // request.
  it("refuses a digest it cannot read rather than throwing", async () => {
    expect(await verifyPassword("x", "not a digest")).toBe(false);
    expect(await verifyPassword("x", "")).toBe(false);
  });
});

describe("a model with a secure password", () => {
  interface UserRow {
    id: number;
    email: string;
    password_digest: string;
  }

  class User extends Model<UserRow>("users") {
    declare password: string;
    declare passwordConfirmation: string | undefined;
    declare authenticate: (password: string) => Promise<User | null>;

    static {
      hasSecurePassword(this);
    }
  }

  beforeEach(async () => {
    User.resetColumnInformation();

    await new SchemaStatements(connection).createTable("users", (t) => {
      t.string("email");
      t.string("password_digest");
    });
  });

  it("stores a digest rather than the password", async () => {
    await User.create({ email: "a@b.com", password: "correct horse" } as never);

    const rows = await connection.query<{ password_digest: string }>(
      "SELECT password_digest FROM users",
    );

    expect(rows[0]!.password_digest).toStartWith("$argon2id$");
    expect(JSON.stringify(rows[0])).not.toContain("correct horse");
  });

  // The plain password must never reach the column list, or it would be
  // written to the table beside its own hash.
  it("never writes the password as a column", async () => {
    const user = await User.create({ email: "a@b.com", password: "correct horse" } as never);
    expect(Object.keys(user.attributes())).not.toContain("password");
  });

  it("authenticates", async () => {
    const user = await User.create({ email: "a@b.com", password: "correct horse" } as never);

    expect(await user.authenticate("correct horse")).toBe(user);
    expect(await user.authenticate("wrong")).toBeNull();
  });

  it("authenticates a record loaded from the database", async () => {
    await User.create({ email: "a@b.com", password: "correct horse" } as never);
    const loaded = await User.find(1);

    expect(await loaded.authenticate("correct horse")).toBe(loaded);
  });

  it("requires one", async () => {
    const user = User.build({ email: "a@b.com" });

    expect(await user.save()).toBe(false);
    expect(user.errors.on("password")).toContain("can't be blank");
  });

  it("requires it to be long enough", async () => {
    const user = User.build({ email: "a@b.com", password: "short" } as never);

    expect(await user.save()).toBe(false);
    expect(user.errors.on("password")[0]).toContain(String(MINIMUM_PASSWORD_LENGTH));
  });

  // `assign` used to write past the prototype setter, so the plain password
  // would have been written as its own column beside its hash — the same bug
  // the constructor was fixed for, still open on this path.
  it("hashes a password given to update", async () => {
    const user = await User.create({ email: "a@b.com", password: "correct horse" } as never);
    await user.update({ password: "a different one" } as never);

    const reloaded = await User.find(user.id);
    expect(reloaded.attributes()).not.toHaveProperty("password");
    expect(await reloaded.authenticate("a different one")).not.toBeNull();
  });

  it("checks a confirmation when one is given", async () => {
    const user = User.build({ email: "a@b.com", password: "correct horse" } as never);
    user.passwordConfirmation = "different horse";

    expect(await user.save()).toBe(false);
    expect(user.errors.on("passwordConfirmation")).toContain("doesn't match Password");
  });

  it("accepts a matching confirmation", async () => {
    const user = User.build({ email: "a@b.com", password: "correct horse" } as never);
    user.passwordConfirmation = "correct horse";

    expect(await user.save()).toBe(true);
  });

  // A record loaded and saved again should not have to be given its password
  // back.
  it("lets a saved record be saved again without one", async () => {
    const user = await User.create({ email: "a@b.com", password: "correct horse" } as never);

    const loaded = await User.find(user.id);
    expect(await loaded.update({ email: "c@d.com" })).toBe(true);
    expect(await loaded.authenticate("correct horse")).toBe(loaded);
  });

  it("changes the password when a new one is set", async () => {
    const user = await User.create({ email: "a@b.com", password: "correct horse" } as never);

    user.password = "a different horse";
    await user.save();

    expect(await user.authenticate("a different horse")).toBe(user);
    expect(await user.authenticate("correct horse")).toBeNull();
  });
});
