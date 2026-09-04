/**
 * Showing the code a failure happened in, ported from
 * `actionpack/test/dispatch/exception_wrapper_test.rb` and the source-extract
 * cases in `activesupport/test/`.
 *
 * A stack trace names a position and shows none of it, so reading one means
 * opening each file and counting lines — and the frame that matters is rarely
 * the top one.
 */

import { describe, expect, it } from "bun:test";
import { BacktraceCleaner } from "../src/backtrace-cleaner.js";
import {
  annotatedSourceCode,
  applicationTrace,
  backtraceFrames,
  exceptionName,
  extractSource,
  frameLocation,
  frameworkTrace,
  fullTrace,
  parseBacktraceFrame,
  sourceExtracts,
} from "../src/source-extract.js";

const FILE = "/app/packages/orm/src/model.ts";

const SOURCE = Array.from({ length: 10 }, (_, index) => `line ${String(index + 1)}`).join("\n");

const read = (file: string): string => {
  if (file !== FILE) throw new Error(`ENOENT: ${file}`);

  return SOURCE;
};

const STACK = [
  "TypeError: cannot read x of undefined",
  `    at save (${FILE}:5:11)`,
  `    at ${FILE}:8:3`,
  "    at Object.<anonymous> (/app/node_modules/thing/index.js:2:1)",
].join("\n");

describe("taking a frame apart", () => {
  it("reads a named frame", () => {
    const frame = parseBacktraceFrame(`    at save (${FILE}:5:11)`);

    expect(frame?.method).toBe("save");
    expect(frame?.file).toBe(FILE);
    expect(frame?.lineNumber).toBe(5);
    expect(frame?.column).toBe(11);
  });

  /** A bare `throw` at module scope produces exactly these and nothing else. */
  it("reads a frame with no function name", () => {
    const frame = parseBacktraceFrame(`    at ${FILE}:8:3`);

    expect(frame?.file).toBe(FILE);
    expect(frame?.lineNumber).toBe(8);
    expect(frame?.method).toBeUndefined();
  });

  it("keeps the line as it was written", () => {
    expect(parseBacktraceFrame(`    at save (${FILE}:5:11)`)?.line).toContain("at save");
  });

  it("is not fooled by the message line at the top", () => {
    expect(parseBacktraceFrame("TypeError: cannot read x of undefined")).toBeNull();
  });

  it("gives null for anything else", () => {
    expect(parseBacktraceFrame("")).toBeNull();
    expect(parseBacktraceFrame("not a frame")).toBeNull();
  });

  it("handles a windows path", () => {
    const frame = parseBacktraceFrame("    at save (D:\\app\\src\\model.ts:5:11)");

    expect(frame?.file).toBe("D:\\app\\src\\model.ts");
    expect(frame?.lineNumber).toBe(5);
  });
});

describe("frames of a trace", () => {
  it("takes every frame and drops the message", () => {
    expect(backtraceFrames(STACK)).toHaveLength(3);
  });

  it("keeps them in order", () => {
    expect(backtraceFrames(STACK).map((frame) => frame.lineNumber)).toEqual([5, 8, 2]);
  });

  it("takes lines as readily as a string", () => {
    expect(backtraceFrames(STACK.split("\n"))).toHaveLength(3);
  });

  it("survives no trace at all", () => {
    expect(backtraceFrames(undefined)).toEqual([]);
    expect(backtraceFrames("")).toEqual([]);
  });
});

describe("extracting source", () => {
  const frame = { file: FILE, lineNumber: 5, line: "" };

  it("gives the lines around the failing one", () => {
    const lines = extractSource(frame, { read });

    expect(lines.map((line) => line.number)).toEqual([2, 3, 4, 5, 6, 7, 8]);
  });

  it("marks the failing one and only that one", () => {
    const lines = extractSource(frame, { read });

    expect(lines.filter((line) => line.failing).map((line) => line.number)).toEqual([5]);
  });

  it("carries the text", () => {
    expect(extractSource(frame, { read })[0]?.text).toBe("line 2");
  });

  it("takes a different amount of context", () => {
    expect(extractSource(frame, { read, context: 1 }).map((line) => line.number)).toEqual([
      4, 5, 6,
    ]);
  });

  it("stops at the top of the file", () => {
    const lines = extractSource({ ...frame, lineNumber: 2 }, { read });

    expect(lines[0]?.number).toBe(1);
  });

  it("stops at the end of the file", () => {
    const lines = extractSource({ ...frame, lineNumber: 9 }, { read });

    expect(lines[lines.length - 1]?.number).toBe(10);
  });

  /**
   * The whole point is explaining a failure that already happened; throwing
   * here would replace a useful error with a useless one. A stack can name a
   * file that was deleted, moved, bundled, or never on disk.
   */
  it("gives nothing for a file it cannot read", () => {
    expect(extractSource({ ...frame, file: "/gone.ts" }, { read })).toEqual([]);
  });

  it("gives nothing for a line past the end", () => {
    expect(extractSource({ ...frame, lineNumber: 99 }, { read })).toEqual([]);
  });

  /**
   * Just past the end is the case that matters: the context window still
   * overlaps the file, so without the check this hands back the last few
   * lines as though they were the failure — source for a line that does not
   * exist, which is worse than none.
   */
  it("gives nothing for a line just past the end", () => {
    expect(extractSource({ ...frame, lineNumber: 11 }, { read })).toEqual([]);
  });

  it("gives nothing for a line before the start", () => {
    expect(extractSource({ ...frame, lineNumber: 0 }, { read })).toEqual([]);
  });
});

