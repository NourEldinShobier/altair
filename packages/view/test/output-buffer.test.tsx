/**
 * Collecting rendered markup and the form helpers that build it, ported from
 * `actionview/test/template/capture_helper_test.rb`,
 * `form_options_helper_test.rb` and `number_helper_test.rb`.
 *
 * Concatenating rendered markup with raw text loses the distinction between
 * them: escaped output gets escaped again and a name renders as
 * `O&amp;#39;Brien`, or unescaped text is appended to something safe and the
 * whole thing is trusted. Every join here says which it is dealing with.
 */

import { describe, expect, it } from "bun:test";
import { raw, renderToString } from "../src/render.js";
import {
  OutputBuffer,
  UnsafeConcat,
  WEEKDAYS,
  applyFormForOptions,
  capture,
  concat,
  currentValue,
  datalist,
  emittedHiddenId,
  fromCollection,
  groupedCollectionSelect,
  htmlSafe,
  inputChecked,
  multipart,
  numberWithPrecision,
  relativeTimeInWords,
  safeConcat,
  safeExprAppend,
  selectType,
  stripTrailingNewlines,
  weekdaySelect,
  withOutputBuffer,
  xssSafe,
} from "../src/output-buffer.js";

describe("knowing what is already markup", () => {
  it("recognises rendered output", () => {
    expect(htmlSafe(raw("<b>x</b>"))).toBe(true);
    expect(xssSafe(raw("<b>x</b>"))).toBe(true);
  });

  it("does not mistake a string for it", () => {
    expect(htmlSafe("<b>x</b>")).toBe(false);
    expect(xssSafe(null)).toBe(false);
  });
});

describe("joining output", () => {
  it("escapes what is not markup", () => {
    expect(safeConcat("O'Brien & Sons").value).toBe("O&#39;Brien &amp; Sons");
  });

  /** Escaping it again is how a name renders as `O&amp;#39;Brien`. */
  it("leaves what is markup alone", () => {
    expect(safeConcat(raw("<b>bold</b>")).value).toBe("<b>bold</b>");
  });

  /** The decision is per operand — one side is markup, the other is a value. */
  it("decides separately for each part", () => {
    expect(safeConcat(raw("<b>"), "a & b", raw("</b>")).value).toBe("<b>a &amp; b</b>");
  });

  it("joins nothing into nothing", () => {
    expect(safeConcat().value).toBe("");
  });

  it("appends to a buffer", () => {
    expect(safeExprAppend(raw("<p>"), "a & b").value).toBe("<p>a &amp; b");
  });

  it("joins markup without escaping", () => {
    expect(concat(raw("<b>"), raw("x"), raw("</b>")).value).toBe("<b>x</b>");
  });

  /**
   * A plain string here is a mistake the caller can see, rather than an escape
   * that silently did not happen.
   */
  it("refuses a plain string", () => {
    expect(() => concat(raw("<b>"), "not marked")).toThrow(UnsafeConcat);
  });

  it("says what to do instead", () => {
    expect(() => concat("plain")).toThrow("safeConcat");
  });
});

describe("capturing", () => {
  it("renders something and hands back its markup", async () => {
    expect((await capture(<p>Hello</p>)).value).toBe("<p>Hello</p>");
  });

  it("hands back something already marked safe", async () => {
    expect(htmlSafe(await capture(<p>x</p>))).toBe(true);
  });

  it("collects into a buffer", async () => {
    const collected = await withOutputBuffer((buffer) => {
      buffer.append(raw("<b>")).append("a & b").append(raw("</b>"));
    });

    expect(collected.value).toBe("<b>a &amp; b</b>");
  });

  it("collects nothing into nothing", async () => {
    expect((await withOutputBuffer(() => undefined)).value).toBe("");
  });

  it("takes markup that is already known to be safe", () => {
    const buffer = new OutputBuffer();
    buffer.appendRaw("<hr>");

    expect(buffer.toHtml().value).toBe("<hr>");
    expect(buffer.length).toBe(1);
  });

  it("waits for an asynchronous body", async () => {
    const collected = await withOutputBuffer(async (buffer) => {
      await Promise.resolve();
      buffer.append(raw("<p>late</p>"));
    });

    expect(collected.value).toBe("<p>late</p>");
  });
});

