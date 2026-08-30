/**
 * Multi-part attribute assembly, ported from the multiparameter cases in
 * `activerecord/test/cases/base_test.rb`.
 */

import { describe, expect, it } from "bun:test";
import {
  assignMultiparameterAttributes,
  isMultiparameterKey,
  multiparameterAttribute,
} from "../src/multiparameter.js";

describe("recognising the parts", () => {
  it("knows a part when it sees one", () => {
    expect(isMultiparameterKey("published_on(1i)")).toBe(true);
    expect(isMultiparameterKey("published_on")).toBe(false);
  });

  it("names the attribute a part belongs to", () => {
    expect(multiparameterAttribute("published_on(2i)")).toBe("published_on");
    expect(multiparameterAttribute("title")).toBeUndefined();
  });

  it("recognises the other cast letters", () => {
    expect(isMultiparameterKey("price(1f)")).toBe(true);
    expect(isMultiparameterKey("name(1s)")).toBe(true);
  });
});

describe("assembling a date", () => {
  it("puts three parts back together", () => {
    const { attributes } = assignMultiparameterAttributes({
      "published_on(1i)": "2026",
      "published_on(2i)": "3",
      "published_on(3i)": "9",
    });

    expect((attributes.published_on as Date).toISOString()).toBe("2026-03-09T00:00:00.000Z");
  });

  it("puts five parts back together", () => {
    const { attributes } = assignMultiparameterAttributes({
      "starts_at(1i)": "2026",
      "starts_at(2i)": "3",
      "starts_at(3i)": "9",
      "starts_at(4i)": "14",
      "starts_at(5i)": "30",
    });

    expect((attributes.starts_at as Date).toISOString()).toBe("2026-03-09T14:30:00.000Z");
  });

  /** A date_select posts three of the six; insisting on all would reject it. */
  it("defaults the parts that were not posted", () => {
    const { attributes } = assignMultiparameterAttributes({ "published_on(1i)": "2026" });

    expect((attributes.published_on as Date).toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("does not mind the parts arriving out of order", () => {
    const { attributes } = assignMultiparameterAttributes({
      "published_on(3i)": "9",
      "published_on(1i)": "2026",
      "published_on(2i)": "3",
    });

    expect((attributes.published_on as Date).toISOString()).toBe("2026-03-09T00:00:00.000Z");
  });

  it("assembles several attributes at once", () => {
    const { attributes } = assignMultiparameterAttributes({
      "starts_on(1i)": "2026",
      "starts_on(2i)": "1",
      "ends_on(1i)": "2026",
      "ends_on(2i)": "6",
    });

    expect((attributes.starts_on as Date).getUTCMonth()).toBe(0);
    expect((attributes.ends_on as Date).getUTCMonth()).toBe(5);
  });
});

describe("blanks", () => {
  /**
   * A date with the year chosen and the month not is not a date, and guessing
   * January would record a fact nobody entered.
   */
  it("gives null when a part is blank", () => {
    const { attributes } = assignMultiparameterAttributes({
      "published_on(1i)": "2026",
      "published_on(2i)": "",
      "published_on(3i)": "9",
    });

    expect(attributes.published_on).toBeNull();
  });

  it("gives null when the year is blank", () => {
    const { attributes } = assignMultiparameterAttributes({
      "published_on(1i)": "",
      "published_on(2i)": "3",
    });

    expect(attributes.published_on).toBeNull();
  });

  /** An empty form is not an error, so nothing is reported. */
  it("reports no error for a blank set", () => {
    const { errors } = assignMultiparameterAttributes({
      "published_on(1i)": "",
      "published_on(2i)": "",
    });

    expect(errors).toEqual({});
  });
});

describe("dates that do not exist", () => {
  /** User input: 31 February belongs on the field, not in a 500. */
  it("reports rather than throws", () => {
    const { errors } = assignMultiparameterAttributes({
      "published_on(1i)": "2026",
      "published_on(2i)": "2",
      "published_on(3i)": "31",
    });

    expect(Object.keys(errors)).toEqual(["published_on"]);
  });

  it("names the attribute in the message", () => {
    const { errors } = assignMultiparameterAttributes({
      "published_on(1i)": "notayear",
      "published_on(2i)": "2",
    });

    expect(errors.published_on).toContain("published_on");
  });
});

describe("everything else", () => {
  it("passes ordinary parameters through", () => {
    const { attributes } = assignMultiparameterAttributes({ title: "Hi", draft: true });

    expect(attributes).toEqual({ title: "Hi", draft: true });
  });

  it("mixes the two", () => {
    const { attributes } = assignMultiparameterAttributes({
      title: "Hi",
      "published_on(1i)": "2026",
      "published_on(2i)": "3",
      "published_on(3i)": "9",
    });

    expect(attributes.title).toBe("Hi");
    expect(attributes.published_on).toBeInstanceOf(Date);
  });

  /**
   * Positions beyond six are a value split for a reason this does not know
   * about, so the parts are handed back rather than guessed at.
   */
  it("leaves a non-date grouping as its parts", () => {
    const { attributes } = assignMultiparameterAttributes({
      "address(1s)": "Main St",
      "address(7s)": "Springfield",
    });

    expect(attributes["address(1s)"]).toBe("Main St");
    expect(attributes["address(7s)"]).toBe("Springfield");
    expect(attributes.address).toBeUndefined();
  });

  it("copes with nothing at all", () => {
    expect(assignMultiparameterAttributes({})).toEqual({ attributes: {}, errors: {} });
  });
});
