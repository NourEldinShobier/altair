/**
 * Generator suite.
 *
 * Mirrors railties/test/generators/. Generators return a path and contents
 * rather than writing files, so these assert the exact output — which is what
 * Rails' generator tests do with `assert_file`.
 */

import { describe, expect, it } from "bun:test";
import {
  generateController,
  generateMigration,
  generateModel,
  generateResourceController,
  generateScaffold,
  migrationVersion,
  parseFields,
  tsTypeFor,
} from "../src/generators.js";
import { generate } from "../src/commands.js";

const NOW = new Date(Date.UTC(2026, 7, 22, 14, 30, 5));

describe("field parsing", () => {
  it("parses name:type pairs", () => {
    expect(parseFields(["title:string", "body:text"])).toEqual([
      { name: "title", type: "string" },
      { name: "body", type: "text" },
    ]);
  });

  it("defaults to string", () => {
    expect(parseFields(["title"])).toEqual([{ name: "title", type: "string" }]);
  });

  it("rejects an unknown type", () => {
    expect(() => parseFields(["title:widget"])).toThrow('Unknown type "widget"');
  });

  it("maps column types to TypeScript types", () => {
    expect(tsTypeFor("string")).toBe("string");
    expect(tsTypeFor("integer")).toBe("number");
    expect(tsTypeFor("references")).toBe("number");
    expect(tsTypeFor("json")).toBe("unknown");
  });
});

describe("migration version", () => {
  // Rails names migrations by a UTC timestamp so they sort in creation order.
  it("is a sortable UTC timestamp", () => {
    expect(migrationVersion(NOW)).toBe("20260822143005");
  });

  it("pads every part", () => {
    expect(migrationVersion(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)))).toBe("20260102030405");
  });
});

describe("generate migration", () => {
  it("names the file after the version and the migration", () => {
    const file = generateMigration("create_posts", parseFields(["title:string"]), NOW);
    expect(file.path).toBe("db/migrate/20260822143005_create_posts.ts");
  });

  it("builds a create table body from the fields", () => {
    const file = generateMigration("create_posts", parseFields(["title:string", "body:text"]), NOW);

    expect(file.contents).toContain('await schema.createTable("posts", (t) => {');
    expect(file.contents).toContain('t.string("title");');
    expect(file.contents).toContain('t.text("body");');
    expect(file.contents).toContain("t.timestamps();");
    expect(file.contents).toContain('await schema.dropTable("posts");');
  });

  it("uses references for a belongs-to column", () => {
    const file = generateMigration("create_comments", parseFields(["post:references"]), NOW);
    expect(file.contents).toContain('t.references("post");');
  });

  // Guessing the body of an arbitrarily named migration produces the wrong
  // thing, so it gets a skeleton instead.
  it("leaves a non-create migration empty", () => {
    const file = generateMigration("add_slug_to_posts", [], NOW);

    expect(file.contents).toContain("Describe the change here");
    expect(file.contents).not.toContain("createTable");
  });

  // classify() singularizes, which is right for a table-to-model name and
  // wrong here: Rails calls this migration CreateProducts, not CreateProduct.
  it("keeps the migration name plural", () => {
    const file = generateMigration("create_products", [], NOW);
    expect(file.contents).toContain('name: "CreateProducts"');
  });

  it("declares the version inside the file too", () => {
    const file = generateMigration("create_posts", [], NOW);
    expect(file.contents).toContain('version: "20260822143005"');
  });
});

describe("generate model", () => {
  it("follows Rails' naming conventions", () => {
    const file = generateModel("Post", parseFields(["title:string"]));

    expect(file.path).toBe("app/models/post.ts");
    expect(file.contents).toContain('export class Post extends Model<PostRow>("posts")');
  });

  it("singularizes and underscores a multi-word name", () => {
    const file = generateModel("LineItems", []);

    expect(file.path).toBe("app/models/line_item.ts");
    expect(file.contents).toContain('Model<LineItemRow>("line_items")');
  });

  // Attributes come from db/types.ts, which db:migrate generates from the
  // database. Hand-writing them means a column added in a migration and
  // forgotten here makes the compiler report a shape the database lacks.
  it("takes its attributes from the generated types", () => {
    const file = generateModel("Post", parseFields(["title:string", "views:integer"]));

    expect(file.contents).toContain('import type { PostRow } from "#db/types";');
    expect(file.contents).toContain('Model<PostRow>("posts")');
    expect(file.contents).not.toContain("interface PostAttributes");
  });

  it("declares and registers a belongsTo for a reference", () => {
    const file = generateModel("Comment", parseFields(["post:references", "body:text"]));

    expect(file.contents).toContain("declare post: BelongsTo<Post>;");
    expect(file.contents).toContain('this.belongsTo("post", () => Post);');
    expect(file.contents).toContain('import { Post } from "./post.js";');
  });

  it("imports only what it uses", () => {
    const file = generateModel("Post", parseFields(["title:string"]));

    expect(file.contents).toContain('import { Model } from "@altair/orm";');
    expect(file.contents).not.toContain("BelongsTo");
  });
});

describe("generate controller", () => {
  it("names the file and class conventionally", () => {
    const file = generateController("Posts");

    expect(file.path).toBe("app/controllers/posts_controller.ts");
    expect(file.contents).toContain("export class PostsController extends Controller");
  });

  it("pluralizes a singular name", () => {
    expect(generateController("Post").path).toBe("app/controllers/posts_controller.ts");
  });

  it("writes the actions it was given", () => {
    const file = generateController("Posts", ["index", "show"]);

    expect(file.contents).toContain("index(): void");
    expect(file.contents).toContain("show(): void");
  });
});