describe("sourceExtracts", () => {
  it("reads the top frames of an error", () => {
    const extracts = sourceExtracts({ stack: STACK }, { read });

    expect(extracts).toHaveLength(3);
    expect(extracts[0]?.frame.lineNumber).toBe(5);
  });

  it("attaches the source it could read", () => {
    const extracts = sourceExtracts({ stack: STACK }, { read });

    expect(extracts[0]?.lines).not.toHaveLength(0);
  });

  it("leaves the source empty for a frame it could not read", () => {
    const extracts = sourceExtracts({ stack: STACK }, { read });

    expect(extracts[2]?.lines).toEqual([]);
  });

  /** A deep recursion is thousands of frames; a file read each is an outage. */
  it("stops after a few frames", () => {
    const deep = ["Error: boom", ...Array.from({ length: 500 }, () => `    at f (${FILE}:5:1)`)];

    expect(sourceExtracts(deep.join("\n"), { read })).toHaveLength(5);
  });

  it("takes a different limit", () => {
    expect(sourceExtracts({ stack: STACK }, { read, limit: 1 })).toHaveLength(1);
  });

  it("survives an error with no stack", () => {
    expect(sourceExtracts({}, { read })).toEqual([]);
  });
});

describe("annotating", () => {
  it("marks the failing line in the gutter", () => {
    const [extract] = sourceExtracts({ stack: STACK }, { read, limit: 1 });
    const annotated = annotatedSourceCode(extract as never);

    expect(annotated).toContain("> 5 | line 5");
    expect(annotated).toContain("  4 | line 4");
  });

  /**
   * In the gutter rather than around the text, so the code stays copyable and
   * an arrow does not shift every column after it and make the column number
   * a lie.
   */
  it("does not touch the code itself", () => {
    const [extract] = sourceExtracts({ stack: STACK }, { read, limit: 1 });

    for (const line of annotatedSourceCode(extract as never).split("\n")) {
      expect(line.split("| ")[1]).toMatch(/^line \d+$/);
    }
  });

  it("lines the numbers up when they differ in width", () => {
    const [extract] = sourceExtracts(`Error\n    at f (${FILE}:9:1)`, { read, limit: 1 });
    const lines = annotatedSourceCode(extract as never).split("\n");

    expect(lines[0]).toContain(" 6 |");
    expect(lines.at(-1)).toContain("10 |");
    expect(new Set(lines.map((line) => line.indexOf("|"))).size).toBe(1);
  });

  it("gives nothing for an extract with no source", () => {
    expect(annotatedSourceCode({ frame: { file: "x", lineNumber: 1, line: "" }, lines: [] })).toBe(
      "",
    );
  });
});

describe("frameLocation", () => {
  it("gives what an editor opens", () => {
    expect(frameLocation({ file: FILE, lineNumber: 5, line: "" })).toBe(`${FILE}:5`);
  });
});

describe("the three traces", () => {
  const cleaner = new BacktraceCleaner().addSilencer((line) => line.includes("node_modules"));

  /** A framework failure almost always started with a call the reader can change. */
  it("keeps the application's own frames", () => {
    const application = applicationTrace({ stack: STACK }, cleaner);

    expect(application.join("\n")).toContain("model.ts");
    expect(application.join("\n")).not.toContain("node_modules");
  });

  it("keeps only the others in the framework trace", () => {
    const framework = frameworkTrace({ stack: STACK }, cleaner);

    expect(framework.join("\n")).toContain("node_modules");
    expect(framework.join("\n")).not.toContain("model.ts");
  });

  it("keeps everything in the full trace", () => {
    const full = fullTrace({ stack: STACK }, cleaner);

    expect(full).toHaveLength(3);
  });

  it("survives an error with no stack", () => {
    expect(applicationTrace({}, cleaner)).toEqual([]);
  });
});

describe("exceptionName", () => {
  it("names an ordinary error by its message class", () => {
    expect(exceptionName(new TypeError("x"))).toBe("TypeError");
  });

  /** A subclass that forgot to set `name` still reports as its own class. */
  it("prefers the constructor over a name nobody set", () => {
    class RecordNotFound extends Error {}

    expect(exceptionName(new RecordNotFound("x"))).toBe("RecordNotFound");
  });

  it("respects a name that was set", () => {
    const error = new Error("x");
    error.name = "Deliberate";

    expect(exceptionName(error)).toBe("Deliberate");
  });

  it("says something for a thrown non-error", () => {
    expect(exceptionName("a string")).toBe("string");
    expect(exceptionName(undefined)).toBe("undefined");
  });
});
