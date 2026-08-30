/**
 * Date and time selects, ported from
 * `actionview/test/template/date_helper_test.rb`.
 */

import { describe, expect, it } from "bun:test";
import type { RawHtml } from "../src/render.js";
import {
  dateSelect,
  datetimeSelect,
  multiparameterName,
  selectDate,
  selectDay,
  selectHour,
  selectMinute,
  selectMonth,
  selectSecond,
  selectYear,
  timeSelect,
  timeZoneSelect,
} from "../src/date_select.js";

function html(node: unknown): string {
  return (node as RawHtml).value;
}

describe("multiparameterName", () => {
  /**
   * Without the suffix the three selects each claim the attribute and the last
   * posted wins — a form that silently records the day as the whole date.
   */
  it("numbers the parts largest first", () => {
    expect(multiparameterName("post", "published_on", "year")).toBe("post[published_on](1i)");
    expect(multiparameterName("post", "published_on", "month")).toBe("post[published_on](2i)");
    expect(multiparameterName("post", "published_on", "day")).toBe("post[published_on](3i)");
  });

  it("numbers the time parts after the date ones", () => {
    expect(multiparameterName("post", "starts_at", "hour")).toBe("post[starts_at](4i)");
    expect(multiparameterName("post", "starts_at", "minute")).toBe("post[starts_at](5i)");
    expect(multiparameterName("post", "starts_at", "second")).toBe("post[starts_at](6i)");
  });

  it("works without a scope", () => {
    expect(multiparameterName(undefined, "published_on", "year")).toBe("published_on(1i)");
  });
});

describe("selectYear", () => {
  it("posts under the year part's name", () => {
    expect(
      html(selectYear("post", "published_on", 2026, { startYear: 2025, endYear: 2027 })),
    ).toContain('name="post[published_on](1i)"');
  });

  it("offers the range it was given", () => {
    const markup = html(selectYear("post", "on", undefined, { startYear: 2024, endYear: 2026 }));

    expect(markup).toContain('value="2024"');
    expect(markup).toContain('value="2026"');
    expect(markup).not.toContain('value="2027"');
  });

  it("marks the selected year", () => {
    const markup = html(selectYear("post", "on", 2025, { startYear: 2024, endYear: 2026 }));

    expect(markup).toContain('<option value="2025" selected>');
  });

  /** A birthday form wants this year first and 1920 last. */
  it("counts backwards when the start is later than the end", () => {
    const markup = html(selectYear("post", "on", undefined, { startYear: 2026, endYear: 2024 }));
    const order = [...markup.matchAll(/value="(\d+)"/g)].map((m) => m[1]);

    expect(order).toEqual(["2026", "2025", "2024"]);
  });

  it("adds a blank option when asked", () => {
    const markup = html(
      selectYear("post", "on", undefined, { startYear: 2026, endYear: 2026, includeBlank: true }),
    );

    expect(markup).toContain('<option value=""></option>');
  });

  it("gives the select an id derived from the part", () => {
    expect(html(selectYear("post", "published_on"))).toContain('id="post_published_on_1i"');
  });
});

describe("the other parts", () => {
  it("names the months", () => {
    const markup = html(selectMonth("post", "on", 3));

    expect(markup).toContain(">January<");
    expect(markup).toContain('<option value="3" selected>March</option>');
  });

  it("takes month names of its own", () => {
    const markup = html(selectMonth("post", "on", 1, { useMonthNames: ["Jan", "Feb"] }));

    expect(markup).toContain(">Jan<");
    expect(markup).not.toContain(">January<");
  });

  it("offers 31 days", () => {
    const markup = html(selectDay("post", "on"));

    expect(markup).toContain('value="31"');
    expect(markup).not.toContain('value="32"');
  });

  it("offers 24 hours from zero", () => {
    const markup = html(selectHour("post", "at"));

    expect(markup).toContain('value="0"');
    expect(markup).toContain('value="23"');
    expect(markup).not.toContain('value="24"');
  });

  it("pads the time parts", () => {
    expect(html(selectHour("post", "at"))).toContain(">00<");
    expect(html(selectMinute("post", "at"))).toContain(">05<");
    expect(html(selectSecond("post", "at"))).toContain(">59<");
  });
});

describe("the composed helpers", () => {
  it("renders three selects for a date", () => {
    const markup = html(dateSelect("post", "published_on"));

    expect(markup.match(/<select/g)).toHaveLength(3);
    expect(markup).toContain("(1i)");
    expect(markup).toContain("(2i)");
    expect(markup).toContain("(3i)");
  });

  it("renders two for a time", () => {
    const markup = html(timeSelect("post", "starts_at"));

    expect(markup.match(/<select/g)).toHaveLength(2);
    expect(markup).toContain("(4i)");
    expect(markup).toContain("(5i)");
  });

  it("renders five for a datetime", () => {
    expect(html(datetimeSelect("post", "starts_at")).match(/<select/g)).toHaveLength(5);
  });

  it("selects the parts of the value it was given", () => {
    const markup = html(
      dateSelect("post", "on", new Date("2026-03-09T00:00:00Z"), {
        startYear: 2026,
        endYear: 2026,
      }),
    );

    expect(markup).toContain('<option value="2026" selected>');
    expect(markup).toContain('<option value="3" selected>March</option>');
    expect(markup).toContain('<option value="9" selected>');
  });

  it("takes an order of its own", () => {
    const markup = html(dateSelect("post", "on", undefined, { order: ["day", "month", "year"] }));
    const first = markup.indexOf("(3i)");
    const last = markup.indexOf("(1i)");

    expect(first).toBeLessThan(last);
  });

  it("works without a record scope", () => {
    expect(html(selectDate("published_on"))).toContain('name="published_on(1i)"');
  });

  it("disables every part at once", () => {
    const markup = html(dateSelect("post", "on", undefined, { disabled: true }));

    expect(markup.match(/disabled/g)).toHaveLength(3);
  });
});

describe("timeZoneSelect", () => {
  /** One value, so one select — it is here for company, not for the mechanism. */
  it("posts under the plain attribute name", () => {
    const markup = html(timeZoneSelect("user", "zone", ["UTC", "Europe/Paris"]));

    expect(markup).toContain('name="user[zone]"');
    expect(markup).not.toContain("(1i)");
  });

  it("marks the selected zone", () => {
    const markup = html(timeZoneSelect("user", "zone", ["UTC", "Europe/Paris"], "Europe/Paris"));

    expect(markup).toContain('<option value="Europe/Paris" selected>Europe/Paris</option>');
  });

  it("adds a blank when asked", () => {
    const markup = html(timeZoneSelect("user", "zone", ["UTC"], undefined, { includeBlank: true }));

    expect(markup).toContain('<option value=""></option>');
  });
});
