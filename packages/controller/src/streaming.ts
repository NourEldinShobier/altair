/**
 * Streaming responses, covering the ground of `ActionController::Live` and
 * `send_data`.
 *
 * Rails needs a dedicated module and a separate thread per streaming request,
 * because Rack responses are strings. A `Response` takes a `ReadableStream`,
 * so this is mostly framing and the handful of details that decide whether a
 * stream survives a real network.
 *
 *     await this.render.stream(rows(), { contentType: "text/csv" })
 *     await this.render.events(updates())
 *
 * The reason to stream an export rather than build it: a hundred thousand rows
 * assembled into one string is a hundred thousand rows in memory, and the
 * first byte does not leave until the last one is ready. A client watching a
 * spinner for ninety seconds usually gives up before a proxy does.
 */

import { errors } from "@altair/support";

/** One Server-Sent Event. Every field is optional except the data. */
export interface ServerSentEvent {
  data: unknown;
  /** Names the event, so a client can listen for one kind. */
  event?: string;
  /** The client echoes this back as `Last-Event-ID` when it reconnects. */
  id?: string;
  /** How long the client should wait before reconnecting, in milliseconds. */
  retry?: number;
  /** A comment. Sent as `: text`, and used to keep an idle connection open. */
  comment?: string;
}

/**
 * Frames one event in the wire format.
 *
 * Every line of the data gets its own `data:` prefix. A newline inside a
 * payload otherwise ends the field, and the rest of the JSON becomes a
 * malformed second field — the classic way an SSE stream half-works, since
 * short messages are fine and one long one breaks the connection.
 */
export function frameEvent(event: ServerSentEvent): string {
  const lines: string[] = [];

  if (event.comment !== undefined) lines.push(`: ${event.comment}`);
  if (event.event !== undefined) lines.push(`event: ${event.event}`);
  if (event.id !== undefined) lines.push(`id: ${event.id}`);
  if (event.retry !== undefined) lines.push(`retry: ${Math.floor(event.retry)}`);

  const payload = typeof event.data === "string" ? event.data : JSON.stringify(event.data);
  for (const line of String(payload).split(/\r\n|\r|\n/)) lines.push(`data: ${line}`);

  // A blank line ends the event. Without it the client holds the fields and
  // waits, so the stream appears to be connected and delivers nothing.
  return `${lines.join("\n")}\n\n`;
}

/** Told about a failure that happened after the headers went out. */
export type StreamErrorHandler = (error: unknown) => void;

export interface StreamOptions extends ResponseInit {
  contentType?: string;
  /** Stops the stream when the client goes away. */
  signal?: AbortSignal;
  /**
   * Called when the source throws mid-stream. Rails' `on_error`.
   *
   * This is the only chance the application gets. By the time a stream fails,
   * a 200 and the headers are already on the wire and cannot be taken back —
   * so there is no status to change, no error page to render, and no
   * `rescue_from` that can run. All that is left is to break the body, and
   * without this the failure is invisible on the server as well as the client.
   */
  onError?: StreamErrorHandler;
}

/**
 * Tells the application a stream failed after its headers went out. Rails'
 * `call_on_error`.
 *
 * Reports the failure itself when nobody is listening, which Rails does not
 * do. A half-sent CSV export is not distinguishable from a complete one by
 * anything the client can see — no status says so, and the file simply stops —
 * so a mid-stream failure that nothing logged is a failure nobody will ever
 * hear about. That is the one kind of error worth reporting even unasked.
 *
 * A handler that throws is reported, and so is the error it was given: the
 * handler's own failure must not swallow the one it was called about.
 */
export function callOnError(error: unknown, handler?: StreamErrorHandler): void {
  if (handler === undefined) {
    errors.report(error, { handled: false, source: "streaming" });

    return;
  }

  try {
    handler(error);
  } catch (failure) {
    errors.report(failure, { handled: false, source: "streaming" });
    errors.report(error, { handled: false, source: "streaming" });
  }
}

/**
 * A response whose body is produced as it is sent.
 *
 * Pull-based, so the source is asked for the next chunk only once the previous
 * one has been taken. Pushing everything into the queue as fast as the source
 * can produce it is the same as building the string, with extra steps.
 */
export function streamResponse(
  source: AsyncIterable<string | Uint8Array> | Iterable<string | Uint8Array>,
  options: StreamOptions = {},
): Response {
  const { contentType, signal, onError, headers, ...init } = options;
  const encoder = new TextEncoder();

  const iterator = (
    Symbol.asyncIterator in source
      ? (source as AsyncIterable<string | Uint8Array>)[Symbol.asyncIterator]()
      : (source as Iterable<string | Uint8Array>)[Symbol.iterator]()
  ) as AsyncIterator<string | Uint8Array>;

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      // The client has gone. Finishing the export it is no longer reading is
      // work nobody will see, and on a large one it is work that keeps a
      // database cursor open for it.
      if (signal?.aborted) {
        await iterator.return?.();
        controller.close();
        return;
      }

      try {
        const { value, done } = await iterator.next();

        if (done) {
          controller.close();
          return;
        }

        controller.enqueue(typeof value === "string" ? encoder.encode(value) : value);
      } catch (error) {
        // The headers are long gone, so there is no status left to change:
        // all that can be done is to break the body, which is what a reader
        // needs in order to know it did not get everything — and tell the
        // application, which is the only place the failure can be recorded.
        await iterator.return?.();
        callOnError(error, onError);
        controller.error(error);
      }
    },

    async cancel() {
      await iterator.return?.();
    },
  });

  return new Response(body, {
    status: 200,
    ...init,
    headers: mergedHeaders({ "content-type": contentType ?? "application/octet-stream" }, headers),
  });
}

/**
 * Defaults, with the caller's headers on top.
 *
 * Built up rather than spread, because `HeadersInit` is three shapes and only
 * one of them spreads. A `Headers` instance spreads to `{}` — every header the
 * caller set, dropped without a word — and an array of pairs spreads to
 * `{ "0": [...] }`, which writes a header named `0`. `StreamOptions` extends
 * `ResponseInit`, so both were types this accepted.
 *
 * Not `new Headers(given)` either: a record may hold `undefined` for a header
 * the caller decided against, and the constructor writes that out as the five
 * characters `undefined`.
 */
function mergedHeaders(defaults: Record<string, string>, given: ResponseInit["headers"]): Headers {
  const headers = new Headers(defaults);

  if (given instanceof Headers) for (const [name, value] of given) headers.set(name, value);
  else if (Array.isArray(given)) for (const [name, value] of given) headers.set(name, value);
  else if (given !== undefined) {
    for (const [name, value] of Object.entries(given)) {
      if (value !== undefined) headers.set(name, value);
    }
  }

  return headers;
}

/**
 * A Server-Sent Events response.
 *
 * The headers are not decoration. `no-cache` keeps a proxy from holding the
 * stream and replaying it, and `X-Accel-Buffering: no` tells nginx not to
 * buffer — the default is to collect a few kilobytes before forwarding, which
 * turns a live feed into a feed that arrives in bursts minutes late, and looks
 * exactly like a broken application rather than a proxy setting.
 */
export function eventStreamResponse(
  source: AsyncIterable<ServerSentEvent>,
  options: Omit<StreamOptions, "contentType"> = {},
): Response {
  const { headers, ...rest } = options;

  async function* framed(): AsyncGenerator<string> {
    for await (const event of source) yield frameEvent(event);
  }

  return streamResponse(framed(), {
    ...rest,
    contentType: "text/event-stream",
    headers: mergedHeaders(
      {
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
      headers,
    ),
  });
}
