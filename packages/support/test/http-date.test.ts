/**
 * The date format HTTP headers use, ported from
 * `activesupport/test/core_ext/time_ext_test.rb`'s httpdate cases.
 *
 * There is one format a server may send and three it must accept. An
 * unparseable `If-Modified-Since` reads as "no date", the response is served
 * in full, and the only symptom is a cache that never hits for one class of
 * client — which nobody finds by looking.
 */

import { describe, expect, it } from "bun:test";
import { httpdate, notModifiedSince, parseHttpDate } from "../src/http-date.js";

const MOMENT = new Date(Date.UTC(2026, 0, 1, 12, 0, 0));

describe("httpdate", () => {
  it("writes the format a header carries", () => {
    expect(httpdate(MOMENT)).toBe("Thu, 01 Jan 2026 12:00:00 GMT");
  });

  it("pads the day and the time", () => {
    expect(httpdate(new Date(Date.UTC(2026, 8, 5, 3, 4, 5)))).toBe("Sat, 05 Sep 2026 03:04:05 GMT");
  });

  it("always says GMT, whatever the machine's zone", () => {
    expect(httpdate(MOMENT).endsWith(" GMT")).toBe(true);
  });

  it("writes a four-digit year", () => {
    expect(httpdate(new Date(Date.UTC(999, 0, 1)))).toContain("0999");
  });

  it("round-trips through the parser", () => {
    expect(parseHttpDate(httpdate(MOMENT))?.getTime()).toBe(MOMENT.getTime());
  });
});

describe("parseHttpDate", () => {
  it("reads the modern format", () => {
    expect(parseHttpDate("Thu, 01 Jan 2026 12:00:00 GMT")?.getTime()).toBe(MOMENT.getTime());
  });

  /** Obsolete since 1999 and still emitted by proxies. */
  it("reads the RFC 850 format", () => {
    expect(parseHttpDate("Thursday, 01-Jan-26 12:00:00 GMT")?.getTime()).toBe(MOMENT.getTime());
  });

  it("reads the asctime format", () => {
    expect(parseHttpDate("Thu Jan  1 12:00:00 2026")?.getTime()).toBe(MOMENT.getTime());
  });

  it("reads an asctime day without the extra space", () => {
    expect(parseHttpDate("Sat Sep 12 03:04:05 2026")?.getUTCDate()).toBe(12);
  });

  /**
   * The window every implementation uses: a validator dated in the future is
   * meaningless and one dated in the past is ordinary.
   */
  it("reads a two-digit year as the nearest past century", () => {
    expect(parseHttpDate("Monday, 01-Jan-99 00:00:00 GMT")?.getUTCFullYear()).toBe(1999);
  });

  it("reads a recent two-digit year as this century", () => {
    expect(parseHttpDate("Thursday, 01-Jan-26 00:00:00 GMT")?.getUTCFullYear()).toBe(2026);
  });

  /**
   * Null rather than an invalid Date, so a caller cannot compare against NaN
   * and get false for every question — which turns an unparseable header into
   * "not modified" instead of "I do not know".
   */
  it("gives null for something it cannot read", () => {
    expect(parseHttpDate("yesterday")).toBeNull();
    expect(parseHttpDate("")).toBeNull();
    expect(parseHttpDate(null)).toBeNull();
    expect(parseHttpDate(undefined)).toBeNull();
  });

  it("gives null for a month that is not one", () => {
    expect(parseHttpDate("Thu, 01 Foo 2026 12:00:00 GMT")).toBeNull();
  });

  /** Date.UTC turns 31 February into 3 March without complaint. */
  it("gives null for a day that does not exist", () => {
    expect(parseHttpDate("Thu, 31 Feb 2026 12:00:00 GMT")).toBeNull();
  });

  it("takes a leap day in a leap year", () => {
    expect(parseHttpDate("Tue, 29 Feb 2028 12:00:00 GMT")?.getUTCDate()).toBe(29);
  });

  it("ignores surrounding space", () => {
    expect(parseHttpDate("  Thu, 01 Jan 2026 12:00:00 GMT  ")?.getTime()).toBe(MOMENT.getTime());
  });

  it("refuses a date with an offset that is not GMT", () => {
    expect(parseHttpDate("Thu, 01 Jan 2026 12:00:00 +0100")).toBeNull();
  });
});

describe("notModifiedSince", () => {
  it("is true when the resource is older", () => {
    expect(
      notModifiedSince("Thu, 01 Jan 2026 12:00:00 GMT", new Date(MOMENT.getTime() - 1000)),
    ).toBe(true);
  });

  it("is false when it is newer", () => {
    expect(
      notModifiedSince("Thu, 01 Jan 2026 12:00:00 GMT", new Date(MOMENT.getTime() + 2000)),
    ).toBe(false);
  });

  it("is true when they are the same second", () => {
    expect(notModifiedSince("Thu, 01 Jan 2026 12:00:00 GMT", MOMENT)).toBe(true);
  });

  /**
   * A resource modified 300ms after the header's second is not modified as far
   * as the wire is concerned; comparing milliseconds makes every such response
   * a spurious 200.
   */
  it("ignores milliseconds, which the format does not carry", () => {
    expect(
      notModifiedSince("Thu, 01 Jan 2026 12:00:00 GMT", new Date(MOMENT.getTime() + 300)),
    ).toBe(true);
  });

  /** "I do not know" has to mean "send it", not "do not". */
  it("is false when the header cannot be read", () => {
    expect(notModifiedSince("yesterday", MOMENT)).toBe(false);
    expect(notModifiedSince(null, MOMENT)).toBe(false);
  });

  it("reads an obsolete format too", () => {
    expect(notModifiedSince("Thursday, 01-Jan-26 12:00:00 GMT", MOMENT)).toBe(true);
  });
});
