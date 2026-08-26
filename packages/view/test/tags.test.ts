/**
 * Unbound form fields, ported from
 * `actionview/test/template/form_tag_helper_test.rb`.
 *
 * The cases that matter are the two hidden fields — the one beside a checkbox
 * and the one before a collection — and the attribute rules, because
 * `disabled={false}` writing `disabled="false"` disables the field.
 */

import { describe, expect, it } from "bun:test";
import {
  ButtonTag,
  CheckboxTag,
  ColorFieldTag,
  DatalistTag,
  DateFieldTag,
  EmailFieldTag,
  FieldSetTag,
  HiddenFieldTag,
  LabelTag,
  NumberFieldTag,
  PasswordFieldTag,
  RadioButtonTag,
  SubmitTag,
  TextFieldTag,
  TextareaTag,
  contentTag,
  tagOptions,
} from "../src/tags.js";
import { renderToString } from "../src/render.js";

const html = async (node: unknown) => await renderToString(node as never);

describe("attributes", () => {
  it("writes a value as a quoted attribute", () => {
    expect(tagOptions({ name: "q", size: 30 })).toBe(' name="q" size="30"');
  });

  it("writes a true one as the bare word", () => {
    expect(tagOptions({ required: true })).toBe(" required");
  });

  /**
   * The reason `false` cannot become `="false"`: a browser reads any non-empty
   * value as true, so `disabled="false"` disables the field.
   */
  it("drops a false, null or undefined one entirely", () => {
    expect(tagOptions({ disabled: false, a: null, b: undefined })).toBe("");
  });

  it("escapes what it is given", () => {
    expect(tagOptions({ value: '"><script>' })).not.toContain("<script>");
  });
});

describe("text fields", () => {
  it("carries a name, an id derived from it, and a value", async () => {
    expect(await html(TextFieldTag({ name: "q", value: "bun" }))).toBe(
      '<input type="text" name="q" id="q" value="bun">',
    );
  });

  it("derives an id from a bracketed name", async () => {
    expect(await html(TextFieldTag({ name: "post[title]" }))).toContain('id="post_title"');
  });

  it("takes an id it was given", async () => {
    expect(await html(TextFieldTag({ name: "q", id: "search" }))).toContain('id="search"');
  });

  it("leaves the value out when there is none", async () => {
    expect(await html(TextFieldTag({ name: "q" }))).not.toContain("value=");
  });

  it("passes anything else through", async () => {
    expect(
      await html(TextFieldTag({ name: "q", placeholder: "Search", required: true })),
    ).toContain('placeholder="Search" required');
  });

  it("has a type for each kind of field", async () => {
    expect(await html(PasswordFieldTag({ name: "p" }))).toContain('type="password"');
    expect(await html(EmailFieldTag({ name: "e" }))).toContain('type="email"');
    expect(await html(NumberFieldTag({ name: "n" }))).toContain('type="number"');
    expect(await html(DateFieldTag({ name: "d" }))).toContain('type="date"');
    expect(await html(ColorFieldTag({ name: "c" }))).toContain('type="color"');
    expect(await html(HiddenFieldTag({ name: "h" }))).toContain('type="hidden"');
  });
});

/**
 * An unchecked box sends nothing at all, so without the hidden field a form
 * that unticks one is indistinguishable from a form that never had it — which
 * is how a setting turns itself back on.
 */
describe("a checkbox", () => {
  it("sends a zero when it is not ticked", async () => {
    const rendered = await html(CheckboxTag({ name: "subscribed" }));

    expect(rendered.startsWith('<input type="hidden" name="subscribed" value="0">')).toBe(true);
  });

  it("defaults its own value to one", async () => {
    expect(await html(CheckboxTag({ name: "subscribed" }))).toContain(
      '<input type="checkbox" name="subscribed" id="subscribed" value="1">',
    );
  });

  it("is ticked when it is told to be", async () => {
    expect(await html(CheckboxTag({ name: "s", checked: true }))).toContain("checked");
    expect(await html(CheckboxTag({ name: "s", checked: false }))).not.toContain("checked");
  });

  // A radio group is never empty by accident: one of them is always chosen, so
  // there is nothing for a hidden field to say.
  it("has no hidden twin when it is a radio button", async () => {
    const rendered = await html(RadioButtonTag({ name: "plan", value: "pro" }));

    expect(rendered).not.toContain("hidden");
    expect(rendered).toContain('id="plan_pro"');
  });
});

describe("the rest of a form", () => {
  it("writes a textarea with its contents inside", async () => {
    expect(await html(TextareaTag({ name: "body", value: "hello", rows: 4 }))).toBe(
      '<textarea name="body" id="body" rows="4">hello</textarea>',
    );
  });

  it("escapes what goes in a textarea", async () => {
    expect(await html(TextareaTag({ name: "b", value: "<script>" }))).toContain("&lt;script&gt;");
  });

  it("writes a label pointing at a field", async () => {
    expect(await html(LabelTag({ for: "q", text: "Search" }))).toBe(
      '<label for="q">Search</label>',
    );
  });

  it("writes a submit button with words on it", async () => {
    expect(await html(SubmitTag({ value: "Search" }))).toContain('value="Search"');
    expect(await html(SubmitTag())).toContain('value="Save changes"');
  });

  it("says what to show while it is sending", async () => {
    expect(await html(SubmitTag({ disableWith: "Sending…" }))).toContain(
      'data-disable-with="Sending…"',
    );
  });

  it("writes a button with a default type of submit", async () => {
    expect(await html(ButtonTag({ text: "Go" }))).toBe('<button type="submit">Go</button>');
  });

  it("groups fields under a legend", async () => {
    expect(await html(FieldSetTag({ legend: "Address", children: "<input>" }))).toBe(
      "<fieldset><legend>Address</legend><input></fieldset>",
    );
  });

  it("offers suggestions from a datalist", async () => {
    expect(await html(DatalistTag({ id: "cities", options: ["London"] }))).toBe(
      '<datalist id="cities"><option value="London"></datalist>',
    );
  });
});

describe("a plain element", () => {
  it("escapes its contents", async () => {
    expect(await html(contentTag("p", "<b>hi</b>", { class: "note" }))).toBe(
      '<p class="note">&lt;b&gt;hi&lt;/b&gt;</p>',
    );
  });
});
