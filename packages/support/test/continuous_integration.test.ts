/**
 * Running a project's checks and saying what happened, ported from
 * `activesupport/test/continuous_integration_test.rb`.
 *
 * The command runner and the clock are parameters, so every case here is
 * about what the report says rather than about how fast the machine is.
 */

import { describe, expect, it } from "bun:test";
import { CI_COLOURS, ContinuousIntegration, formatElapsed } from "../src/continuous_integration.js";

/** A runner whose answer is decided per command, and a clock that only moves when told. */
function harness(
  outcomes: Record<string, boolean> = {},
  options: { failFast?: boolean; colour?: boolean; durations?: Record<string, number> } = {},
) {
  const lines: string[] = [];
  const ran: string[] = [];
  const arguments_: string[][] = [];
  let now = 0;

  const ci = new ContinuousIntegration({
    run: (command) => {
      const key = command.join(" ");

      ran.push(key);
      arguments_.push([...command]);
      now += options.durations?.[key] ?? 0;

      return outcomes[key] ?? true;
    },
    write: (line) => void lines.push(line),
    clock: () => now,
    failFast: options.failFast,
    colour: options.colour ?? false,
  });

  return { ci, lines, ran, arguments: arguments_ };
}

describe("a step", () => {
  it("runs the command and records what happened", async () => {
    const { ci, ran } = harness();

    expect(await ci.step("Style", "bin/lint")).toBe(true);
    expect(ran).toEqual(["bin/lint"]);
    expect(ci.results).toEqual([{ title: "Style", ok: true, seconds: 0 }]);
  });

  /** So a path with a space in it is one argument, not two. */
  it("passes each argument through rather than a joined string", async () => {
    const { ci, arguments: given } = harness();

    await ci.step("One test", "bun", "test", "--only", "a b");

    expect(given).toEqual([["bun", "test", "--only", "a b"]]);
  });

  it("times it", async () => {
    const { ci } = harness({}, { durations: { "bin/test": 1500 } });

    await ci.step("Tests", "bin/test");

    expect(ci.results[0]?.seconds).toBe(1.5);
  });

  /** Somebody staring at a blank terminal cannot tell which step is stuck. */
  it("announces itself before doing the work", async () => {
    const lines: string[] = [];
    let seen: string[] = [];
    const ci = new ContinuousIntegration({
      write: (line) => void lines.push(line),
      colour: false,
      run: () => {
        seen = [...lines];

        return true;
      },
    });

    await ci.step("Tests", "bin/test");

    expect(seen).toEqual(["Tests", "bin/test"]);
  });

  /**
   * Losing every other step's result to an exception in one of them is how a
   * report ends up less useful than the shell script it replaced.
   */
  it("counts a runner that threw as a failure", async () => {
    const ci = new ContinuousIntegration({
      write: () => undefined,
      colour: false,
      run: () => {
        throw new Error("no such command");
      },
    });

    expect(await ci.step("Style", "bin/lint")).toBe(false);
    expect(ci.success()).toBe(false);
  });

  it("refuses to run anything when no runner was given", async () => {
    const ci = new ContinuousIntegration({ write: () => undefined, colour: false });

    expect(await ci.step("Style", "bin/lint")).toBe(false);
  });
});

