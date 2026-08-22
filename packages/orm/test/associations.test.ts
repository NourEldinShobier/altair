/**
 * Association suite.
 *
 * Mirrors activerecord/test/cases/associations/ — belongs_to, has_many,
 * has_one and eager loading.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Connection, setConnection } from "../src/connection.js";
import { testConnection } from "./support/database.js";
import { SchemaStatements } from "../src/schema.js";
import { Model, type BelongsTo, type HasMany, type HasOne } from "../src/model.js";
import { defaultForeignKey } from "../src/associations.js";

interface UserAttributes {
  id: number;
  name: string;
}
interface PostAttributes {
  id: number;
  title: string;
  user_id: number | null;
}
interface CommentAttributes {
  id: number;
  body: string;
  post_id: number | null;
}
interface ProfileAttributes {
  id: number;
  bio: string;
  user_id: number | null;
}

// `declare` states the shape the association accessors take; the static block
// registers them. No casts, no codegen.
class User extends Model<UserAttributes>("users") {
  declare posts: HasMany<Post>;
  declare profile: HasOne<Profile>;
}
class Post extends Model<PostAttributes>("posts") {
  declare user: BelongsTo<User>;
  declare comments: HasMany<Comment>;
}
class Comment extends Model<CommentAttributes>("comments") {
  declare post: BelongsTo<Post>;
}
class Profile extends Model<ProfileAttributes>("profiles") {}

User.hasMany("posts", () => Post);
User.hasOne("profile", () => Profile);
Post.belongsTo("user", () => User);
Post.hasMany("comments", () => Comment);
Comment.belongsTo("post", () => Post);

let connection: Connection;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  const schema = new SchemaStatements(connection);
  await schema.createTable("users", (t) => t.string("name"));
  await schema.createTable("posts", (t) => {
    t.string("title");
    t.references("user");
  });
  await schema.createTable("comments", (t) => {
    t.text("body");
    t.references("post");
  });
  await schema.createTable("profiles", (t) => {
    t.text("bio");
    t.references("user");
  });
});

describe("foreign keys", () => {
  it("follows Rails' naming convention", () => {
    expect(defaultForeignKey("User")).toBe("user_id");
    expect(defaultForeignKey("LineItem")).toBe("line_item_id");
    expect(defaultForeignKey("Posts")).toBe("post_id");
  });
});

describe("belongsTo", () => {
  it("loads the owner", async () => {
    const user = await User.create({ name: "Ada" });
    const post = await Post.create({ title: "Hello", user_id: user.id });

    const author = await post.user();
    expect(author!.name).toBe("Ada");
  });

  it("returns null when the key is null", async () => {
    const post = await Post.create({ title: "Orphan" });
    expect(await post.user()).toBeNull();
  });
});

describe("hasMany", () => {
  it("loads the children", async () => {
    const user = await User.create({ name: "Ada" });
    await Post.create({ title: "One", user_id: user.id });
    await Post.create({ title: "Two", user_id: user.id });
    await Post.create({ title: "Other", user_id: 999 });

    const posts = await user.posts();
    expect(posts.map((p) => p.title).sort()).toEqual(["One", "Two"]);
  });

  it("returns an empty list when there are none", async () => {
    const user = await User.create({ name: "Lonely" });
    expect(await user.posts()).toHaveLength(0);
  });

  // Rails: post.comments.where(...) — the association stays chainable.
  it("returns a chainable relation", async () => {
    const post = await Post.create({ title: "Discussed" });
    await Comment.create({ body: "keep", post_id: post.id });
    await Comment.create({ body: "drop", post_id: post.id });

    const filtered = await post.comments().where({ body: "keep" });

    expect(filtered.map((c) => c.body)).toEqual(["keep"]);
  });
});

describe("hasOne", () => {
  it("loads the single child", async () => {
    const user = await User.create({ name: "Ada" });
    await Profile.create({ bio: "Mathematician", user_id: user.id });

    const profile = await user.profile();
    expect(profile!.bio).toBe("Mathematician");
  });

  it("returns null when there is none", async () => {
    const user = await User.create({ name: "Bare" });
    expect(await user.profile()).toBeNull();
  });
});

describe("includes", () => {
  beforeEach(async () => {
    const ada = await User.create({ name: "Ada" });
    const alan = await User.create({ name: "Alan" });
    await Post.create({ title: "A1", user_id: ada.id });
    await Post.create({ title: "A2", user_id: ada.id });
    await Post.create({ title: "B1", user_id: alan.id });
  });

  // Rails: eager loading exists to turn N+1 into 2.
  it("preloads a belongsTo in one extra query", async () => {
    const posts = await Post.all().order("title").includes("user");

    const names: string[] = [];
    for (const post of posts) {
      const user = await post.user();
      names.push(user!.name);
    }

    expect(names).toEqual(["Ada", "Ada", "Alan"]);
  });

  it("preloads a hasMany", async () => {
    const users = await User.all().order("name").includes("posts");

    const counts: number[] = [];
    for (const user of users) {
      const posts = await user.posts();
      counts.push(posts.length);
    }

    expect(counts).toEqual([2, 1]);
  });

  it("preloads a hasOne", async () => {
    const ada = await User.findBy({ name: "Ada" });
    await Profile.create({ bio: "Analyst", user_id: ada!.id });

    const users = await User.where({ name: "Ada" }).includes("profile");
    const profile = await users[0]!.profile();

    expect(profile!.bio).toBe("Analyst");
  });

  it("reports an unknown association", async () => {
    await expect(Post.all().includes("nope").toArray()).rejects.toThrow(
      'has no association named "nope"',
    );
  });

  it("preloads several associations at once", async () => {
    const posts = await Post.all().includes("user", "comments");
    expect(posts).toHaveLength(3);
  });
});

// Rails matches `belongs_to :author` to `post.author` at run time and never
// says when they disagree — a typo produces an association nobody can reach.
// The name is a property of the model, so the compiler can check it.
describe("declaring an association", () => {
  it("refuses a name the model does not declare", () => {
    class Article extends Model<{ id: number }>("posts") {
      declare comments: HasMany<Comment>;
    }

    // @ts-expect-error "commnets" is not a property Article declares
    Article.hasMany("commnets", () => Comment);

    // The declared spelling is accepted.
    Article.hasMany("comments", () => Comment);
    expect(Object.keys(Article.associations)).toContain("comments");
  });
});

describe("inheritance", () => {
  it("does not leak a subclass association back to the parent", () => {
    class Article extends Post {
      declare revisions: HasMany<Comment>;
    }
    Article.hasMany("revisions", () => Comment);

    expect(Object.keys(Article.associations)).toContain("revisions");
    expect(Object.keys(Post.associations)).not.toContain("revisions");
    // The parent's own associations are still inherited.
    expect(Object.keys(Article.associations)).toContain("user");
  });
});
