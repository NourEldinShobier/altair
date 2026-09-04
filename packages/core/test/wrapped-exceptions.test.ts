/**
 * An exception that wraps another, ported from
 * `actionpack/test/dispatch/exception_wrapper_test.rb` — the
 * `unwrapped_exception`, `original_message` and `rescue_response?` cases.
 *
 * A template that raises wraps what was raised, and the wrapper names the
 * template while the cause names the mistake. Everything here is about which
 * of the two the application answers with.
 */

import { describe, expect, it } from "bun:test";
import {
  originalMessage,
  rescueResponse,
  statusForError,
  unwrappedException,
} from "../src/rescue-responses.js";

function named(name: string, message = "boom", cause?: unknown): Error {
  const error = cause === undefined ? new Error(message) : new Error(message, { cause });
  error.name = name;

  return error;
}

describe("the error underneath a wrapper", () => {
  /**
   * Classified by the wrapper, every one of these is a 500 — including the
   * `RecordNotFound` a partial raised, which is a 404 answered as a fault.
   */
  it("is the first one with a status", () => {
    const wrapped = named("TemplateError", "in posts/_post", named("RecordNotFound"));

    expect((unwrappedException(wrapped) as Error).name).toBe("RecordNotFound");
    expect(statusForError(wrapped)).toBe(404);
  });

  /**
   * Not the innermost: an application that deliberately wraps something in a
   * `BadRequest` means the `BadRequest`, and the driver error underneath is
   * not the answer.
   */
  it("stops at the first classified one", () => {
    const wrapped = named("BadRequest", "bad", named("RecordNotFound"));

    expect((unwrappedException(wrapped) as Error).name).toBe("BadRequest");
    expect(statusForError(wrapped)).toBe(400);
  });

  it("is the error itself when nothing in the chain is classified", () => {
    const wrapped = named("TemplateError", "in posts/_post", named("TypeError"));

    expect(unwrappedException(wrapped)).toBe(wrapped);
    expect(statusForError(wrapped)).toBe(500);
  });

  it("takes an application's own classifications", () => {
    const wrapped = named("TemplateError", "in posts/_post", named("PaymentRequired"));

    expect(statusForError(wrapped, { PaymentRequired: 402 })).toBe(402);
  });

  it("walks more than one wrapper", () => {
    const wrapped = named("A", "a", named("B", "b", named("RecordInvalid")));

    expect(statusForError(wrapped)).toBe(422);
  });

  /**
   * An error caught and rethrown with itself, or with something that already
   * names it, is a mistake nobody notices until something walks the chain.
   */
  it("terminates on a chain that points at itself", () => {
    const looping = named("A");
    Object.defineProperty(looping, "cause", { value: looping });

    expect(statusForError(looping)).toBe(500);
    expect(unwrappedException(looping)).toBe(looping);
  });

  /** Two errors naming each other, which no identity check would catch. */
  it("terminates on a cycle of two", () => {
    const first = named("A");
    const second = named("B", "b", first);
    Object.defineProperty(first, "cause", { value: second });

    expect(statusForError(first)).toBe(500);
    expect(originalMessage(first)).toBe("boom");
  });

  /**
   * Eight wrappers deep, the exception at the bottom is not what the request
   * should answer with — a chain that long is a mistake either way.
   */
  it("stops before the bottom of an absurdly deep chain", () => {
    let deep = named("RecordNotFound");
    for (let depth = 0; depth < 50; depth += 1) deep = named("Wrapper", "w", deep);

    expect(statusForError(deep)).toBe(500);
  });

  it("leaves something that is not an error alone", () => {
    expect(unwrappedException("boom")).toBe("boom");
    expect(statusForError("boom")).toBe(500);
  });
});

describe("whether the framework has a status for it", () => {
  /**
   * What an error page asks before deciding how much to show: a classified
   * exception is an expected outcome, an unclassified one is a bug.
   */
  it("is true for one it classified", () => {
    expect(rescueResponse(named("RecordNotFound"))).toBe(true);
    expect(rescueResponse(named("TemplateError", "x", named("RecordNotFound")))).toBe(true);
  });

  it("is false for one it did not", () => {
    expect(rescueResponse(named("TypeError"))).toBe(false);
    expect(rescueResponse("boom")).toBe(false);
  });

  it("counts an application's own classifications", () => {
    expect(rescueResponse(named("PaymentRequired"), { PaymentRequired: 402 })).toBe(true);
  });
});

describe("the message of the error itself", () => {
  /**
   * A wrapper's message names the template and the line; the useful half is
   * underneath. Shown without unwrapping, the page says a partial failed and
   * never says why.
   */
  it("is the innermost cause's", () => {
    const wrapped = named("TemplateError", "in posts/_post", named("TypeError", "not a function"));

    expect(originalMessage(wrapped)).toBe("not a function");
  });

  it("is the error's own when nothing wrapped it", () => {
    expect(originalMessage(named("TypeError", "not a function"))).toBe("not a function");
  });

  it("goes all the way down", () => {
    const wrapped = named("A", "a", named("B", "b", named("C", "the real one")));

    expect(originalMessage(wrapped)).toBe("the real one");
  });

  it("describes something that is not an error", () => {
    expect(originalMessage("boom")).toBe("boom");
  });

  /**
   * Bounded like the unwrapping, and for the same reason: past eight wrappers
   * the message at the bottom is not what went wrong here, and a chain that
   * long is itself the thing to look at.
   */
  it("stops before the bottom of an absurdly deep chain", () => {
    let deep = named("Innermost", "the real one");
    for (let depth = 0; depth < 50; depth += 1) deep = named("Wrapper", "wrapped", deep);

    expect(originalMessage(deep)).toBe("wrapped");
  });

  it("terminates on a chain that points at itself", () => {
    const looping = named("A", "a");
    Object.defineProperty(looping, "cause", { value: looping });

    expect(originalMessage(looping)).toBe("a");
  });
});
