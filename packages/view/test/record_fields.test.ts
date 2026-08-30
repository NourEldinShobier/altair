/**
 * Record-bound form fields, ported from
 * `actionview/test/template/form_helper_test.rb`.
 *
 * The tag-level helpers are tested next door. These cases are about the four
 * things the record-bound layer works out that a tag cannot: the name, the id,
 * the current value, and whether a box is checked.
 */

import { describe, expect, it } from "bun:test";
import type { RawHtml } from "../src/render.js";
import {
  checkbox,
  colorField,
  dateField,
  datetimeField,
  emailField,
  fieldType,
  fileField,
  hiddenField,
  monthField,
  numberField,
  passwordField,
  radioButton,
  textField,
  textarea,
  timeField,
  urlField,
  valueFor,
} from "../src/record_fields.js";

function html(node: unknown): string {
  return (node as RawHtml).value;
}

const post = {
  title: "Hello",
  body: "Some text",
  published: true,
  views: 42,
  state: "draft",
  published_on: "2026-03-09T14:30:00.000Z",
};

describe("the name and the id", () => {
  /** A flat parameter is one the model cannot assign. */
  it("nests the name under the scope", () => {
    expect(html(textField("post", "title", post))).toContain('name="post[title]"');
  });

  /** A mismatched id leaves the label pointing at nothing. */
  it("derives the id the label points at", () => {
    expect(html(textField("post", "title", post))).toContain('id="post_title"');
  });

  it("works without a scope", () => {
    const markup = html(textField(undefined, "title", post));

    expect(markup).toContain('name="title"');
    expect(markup).toContain('id="title"');
  });

  it("takes an id of its own", () => {
    expect(html(textField("post", "title", post, { id: "custom" }))).toContain('id="custom"');
  });
});

describe("the value", () => {
  /** Without this an edit form silently blanks every field not retyped. */
  it("reads it off the record", () => {
    expect(html(textField("post", "title", post))).toContain('value="Hello"');
  });

  it("renders no value attribute when the record has none", () => {
    expect(html(textField("post", "title", {}))).not.toContain("value=");
  });

  it("renders none with no record at all", () => {
    expect(html(textField("post", "title"))).not.toContain("value=");
  });

  it("prefers an explicit value", () => {
    expect(html(textField("post", "title", post, { value: "Override" }))).toContain(
      'value="Override"',
    );
  });

  it("stringifies a number", () => {
    expect(html(numberField("post", "views", post))).toContain('value="42"');
  });

  /** Null and absent are the same to a form; empty string is not. */
  it("treats null as absent", () => {
    expect(valueFor({ title: null }, "title")).toBeUndefined();
    expect(valueFor({ title: "" }, "title")).toBe("");
  });

  it("escapes the value", () => {
    expect(html(textField("post", "title", { title: '"><script>' }))).toContain("&quot;");
  });
});

describe("passwordField", () => {
  /**
   * Rendering a password back into a form puts it in the page source, the
   * browser cache and any proxy log along the way. Rails does the same.
   */
  it("never reads the value off the record", () => {
    expect(html(passwordField("user", "password", { password: "secret" }))).not.toContain("secret");
  });

  it("renders one that was passed explicitly", () => {
    expect(html(passwordField("user", "password", {}, { value: "given" }))).toContain(
      'value="given"',
    );
  });
});

describe("fileField", () => {
  /** A browser refuses a value on a file input; rendering one only misleads. */
  it("never renders a value", () => {
    expect(html(fileField("post", "cover", { cover: "/uploads/a.png" }))).not.toContain("value=");
  });

  it("still derives the name and id", () => {
    const markup = html(fileField("post", "cover"));

    expect(markup).toContain('name="post[cover]"');
    expect(markup).toContain('id="post_cover"');
  });
});

describe("the temporal fields", () => {
  /**
   * A browser ignores a datetime-local value carrying a zone or milliseconds
   * and renders the field empty, so a stored timestamp appears to vanish.
   */
  it("trims a timestamp for a date field", () => {
    expect(html(dateField("post", "published_on", post))).toContain('value="2026-03-09"');
  });

  it("trims it for a datetime field", () => {
    expect(html(datetimeField("post", "published_on", post))).toContain('value="2026-03-09T14:30"');
  });

  it("trims it for a month field", () => {
    expect(html(monthField("post", "published_on", post))).toContain('value="2026-03"');
  });

  it("takes the time out for a time field", () => {
    expect(html(timeField("post", "published_on", post))).toContain('value="14:30"');
  });

  it("leaves a bare time alone", () => {
    expect(html(timeField("post", "at", { at: "09:15" }))).toContain('value="09:15"');
  });
});

