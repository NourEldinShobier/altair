/**
 * What happens when a stream fails after its headers have gone out, ported
 * from the `on_error` cases in
 * `actionpack/test/controller/live_stream_test.rb`.
 *
 * By the time a stream fails, a 200 is already on the wire and cannot be taken
 * back: no status can change, no error page can render, and no `rescueFrom`
 * can run. A half-sent CSV export looks exactly like a complete one — the file
 * simply stops — so a failure nothing recorded is a failure nobody will ever
 * hear about.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { errors } from "@altair/support";
import { callOnError, streamResponse } from "../src/streaming.js";

afterEach(() => errors.reset());

/** Whatever the error reporter was told. */
function reported(): unknown[] {
  const seen: unknown[] = [];

  errors.subscribe((error) => void seen.push(error));

  return seen;
}

/** Reads a response body to the end, returning what arrived and how it ended. */
async function drain(response: Response): Promise<{ text: string; failure: unknown }> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";

  try {
    for (;;) {
      const { value, done } = await reader.read();

      if (done) return { text, failure: undefined };

      text += decoder.decode(value);
    }
  } catch (failure) {
    return { text, failure };
  }
}

async function* failsAfter(chunks: string[], error: Error): AsyncGenerator<string> {
  for (const chunk of chunks) yield chunk;

  throw error;
}

describe("a source that throws mid-stream", () => {
  it("tells the handler what went wrong", async () => {
    const boom = new Error("the query died");
    const seen: unknown[] = [];

    await drain(
      streamResponse(failsAfter(["a,b\n"], boom), { onError: (error) => void seen.push(error) }),
    );

    expect(seen).toEqual([boom]);
  });

  /** A reader needs to know it did not get everything. */
  it("still breaks the body", async () => {
    const boom = new Error("the query died");

    const { text, failure } = await drain(
      streamResponse(failsAfter(["a,b\n"], boom), { onError: () => undefined }),
    );

    expect(text).toBe("a,b\n");
    expect(failure).toBe(boom);
  });

  it("tells the handler once, not once per chunk", async () => {
    let calls = 0;

    await drain(
      streamResponse(failsAfter(["a", "b", "c"], new Error("boom")), {
        onError: () => {
          calls += 1;
        },
      }),
    );

    expect(calls).toBe(1);
  });

  /**
   * A generator closes itself when it throws; anything hand-rolled — a cursor,
   * a socket — does not, and is what would be left open.
   */
  it("closes the source, generator or not", async () => {
    let returned = 0;
    let sent = false;

    const source: AsyncIterable<string> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          if (sent) throw new Error("boom");

          sent = true;

          return { value: "a", done: false };
        },
        return: async () => {
          returned += 1;

          return { value: undefined, done: true };
        },
      }),
    };

    await drain(streamResponse(source, { onError: () => undefined }));

    expect(returned).toBe(1);
  });
});

describe("when nobody is listening", () => {
  /** The one kind of error worth reporting even unasked. */
  it("reports the failure rather than losing it", async () => {
    const boom = new Error("the query died");
    const seen = reported();

    await drain(streamResponse(failsAfter(["a"], boom)));

    expect(seen).toEqual([boom]);
  });

  it("does not report it as well when a handler took it", async () => {
    const seen = reported();

    await drain(streamResponse(failsAfter(["a"], new Error("boom")), { onError: () => undefined }));

    expect(seen).toEqual([]);
  });
});

describe("a handler that throws", () => {
  /** The handler's own failure must not swallow the one it was called about. */
  it("does not lose the error it was called about", () => {
    const boom = new Error("the query died");
    const inHandler = new Error("the logger is down");
    const seen = reported();

    callOnError(boom, () => {
      throw inHandler;
    });

    expect(seen).toContain(boom);
    expect(seen).toContain(inHandler);
  });

  it("does not stop the body from breaking", async () => {
    const boom = new Error("the query died");
    reported();

    const { failure } = await drain(
      streamResponse(failsAfter(["a"], boom), {
        onError: () => {
          throw new Error("the logger is down");
        },
      }),
    );

    expect(failure).toBe(boom);
  });
});

describe("a stream that ends normally", () => {
  it("tells nobody anything", async () => {
    const seen = reported();
    let called = 0;

    async function* source(): AsyncGenerator<string> {
      yield "a";
    }

    const { text, failure } = await drain(
      streamResponse(source(), {
        onError: () => {
          called += 1;
        },
      }),
    );

    expect(text).toBe("a");
    expect(failure).toBeUndefined();
    expect(called).toBe(0);
    expect(seen).toEqual([]);
  });

  /** A client that left is not a failure — there is nothing to report. */
  it("says nothing when the client goes away", async () => {
    const seen = reported();
    let called = 0;
    const controller = new AbortController();

    controller.abort();

    async function* source(): AsyncGenerator<string> {
      yield "a";
    }

    await drain(
      streamResponse(source(), {
        signal: controller.signal,
        onError: () => {
          called += 1;
        },
      }),
    );

    expect(called).toBe(0);
    expect(seen).toEqual([]);
  });
});