describe("trailing newlines", () => {
  it("drops them", () => {
    expect(stripTrailingNewlines("body\n\n")).toBe("body");
  });

  /** Trimming generally would change `<pre>` and remove deliberate spacing. */
  it("leaves other whitespace alone", () => {
    expect(stripTrailingNewlines("body  ")).toBe("body  ");
    expect(stripTrailingNewlines("\n  body")).toBe("\n  body");
  });

  it("leaves a string with none alone", () => {
    expect(stripTrailingNewlines("body")).toBe("body");
  });
});

describe("numbers", () => {
  /** `10.5` in a column of `10.50` reads as a different kind of number. */
  it("keeps trailing zeros", () => {
    expect(numberWithPrecision(10.5, { precision: 2 })).toBe("10.50");
  });

  it("rounds rather than truncating", () => {
    expect(numberWithPrecision(1.239, { precision: 2 })).toBe("1.24");
  });

  it("drops insignificant zeros when told to", () => {
    expect(numberWithPrecision(10.5, { precision: 4, stripInsignificantZeros: true })).toBe("10.5");
  });

  it("drops the point too when nothing is left after it", () => {
    expect(numberWithPrecision(10, { precision: 2, stripInsignificantZeros: true })).toBe("10");
  });

  it("takes a separator", () => {
    expect(numberWithPrecision(1.5, { precision: 2, separator: "," })).toBe("1,50");
  });

  it("defaults to three places", () => {
    expect(numberWithPrecision(1)).toBe("1.000");
  });
});

describe("how long ago", () => {
  const at = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000);

  it("says less than a minute", () => {
    expect(relativeTimeInWords(at(20))).toBe("less than a minute");
  });

  it("says one minute", () => {
    expect(relativeTimeInWords(at(60))).toBe("1 minute");
  });

  it("counts minutes", () => {
    expect(relativeTimeInWords(at(600))).toBe("10 minutes");
  });

  it("says about an hour", () => {
    expect(relativeTimeInWords(at(3600))).toBe("about 1 hour");
  });

  it("counts hours", () => {
    expect(relativeTimeInWords(at(3600 * 5))).toBe("about 5 hours");
  });

  it("counts days", () => {
    expect(relativeTimeInWords(at(86_400 * 5))).toBe("5 days");
  });

  it("counts months", () => {
    expect(relativeTimeInWords(at(86_400 * 90))).toBe("3 months");
  });

  /** "about 1 years" is what an unpluralised version says, and it shows. */
  it("counts years", () => {
    expect(relativeTimeInWords(at(86_400 * 400))).toBe("about 1 year");
  });

  /** A time in the future is a distance too, not a negative one. */
  it("takes a distance either way", () => {
    expect(relativeTimeInWords(at(-600))).toBe("10 minutes");
  });
});

describe("selects", () => {
  it("says which kind a select is", () => {
    expect(selectType(false)).toBe("select-one");
    expect(selectType(true)).toBe("select-multiple");
    expect(selectType(false, 5)).toBe("select-multiple");
    expect(selectType(false, 1)).toBe("select-one");
  });

  /**
   * A form posts strings. A select whose values are database ids sends `"7"`
   * while the record holds `7`, so strict comparison selects nothing on a
   * re-render.
   */
  it("matches a number against the string a form posted", () => {
    expect(inputChecked(7, "7")).toBe(true);
    expect(inputChecked("7", 7)).toBe(true);
  });

  it("does not match something else", () => {
    expect(inputChecked(7, "8")).toBe(false);
  });

  it("matches within a multiple selection", () => {
    expect(inputChecked(7, ["6", "7"])).toBe(true);
    expect(inputChecked(9, ["6", "7"])).toBe(false);
  });

  it("matches nothing when nothing is selected", () => {
    expect(inputChecked(7, undefined)).toBe(false);
    expect(inputChecked(7, null)).toBe(false);
  });

  it("takes the submitted value over the record's", () => {
    expect(currentValue({ status: "draft" }, "status", "published")).toBe("published");
  });

  it("falls back to the record's", () => {
    expect(currentValue({ status: "draft" }, "status")).toBe("draft");
  });

  it("survives having no record", () => {
    expect(currentValue(undefined, "status")).toBeUndefined();
  });
});

