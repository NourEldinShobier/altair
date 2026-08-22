/**
 * View helpers and the request scope.
 *
 * Mirrors actionview/test/template/number_helper_test.rb and
 * text_helper_test.rb, plus the question ERB never had to answer: where a
 * component gets the request from.
 */

import { describe, expect, it } from "bun:test";
import { Current } from "@altair/support";
import {
  formatDate,
  numberToCurrency,
  numberToHuman,
  numberToHumanSize,
  numberToPercentage,
  numberWithDelimiter,
  pluralize,
  timeAgo,
  truncate,
} from "../src/helpers.js";
import {
  hasRequest,
  useCsrfToken,
  useCurrentUser,
  useFlash,
  useFlashMessage,
  usePath,
  useRequest,
  useRequestId,
  useUrl,
} from "../src/context.js";

describe("numbers", () => {
  it("format currency", () => {
    expect(numberToCurrency(1234.5, { locale: "en-US" })).toBe("$1,234.50");
  });

  it("take a currency of their own", () => {
    expect(numberToCurrency(10, { locale: "en-GB", currency: "GBP" })).toBe("£10.00");
  });

  it("delimit thousands", () => {
    expect(numberWithDelimiter(1234567, { locale: "en-US" })).toBe("1,234,567");
  });

  // Rails takes 65.4 to mean 65.4%, where Intl takes a fraction.
  it("format percentages the way Rails does", () => {
    expect(numberToPercentage(65.4, { locale: "en-US", precision: 1 })).toBe("65.4%");
  });

  it("shorten large numbers", () => {
    expect(numberToHuman(1234, { locale: "en-US" })).toBe("1.23 thousand");
    expect(numberToHuman(1_500_000, { locale: "en-US" })).toBe("1.5 million");
  });

  // Rails counts in 1024s, so a KB here is a kibibyte, as it is on disk.
  it("shorten byte counts", () => {
    expect(numberToHumanSize(500)).toBe("500 B");
    expect(numberToHumanSize(1536, { locale: "en-US" })).toBe("1.5 KB");
    expect(numberToHumanSize(1024 * 1024, { locale: "en-US" })).toBe("1 MB");
  });

  it("keep the sign on a negative size", () => {
    expect(numberToHumanSize(-1536, { locale: "en-US" })).toBe("-1.5 KB");
  });
});

describe("text", () => {
  it("leaves short text alone", () => {
    expect(truncate("short", { length: 30 })).toBe("short");
  });

  // The omission counts toward the length, or truncating makes text longer.
  it("never returns more than the length asked for", () => {
    const result = truncate("a".repeat(100), { length: 20 });

    expect(result).toHaveLength(20);
    expect(result.endsWith("...")).toBe(true);
  });

  it("takes an omission of its own", () => {
    expect(truncate("abcdefghij", { length: 6, omission: "…" })).toBe("abcde…");
  });

  it("cuts at a word boundary when asked", () => {
    expect(truncate("the quick brown fox jumps", { length: 20, separator: " " })).toBe(
      "the quick brown...",
    );
  });

  it("counts with the word", () => {
    expect(pluralize(1, "post")).toBe("1 post");
    expect(pluralize(2, "post")).toBe("2 posts");
    expect(pluralize(0, "post")).toBe("0 posts");
  });

  it("takes an irregular plural", () => {
    expect(pluralize(2, "person", "people")).toBe("2 people");
  });

  it("inflects one it was not given", () => {
    expect(pluralize(3, "category")).toBe("3 categories");
  });
});

describe("dates", () => {
  const moment = new Date("2026-03-04T10:00:00Z");

  it("format", () => {
    expect(formatDate(moment, { locale: "en-US", timeZone: "UTC" })).toBe("Mar 4, 2026");
  });

  it("take a style", () => {
    expect(formatDate(moment, { locale: "en-US", dateStyle: "short", timeZone: "UTC" })).toBe(
      "3/4/26",
    );
  });

  it("accept a string", () => {
    expect(formatDate("2026-03-04T10:00:00Z", { locale: "en-US", timeZone: "UTC" })).toBe(
      "Mar 4, 2026",
    );
  });

  // A malformed value from a database should not take down a page.
  it("hand back an unparseable value untouched", () => {
    expect(formatDate("not a date")).toBe("not a date");
  });

  it("say how long ago", () => {
    const now = new Date("2026-03-04T10:00:00Z");

    expect(timeAgo(new Date("2026-03-04T09:59:30Z"), { locale: "en-US", now })).toBe(
      "30 seconds ago",
    );
    expect(timeAgo(new Date("2026-03-01T10:00:00Z"), { locale: "en-US", now })).toBe("3 days ago");
  });

  it("say how long until", () => {
    const now = new Date("2026-03-04T10:00:00Z");
    expect(timeAgo(new Date("2026-03-05T10:00:00Z"), { locale: "en-US", now })).toBe("tomorrow");
  });
});

describe("the request scope", () => {
  const request = new Request("https://example.com/posts/1?page=2");

  it("is empty outside a request", () => {
    expect(useRequest()).toBeUndefined();
    expect(hasRequest()).toBe(false);
    expect(useFlash()).toEqual({});
  });

  it("hands back the request being served", async () => {
    await Current.run({ request }, () => {
      expect(useRequest()).toBe(request);
      expect(hasRequest()).toBe(true);
    });
  });

  it("parses the url", async () => {
    await Current.run({ request }, () => {
      expect(usePath()).toBe("/posts/1");
      expect(useUrl()?.searchParams.get("page")).toBe("2");
    });
  });

  it("carries the request id", async () => {
    await Current.run({ requestId: "abc" }, () => {
      expect(useRequestId()).toBe("abc");
    });
  });

  it("carries whoever is signed in", async () => {
    await Current.run({ user: { name: "Ada" } }, () => {
      expect(useCurrentUser<{ name: string }>()?.name).toBe("Ada");
    });
  });

  it("carries the CSRF token a form has to echo", async () => {
    await Current.run({ csrfToken: "tok" }, () => {
      expect(useCsrfToken()).toBe("tok");
    });
  });

  it("carries the flash", async () => {
    await Current.run({ flash: { notice: "Saved" } }, () => {
      expect(useFlashMessage("notice")).toBe("Saved");
      expect(useFlashMessage("alert")).toBeUndefined();
    });
  });

  // The scope follows the async call chain, so two requests rendering at once
  // cannot see each other's.
  it("keeps concurrent requests apart", async () => {
    const seen: (string | undefined)[] = [];

    await Promise.all([
      Current.run({ requestId: "one" }, async () => {
        await Bun.sleep(5);
        seen.push(useRequestId());
      }),
      Current.run({ requestId: "two" }, async () => {
        await Bun.sleep(1);
        seen.push(useRequestId());
      }),
    ]);

    expect(seen.sort()).toEqual(["one", "two"]);
  });
});
