/**
 * Serving part of a file, ported from `actionpack/test/dispatch/response_test.rb`
 * and the byte-range cases Rails inherits from Rack.
 *
 * Without this a video cannot seek, Safari will not play media at all, and a
 * download that lost its connection at 4GB starts again.
 */

import { describe, expect, it } from "bun:test";
import {
  contentRange,
  ifRangeSatisfied,
  parseRange,
  partialResponse,
  rangeLength,
  unsatisfiedContentRange,
} from "../src/ranges.js";

const SIZE = 1000;

function request(headers: Record<string, string> = {}): Request {
  return new Request("https://app.test/file", { headers });
}

describe("parseRange", () => {
  it("reads a simple range", () => {
    expect(parseRange("bytes=0-499", SIZE)).toEqual([{ start: 0, end: 499 }]);
  });

  it("reads an open-ended range as the rest of the file", () => {
    expect(parseRange("bytes=500-", SIZE)).toEqual([{ start: 500, end: 999 }]);
  });

  /** The one form that reads backwards, and the one most often got wrong. */
  it("reads a suffix range as the last n bytes", () => {
    expect(parseRange("bytes=-500", SIZE)).toEqual([{ start: 500, end: 999 }]);
  });

  it("does not run a suffix range past the start of the file", () => {
    expect(parseRange("bytes=-5000", SIZE)).toEqual([{ start: 0, end: 999 }]);
  });

  it("clamps an end past the last byte", () => {
    expect(parseRange("bytes=0-9999", SIZE)).toEqual([{ start: 0, end: 999 }]);
  });

  it("reads the whole file asked for explicitly", () => {
    expect(parseRange("bytes=0-999", SIZE)).toEqual([{ start: 0, end: 999 }]);
  });

  it("gives null when there is no header", () => {
    expect(parseRange(null, SIZE)).toBeNull();
  });

  /** A unit we do not understand has to be ignored rather than guessed at. */
  it("gives null for a unit that is not bytes", () => {
    expect(parseRange("items=0-10", SIZE)).toBeNull();
    expect(parseRange("nonsense", SIZE)).toBeNull();
  });

  /**
   * Different from null, and gets a different response: nothing to do versus
   * 416.
   */
  it("gives an empty list for a range outside the file", () => {
    expect(parseRange("bytes=1000-1500", SIZE)).toEqual([]);
  });

  it("gives an empty list for a backwards range", () => {
    expect(parseRange("bytes=500-100", SIZE)).toEqual([]);
  });

  it("gives an empty list for a zero-length suffix", () => {
    expect(parseRange("bytes=-0", SIZE)).toEqual([]);
  });

  it("reads several", () => {
    expect(parseRange("bytes=0-99,200-299", SIZE)).toEqual([
      { start: 0, end: 99 },
      { start: 200, end: 299 },
    ]);
  });

  /**
   * What the specification says: a client that asked for something outside
   * the file is told so rather than quietly given the part that existed.
   */
  it("treats one unsatisfiable range as making the whole header so", () => {
    expect(parseRange("bytes=0-99,5000-6000", SIZE)).toEqual([]);
  });

  it("ignores surrounding space", () => {
    expect(parseRange(" bytes=0-99 ", SIZE)).toEqual([{ start: 0, end: 99 }]);
  });

  it("takes the header case-insensitively", () => {
    expect(parseRange("BYTES=0-99", SIZE)).toEqual([{ start: 0, end: 99 }]);
  });
});

describe("the header values", () => {
  /** Inclusive at both ends, which is how the header counts and JS does not. */
  it("counts a range inclusively", () => {
    expect(rangeLength({ start: 0, end: 499 })).toBe(500);
    expect(rangeLength({ start: 5, end: 5 })).toBe(1);
  });

  it("writes a content range", () => {
    expect(contentRange({ start: 0, end: 499 }, SIZE)).toBe("bytes 0-499/1000");
  });

  it("writes the unsatisfied form with only the size", () => {
    expect(unsatisfiedContentRange(SIZE)).toBe("bytes */1000");
  });
});

