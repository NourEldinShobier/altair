/**
 * Select options, ported from
 * `actionview/test/template/form_options_helper_test.rb`.
 *
 * The cases that matter are the ones a hand-written `map` gets wrong: which
 * option is selected when the value came back from a form as a string, what a
 * blank choice looks like, and the hidden field that makes "none" different
 * from "unchanged".
 */

import { describe, expect, it } from "bun:test";
import {
  CollectionCheckboxes,
  CollectionRadioButtons,
  CollectionSelect,
  Select,
  groupedOptionsForSelect,
  optionGroupsFromCollectionForSelect,
  optionsForSelect,
  optionsFromCollectionForSelect,
  weekdayOptionsForSelect,
} from "../src/options.js";
import { renderToString } from "../src/render.js";

const html = async (node: unknown) => await renderToString(node as never);

describe("a list of options", () => {
  it("uses the value for both when given one thing", async () => {
    expect(await html(optionsForSelect(["draft", "live"]))).toBe(
      '<option value="draft">draft</option><option value="live">live</option>',
    );
  });

  it("takes a label and a value when given both", async () => {
    expect(await html(optionsForSelect([["Draft", 1] as const]))).toBe(
      '<option value="1">Draft</option>',
    );
  });

  it("marks the chosen one", async () => {
    expect(await html(optionsForSelect(["draft", "live"], "live"))).toContain(
      '<option value="live" selected>',
    );
  });

  /**
   * The case a hand-written `===` gets wrong. A selected value arrives from a
   * form or a URL as a string; the options come from the database as numbers.
   */
  it("matches a number against the string a form sent back", async () => {
    const rendered = await html(optionsForSelect([["Ada", 3] as const], "3"));

    expect(rendered).toContain("selected");
  });

  it("marks several when several are chosen", async () => {
    const rendered = await html(optionsForSelect(["a", "b", "c"], ["a", "c"]));

    expect(rendered.match(/selected/g)).toHaveLength(2);
  });

  it("marks none when nothing is chosen", async () => {
    expect(await html(optionsForSelect(["a", "b"]))).not.toContain("selected");
    expect(await html(optionsForSelect(["a", "b"], null))).not.toContain("selected");
  });

  it("can disable one", async () => {
    expect(await html(optionsForSelect(["a", "b"], undefined, "b"))).toContain(
      '<option value="b" disabled>',
    );
  });

  it("escapes both the label and the value", async () => {
    const rendered = await html(optionsForSelect([["<script>", '"x"'] as const]));

    expect(rendered).not.toContain("<script>");
    expect(rendered).toContain("&lt;script&gt;");
  });
});

describe("options from a collection", () => {
  const authors = [
    { id: 1, name: "Ada" },
    { id: 2, name: "Grace" },
  ];

  it("takes the value and label from each", async () => {
    const rendered = await html(
      optionsFromCollectionForSelect(
        authors,
        (a) => a.id,
        (a) => a.name,
        2,
      ),
    );

    expect(rendered).toBe(
      '<option value="1">Ada</option><option value="2" selected>Grace</option>',
    );
  });
});

describe("grouped options", () => {
  it("wraps each group in an optgroup", async () => {
    const rendered = await html(
      groupedOptionsForSelect({ Fiction: ["Dune"], Other: [["Manual", 2] as const] }, 2),
    );

    expect(rendered).toContain('<optgroup label="Fiction"><option value="Dune">Dune</option>');
    expect(rendered).toContain('<option value="2" selected>Manual</option>');
  });

  it("builds them from a collection of collections", async () => {
    const shelves = [
      { name: "Fiction", books: [{ id: 1, title: "Dune" }] },
      { name: "Other", books: [{ id: 2, title: "Manual" }] },
    ];

    const rendered = await html(
      optionGroupsFromCollectionForSelect(
        shelves,
        (shelf) => shelf.books,
        (shelf) => shelf.name,
        (book) => book.id,
        (book) => book.title,
      ),
    );

    expect(rendered).toContain('<optgroup label="Fiction">');
    expect(rendered).toContain('<option value="1">Dune</option>');
  });
});

