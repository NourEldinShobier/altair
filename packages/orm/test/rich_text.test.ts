/**
 * Rich text.
 *
 * Mirrors actiontext/test/unit/. The decision the tests are about: what is
 * stored is what was submitted, and what is rendered is sanitized. Storing the
 * sanitized copy instead would mean a policy tightened next month does nothing
 * for what was written last month.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Connection, setConnection } from "../src/connection.js";
import { testConnection } from "./support/database.js";
import { SchemaStatements } from "../src/schema.js";
import { Model } from "../src/model.js";
import {
  configureRichText,
  createRichTextTable,
  hasRichText,
  resetRichText,
  RichText,
  RichTextField,
} from "../src/rich_text.js";

interface PostRow {
  id: number;
  title: string;
}

class Post extends Model<PostRow>("posts") {
  declare content: RichTextField;
  declare summary: RichTextField;

  static {
    hasRichText(this, "content");
    hasRichText(this, "summary");
  }
}

/** A second model, so one table serving both can be checked. */
class Page extends Model<PostRow>("pages") {
  declare content: RichTextField;

  static {
    hasRichText(this, "content");
  }
}

/** Stands in for the view's sanitizer, which the ORM must not depend on. */
const strip = async (html: string) => html.replaceAll(/<script[\s\S]*?<\/script>/gi, "");

let connection: Connection;

beforeEach(async () => {
  configureRichText({ sanitizer: strip });

  connection = await testConnection();
  setConnection(connection);
  for (const model of [RichText, Post, Page]) {
    model.columnCache = undefined;
    model.columnTypeCache = undefined;
  }

  const schema = new SchemaStatements(connection);
  await createRichTextTable(schema);
  await schema.createTable("posts", (t) => t.string("title"));
  await schema.createTable("pages", (t) => t.string("title"));
});

afterEach(() => {
  resetRichText();
});

describe("a rich text field", () => {
  it("starts empty", async () => {
    const post = await Post.create({ title: "Hello" });

    expect(await post.content.body()).toBeNull();
    expect(await post.content.isPresent()).toBe(false);
    expect(await post.content.toHtml()).toBe("");
  });

  it("stores a body", async () => {
    const post = await Post.create({ title: "Hello" });
    await post.content.update("<p>Written</p>");

    expect(await post.content.body()).toBe("<p>Written</p>");
    expect(await post.content.isPresent()).toBe(true);
  });

  it("replaces a body rather than adding one", async () => {
    const post = await Post.create({ title: "Hello" });

    await post.content.update("<p>First</p>");
    await post.content.update("<p>Second</p>");

    expect(await post.content.body()).toBe("<p>Second</p>");
    expect(await RichText.count()).toBe(1);
  });

  it("treats whitespace as empty", async () => {
    const post = await Post.create({ title: "Hello" });
    await post.content.update("   ");

    expect(await post.content.isPresent()).toBe(false);
  });

  it("deletes a body", async () => {
    const post = await Post.create({ title: "Hello" });
    await post.content.update("<p>Written</p>");

    await post.content.destroy();

    expect(await post.content.body()).toBeNull();
    expect(await RichText.count()).toBe(0);
  });
});

// The whole decision: what is stored is what arrived.
describe("storing and rendering", () => {
  it("stores exactly what was submitted", async () => {
    const post = await Post.create({ title: "Hello" });
    await post.content.update("<p>Hi</p><script>alert(1)</script>");

    expect(await post.content.body()).toContain("<script>");
  });

  // A policy that tightens next month has to protect what was written last
  // month, and it cannot if the only copy went through the old one.
  it("sanitizes on the way out", async () => {
    const post = await Post.create({ title: "Hello" });
    await post.content.update("<p>Hi</p><script>alert(1)</script>");

    expect(await post.content.toHtml()).toBe("<p>Hi</p>");
  });

  it("renders through whichever sanitizer is configured", async () => {
    configureRichText({ sanitizer: async (html) => html.toUpperCase() });

    const post = await Post.create({ title: "Hello" });
    await post.content.update("<p>hi</p>");

    expect(await post.content.toHtml()).toBe("<P>HI</P>");
  });

  // Rendering a stored body unsanitized is how a stored cross-site scripting
  // bug works. Refusing outright was the safe failure, but it made Action Text
  // unusable until an application wired something up — and the thing most
  // likely to be wired up in a hurry is worse than the one that ships.
  it("sanitizes with nothing configured", async () => {
    resetRichText();

    const post = await Post.create({ title: "Hello" });
    await post.content.update("<p>Hi</p>");

    expect(await post.content.toHtml()).toBe("<p>Hi</p>");
  });

  it("uses the shared sanitizer's policy, not a weaker one", async () => {
    resetRichText();

    const post = await Post.create({ title: "Hello" });
    await post.content.update(
      '<p>Hi<script>alert(1)</script><a href="javascript:alert(1)">x</a></p>',
    );

    const html = await post.content.toHtml();

    expect(html).not.toContain("script");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("Hi");
  });

  it("still prefers one that was configured", async () => {
    configureRichText({ sanitizer: async () => "replaced" });

    const post = await Post.create({ title: "Hello" });
    await post.content.update("<p>Hi</p>");

    expect(await post.content.toHtml()).toBe("replaced");
  });
});

describe("keeping bodies apart", () => {
  it("keeps two fields on one record apart", async () => {
    const post = await Post.create({ title: "Hello" });

    await post.content.update("<p>Body</p>");
    await post.summary.update("<p>Summary</p>");

    expect(await post.content.body()).toBe("<p>Body</p>");
    expect(await post.summary.body()).toBe("<p>Summary</p>");
  });

  it("keeps two records apart", async () => {
    const first = await Post.create({ title: "First" });
    const second = await Post.create({ title: "Second" });

    await first.content.update("<p>One</p>");
    await second.content.update("<p>Two</p>");

    expect(await first.content.body()).toBe("<p>One</p>");
    expect(await second.content.body()).toBe("<p>Two</p>");
  });

  // One table serves every model, so two records with the same id in
  // different tables are the case that breaks a lookup keyed on id alone.
  it("keeps two models with the same id apart", async () => {
    const post = await Post.create({ title: "Post" });
    const page = await Page.create({ title: "Page" });

    expect(post.id).toBe(page.id);

    await post.content.update("<p>Post body</p>");
    await page.content.update("<p>Page body</p>");

    expect(await post.content.body()).toBe("<p>Post body</p>");
    expect(await page.content.body()).toBe("<p>Page body</p>");
  });

  it("records which model a body belongs to", async () => {
    const post = await Post.create({ title: "Hello" });
    await post.content.update("<p>Body</p>");

    const stored = (await RichText.all())[0]!;

    expect(stored.name).toBe("content");
    expect(stored.record_type).toBe("Post");
    expect(stored.record_id).toBe(post.id);
  });
});