describe("ifRangeSatisfied", () => {
  it("is satisfied when there is no condition", () => {
    expect(ifRangeSatisfied(null, '"abc"')).toBe(true);
  });

  it("is satisfied when the validator still matches", () => {
    expect(ifRangeSatisfied('"abc"', '"abc"')).toBe(true);
  });

  /**
   * The file changed, so the right answer is the whole new one — a slice
   * spliced onto a stale prefix is a corrupt file that no error describes.
   */
  it("is not satisfied when it does not", () => {
    expect(ifRangeSatisfied('"abc"', '"def"')).toBe(false);
  });

  /**
   * Equivalent is not good enough to join two halves of a byte stream. The
   * case that matters is the matching pair: a client echoing back the weak
   * etag it was given still must not get a partial response, because two
   * bodies that are equivalent need not be byte-identical.
   */
  it("is never satisfied by a weak etag, even one that matches", () => {
    expect(ifRangeSatisfied('W/"abc"', 'W/"abc"')).toBe(false);
    expect(ifRangeSatisfied('W/"abc"', '"abc"')).toBe(false);
    expect(ifRangeSatisfied('"abc"', 'W/"abc"')).toBe(false);
  });

  it("is not satisfied when there is nothing to compare against", () => {
    expect(ifRangeSatisfied('"abc"', null)).toBe(false);
  });
});

describe("partialResponse", () => {
  const slice = () => "partial";

  it("gives null when nothing asked for a range", () => {
    expect(partialResponse(request(), slice, { size: SIZE })).toBeNull();
  });

  it("answers 206 for a range it can serve", () => {
    const response = partialResponse(request({ range: "bytes=0-499" }), slice, { size: SIZE });

    expect(response?.status).toBe(206);
  });

  it("names the range and the size", () => {
    const response = partialResponse(request({ range: "bytes=0-499" }), slice, { size: SIZE });

    expect(response?.headers.get("content-range")).toBe("bytes 0-499/1000");
    expect(response?.headers.get("content-length")).toBe("500");
  });

  it("says ranges are available", () => {
    const response = partialResponse(request({ range: "bytes=0-499" }), slice, { size: SIZE });

    expect(response?.headers.get("accept-ranges")).toBe("bytes");
  });

  /** With the size named, so the client can ask again correctly. */
  it("answers 416 for a range it cannot", () => {
    const response = partialResponse(request({ range: "bytes=5000-6000" }), slice, { size: SIZE });

    expect(response?.status).toBe(416);
    expect(response?.headers.get("content-range")).toBe("bytes */1000");
  });

  it("carries the headers the whole response would have", () => {
    const response = partialResponse(request({ range: "bytes=0-99" }), slice, {
      size: SIZE,
      headers: { "content-disposition": 'attachment; filename="a.mp4"' },
    });

    expect(response?.headers.get("content-disposition")).toContain("a.mp4");
  });

  it("carries the content type", () => {
    const response = partialResponse(request({ range: "bytes=0-99" }), slice, {
      size: SIZE,
      contentType: "video/mp4",
    });

    expect(response?.headers.get("content-type")).toBe("video/mp4");
  });

  it("slices what it was told to", async () => {
    const response = partialResponse(
      request({ range: "bytes=10-19" }),
      (range) => `${String(range.start)}-${String(range.end)}`,
      { size: SIZE },
    );

    expect(await response?.text()).toBe("10-19");
  });

  /** Legal, and almost nothing sends one; the first is a correct answer. */
  it("serves the first when several were asked for", () => {
    const response = partialResponse(request({ range: "bytes=0-99,200-299" }), slice, {
      size: SIZE,
    });

    expect(response?.headers.get("content-range")).toBe("bytes 0-99/1000");
  });

  it("falls through when the conditional range no longer applies", () => {
    const response = partialResponse(request({ range: "bytes=0-99", "if-range": '"old"' }), slice, {
      size: SIZE,
      etag: '"new"',
    });

    expect(response).toBeNull();
  });

  it("serves the range when the conditional range still applies", () => {
    const response = partialResponse(
      request({ range: "bytes=0-99", "if-range": '"same"' }),
      slice,
      { size: SIZE, etag: '"same"' },
    );

    expect(response?.status).toBe(206);
  });
});
