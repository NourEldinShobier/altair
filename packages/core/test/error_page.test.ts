/**
 * The page a developer sees when a request raises, ported from
 * `actionpack/test/dispatch/debug_exceptions_test.rb`.
 *
 * A stack trace tells you where. This tells you where and what the line said,
 * which is the difference between reading a path and reading the code.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseStack, renderErrorPage, sourceFor } from "../src/error_page.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "altair-error-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const request = () => new Request("https://app.example/posts/7?draft=1", { method: "POST" });

describe("taking a stack apart", () => {
  it("reads a frame's file, line and column", () => {
    const stack = ["Error: boom", "    at doThing (/app/src/posts.ts:12:9)"].join("\n");

    const [frame] = parseStack(stack, "/app");

    expect(frame).toMatchObject({ name: "doThing", line: 12, column: 9 });
    expect(frame?.file).toContain("posts.ts");
  });

  it("reads a frame with no function name", () => {
    const [frame] = parseStack("Error\n    at /app/src/posts.ts:3:1", "/app");

    expect(frame?.name).toBe("(anonymous)");
    expect(frame?.line).toBe(3);
  });

  it("ignores the message line", () => {
    expect(parseStack("Error: boom", "/app")).toEqual([]);
  });

  it("handles an empty stack", () => {
    expect(parseStack(undefined, "/app")).toEqual([]);
  });
});

/**
 * A trace is forty lines and three of them are yours. Separating them is what
 * makes the page readable at all — Rails calls it the application trace and
 * puts it first for the same reason.
 */
describe("telling the application's frames from everyone else's", () => {
  const stackFor = (files: string[]) =>
    ["Error: boom", ...files.map((file) => `    at fn (${file}:1:1)`)].join("\n");

  it("counts a file under the project as the application's", () => {
    const frames = parseStack(stackFor(["/app/src/posts.ts"]), "/app");

    expect(frames[0]?.application).toBe(true);
  });

  it("does not count node_modules", () => {
    const frames = parseStack(stackFor(["/app/node_modules/x/index.js"]), "/app");

    expect(frames[0]?.application).toBe(false);
  });

  it("does not count the runtime's own frames", () => {
    const frames = parseStack(stackFor(["node:internal/process", "bun:sql"]), "/app");

    expect(frames.map((frame) => frame.application)).toEqual([false, false]);
  });

  it("does not count a file outside the project", () => {
    const frames = parseStack(stackFor(["/elsewhere/lib.ts"]), "/app");

    expect(frames[0]?.application).toBe(false);
  });
});

describe("reading the source around a frame", () => {
  it("gives the failing line and its neighbours", async () => {
    const file = join(root, "posts.ts");
    await writeFile(file, Array.from({ length: 20 }, (_, at) => `line ${at + 1}`).join("\n"));

    const extract = await sourceFor(
      { name: "fn", file, line: 10, column: 1, application: true },
      2,
    );

    expect(extract?.lines.map((one) => one.number)).toEqual([8, 9, 10, 11, 12]);
    expect(extract?.lines[2]?.text).toBe("line 10");
  });

  it("does not run off the start of the file", async () => {
    const file = join(root, "short.ts");
    await writeFile(file, "one\ntwo\nthree");

    const extract = await sourceFor({ name: "fn", file, line: 1, column: 1, application: true }, 5);

    expect(extract?.lines[0]?.number).toBe(1);
  });

  /**
   * This runs when something has already gone wrong. An error page that raises
   * because a file moved replaces a useful answer with none.
   */
  it("gives nothing rather than throwing when the file is gone", async () => {
    const extract = await sourceFor({
      name: "fn",
      file: join(root, "missing.ts"),
      line: 1,
      column: 1,
      application: true,
    });

    expect(extract).toBeUndefined();
  });
});

describe("the page", () => {
  const errorAt = async (file: string) => {
    await writeFile(file, "const a = 1;\nthrow new Error('the rates service is down');\n");

    const error = new Error("the rates service is down");
    error.stack = `Error: the rates service is down\n    at charge (${file}:2:7)`;

    return error;
  };

  it("names the error and its message", async () => {
    const html = await renderErrorPage(await errorAt(join(root, "billing.ts")), request(), {
      root,
      status: 500,
    });

    expect(html).toContain("the rates service is down");
    expect(html).toContain("<h1>Error</h1>");
  });

  it("shows the failing line of source", async () => {
    const html = await renderErrorPage(await errorAt(join(root, "billing.ts")), request(), {
      root,
      status: 500,
    });

    expect(html).toContain("the rates service is down");
    expect(html).toContain("const a = 1;");
    expect(html).toContain('class="here"');
  });

  it("says which request it was", async () => {
    const html = await renderErrorPage(await errorAt(join(root, "billing.ts")), request(), {
      root,
      status: 500,
    });

    expect(html).toContain("POST");
    expect(html).toContain("/posts/7");
  });

  it("shows the parameters when it is given them", async () => {
    const html = await renderErrorPage(await errorAt(join(root, "billing.ts")), request(), {
      root,
      status: 500,
      params: { id: "7" },
    });

    expect(html).toContain("Parameters");
    expect(html).toContain("id");
  });

  /**
   * A page that prints the session cookie is a page that gets pasted into a
   * chat window with the session cookie in it.
   */
  it("leaves the cookie and authorization headers out", async () => {
    const withSecrets = new Request("https://app.example/", {
      headers: {
        cookie: "_session=verysecret",
        authorization: "Bearer alsosecret",
        "x-ordinary": "fine",
      },
    });

    const html = await renderErrorPage(await errorAt(join(root, "billing.ts")), withSecrets, {
      root,
      status: 500,
    });

    expect(html).not.toContain("verysecret");
    expect(html).not.toContain("alsosecret");
    expect(html).toContain("x-ordinary");
  });

  it("escapes a message that contains markup", async () => {
    const error = new Error("<script>alert(1)</script>");
    error.stack = "Error\n    at fn (/nowhere.ts:1:1)";

    const html = await renderErrorPage(error, request(), { root, status: 500 });

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders something for a thrown non-error", async () => {
    const html = await renderErrorPage("just a string", request(), { root, status: 500 });

    expect(html).toContain("just a string");
  });

  it("renders when there is no stack at all", async () => {
    const error = new Error("boom");
    error.stack = undefined;

    const html = await renderErrorPage(error, request(), { root, status: 500 });

    expect(html).toContain("boom");
    expect(html).toContain("No frames.");
  });

  /**
   * The error page has to work when the asset pipeline is what broke, so
   * nothing on it may be fetched.
   */
  it("asks the network for nothing", async () => {
    const html = await renderErrorPage(await errorAt(join(root, "billing.ts")), request(), {
      root,
      status: 500,
    });

    expect(html).not.toContain("<link");
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/https?:\/\/(?!app\.example)/);
  });

  it("opens on a frame the developer can act on", async () => {
    const mine = join(root, "mine.ts");
    await writeFile(mine, "// my code\n// the failing line\n");

    const error = new Error("boom");
    error.stack = [
      "Error: boom",
      `    at deep (${join(root, "node_modules", "dep", "index.js")}:9:1)`,
      `    at mine (${mine}:2:1)`,
    ].join("\n");

    const html = await renderErrorPage(error, request(), { root, status: 500 });

    // The dependency's frame is first in the trace; the source shown is not.
    expect(html).toContain("the failing line");
  });
});