describe("the select itself", () => {
  it("wraps the options it is given", async () => {
    const rendered = await html(
      Select({ name: "post[state]", options: optionsForSelect(["draft"]) }),
    );

    expect(rendered).toBe(
      '<select name="post[state]" id="post[state]"><option value="draft">draft</option></select>',
    );
  });

  it("adds a blank choice when asked", async () => {
    const rendered = await html(
      Select({ name: "s", options: optionsForSelect(["a"]), includeBlank: true }),
    );

    expect(rendered).toContain('<option value=""></option>');
  });

  it("labels the blank choice when given words for it", async () => {
    const rendered = await html(
      Select({ name: "s", options: optionsForSelect(["a"]), includeBlank: "Choose one" }),
    );

    expect(rendered).toContain('<option value="">Choose one</option>');
  });

  it("carries the attributes a form needs", async () => {
    const rendered = await html(
      Select({
        name: "s",
        options: optionsForSelect([]),
        multiple: true,
        required: true,
        class: "x",
      }),
    );

    expect(rendered).toContain('class="x"');
    expect(rendered).toContain("multiple");
    expect(rendered).toContain("required");
  });

  it("builds one straight from a collection", async () => {
    const rendered = await html(
      CollectionSelect({
        name: "post[author_id]",
        collection: [{ id: 1, name: "Ada" }],
        value: (a) => a.id,
        label: (a) => a.name,
        selected: 1,
      }),
    );

    expect(rendered).toContain('<select name="post[author_id]"');
    expect(rendered).toContain('<option value="1" selected>Ada</option>');
  });
});

describe("checkboxes and radio buttons for a collection", () => {
  const tags = [
    { id: 1, name: "ruby" },
    { id: 2, name: "bun" },
  ];

  /**
   * Unchecking everything has to send something. Without the hidden field the
   * parameter disappears entirely, and the server reads "unchanged" where the
   * person meant "none".
   */
  it("sends an empty value so none is different from unchanged", async () => {
    const rendered = await html(
      CollectionCheckboxes({
        name: "post[tag_ids][]",
        collection: tags,
        value: (t) => t.id,
        label: (t) => t.name,
      }),
    );

    expect(rendered.startsWith('<input type="hidden" name="post[tag_ids][]" value="">')).toBe(true);
  });

  it("checks the ones already chosen", async () => {
    const rendered = await html(
      CollectionCheckboxes({
        name: "post[tag_ids][]",
        collection: tags,
        value: (t) => t.id,
        label: (t) => t.name,
        checked: [2],
      }),
    );

    expect(rendered.match(/checked/g)).toHaveLength(1);
    expect(rendered).toContain('value="2" checked');
  });

  it("labels each box so clicking the words works", async () => {
    const rendered = await html(
      CollectionCheckboxes({
        name: "t[]",
        collection: tags,
        value: (t) => t.id,
        label: (t) => t.name,
      }),
    );

    expect(rendered).toContain("<label for=");
    expect(rendered).toContain("ruby</label>");
  });

  it("has no hidden field for radio buttons, which are never plural", async () => {
    const rendered = await html(
      CollectionRadioButtons({
        name: "post[tag_id]",
        collection: tags,
        value: (t) => t.id,
        label: (t) => t.name,
      }),
    );

    expect(rendered).not.toContain('type="hidden"');
    expect(rendered).toContain('type="radio"');
  });
});

describe("the days of the week", () => {
  it("starts on Monday and carries the day's number", async () => {
    const rendered = await html(weekdayOptionsForSelect());

    expect(rendered.startsWith('<option value="1">Monday</option>')).toBe(true);
    expect(rendered).toContain('<option value="0">Sunday</option>');
  });

  it("starts on Sunday when asked", async () => {
    expect(await html(weekdayOptionsForSelect(undefined, 0))).toMatch(
      /^<option value="0">Sunday<\/option>/,
    );
  });
});
