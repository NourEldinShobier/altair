/**
 * Form builders.
 *
 * Mirrors actionview/test/template/form_helper_test.rb. The cases that matter
 * are the conventions a Rails developer relies on without thinking: fields
 * named after the model so `params.require("post")` finds them, a checkbox
 * that can be unticked, and a password that is never echoed back.
 */

import { describe, expect, it } from "bun:test";
import { renderToString } from "../src/render.js";
import { fieldId, fieldName, FormBuilder, FormWith, scopeFor } from "../src/form.js";

class Post {
  #values: Record<string, unknown>;
  #errors: Record<string, string[]>;

  isNewRecord: boolean;

  constructor(values: Record<string, unknown> = {}, errors: Record<string, string[]> = {}) {
    this.#values = values;
    this.#errors = errors;
    this.isNewRecord = values.id === undefined;
  }

  attributes(): Record<string, unknown> {
    return this.#values;
  }

  get errors() {
    return { on: (attribute: string) => this.#errors[attribute] ?? [] };
  }
}

const render = (node: Parameters<typeof renderToString>[0]) => renderToString(node);

describe("naming", () => {
  // The convention that makes params.require("post").permit(...) work.
  it("nests a field under its model", () => {
    expect(fieldName("post", "title")).toBe("post[title]");
    expect(fieldId("post", "title")).toBe("post_title");
  });

  it("leaves an unscoped field bare", () => {
    expect(fieldName(undefined, "query")).toBe("query");
    expect(fieldId(undefined, "query")).toBe("query");
  });

  it("marks a field that takes many values", () => {
    expect(fieldName("post", "tags", true)).toBe("post[tags][]");
  });

  it("takes the scope from the model's name", () => {
    expect(scopeFor(new Post())).toBe("post");
  });

  it("prefers a scope that was given", () => {
    expect(scopeFor(new Post(), "article")).toBe("article");
  });

  it("has no scope without a model", () => {
    expect(scopeFor(undefined)).toBeUndefined();
  });
});

describe("fields", () => {
  const builder = new FormBuilder("post", new Post({ title: "Hello", views: 3 }));

  it("carry the record's value", async () => {
    expect(await render(builder.textField("title"))).toBe(
      '<input type="text" name="post[title]" id="post_title" value="Hello">',
    );
  });

  it("are empty when the record has nothing", async () => {
    expect(await render(builder.textField("missing"))).toContain('value=""');
  });

  it("take extra attributes", async () => {
    expect(await render(builder.textField("title", { class: "input", required: true }))).toContain(
      'class="input"',
    );
  });

  it("render a label pointing at the field", async () => {
    expect(await render(builder.label("title"))).toBe('<label for="post_title">Title</label>');
  });

  it("take a label of their own", async () => {
    expect(await render(builder.label("title", "Headline"))).toContain(">Headline<");
  });

  it("render a textarea with its value between the tags", async () => {
    expect(await render(builder.textArea("title"))).toBe(
      '<textarea name="post[title]" id="post_title">Hello</textarea>',
    );
  });

  it("render typed inputs", async () => {
    expect(await render(builder.emailField("title"))).toContain('type="email"');
    expect(await render(builder.numberField("views"))).toContain('type="number"');
    expect(await render(builder.dateField("title"))).toContain('type="date"');
  });

  // Echoing a stored password into HTML puts it in every cache and proxy log
  // between here and the person.
  it("never echo a password back", async () => {
    const secret = new FormBuilder("user", new Post({ password: "hunter2" }));
    const html = await render(secret.passwordField("password"));

    expect(html).toContain('value=""');
    expect(html).not.toContain("hunter2");
  });

  it("escape a value that contains markup", async () => {
    const dangerous = new FormBuilder("post", new Post({ title: '"><script>alert(1)</script>' }));

    const html = await render(dangerous.textField("title"));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("checkboxes", () => {
  // An unchecked box sends nothing, so without the hidden field a box could be
  // ticked and never unticked.
  it("pair with a hidden field so unchecking is possible", async () => {
    const builder = new FormBuilder("post", new Post({ published: false }));
    const html = await render(builder.checkBox("published"));

    expect(html).toContain('<input type="hidden" name="post[published]" value="0">');
    expect(html).toContain('type="checkbox"');
  });

  it("are checked when the record says so", async () => {
    const on = new FormBuilder("post", new Post({ published: true }));
    expect(await render(on.checkBox("published"))).toContain("checked");
  });

  it("are unchecked otherwise", async () => {
    const off = new FormBuilder("post", new Post({ published: false }));
    expect(await render(off.checkBox("published"))).not.toContain("checked");
  });

  // A database that stores booleans as 0 and 1 must not render every row ticked.
  it("read a boolean stored as a number", async () => {
    const one = new FormBuilder("post", new Post({ published: 1 }));
    const zero = new FormBuilder("post", new Post({ published: 0 }));

    expect(await render(one.checkBox("published"))).toContain("checked");
    expect(await render(zero.checkBox("published"))).not.toContain("checked");
  });
});

describe("radios and selects", () => {
  const builder = new FormBuilder("post", new Post({ category: "tech" }));

  it("check the radio matching the value", async () => {
    expect(await render(builder.radioButton("category", "tech"))).toContain("checked");
    expect(await render(builder.radioButton("category", "life"))).not.toContain("checked");
  });

  it("give each radio its own id", async () => {
    expect(await render(builder.radioButton("category", "tech"))).toContain(
      'id="post_category_tech"',
    );
  });

  it("select the matching option", async () => {
    const html = await render(builder.select("category", ["tech", "life"]));

    expect(html).toContain('<option value="tech" selected>tech</option>');
    expect(html).toContain('<option value="life">life</option>');
  });

  it("take options with their own labels", async () => {
    const html = await render(builder.select("category", [{ value: "tech", label: "Technology" }]));

    expect(html).toContain(">Technology<");
  });

  /**
   * A select with no blank option has already answered for the person looking
   * at it: whatever is first is what gets submitted by anyone who does not
   * touch it, which is how a required field arrives filled in with a value
   * nobody chose.
   */
  it("can start with nothing chosen", async () => {
    const html = await render(builder.select("category", ["tech", "life"], { includeBlank: true }));

    expect(html).toContain('<option value=""></option>');
    // The blank goes first, or it is not what an untouched form submits.
    expect(html.indexOf('value=""')).toBeLessThan(html.indexOf('value="tech"'));
  });

  it("can say something in the blank", async () => {
    const html = await render(builder.select("category", ["tech"], { prompt: "Pick a category" }));

    expect(html).toContain('<option value="">Pick a category</option>');
  });

  it("leaves the blank out unless it is asked for", async () => {
    expect(await render(builder.select("category", ["tech"]))).not.toContain('value=""');
  });

  // Rails keeps the html attributes in their own argument, after the options.
  it("still takes attributes of its own", async () => {
    const html = await render(
      builder.select("category", ["tech"], { includeBlank: true }, { class: "pretty" }),
    );

    expect(html).toContain('class="pretty"');
  });
});

describe("errors", () => {
  it("render nothing when the attribute is valid", async () => {
    const builder = new FormBuilder("post", new Post({ title: "Hello" }));
    expect(await render(builder.errors("title"))).toBe("");
  });

  it("render the messages when it is not", async () => {
    const builder = new FormBuilder("post", new Post({}, { title: ["can't be blank"] }));
    const html = await render(builder.errors("title"));

    expect(html).toContain("Title can&#39;t be blank");
  });

  it("render every message", async () => {
    const builder = new FormBuilder(
      "post",
      new Post({}, { title: ["can't be blank", "is too short"] }),
    );

    expect(await render(builder.errors("title"))).toContain("is too short");
  });

  it("say nothing for a form with no record", async () => {
    expect(await render(new FormBuilder("post", undefined).errors("title"))).toBe("");
  });
});

describe("the form element", () => {
  const body = (f: FormBuilder) => f.textField("title");

  it("posts a new record", async () => {
    const html = await render(
      <FormWith model={new Post()} url="/posts">
        {body}
      </FormWith>,
    );

    expect(html).toContain('<form action="/posts" method="post">');
    expect(html).not.toContain("_method");
  });

  // A browser can send only GET and POST, so the verb the router reads comes
  // from a hidden field.
  it("patches a record that already exists", async () => {
    const html = await render(
      <FormWith model={new Post({ id: 1, title: "Hello" })} url="/posts/1">
        {body}
      </FormWith>,
    );

    expect(html).toContain('method="post"');
    expect(html).toContain('<input type="hidden" name="_method" value="patch">');
  });

  it("sends a delete the same way", async () => {
    const html = await render(
      <FormWith url="/posts/1" method="delete">
        {() => null}
      </FormWith>,
    );

    expect(html).toContain('value="delete"');
  });

  it("leaves a get form alone", async () => {
    const html = await render(
      <FormWith url="/search" method="get">
        {() => null}
      </FormWith>,
    );

    expect(html).toContain('method="get"');
    expect(html).not.toContain("_method");
  });

  it("carries the CSRF token", async () => {
    const html = await render(
      <FormWith url="/posts" authenticityToken="tok123">
        {() => null}
      </FormWith>,
    );

    expect(html).toContain('<input type="hidden" name="authenticity_token" value="tok123">');
  });

  it("names its fields after the model", async () => {
    const html = await render(
      <FormWith model={new Post({ title: "Hello" })} url="/posts">
        {body}
      </FormWith>,
    );

    expect(html).toContain('name="post[title]"');
  });

  it("takes a scope of its own", async () => {
    const html = await render(
      <FormWith model={new Post({ title: "Hello" })} scope="article" url="/posts">
        {body}
      </FormWith>,
    );

    expect(html).toContain('name="article[title]"');
  });

  it("passes attributes through", async () => {
    const html = await render(
      <FormWith url="/posts" id="new-post" class="form" attributes={{ "data-remote": true }}>
        {() => null}
      </FormWith>,
    );

    expect(html).toContain('id="new-post"');
    expect(html).toContain('class="form"');
    expect(html).toContain("data-remote");
  });
});

describe("submit buttons", () => {
  it("say Create for a new record", async () => {
    expect(await render(new FormBuilder("post", new Post()).submit())).toContain(">Create<");
  });

  it("say Update for one that exists", async () => {
    expect(await render(new FormBuilder("post", new Post({ id: 1 })).submit())).toContain(
      ">Update<",
    );
  });

  it("say whatever they were told to", async () => {
    expect(await render(new FormBuilder("post", new Post()).submit("Publish"))).toContain(
      ">Publish<",
    );
  });
});

describe("nested fields", () => {
  // The names accepted by acceptsNestedAttributesFor on the other side.
  it("name a nested record's fields for the parent to accept", async () => {
    const builder = new FormBuilder("post", undefined);
    const nested = builder.fieldsFor("comments", 0);

    expect(await render(nested.textField("body"))).toContain(
      'name="post[comments_attributes][0][body]"',
    );
  });

  it("name a to-one nested record without an index", async () => {
    const nested = new FormBuilder("post", undefined).fieldsFor("author");
    expect(await render(nested.textField("name"))).toContain(
      'name="post[author_attributes][name]"',
    );
  });

  it("carry the destroy flag a nested form needs", async () => {
    const nested = new FormBuilder("post", undefined).fieldsFor("comments", 1);
    expect(await render(nested.hiddenField("_destroy", "1"))).toContain(
      'name="post[comments_attributes][1][_destroy]"',
    );
  });
});
