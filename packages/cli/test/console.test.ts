/**
 * The console.
 *
 * Rails' `rails console` is a REPL with the application booted. Bun has no
 * `node:repl`, so this is built on readline and an async function — which is
 * why `await` works at the prompt without ceremony, and why that is the first
 * thing tested.
 */

import { describe, expect, it } from "bun:test";
import { PassThrough } from "node:stream";
import {
  declaredName,
  evaluateInput,
  formatValue,
  isComplete,
  startConsole,
  type ConsoleContext,
} from "../src/console.js";

describe("completeness", () => {
  it("accepts a balanced line", () => {
    expect(isComplete("1 + 1")).toBe(true);
    expect(isComplete("Post.find(1)")).toBe(true);
  });

  it("waits for a closing bracket", () => {
    expect(isComplete("Post.where({")).toBe(false);
    expect(isComplete("[1, 2,")).toBe(false);
  });

  it("accepts it once it closes", () => {
    expect(isComplete("Post.where({\n  id: 1,\n})")).toBe(true);
  });

  // A bracket inside a string is not a bracket.
  it("ignores brackets in strings", () => {
    expect(isComplete('"("')).toBe(true);
    expect(isComplete("'a { b'")).toBe(true);
    expect(isComplete("`x ( y`")).toBe(true);
  });

  it("waits for a closing quote", () => {
    expect(isComplete('"unfinished')).toBe(false);
  });

  it("is not fooled by an escaped quote", () => {
    expect(isComplete('"a \\" b"')).toBe(true);
  });
});

describe("declarations", () => {
  it("are recognised", () => {
    expect(declaredName("const post = Post.find(1)")).toEqual({
      name: "post",
      expression: "Post.find(1)",
    });
  });

  it("work with let and var", () => {
    expect(declaredName("let x = 1")?.name).toBe("x");
    expect(declaredName("var y = 2")?.name).toBe("y");
  });

  it("are not found in an ordinary expression", () => {
    expect(declaredName("Post.find(1)")).toBeUndefined();
    expect(declaredName("constant + 1")).toBeUndefined();
  });
});

describe("evaluating", () => {
  it("returns an expression's value", async () => {
    expect((await evaluateInput("1 + 1", {})).value).toBe(2);
  });

  it("sees the names in the context", async () => {
    const context: ConsoleContext = { Post: { table: "posts" } };
    expect((await evaluateInput("Post.table", context)).value).toBe("posts");
  });

  // The reason this is built on an async function: a console for an ORM whose
  // every read is a promise is useless without it.
  it("awaits", async () => {
    const context: ConsoleContext = { find: async () => ({ title: "Hello" }) };
    expect((await evaluateInput("(await find()).title", context)).value).toBe("Hello");
  });

  // The difference between a console and a calculator.
  it("remembers a declaration for the next line", async () => {
    const context: ConsoleContext = {};

    const first = await evaluateInput("const total = 40 + 2", context);
    expect(first.assigned).toBe("total");
    expect(context.total).toBe(42);

    expect((await evaluateInput("total + 1", context)).value).toBe(43);
  });

  it("remembers an awaited declaration", async () => {
    const context: ConsoleContext = { load: async () => 7 };

    await evaluateInput("const value = await load()", context);
    expect(context.value).toBe(7);
  });

  it("runs statements that are not expressions", async () => {
    const context: ConsoleContext = { seen: [] as number[] };
    await evaluateInput("for (let i = 0; i < 3; i++) seen.push(i)", context);

    expect(context.seen).toEqual([0, 1, 2]);
  });

  it("lets the line's own error through", async () => {
    await expect(evaluateInput("throw new Error('boom')", {})).rejects.toThrow("boom");
  });
});

describe("formatting", () => {
  it("quotes a string, so an empty one is visible", () => {
    expect(formatValue("hello")).toBe('"hello"');
    expect(formatValue("")).toBe('""');
  });

  it("names undefined", () => {
    expect(formatValue(undefined)).toBe("undefined");
  });

  it("renders an error as a message rather than a stack", () => {
    expect(formatValue(new TypeError("nope"))).toBe("TypeError: nope");
  });

  it("renders objects readably", () => {
    expect(formatValue({ id: 1 })).toContain("id");
  });

  // An object with a throwing getter should not take the prompt down.
  it("survives a value that refuses to be inspected", () => {
    const hostile = {
      get boom(): never {
        throw new Error("no");
      },
    };

    expect(() => formatValue(hostile)).not.toThrow();
  });
});

/** Drives the loop over a pipe, so the prompt needs no terminal. */
async function runConsole(lines: string[], context: ConsoleContext = {}): Promise<string> {
  const input = new PassThrough();
  const output = new PassThrough();

  let written = "";
  output.on("data", (chunk: Buffer) => {
    written += chunk.toString();
  });

  const finished = startConsole(context, {
    io: { input, output },
    prompt: "",
  });

  for (const line of lines) input.write(`${line}\n`);
  input.end();

  await finished;
  return written;
}

describe("the loop", () => {
  it("prints the value of each line", async () => {
    expect(await runConsole(["1 + 1"])).toContain("=> 2");
  });

  it("says what a declaration bound", async () => {
    expect(await runConsole(["const x = 5"])).toContain("x = 5");
  });

  it("carries state between lines", async () => {
    const output = await runConsole(["const x = 5", "x * 2"]);
    expect(output).toContain("=> 10");
  });

  // An error at the prompt is an answer, not a reason to stop.
  it("keeps going after an error", async () => {
    const output = await runConsole(["missingName", "1 + 1"]);

    expect(output).toContain("ReferenceError");
    expect(output).toContain("=> 2");
  });

  it("joins a line that is still open", async () => {
    const output = await runConsole(["[1,", "2]"]);
    expect(output).toContain("1");
    expect(output).toContain("2");
  });

  it("leaves on .exit", async () => {
    const output = await runConsole([".exit", "1 + 1"]);
    expect(output).not.toContain("=> 2");
  });

  it("ignores a blank line", async () => {
    expect(await runConsole(["", "1 + 1"])).toContain("=> 2");
  });

  it("prints a banner when given one", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let written = "";
    output.on("data", (chunk: Buffer) => {
      written += chunk.toString();
    });

    const finished = startConsole({}, { io: { input, output }, banner: "Altair console" });
    input.end();
    await finished;

    expect(written).toContain("Altair console");
  });
});

// Inspecting a model prints every method and internal symbol on it, which
// buries the two fields the question was about. Rails prints the columns.
describe("printing records", () => {
  class Post {
    constructor(private readonly row: Record<string, unknown>) {}
    attributes(): Record<string, unknown> {
      return this.row;
    }
    save(): void {}
  }

  it("renders a record as its class and columns", () => {
    expect(formatValue(new Post({ id: 1, title: "Hello" }))).toBe('#<Post id: 1, title: "Hello">');
  });

  it("renders a list of records the same way", () => {
    const posts = [new Post({ id: 1 }), new Post({ id: 2 })];
    expect(formatValue(posts)).toBe("[#<Post id: 1>, #<Post id: 2>]");
  });

  it("prints no methods", () => {
    expect(formatValue(new Post({ id: 1 }))).not.toContain("save");
  });

  it("falls back to the class name when attributes throw", () => {
    class Broken {
      attributes(): Record<string, unknown> {
        throw new Error("no");
      }
    }

    expect(formatValue(new Broken())).toBe("#<Broken>");
  });

  it("leaves a plain object alone", () => {
    expect(formatValue({ id: 1 })).toContain("id");
  });
});