describe("the hidden field a multiple select needs", () => {
  /**
   * A multiple select with nothing chosen posts *nothing at all*, so a form
   * that cleared every checkbox looks identical to one that never had the
   * field.
   */
  it("is emitted for a multiple select", async () => {
    expect(await renderToString(emittedHiddenId("tags[]", true))).toContain('type="hidden"');
  });

  it("is not emitted for a single one", () => {
    expect(emittedHiddenId("tag", false)).toBeNull();
  });

  it("carries an empty value", async () => {
    expect(await renderToString(emittedHiddenId("tags[]", true))).toContain('value=""');
  });
});

describe("form options", () => {
  it("says a form needs to be multipart when it has a file", () => {
    expect(multipart([{ type: "text" }, { type: "file" }])).toBe(true);
  });

  it("says it does not otherwise", () => {
    expect(multipart([{ type: "text" }])).toBe(false);
    expect(multipart([])).toBe(false);
  });

  /**
   * From the record rather than the caller, which is what makes one partial
   * serve both — and a form posting a create to an update route is a 404 the
   * user sees.
   */
  it("posts a new record to the collection", () => {
    expect(applyFormForOptions({ isNewRecord: true }, "/posts")).toEqual({
      url: "/posts",
      method: "post",
    });
  });

  it("patches a persisted one at its own url", () => {
    expect(applyFormForOptions({ isNewRecord: false, id: 7 }, "/posts")).toEqual({
      url: "/posts/7",
      method: "patch",
    });
  });

  it("treats a record that does not say as new", () => {
    expect(applyFormForOptions({}, "/posts").method).toBe("post");
  });

  it("lets the caller override both", () => {
    expect(
      applyFormForOptions({ isNewRecord: false, id: 7 }, "/posts", {
        url: "/admin/posts/7",
        method: "put",
      }),
    ).toEqual({ url: "/admin/posts/7", method: "put" });
  });

  it("builds options from records", () => {
    expect(fromCollection([{ id: 1, name: "Ada" }], "id", "name")).toEqual([["Ada", 1]]);
  });
});

describe("built selects", () => {
  it("renders a datalist", async () => {
    const html = await renderToString(datalist("colours", ["red", "blue"]));

    expect(html).toContain('id="colours"');
    expect(html).toContain('value="red"');
  });

  it("renders the weekdays", async () => {
    const html = await renderToString(weekdaySelect("day"));

    expect(html).toContain("Monday");
    expect(html).toContain("Sunday");
  });

  it("starts the week where it was told to", async () => {
    const html = await renderToString(weekdaySelect("day", { beginningOfWeek: 0 }));

    expect(html.indexOf("Sunday")).toBeLessThan(html.indexOf("Monday"));
  });

  it("starts on Monday by default", async () => {
    const html = await renderToString(weekdaySelect("day"));

    expect(html.indexOf("Monday")).toBeLessThan(html.indexOf("Sunday"));
  });

  it("marks the chosen day", async () => {
    const html = await renderToString(weekdaySelect("day", { selected: 3 }));

    expect(html).toContain('value="3" selected');
  });

  it("names all seven", () => {
    expect(WEEKDAYS).toHaveLength(7);
  });

  it("groups options by a parent record", async () => {
    const html = await renderToString(
      groupedCollectionSelect(
        "city",
        [{ name: "France", cities: [{ id: 1, name: "Paris" }] }],
        "name",
        (group) => group.cities,
        "id",
        "name",
      ),
    );

    expect(html).toContain('<optgroup label="France"');
    expect(html).toContain("Paris");
  });

  it("marks the chosen one inside a group", async () => {
    const html = await renderToString(
      groupedCollectionSelect(
        "city",
        [{ name: "France", cities: [{ id: 1, name: "Paris" }] }],
        "name",
        (group) => group.cities,
        "id",
        "name",
        "1",
      ),
    );

    expect(html).toContain("selected");
  });
});
