/**
 * Bold, italic and underline on a coloured line, ported from the
 * `ActiveSupport::ColorizeLogging#mode_from` cases in
 * `activesupport/test/log_subscriber_test.rb`.
 */

import { describe, expect, it } from "bun:test";
import { SGR_MODES, colorize, modeFrom } from "../src/logger.js";

const ESC = "";

describe("the escape for a set of modes", () => {
  it("is one sequence, not one per mode", () => {
    expect(modeFrom({ bold: true, underline: true })).toBe(`${ESC}[1;4m`);
  });

  it("names each mode by its own code", () => {
    expect(modeFrom({ bold: true })).toBe(`${ESC}[1m`);
    expect(modeFrom({ italic: true })).toBe(`${ESC}[3m`);
    expect(modeFrom({ underline: true })).toBe(`${ESC}[4m`);
  });

  /**
   * A formatter whose output varies by key order is one no test can compare
   * and no log can be diffed.
   */
  it("writes the modes in a fixed order", () => {
    expect(modeFrom({ underline: true, italic: true, bold: true })).toBe(
      modeFrom({ bold: true, italic: true, underline: true }),
    );
    expect(modeFrom({ underline: true, bold: true })).toBe(`${ESC}[1;4m`);
  });

  /** An empty `ESC[m` means "reset", so it would clear the colour after it. */
  it("is nothing at all when no mode is asked for", () => {
    expect(modeFrom({})).toBe("");
    expect(modeFrom()).toBe("");
    expect(modeFrom({ bold: false, italic: false })).toBe("");
  });

  it("ignores a mode that was asked for falsely", () => {
    expect(modeFrom({ bold: true, italic: false })).toBe(`${ESC}[1m`);
  });

  it("knows the three modes an SGR sequence has codes for", () => {
    expect(SGR_MODES).toEqual({ bold: 1, italic: 3, underline: 4 });
  });
});

describe("colouring with a mode", () => {
  /** The reset that ends the run clears both; there is no ending one alone. */
  it("puts the modes before the colour and resets once", () => {
    expect(colorize("hi", `${ESC}[31m`, { bold: true })).toBe(`${ESC}[1m${ESC}[31mhi${ESC}[0m`);
  });

  it("is unchanged when no mode is asked for", () => {
    expect(colorize("hi", `${ESC}[31m`)).toBe(`${ESC}[31mhi${ESC}[0m`);
  });
});