describe("the run as a whole", () => {
  /**
   * A run that stops at the first failure tells you the formatter is unhappy
   * and nothing about the tests. Finding out both were broken then takes as
   * many pushes as there are broken things.
   */
  it("runs every step even after one fails", async () => {
    const { ci, ran } = harness({ "bin/lint": false });

    const ok = await ci.run("CI", undefined, async () => {
      await ci.step("Style", "bin/lint");
      await ci.step("Tests", "bin/test");
    });

    expect(ran).toEqual(["bin/lint", "bin/test"]);
    expect(ok).toBe(false);
  });

  it("stops after a failure when asked to", async () => {
    const { ci, ran } = harness({ "bin/lint": false }, { failFast: true });

    await ci.run("CI", undefined, async () => {
      await ci.step("Style", "bin/lint");
      await ci.step("Tests", "bin/test");
    });

    expect(ran).toEqual(["bin/lint"]);
  });

  /** Recorded as nothing rather than as a pass: it did not run. */
  it("does not record a step it skipped", async () => {
    const { ci } = harness({ "bin/lint": false }, { failFast: true });

    await ci.run("CI", undefined, async () => {
      await ci.step("Style", "bin/lint");
      await ci.step("Tests", "bin/test");
    });

    expect(ci.results.map((result) => result.title)).toEqual(["Style"]);
  });

  it("says everything passed when it did", async () => {
    const { ci } = harness();

    expect(
      await ci.run("CI", undefined, async () => {
        await ci.step("Style", "bin/lint");
      }),
    ).toBe(true);
  });

  /** So the failures can be read without scrolling back through the output. */
  it("lists the failed steps again at the end", async () => {
    const { ci, lines } = harness({ "bin/lint": false, "bin/audit": false });

    await ci.run("CI", undefined, async () => {
      await ci.step("Style", "bin/lint");
      await ci.step("Tests", "bin/test");
      await ci.step("Audit", "bin/audit");
    });

    expect(lines).toContain("  -> Style failed");
    expect(lines).toContain("  -> Audit failed");
    expect(lines).not.toContain("  -> Tests failed");
  });

  /** With one step, the line above already said which one failed. */
  it("does not repeat a single failure", async () => {
    const { ci, lines } = harness({ "bin/lint": false });

    await ci.run("CI", undefined, async () => {
      await ci.step("Style", "bin/lint");
    });

    expect(lines).not.toContain("  -> Style failed");
  });

  it("times the whole run, not the sum of the steps", async () => {
    const { ci, lines } = harness({}, { durations: { "bin/test": 65_000 } });

    await ci.run("CI", undefined, async () => {
      await ci.step("Tests", "bin/test");
    });

    expect(lines.at(-1)).toBe("PASS CI in 1m5.00s");
  });

  it("shows the subtitle when there is one", async () => {
    const { ci, lines } = harness();

    await ci.run("CI", "everything, in order", () => undefined);

    expect(lines.slice(0, 2)).toEqual(["CI", "everything, in order"]);
  });

  it("shows no subtitle line when there is none", async () => {
    const { ci, lines } = harness();

    await ci.run("CI", undefined, () => undefined);

    expect(lines[0]).toBe("CI");
    expect(lines).toHaveLength(2);
  });
});

describe("what it writes", () => {
  it("colours a line by what kind of line it is", () => {
    const lines: string[] = [];
    const ci = new ContinuousIntegration({ write: (line) => void lines.push(line), colour: true });

    ci.echo("all good", "success");

    expect(lines[0]).toBe(`[1m${CI_COLOURS.success}all good[0m`);
  });

  it("gives each kind its own colour", () => {
    const lines: string[] = [];
    const ci = new ContinuousIntegration({ write: (line) => void lines.push(line), colour: true });

    ci.echo("bad", "error");

    expect(lines[0]).toContain(CI_COLOURS.error);
    expect(lines[0]).not.toContain(CI_COLOURS.banner);
  });

  /**
   * A log piped to a file or shipped to a collector with escape codes in it
   * is one every grep has to strip first, and most do not.
   */
  it("writes plain text when colour is off", () => {
    const { ci, lines } = harness();

    ci.echo("all good", "success");

    expect(lines[0]).toBe("all good");
  });

  /** An abandoned run reads as an error, not as an announcement. */
  it("writes an abandonment as an error", () => {
    const lines: string[] = [];
    const ci = new ContinuousIntegration({ write: (line) => void lines.push(line), colour: true });

    ci.failure("Skipping signoff", "CI failed");

    expect(lines[0]).toContain(CI_COLOURS.error);
    expect(lines[0]).toContain("Skipping signoff");
    expect(lines[1]).toContain(CI_COLOURS.subtitle);
  });

  it("names a failure as an error", async () => {
    const { ci, lines } = harness({ "bin/lint": false });

    await ci.step("Style", "bin/lint");

    expect(lines.at(-1)).toBe("FAIL Style in 0.00s");
  });
});

describe("a duration a person can read", () => {
  /** "0m3.40s" is noise on the three seconds a formatter takes. */
  it("leaves the minutes off when there are none", () => {
    expect(formatElapsed(3.4)).toBe("3.40s");
    expect(formatElapsed(59.999)).toBe("60.00s");
  });

  it("shows the minutes once there are any", () => {
    expect(formatElapsed(65)).toBe("1m5.00s");
    expect(formatElapsed(3600)).toBe("60m0.00s");
  });

  it("rounds to hundredths", () => {
    expect(formatElapsed(1.006)).toBe("1.01s");
    expect(formatElapsed(0)).toBe("0.00s");
  });
});