describe("checkbox", () => {
  /** An edit form that forgot to compute checked turns every setting off. */
  it("checks it from the record", () => {
    expect(html(checkbox("post", "published", post))).toContain("checked");
  });

  it("leaves it unchecked when the record says so", () => {
    expect(html(checkbox("post", "published", { published: false }))).not.toContain("checked");
  });

  /**
   * A boolean column comes back as a boolean, as 1, or as "t" depending on the
   * adapter. Comparing against the checked value alone misses two of the three.
   */
  it("recognises every shape a boolean comes back as", () => {
    for (const value of [true, 1, "1", "t", "true"]) {
      expect(html(checkbox("post", "published", { published: value })), String(value)).toContain(
        "checked",
      );
    }
  });

  it("does not check it for a falsy shape", () => {
    for (const value of [false, 0, "0", "f", "false"]) {
      expect(
        html(checkbox("post", "published", { published: value })),
        String(value),
      ).not.toContain("checked");
    }
  });

  /** So unchecking posts something rather than nothing. */
  it("emits the hidden field before it", () => {
    const markup = html(checkbox("post", "published", post));

    expect(markup).toContain('<input type="hidden" name="post[published]" value="0">');
    expect(markup.indexOf("hidden")).toBeLessThan(markup.indexOf("checkbox"));
  });

  it("takes a checked value of its own", () => {
    const markup = html(checkbox("post", "state", { state: "live" }, { checkedValue: "live" }));

    expect(markup).toContain('value="live"');
    expect(markup).toContain("checked");
  });

  it("takes an explicit checked flag", () => {
    expect(html(checkbox("post", "published", { published: false }, { checked: true }))).toContain(
      "checked",
    );
  });
});

describe("radioButton", () => {
  /** What makes a group show the current choice without comparing each. */
  it("checks the one matching the record", () => {
    expect(html(radioButton("post", "state", "draft", post))).toContain("checked");
    expect(html(radioButton("post", "state", "live", post))).not.toContain("checked");
  });

  it("gives each button its own id", () => {
    expect(html(radioButton("post", "state", "draft", post))).toContain('id="post_state_draft"');
  });

  it("shares the name across the group", () => {
    expect(html(radioButton("post", "state", "live", post))).toContain('name="post[state]"');
  });
});

describe("textarea", () => {
  it("puts the value between the tags", () => {
    expect(html(textarea("post", "body", post))).toContain(">Some text<");
  });

  it("derives the name and id", () => {
    const markup = html(textarea("post", "body", post));

    expect(markup).toContain('name="post[body]"');
    expect(markup).toContain('id="post_body"');
  });
});

describe("the other field types", () => {
  it("render their own input type", () => {
    expect(html(emailField("user", "email", { email: "a@b.c" }))).toContain('type="email"');
    expect(html(urlField("user", "site", {}))).toContain('type="url"');
    expect(html(colorField("user", "colour", {}))).toContain('type="color"');
    expect(html(hiddenField("post", "id", { id: 7 }))).toContain('type="hidden"');
  });
});

describe("fieldType", () => {
  /** A guess for a generator, and named as one. */
  it("reads the intent out of the name", () => {
    expect(fieldType("password_digest")).toBe("password");
    expect(fieldType("email")).toBe("email");
    expect(fieldType("website_url")).toBe("url");
    expect(fieldType("phone")).toBe("tel");
    expect(fieldType("colour")).toBe("color");
  });

  it("falls back to the value's own type", () => {
    expect(fieldType("published", true)).toBe("checkbox");
    expect(fieldType("views", 42)).toBe("number");
    expect(fieldType("title", "Hello")).toBe("text");
  });

  it("tells a date column from a timestamp one", () => {
    expect(fieldType("published_on", new Date())).toBe("date");
    expect(fieldType("created_at", new Date())).toBe("datetime-local");
  });

  it("prefers the name over the value", () => {
    expect(fieldType("email", 42)).toBe("email");
  });
});
