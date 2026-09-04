/**
 * Which builder a form uses, ported from the `default_form_builder` cases in
 * `actionview/test/template/form_helper_test.rb`.
 *
 * The bug this feature exists to prevent is quiet: a form whose builder is not
 * the application's renders no validation errors, and the page looks like
 * saving simply did nothing.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  FormBuilder,
  FormWith,
  defaultFormBuilder,
  resetDefaultFormBuilder,
  setDefaultFormBuilder,
} from "../src/form.js";
import { renderToString } from "../src/render.js";

/** An application's own builder: every field carries its errors. */
class LoudBuilder extends FormBuilder {
  override textField(attribute: string): ReturnType<FormBuilder["textField"]> {
    return (
      <span class="loud">
        {super.textField(attribute)}
        {this.errorsOn(attribute).join(", ")}
      </span>
    );
  }
}

const record = {
  attributes: () => ({ title: "Hi" }),
  errors: { on: (attribute: string) => (attribute === "title" ? ["is too short"] : []) },
  isNewRecord: true,
};

afterEach(resetDefaultFormBuilder);

describe("the builder a form uses", () => {
  it("is the plain one until told otherwise", () => {
    expect(defaultFormBuilder()).toBe(FormBuilder);
  });

  /**
   * The consistency nobody has to remember: without this, the error markup
   * lives in every template and the one that forgets is the form where errors
   * do not appear.
   */
  it("is the application's once one is set", async () => {
    setDefaultFormBuilder(LoudBuilder);

    const html = await renderToString(
      <FormWith url="/posts" model={record}>
        {(f) => f.textField("title")}
      </FormWith>,
    );

    expect(html).toContain("is too short");
    expect(html).toContain('class="loud"');
  });

  it("can be overridden for one form", async () => {
    const html = await renderToString(
      <FormWith url="/posts" model={record} builder={LoudBuilder}>
        {(f) => f.textField("title")}
      </FormWith>,
    );

    expect(html).toContain("is too short");
  });

  it("prefers the form's own builder to the application's", async () => {
    setDefaultFormBuilder(LoudBuilder);

    const html = await renderToString(
      <FormWith url="/posts" model={record} builder={FormBuilder}>
        {(f) => f.textField("title")}
      </FormWith>,
    );

    expect(html).not.toContain("is too short");
  });

  it("is put back by a reset", () => {
    setDefaultFormBuilder(LoudBuilder);
    resetDefaultFormBuilder();

    expect(defaultFormBuilder()).toBe(FormBuilder);
  });

  /** The builder does not leak into the markup as an attribute. */
  it("does not appear on the form element", async () => {
    const html = await renderToString(
      <FormWith url="/posts" model={record} builder={LoudBuilder}>
        {() => null}
      </FormWith>,
    );

    expect(html).not.toContain("builder");
  });
});

describe("nested fields", () => {
  /**
   * A `fieldsFor` that quietly reverted to the plain builder is exactly the
   * place errors would stop being rendered — and it would look like the
   * nested record simply had none.
   */
  it("keep the builder the form was using", async () => {
    const html = await renderToString(
      <FormWith url="/posts" model={record} builder={LoudBuilder}>
        {(f) => f.fieldsFor("comments").textField("body")}
      </FormWith>,
    );

    expect(html).toContain('class="loud"');
    expect(html).toContain('name="object[comments_attributes][body]"');
  });

  it("keep it however deep they go", async () => {
    const html = await renderToString(
      <FormWith url="/posts" model={record} builder={LoudBuilder}>
        {(f) => f.fieldsFor("comments").fieldsFor("votes").textField("score")}
      </FormWith>,
    );

    expect(html).toContain('class="loud"');
  });
});
