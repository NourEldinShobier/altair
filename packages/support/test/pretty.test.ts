/**
 * The development log format.
 *
 * Colour is asserted through the escape codes rather than by eye, since the
 * whole point is that the right thing is highlighted and nothing else is.
 */

import { describe, expect, it } from "bun:test";
import { colourEnabled, identityColour, prettyFormatter, type LogEntry } from "../src/index.js";

const ESC = "\u001b";
const entry = (over: Partial<LogEntry> = {}): LogEntry => ({
  level: "info",
  message: "completed",
  time: new Date("2026-01-15T12:34:56.789Z"),
  payload: {},
  ...over,
});

const plain = prettyFormatter({ colour: false });
const colour = prettyFormatter({ colour: true });

/** What the line reads as once the escapes are taken out. */
const stripped = (line: string) => line.replaceAll(new RegExp(`${ESC}\\[\\d+m`, "gu"), "");

describe("the line", () => {
  it("leads with the time and the level", () => {
    expect(plain(entry())).toStartWith("12:34:56.789 INFO  completed");
  });

  it("pads the level, so the messages line up", () => {
    expect(plain(entry({ level: "warn" }))).toContain("WARN  completed");
    expect(plain(entry({ level: "debug" }))).toContain("DEBUG completed");
  });

  it("writes the payload as pairs", () => {
    expect(plain(entry({ payload: { status: 200 } }))).toEndWith("status=200");
  });

  // Scrolling a log should be scanning a column, not reading every line.
  it("puts the same keys in the same place every time", () => {
    const line = plain(entry({ payload: { queries: 3, status: 200, path: "/a", method: "GET" } }));

    expect(stripped(line)).toContain("method=GET path=/a status=200 queries=3");
  });

  it("quotes a value with spaces so the pairs stay separable", () => {
    expect(plain(entry({ payload: { sql: "SELECT 1" } }))).toContain('sql="SELECT 1"');
  });
});

describe("what gets colour", () => {
  it("colours the level by how bad it is", () => {
    expect(colour(entry({ level: "info" }))).toContain(`${ESC}[34mINFO`);
    expect(colour(entry({ level: "warn" }))).toContain(`${ESC}[33mWARN`);
    expect(colour(entry({ level: "error" }))).toContain(`${ESC}[31mERROR`);
  });

  // The colours a browser's devtools would give.
  it("colours a status by its range", () => {
    expect(colour(entry({ payload: { status: 200 } }))).toContain(`${ESC}[32m200`);
    expect(colour(entry({ payload: { status: 404 } }))).toContain(`${ESC}[33m404`);
    expect(colour(entry({ payload: { status: 500 } }))).toContain(`${ESC}[31m500`);
  });

  it("colours a duration by how slow it was", () => {
    expect(colour(entry({ payload: { durationMs: 12 } }))).toContain(`${ESC}[32m12`);
    expect(colour(entry({ payload: { durationMs: 120 } }))).toContain(`${ESC}[33m120`);
    expect(colour(entry({ payload: { durationMs: 900 } }))).toContain(`${ESC}[31m900`);
  });

  // The eye follows a colour far faster than it reads a uuid, which is the
  // only reason a request id in a log is useful at all.
  it("gives one request one colour, every time", () => {
    expect(identityColour("abc-123")).toBe(identityColour("abc-123"));
  });

  it("gives different requests different colours, usually", () => {
    const ids = ["a", "b", "c", "d", "e", "f"].map(identityColour);
    expect(new Set(ids).size).toBeGreaterThan(1);
  });

  it("puts the request id in front of the message, not among the pairs", () => {
    const line = stripped(colour(entry({ payload: { requestId: "abcdefgh-1234", status: 200 } })));

    expect(line).toContain("[abcdefgh] completed");
    expect(line).not.toContain("requestId=");
  });
});

describe("errors", () => {
  const failed = () => {
    const error = new Error("kaboom");
    error.stack = "Error: kaboom\n    at one (a.ts:1:1)\n    at two (b.ts:2:2)";
    return entry({ level: "error", message: "failed", payload: { error } });
  };

  it("shows the message on the line", () => {
    expect(plain(failed())).toContain("error=Error: kaboom");
  });

  // A stack on one line is unreadable, and a stack that is not printed is why
  // somebody goes looking for it in the database.
  it("puts the stack underneath, indented", () => {
    const lines = plain(failed()).split("\n");

    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe("    at one (a.ts:1:1)");
  });

  it("can be told not to", () => {
    expect(prettyFormatter({ colour: false, stacks: false })(failed())).not.toContain("\n");
  });
});

describe("whether to use colour at all", () => {
  // The agreed way to ask.
  it("obeys NO_COLOR", () => {
    expect(colourEnabled({ NO_COLOR: "1" })).toBe(false);
  });

  it("ignores an empty NO_COLOR, as the convention says", () => {
    expect(colourEnabled({ NO_COLOR: "" })).toBe(false);
  });

  it("obeys FORCE_COLOR", () => {
    expect(colourEnabled({ FORCE_COLOR: "1" })).toBe(true);
    expect(colourEnabled({ FORCE_COLOR: "0" })).toBe(false);
  });

  it("lets NO_COLOR win over FORCE_COLOR", () => {
    expect(colourEnabled({ NO_COLOR: "1", FORCE_COLOR: "1" })).toBe(false);
  });

  // Escape codes in a stored log are rubbish every later reader has to strip.
  it("says no when nothing is watching", () => {
    expect(colourEnabled({})).toBe(Boolean(process.stdout.isTTY));
  });

  it("writes nothing but the text when colour is off", () => {
    const line = plain(entry({ level: "error", payload: { status: 500 } }));
    expect(line).not.toContain(ESC);
  });
});
