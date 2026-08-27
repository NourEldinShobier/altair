/**
 * Writing a time down, ported from
 * `activesupport/test/core_ext/time_ext_test.rb`.
 *
 * Each of these is a wire format somebody else defined. `toISOString` covers
 * one of the five, and the rest are why the file exists.
 */

import { describe, expect, it } from "bun:test";
import {
  dayOfYear,
  formattedOffset,
  httpDate,
  iso8601,
  rfc2822,
  strftime,
  toDbFormat,
  toEpochSeconds,
  xmlschema,
} from "../src/formats.js";

/** A Thursday in August, 13:05:09.123 UTC. */
const when = () => new Date(Date.UTC(2026, 7, 27, 13, 5, 9, 123));

/**
 * A Set-Cookie expiry in any other format is ignored by some browsers and
 * honoured by others, which is a bug that reproduces on one machine in four.
 */
describe("an HTTP date", () => {
  it("is the one spelling headers accept", () => {
    expect(httpDate(when())).toBe("Thu, 27 Aug 2026 13:05:09 GMT");
  });

  it("pads a single-digit day", () => {
    expect(httpDate(new Date(Date.UTC(2026, 0, 5, 1, 2, 3)))).toBe("Mon, 05 Jan 2026 01:02:03 GMT");
  });
});

describe("an email date", () => {
  it("carries a numeric offset rather than a name", () => {
    expect(rfc2822(when())).toBe("Thu, 27 Aug 2026 13:05:09 +0000");
  });
});

describe("an XML timestamp", () => {
  it("drops the milliseconds by default", () => {
    expect(xmlschema(when())).toBe("2026-08-27T13:05:09Z");
  });

  it("keeps as many as it is asked for", () => {
    expect(xmlschema(when(), 3)).toBe("2026-08-27T13:05:09.123Z");
  });

  it("answers to its other two names", () => {
    expect(iso8601(when())).toBe(xmlschema(when()));
  });
});

describe("the database format", () => {
  it("is what somebody would paste into a query", () => {
    expect(toDbFormat(when())).toBe("2026-08-27 13:05:09");
  });
});

/**
 * `getTimezoneOffset` counts backwards — it answers -60 for UTC+1 — and
 * copying that number straight into a string is how a timestamp ends up an
 * hour and a half wrong in the other direction.
 */
describe("an offset", () => {
  it("reads the way a person writes one", () => {
    expect(formattedOffset(-60)).toBe("+01:00");
    expect(formattedOffset(300)).toBe("-05:00");
    expect(formattedOffset(0)).toBe("+00:00");
  });

  it("handles a half-hour zone", () => {
    expect(formattedOffset(-330)).toBe("+05:30");
  });

  it("can leave the colon out", () => {
    expect(formattedOffset(-60, false)).toBe("+0100");
  });
});

describe("a format string", () => {
  it("fills in the directives it knows", () => {
    expect(strftime(when(), "%Y-%m-%d %H:%M:%S")).toBe("2026-08-27 13:05:09");
    expect(strftime(when(), "%a %b %d")).toBe("Thu Aug 27");
  });

  it("has the day of the year and the epoch", () => {
    expect(strftime(when(), "%j")).toBe("239");
    expect(strftime(when(), "%s")).toBe(String(toEpochSeconds(when())));
  });

  it("leaves a directive it does not know alone", () => {
    expect(strftime(when(), "%Q")).toBe("%Q");
  });

  it("writes a literal percent", () => {
    expect(strftime(when(), "100%%")).toBe("100%");
  });
});

describe("the day of the year", () => {
  it("counts from one", () => {
    expect(dayOfYear(new Date(Date.UTC(2026, 0, 1)))).toBe(1);
    expect(dayOfYear(new Date(Date.UTC(2026, 11, 31)))).toBe(365);
  });

  it("counts the extra day in a leap year", () => {
    expect(dayOfYear(new Date(Date.UTC(2024, 11, 31)))).toBe(366);
  });
});
