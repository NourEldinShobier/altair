/**
 * Making a stack trace readable, ported from
 * `activesupport/test/clean_backtrace_test.rb`.
 *
 * A trace from anything running on a framework is forty lines and three of them
 * are yours. The other thirty-seven are true, and they are the reason nobody
 * reads the trace.
 */

import { describe, expect, it } from "bun:test";
import { BacktraceCleaner, defaultBacktraceCleaner, prettyFormatter } from "../src/index.js";

const trace = [
  "Error: boom",
  "    at charge (/app/src/billing.ts:12:9)",
  "    at handler (/app/node_modules/some-lib/index.js:4:1)",
  "    at run (node:internal/process/task_queues:95:5)",
  "    at main (/app/src/server.ts:3:1)",
].join("\n");

describe("silencers", () => {
  it("removes the lines they match", () => {
    const cleaner = new BacktraceCleaner().addSilencer((line) => line.includes("node_modules"));

    expect(cleaner.clean(trace).join("\n")).not.toContain("node_modules");
  });

  it("keeps everything else", () => {
    const cleaner = new BacktraceCleaner().addSilencer((line) => line.includes("node_modules"));

    expect(cleaner.clean(trace)).toHaveLength(3);
  });

  it("can be asked for the noise instead", () => {
    const cleaner = new BacktraceCleaner().addSilencer((line) => line.includes("node_modules"));
    const noise = cleaner.clean(trace, "noise");

    expect(noise).toHaveLength(1);
    expect(noise[0]).toContain("node_modules");
  });

  it("can be asked for everything", () => {
    const cleaner = new BacktraceCleaner().addSilencer(() => true);

    expect(cleaner.clean(trace, "all")).toHaveLength(4);
  });

  it("can be taken away again", () => {
    const cleaner = new BacktraceCleaner().addSilencer(() => true);
    cleaner.removeSilencers();

    expect(cleaner.clean(trace)).toHaveLength(4);
  });
});

describe("filters", () => {
  it("rewrite each line", () => {
    const cleaner = new BacktraceCleaner().addFilter((line) => line.replace("/app/", ""));

    expect(cleaner.clean(trace)[0]).toContain("src/billing.ts");
    expect(cleaner.clean(trace)[0]).not.toContain("/app/");
  });

  /**
   * Filters run first so a silencer sees the shortened form and can be written
   * against it — otherwise every silencer has to know the absolute path.
   */
  it("run before the silencers", () => {
    const cleaner = new BacktraceCleaner()
      .addFilter((line) => line.replace("/app/", ""))
      .addSilencer((line) => line.startsWith("    at handler (node_modules"));

    expect(cleaner.clean(trace).join("\n")).not.toContain("node_modules");
  });

  it("can be taken away again", () => {
    const cleaner = new BacktraceCleaner().addFilter(() => "replaced");
    cleaner.removeFilters();

    expect(cleaner.clean(trace)[0]).toContain("billing.ts");
  });
});

/**
 * An empty backtrace is strictly worse than a noisy one, and it happens
 * whenever the failure really is inside the framework — which is exactly when
 * somebody needs to see where.
 */
describe("when everything is silenced", () => {
  it("hands back the whole trace rather than nothing", () => {
    const cleaner = new BacktraceCleaner().addSilencer(() => true);

    expect(cleaner.clean(trace)).toHaveLength(4);
  });

  it("still hands back nothing for a trace that was empty", () => {
    expect(new BacktraceCleaner().clean(undefined)).toEqual([]);
    expect(new BacktraceCleaner().clean("")).toEqual([]);
  });
});

describe("what counts as a frame", () => {
  /**
   * A trace that begins with its own message is a trace nobody can filter: the
   * message is not a frame and matches none of the patterns written for one.
   */
  it("drops the message line", () => {
    expect(new BacktraceCleaner().clean(trace).join("\n")).not.toContain("Error: boom");
  });

  it("takes an array of lines as readily as a string", () => {
    expect(new BacktraceCleaner().clean(trace.split("\n"))).toHaveLength(4);
  });

  it("ignores blank lines", () => {
    expect(new BacktraceCleaner().clean("    at a (/x.ts:1:1)\n\n\n")).toHaveLength(1);
  });
});

describe("the default cleaner", () => {
  const cleaner = defaultBacktraceCleaner("/app");

  it("keeps the application's own frames", () => {
    expect(cleaner.clean(trace).join("\n")).toContain("src/billing.ts");
  });

  it("silences node_modules", () => {
    expect(cleaner.clean(trace).join("\n")).not.toContain("node_modules");
  });

  it("silences the runtime's own frames", () => {
    expect(cleaner.clean(trace).join("\n")).not.toContain("node:internal");
  });

  it("shortens absolute paths to something a person recognises", () => {
    expect(cleaner.clean(trace).join("\n")).not.toContain("/app/src");
  });

  /**
   * A stack on Windows carries backslashes, and the root it is asked to strip
   * is written with forward slashes. Without normalising the two, nothing
   * matches and every path stays absolute — which is not a broken trace, just
   * an unreadable one, and so exactly the kind of thing that survives.
   *
   * Asserted on the shortening rather than on a silencer: `node_modules`
   * appears literally whatever the separators, so a silencer matching it
   * proves nothing about normalisation.
   */
  it("normalises separators, so a Windows path is still shortened", () => {
    const windows = [
      "Error",
      "    at h (C:\\app\\node_modules\\lib\\index.js:1:1)",
      "    at charge (C:\\app\\src\\billing.ts:12:9)",
    ].join("\n");

    const cleaned = defaultBacktraceCleaner("C:/app").clean(windows).join("\n");

    expect(cleaned).toContain("src/billing.ts");
    expect(cleaned).not.toContain("C:/app");
    expect(cleaned).not.toContain("C:\\app");
  });
});

/**
 * The consumer. A logged error printed its whole stack — which is the trace
 * nobody reads, and the reason this exists at all.
 */
describe("printed under a log line", () => {
  const entryWith = (stack: string) => {
    const error = new Error("boom");
    error.stack = stack;

    return {
      level: "error" as const,
      message: "the charge failed",
      time: new Date("2026-01-15T12:34:56.789Z"),
      payload: { error },
    };
  };

  const format = (stack: string) =>
    prettyFormatter({ colour: false, cleaner: defaultBacktraceCleaner("/app") })(entryWith(stack));

  it("prints the application's frames", () => {
    expect(format(trace)).toContain("src/billing.ts");
  });

  it("leaves the noise out", () => {
    expect(format(trace)).not.toContain("node_modules");
  });

  /**
   * Silently dropping frames is how somebody concludes the trace is short
   * because the stack was short.
   */
  it("says how many it hid", () => {
    expect(format(trace)).toContain("2 framework frames hidden");
  });

  it("says nothing when it hid nothing", () => {
    expect(format("Error: boom\n    at charge (/app/src/billing.ts:12:9)")).not.toContain("hidden");
  });

  it("can be turned off entirely", () => {
    expect(prettyFormatter({ colour: false, stacks: false })(entryWith(trace))).not.toContain(
      "billing.ts",
    );
  });
});
