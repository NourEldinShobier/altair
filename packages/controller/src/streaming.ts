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

export interface StreamOptions extends ResponseInit {
  contentType?: string;
  /** Stops the stream when the client goes away. */
  signal?: AbortSignal;
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
  const { contentType, signal, headers, ...init } = options;
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
        // needs in order to know it did not get everything.
        await iterator.return?.();
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
    headers: {
      "content-type": contentType ?? "application/octet-stream",
      ...headers,
    },
  });
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
    headers: {
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      ...headers,
    },
  });
}
