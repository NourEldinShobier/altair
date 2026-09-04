/**
 * Working out which channel a test is about, ported from
 * `actioncable/test/channel/test_case_test.rb` and
 * `actioncable/test/connection/test_case_test.rb`.
 *
 * The refusal is the half worth testing: a test whose subject could not be
 * inferred and quietly got nothing would pass.
 */

import { describe, expect, it } from "bun:test";
import {
  NonInferrableChannel,
  NonInferrableConnection,
  channelClass,
  clearMessages,
  connectionClass,
  determineDefaultChannel,
  determineDefaultConnection,
  newTestSubject,
  streamOrRejectFor,
  tests,
  testsConnection,
} from "../src/test-defaults.js";

const known = new Map<string, unknown>([
  ["ChatChannel", { kind: "chat" }],
  ["ApplicationCable::Connection", { kind: "connection" }],
  ["ApplicationCable::Channel", { kind: "base" }],
]);

describe("inferring the subject", () => {
  it("finds the channel a test is named after", () => {
    expect(determineDefaultChannel("Chat", known)).toEqual({ kind: "chat" });
  });

  /**
   * A test that inferred nothing would assert against a channel that never
   * received anything, which looks exactly like one that received everything
   * and did nothing.
   */
  it("refuses to infer nothing", () => {
    expect(() => determineDefaultChannel("Nowhere", known)).toThrow(NonInferrableChannel);
  });

  it("names what it looked for", () => {
    expect(() => determineDefaultChannel("Nowhere", known)).toThrow("NowhereChannel");
  });

  it("says how to fix it", () => {
    expect(() => determineDefaultChannel("Nowhere", known)).toThrow("tests(SomeChannel)");
  });

  it("finds a connection the same way", () => {
    expect(determineDefaultConnection("ApplicationCable::", known)).toEqual({
      kind: "connection",
    });
  });

  it("refuses to infer a connection from nothing", () => {
    expect(() => determineDefaultConnection("Nowhere", known)).toThrow(NonInferrableConnection);
  });
});

describe("saying the subject explicitly", () => {
  it("takes the class itself", () => {
    const subject = newTestSubject();
    const channel = {};

    expect(tests(subject, channel)).toBe(channel);
    expect(subject.channelClass).toBe(channel);
  });

  it("takes a name", () => {
    expect(tests(newTestSubject(), "ChatChannel", known)).toEqual({ kind: "chat" });
  });

  /**
   * Resolved here rather than stored: a name resolving to nothing has to fail
   * now, not at the first assertion — where the failure would be about a
   * channel that received no messages instead of a name nothing answers.
   */
  it("refuses a name nothing answers", () => {
    expect(() => tests(newTestSubject(), "NowhereChannel", known)).toThrow(NonInferrableChannel);
  });

  it("takes a connection too", () => {
    const subject = newTestSubject();

    expect(testsConnection(subject, "ApplicationCable::Connection", known)).toEqual({
      kind: "connection",
    });
    expect(subject.connectionClass).toEqual({ kind: "connection" });
  });

  it("refuses a connection name nothing answers", () => {
    expect(() => testsConnection(newTestSubject(), "Nowhere", known)).toThrow(
      NonInferrableConnection,
    );
  });
});

describe("which subject is used", () => {
  /**
   * Declared first: a test that said which connection it uses has said
   * something the name cannot, and inferring over it would make the
   * declaration silently do nothing.
   */
  it("prefers what was declared", () => {
    const subject = newTestSubject();
    testsConnection(subject, "ApplicationCable::Connection", known);

    expect(connectionClass(subject, "Nowhere", known)).toEqual({ kind: "connection" });
  });

  it("falls back to the name", () => {
    expect(connectionClass(newTestSubject(), "ApplicationCable::", known)).toEqual({
      kind: "connection",
    });
  });

  it("does the same for the channel", () => {
    const subject = newTestSubject();

    expect(channelClass(subject, "Chat", known)).toEqual({ kind: "chat" });

    tests(subject, "ApplicationCable::Channel", known);

    expect(channelClass(subject, "Chat", known)).toEqual({ kind: "base" });
  });
});

describe("between two actions in one test", () => {
  /**
   * Left in place, a message from the first action makes "transmitted nothing"
   * on the second pass for the wrong reason — and that assertion is the one
   * most likely to be wrong, since it passes by default.
   */
  it("clears what was transmitted", () => {
    const subject = newTestSubject();
    subject.messages.push("hello");

    expect(clearMessages(subject).messages).toEqual([]);
  });

  it("hands the subject back", () => {
    const subject = newTestSubject();

    expect(clearMessages(subject)).toBe(subject);
  });
});

describe("streaming for a record that may not exist", () => {
  /**
   * The alternative is a subscription that succeeds and streams from
   * `"posts:"`. The client believes it is subscribed, receives nothing
   * forever, and cannot tell that from a quiet stream.
   */
  it("streams when there is a record", () => {
    const streamed: unknown[] = [];
    let rejected = false;

    expect(
      streamOrRejectFor(
        { id: 1 },
        (record) => streamed.push(record),
        () => {
          rejected = true;
        },
      ),
    ).toBe(true);
    expect(streamed).toEqual([{ id: 1 }]);
    expect(rejected).toBe(false);
  });

  it("rejects when there is not", () => {
    for (const missing of [undefined, null, false]) {
      const streamed: unknown[] = [];
      let rejected = false;

      expect(
        streamOrRejectFor(
          missing,
          (record) => streamed.push(record),
          () => {
            rejected = true;
          },
        ),
      ).toBe(false);
      expect(streamed).toEqual([]);
      expect(rejected).toBe(true);
    }
  });

  /** Zero and the empty string are records a finder can legitimately return. */
  it("does not treat every falsy value as missing", () => {
    let rejected = false;

    expect(
      streamOrRejectFor(
        0,
        () => undefined,
        () => {
          rejected = true;
        },
      ),
    ).toBe(true);
    expect(rejected).toBe(false);
  });
});
