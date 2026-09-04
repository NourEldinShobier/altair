/**
 * Marking the field that failed rather than only listing the message, ported
 * from the `field_error_proc` cases in
 * `actionview/test/template/form_helper_test.rb`.
 *
 * A form re-rendered after a failed validation that lists messages at the top
 * and marks nothing makes a long form a hunt — and for somebody using a screen
 * reader it is worse than a hunt, because there is no way to tell which control
 * each message belongs to.
 */

import { describe, expect, it } from "bun:test";
import { renderToString } from "../src/render.js";
import { FormBuilder } from "../src/form.js";

class Post {
  #values: Record<string, unknown>;
  #errors: Record<string, string[]>;

  isNewRecord = false;

  constructor(values: Record<string, unknown> = {}, errors: Record<string, string[]> = {}) {
    this.#values = values;
    this.#errors = errors;
  }

  attributes(): Record<string, unknown> {
    return this.#values;
  }

  get errors() {
    return { on: (attribute: string) => this.#errors[attribute] ?? [] };
  }
}

function withErrors(): FormBuilder {
  return new FormBuilder(
    "post",
    new Post({ title: "", body: "fine" }, { title: ["can't be blank", "is too short"] }),
  );
}

function valid(): FormBuilder {
  return new FormBuilder("post", new Post({ title: "Hello" }));
}

describe("hasErrors", () => {
  it("says which attribute failed", () => {
    const form = withErrors();

    expect(form.hasErrors("title")).toBe(true);
    expect(form.hasErrors("body")).toBe(false);
  });

  it("says no on a record with none", () => {
    expect(valid().hasErrors("title")).toBe(false);
  });
});

describe("errorAttributes", () => {
  /** What stops a long form with one bad field becoming a hunt. */
  it("gives a class for the stylesheet to select", () => {
    expect(withErrors().errorAttributes("title").class).toBe("field-with-errors");
  });

  it("takes a class of its own", () => {
    expect(withErrors().errorAttributes("title", "invalid").class).toBe("invalid");
  });

  /**
   * The half that gets left out. Without these a blind user gets a list of
   * messages at the top and no way to know which control each belongs to —
   * the same form with the marking removed.
   */
  it("tells a screen reader the field is invalid", () => {
    expect(withErrors().errorAttributes("title")["aria-invalid"]).toBe("true");
  });

  it("points the field at its own messages", () => {
    const form = withErrors();

    expect(form.errorAttributes("title")["aria-describedby"]).toBe(form.errorId("title"));
  });

  it("gives nothing for an attribute that is fine", () => {
    expect(withErrors().errorAttributes("body")).toEqual({});
  });

  it("gives nothing on a record with no errors at all", () => {
    expect(valid().errorAttributes("title")).toEqual({});
  });

  it("can be spread onto a field", async () => {
    const form = withErrors();
    const html = await renderToString(
      <input id={form.id("title")} {...form.errorAttributes("title")} />,
    );

    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('class="field-with-errors"');
  });
});

describe("errorId", () => {
  it("is derived from the field's own id", () => {
    expect(withErrors().errorId("title")).toBe("post_title_errors");
  });

  /** The pointer only works if the messages actually carry the id. */
  it("is what the rendered messages carry", async () => {
    const form = withErrors();
    const html = await renderToString(form.errors("title"));

    expect(html).toContain(`id="${form.errorId("title")}"`);
  });
});

describe("errorMessage", () => {
  it("gives the first message, humanised", () => {
    expect(withErrors().errorMessage("title")).toBe("Title can't be blank");
  });

  it("gives nothing when the attribute is fine", () => {
    expect(withErrors().errorMessage("body")).toBeUndefined();
  });
});

describe("errorWrapping", () => {
  it("wraps a field that failed", async () => {
    const form = withErrors();
    const html = await renderToString(form.errorWrapping("title", <input />));

    expect(html).toContain('<div class="field_with_errors">');
  });

  /** Rails' class name, since the point of this one is matching Rails' CSS. */
  it("uses the name an existing stylesheet expects", async () => {
    const html = await renderToString(withErrors().errorWrapping("title", <input />));

    expect(html).toContain("field_with_errors");
  });

  it("leaves a field that is fine alone", async () => {
    const html = await renderToString(withErrors().errorWrapping("body", <input />));

    expect(html).not.toContain("div");
  });

  it("takes a class of its own", async () => {
    const html = await renderToString(withErrors().errorWrapping("title", <input />, "bad"));

    expect(html).toContain('class="bad"');
  });
});