describe("generate resource controller", () => {
  const file = generateResourceController("Post", parseFields(["title:string", "body:text"]));

  it("implements the seven RESTful actions", () => {
    for (const action of ["index", "show", "create", "update", "destroy"]) {
      expect(file.contents).toContain(`${action}(`);
    }
  });

  it("loads the record in a filter for member actions", () => {
    expect(file.contents).toContain('@beforeAction({ only: ["show", "update", "destroy"] })');
    expect(file.contents).toContain('await Post.find(this.params.get("id"))');
  });

  // A scaffold that mass-assigns everything is a vulnerability, so the
  // generated controller permits exactly the declared columns.
  it("permits only the declared columns", () => {
    expect(file.contents).toContain('.permit("title", "body")');
    expect(file.contents).toContain('this.params.require("post")');
  });

  it("returns 422 with the error messages when a save fails", () => {
    expect(file.contents).toContain("errors: post.errors.fullMessages()");
    expect(file.contents).toContain("status: 422");
  });

  it("returns 201 on create and 204 on destroy", () => {
    expect(file.contents).toContain("status: 201");
    expect(file.contents).toContain("this.head(204)");
  });
});

describe("generate scaffold", () => {
  const files = generateScaffold("Post", parseFields(["title:string"]), NOW);

  it("produces a migration, a model and a controller", () => {
    expect(files.map((file) => file.path)).toEqual([
      "db/migrate/20260822143005_create_posts.ts",
      "app/models/post.ts",
      "app/controllers/posts_controller.ts",
    ]);
  });

  it("agrees on the table across all three", () => {
    expect(files[0]!.contents).toContain('createTable("posts"');
    expect(files[1]!.contents).toContain('Model<PostRow>("posts")');
    expect(files[2]!.contents).toContain("Post.find");
  });
});

describe("generated code shape", () => {
  // Generated code is the first thing a person reads about the framework, so
  // it has to look like code we would write.
  it("indents columns level with timestamps", () => {
    const file = generateMigration("create_posts", parseFields(["title:string"]), NOW);
    const lines = file.contents.split("\n");

    const column = lines.find((line) => line.includes("t.string"))!;
    const timestamps = lines.find((line) => line.includes("t.timestamps"))!;

    expect(column.length - column.trimStart().length).toBe(
      timestamps.length - timestamps.trimStart().length,
    );
  });

  it("leaves no empty class body", () => {
    const file = generateModel("Post", parseFields(["title:string"]));

    expect(file.contents).toContain('Model<PostRow>("posts") {}');
    expect(file.contents).not.toContain("{\n}");
  });

  it("still writes a body when there are associations", () => {
    const file = generateModel("Comment", parseFields(["post:references"]));
    expect(file.contents).toContain("static {");
  });
});

// Generated code that does not compile, or whose own generated test fails, is
// worse than no generator. Each of these was found by generating into a real
// directory and running `tsc` and `bun test` over the output.
describe("mailer, job and channel generators", () => {
  const files = (kind: string, name: string, extra: string[] = []) =>
    Object.fromEntries(generate(kind, name, extra).map((file) => [file.path, file.contents]));

  it("generates a mailer and its test", () => {
    const written = files("mailer", "User", ["welcome", "password_reset"]);

    expect(Object.keys(written)).toEqual([
      "app/mailers/user_mailer.tsx",
      "test/mailers/user_mailer.test.ts",
    ]);
    expect(written["app/mailers/user_mailer.tsx"]).toContain("static passwordReset(");
  });

  // Without a default sender `toMessage()` throws, so the generated test
  // failed the moment it was run.
  it("gives the mailer a sender, or its own test cannot pass", () => {
    expect(files("mailer", "User")["app/mailers/user_mailer.tsx"]).toContain("from:");
  });

  // `message.html()` is not a method; the fields come off `toMessage()`.
  it("writes a mailer test against the API that exists", () => {
    const test = files("mailer", "User")["test/mailers/user_mailer.test.ts"] as string;

    expect(test).toContain("toMessage()");
    expect(test).not.toContain("message.html()");
  });

  it("generates a job and its test", () => {
    const written = files("job", "CleanupImages");

    expect(Object.keys(written)).toEqual([
      "app/jobs/cleanup_images_job.ts",
      "test/jobs/cleanup_images_job.test.ts",
    ]);
  });

  // `singularize` is right for a model and wrong for a job: it turned
  // CleanupImages into cleanup_image_job.
  it("does not fold a plural in a job name", () => {
    expect(Object.keys(files("job", "CleanupImages"))[0]).toContain("cleanup_images");
    expect(Object.keys(files("mailer", "Notifications"))[0]).toContain("notifications");
  });

  it("does not double the suffix when the name already has it", () => {
    expect(Object.keys(files("job", "CleanupJob"))[0]).toBe("app/jobs/cleanup_job.ts");
    expect(Object.keys(files("channel", "ChatChannel"))[0]).toBe("app/channels/chat_channel.ts");
  });

  it("generates a channel that streams", () => {
    const written = files("channel", "Chat");

    expect(written["app/channels/chat_channel.ts"]).toContain("streamFrom");
    expect(written["app/channels/chat_channel.ts"]).toContain("override async subscribed");
  });

  it("still refuses a generator it does not have", () => {
    expect(() => generate("nonsense", "Thing")).toThrow(/Available:/);
  });
});
