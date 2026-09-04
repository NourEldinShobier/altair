/**
 * The form builder's `button`, ported from `FormBuilder#button` in
 * `actionview/lib/action_view/helpers/form_helper.rb` and the `button` cases
 * in `actionview/test/template/form_helper_test.rb`.
 *
 * The difference from `submit` is the name it carries, not the element it
 * renders. Naming an attribute scopes the button to the record, so a form can
 * have two buttons that mean different things and the server learns which one
 * was pressed.
 *
 * Without it the alternatives are a hidden field flipped by script, which
 * fails with JavaScript off, or two forms, which cannot share the fields.
 *
 * Both controls take a node rather than a string, so an icon beside the label
 * does not mean hand-writing the element — and hand-writing it is where the
 * escaping goes wrong.
 */

import { describe, expect, it } from "bun:test";
import { FormBuilder } from "../src/form.js";
import { renderToString } from "../src/render.js";

class Post {
  constructor(
    readonly title = "",
    readonly isNewRecord = true,
  ) {}
}

function builderFor(record: Post): FormBuilder {
  return new FormBuilder("post", record as never);
}

const html = async (node: unknown): Promise<string> => await renderToString(node as never);

describe("a plain button", () => {
  it("submits, and says so", async () => {
    const rendered = await html(builderFor(new Post()).button("Save"));

    expect(rendered).toContain('type="submit"');
    expect(rendered).toContain("Save");
  });

  it("defaults its label the way submit does", async () => {
    expect(await html(builderFor(new Post()).button())).toContain("Create");
    expect(await html(builderFor(new Post("a", false)).button())).toContain("Update");
  });

  it("carries no name when no attribute was given", async () => {
    expect(await html(builderFor(new Post()).button("Save"))).not.toContain("name=");
  });

  it("takes the attributes it was given", async () => {
    expect(await html(builderFor(new Post()).button("Save", { class: "primary" }))).toContain(
      'class="primary"',
    );
  });
});

describe("a button that names an attribute", () => {
  /** Scoped to the record, so the server reads it as one of the post's fields. */
  it("posts under the record's scope", async () => {
    const rendered = await html(
      builderFor(new Post()).button("Save as draft", { attribute: "draft", value: "true" }),
    );

    expect(rendered).toContain('name="post[draft]"');
    expect(rendered).toContain('value="true"');
  });

  it("keeps the attribute out of the markup as an attribute of its own", async () => {
    const rendered = await html(
      builderFor(new Post()).button("Save", { attribute: "draft", value: "true" }),
    );

    expect(rendered).not.toContain('attribute="draft"');
  });

  /** Two buttons, two meanings, one set of fields. */
  it("lets two buttons say different things", async () => {
    const form = builderFor(new Post());

    const draft = await html(form.button("Draft", { attribute: "draft", value: "true" }));
    const publish = await html(form.button("Publish", { attribute: "draft", value: "false" }));

    expect(draft).toContain('value="true"');
    expect(publish).toContain('value="false"');
    expect(draft).toContain('name="post[draft]"');
    expect(publish).toContain('name="post[draft]"');
  });
});

describe("markup inside a control", () => {
  it("goes inside the button", async () => {
    const rendered = await html(
      builderFor(new Post()).button(
        <>
          <span class="icon" /> Save
        </>,
      ),
    );

    expect(rendered).toContain('<span class="icon">');
    expect(rendered).toContain("Save");
  });

  it("goes inside submit too", async () => {
    const rendered = await html(
      builderFor(new Post()).submit(
        <>
          <span class="icon" /> Save
        </>,
      ),
    );

    expect(rendered).toContain('<span class="icon">');
  });

  /** Escaped, because a label is as likely to carry a user's words as anything. */
  it("escapes a string label", async () => {
    expect(await html(builderFor(new Post()).button("<script>alert(1)</script>"))).not.toContain(
      "<script>",
    );
  });
});
