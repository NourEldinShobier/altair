/**
 * Streaming responses and Server-Sent Events.
 *
 * Mirrors actionpack/test/controller/live_stream_test.rb. The framing tests
 * are the ones that matter: an SSE stream with a newline in its payload
 * half-works — short messages arrive, one long one silently breaks the
 * connection — and that is the hardest kind of bug to find from the outside.
 */

import { describe, expect, it } from "bun:test";
import { Controller } from "../src/controller.js";
import { eventStreamResponse, frameEvent, streamResponse } from "../src/streaming.js";

const collect = async (response: Response): Promise<string> => await response.text();

async function* rows(): AsyncGenerator<string> {
  yield "id,title\n";
  yield "1,A\n";
  yield "2,B\n";
}

describe("framing an event", () => {
  it("writes the data and ends the event", () => {
    expect(frameEvent({ data: "hello" })).toBe("data: hello\n\n");
  });

  // Without the blank line the client holds the fields and waits, so the
  // stream looks connected and delivers nothing.
  it("always ends with a blank line", () => {
    expect(frameEvent({ data: "x" })).toEndWith("\n\n");
    expect(frameEvent({ data: "x", event: "tick", id: "7" })).toEndWith("\n\n");
  });

  it("writes the optional fields in order", () => {
    expect(frameEvent({ data: "x", event: "tick", id: "7", retry: 3000 })).toBe(
      "event: tick\nid: 7\nretry: 3000\ndata: x\n\n",
    );
  });

  it("serializes anything that is not a string", () => {
    expect(frameEvent({ data: { a: 1 } })).toBe('data: {"a":1}\n\n');
  });

  // The classic SSE bug. A newline ends the field, so the rest of the payload
  // becomes a malformed second one — and short messages are fine, which is
  // why it survives a demo.
  it("gives every line of the data its own prefix", () => {
    expect(frameEvent({ data: "one\ntwo\nthree" })).toBe("data: one\ndata: two\ndata: three\n\n");
  });

  it("handles the other line endings too", () => {
    expect(frameEvent({ data: "one\r\ntwo\rthree" })).toBe("data: one\ndata: two\ndata: three\n\n");
  });

  it("writes a comment, which is how an idle stream is kept open", () => {
    expect(frameEvent({ data: "", comment: "keep-alive" })).toStartWith(": keep-alive\n");
  });

  it("floors a fractional retry, since the field is an integer", () => {
    expect(frameEvent({ data: "x", retry: 1500.7 })).toContain("retry: 1500");
  });
});

describe("streaming a body", () => {
  it("sends everything the source produced", async () => {
    expect(await collect(streamResponse(rows()))).toBe("id,title\n1,A\n2,B\n");
  });

  it("takes a content type", async () => {
    const response = streamResponse(rows(), { contentType: "text/csv" });

    expect(response.headers.get("content-type")).toBe("text/csv");
  });

  it("accepts a plain iterable as well as an async one", async () => {
    expect(await collect(streamResponse(["a", "b"]))).toBe("ab");
  });

  it("accepts bytes", async () => {
    const bytes = new TextEncoder().encode("hello");

    expect(await collect(streamResponse([bytes]))).toBe("hello");
  });

  // Pull-based: the source is asked for the next chunk once the previous one
  // has been taken. Producing everything up front is the same as building the
  // string, with extra steps.
  it("asks for a chunk at a time", async () => {
    let produced = 0;

    async function* counted(): AsyncGenerator<string> {
      for (let index = 0; index < 5; index += 1) {
        produced += 1;
        yield String(index);
      }
    }

    const reader = streamResponse(counted()).body!.getReader();
    await reader.read();

    expect(produced).toBeLessThan(5);
    await reader.cancel();
  });

  // A client that closed the tab is not owed the rest of the export, and on a
  // large one the work keeps a cursor open for nobody.
  it("stops when the client goes away", async () => {
    let produced = 0;

    async function* endless(): AsyncGenerator<string> {
      for (;;) {
        produced += 1;
        yield "x";
      }
    }

    const controller = new AbortController();
    const response = streamResponse(endless(), { signal: controller.signal });
    const reader = response.body!.getReader();

    await reader.read();
    controller.abort();
    await reader.read();

    const seen = produced;
    await reader.read().catch(() => undefined);

    expect(produced).toBe(seen);
  });

  it("tells the source when the reader cancels", async () => {
    let closed = false;

    async function* watched(): AsyncGenerator<string> {
      try {
        yield "a";
        yield "b";
      } finally {
        closed = true;
      }
    }

    const reader = streamResponse(watched()).body!.getReader();
    await reader.read();
    await reader.cancel();

    expect(closed).toBe(true);
  });

  // The headers are long gone by the time a row fails, so there is no status
  // left to change. Breaking the body is the only way a reader learns it did
  // not get everything.
  it("breaks the body when the source throws", async () => {
    async function* failing(): AsyncGenerator<string> {
      yield "first";
      throw new Error("the database went away");
    }

    const reader = streamResponse(failing()).body!.getReader();
    await reader.read();

    await expect(reader.read()).rejects.toThrow("the database went away");
  });
});

describe("an event stream", () => {
  async function* updates(): AsyncGenerator<{ data: unknown; event?: string }> {
    yield { data: { count: 1 } };
    yield { data: { count: 2 }, event: "tick" };
  }

  it("frames every event", async () => {
    expect(await collect(eventStreamResponse(updates()))).toBe(
      'data: {"count":1}\n\nevent: tick\ndata: {"count":2}\n\n',
    );
  });

  it("says what it is", async () => {
    expect(eventStreamResponse(updates()).headers.get("content-type")).toBe("text/event-stream");
  });

  // A proxy that cached the stream would replay it to the next client, and a
  // stream is by definition not the same twice.
  it("tells caches to keep away", async () => {
    expect(eventStreamResponse(updates()).headers.get("cache-control")).toContain("no-cache");
  });

  // nginx buffers a few kilobytes before forwarding by default, which turns a
  // live feed into one that arrives in bursts minutes late — and looks like a
  // broken application rather than a proxy setting.
  it("tells nginx not to buffer", async () => {
    expect(eventStreamResponse(updates()).headers.get("x-accel-buffering")).toBe("no");
  });
});

describe("from a controller", () => {
  class ExportsController extends Controller {
    index(): void {
      this.render.stream(rows(), { contentType: "text/csv" });
    }

    async live(): Promise<void> {
      async function* ticks(): AsyncGenerator<{ data: unknown }> {
        yield { data: "one" };
      }

      await Promise.resolve();
      this.render.events(ticks());
    }
  }

  const run = async (action: "index" | "live") =>
    await new ExportsController({
      request: new Request("http://test.host/exports"),
      session: {},
    }).processAction(action);

  it("streams the export", async () => {
    const response = await run("index");

    expect(response.headers.get("content-type")).toBe("text/csv");
    expect(await response.text()).toContain("1,A");
  });

  it("streams events", async () => {
    const response = await run("live");

    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe("data: one\n\n");
  });
});
