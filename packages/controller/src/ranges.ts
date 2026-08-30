/**
 * Serving part of a file, ported from `ActionDispatch::Response`'s range
 * handling and Rack's `Rack::Utils.byte_ranges`.
 *
 * `send.ts` returns whole files, which is enough for a download and not enough
 * for anything else. Three things need a partial response, and each fails in a
 * different way without one:
 *
 *   - **Seeking a video.** A player asks for the bytes around the point it is
 *     jumping to. Given the whole file it downloads from the start, so seeking
 *     to the end of an hour-long recording means fetching the hour.
 *   - **Safari playing anything at all.** It requires a 206 for media and will
 *     not play a file served as a plain 200, which reads as "video is broken
 *     in Safari" rather than as a missing header.
 *   - **Resuming a download.** A client that lost a connection at 4GB asks for
 *     the rest; without ranges it starts again.
 *
 * Rails gets this from Rack rather than writing it, which is why the pieces
 * have no single Rails method to point at.
 */

/** One resolved range, as byte offsets into the file. */
export interface ByteRange {
  /** First byte, counting from zero. */
  start: number;
  /** Last byte, inclusive — which is how the header counts, not how JS does. */
  end: number;
}

/**
 * Reads a `Range` header against a known size. Rails' `byte_ranges`.
 *
 * Returns null when there is no range to honour and an empty array when the
 * header asked for something outside the file — which are different answers
 * and get different responses: nothing to do, versus 416.
 *
 * Only `bytes` is understood. The header allows other units and no client
 * sends one, and a unit we do not understand has to be ignored rather than
 * guessed at.
 */
export function parseRange(header: string | null, size: number): ByteRange[] | null {
  if (header === null) return null;

  const match = /^bytes=(.+)$/i.exec(header.trim());

  if (match === null) return null;

  const ranges: ByteRange[] = [];

  for (const part of (match[1] ?? "").split(",")) {
    const range = parseOne(part.trim(), size);

    // One unsatisfiable range makes the whole header unsatisfiable, which is
    // what the specification says: a client that asked for something outside
    // the file gets told so rather than quietly given the part that existed.
    if (range === "unsatisfiable") return [];
    if (range !== null) ranges.push(range);
  }

  return ranges.length > 0 ? ranges : null;
}

function parseOne(part: string, size: number): ByteRange | null | "unsatisfiable" {
  const suffix = /^-(\d+)$/.exec(part);

  if (suffix) {
    // `-500` means the last 500 bytes, not "up to byte 500" — the one form of
    // this header that reads backwards and the one most often got wrong.
    const length = Number(suffix[1]);

    if (length === 0) return "unsatisfiable";

    return { start: Math.max(0, size - length), end: size - 1 };
  }

  const explicit = /^(\d+)-(\d*)$/.exec(part);

  if (explicit === null) return null;

  const start = Number(explicit[1]);

  if (start >= size) return "unsatisfiable";

  const end = explicit[2] === "" ? size - 1 : Math.min(Number(explicit[2]), size - 1);

  if (end < start) return "unsatisfiable";

  return { start, end };
}

/** How many bytes a range covers. Inclusive at both ends. */
export function rangeLength(range: ByteRange): number {
  return range.end - range.start + 1;
}

/** The `Content-Range` a partial response carries. */
export function contentRange(range: ByteRange, size: number): string {
  return `bytes ${String(range.start)}-${String(range.end)}/${String(size)}`;
}

/** The `Content-Range` a 416 carries, which names only the size. */
export function unsatisfiedContentRange(size: number): string {
  return `bytes */${String(size)}`;
}

/**
 * Whether a conditional range still applies. The `If-Range` header.
 *
 * A client resuming a download sends the validator it had. If the file has
 * changed since, the right answer is the whole new file rather than a slice of
 * it spliced onto a stale prefix — which would produce a corrupt file that no
 * error anywhere describes.
 *
 * A weak etag never satisfies it: weak means "equivalent", and equivalent is
 * not good enough to join two halves of a byte stream together.
 */
export function ifRangeSatisfied(header: string | null, etag: string | null): boolean {
  if (header === null) return true;
  if (etag === null) return false;

  const wanted = header.trim();

  if (wanted.startsWith("W/") || etag.trimStart().startsWith("W/")) return false;

  return wanted === etag.trim();
}

export interface PartialOptions {
  /** The full size of the thing being served. */
  size: number;
  contentType?: string;
  /** Extra headers the whole-file response would have carried. */
  headers?: Record<string, string>;
  etag?: string | null;
}

/**
 * The response for a request that asked for part of something.
 *
 * `null` when the request asked for the whole thing, so a caller falls through
 * to whatever it was going to send. A 416 when the range cannot be met, with
 * the size named so the client can ask again correctly.
 *
 * Only the first range is served when several were asked for. A multipart
 * response is legal and almost nothing sends one; serving the first is what
 * Rails does, and it is a correct partial response rather than a wrong
 * complete one.
 */
export function partialResponse(
  request: { headers: { get(name: string): string | null } },
  slice: (range: ByteRange) => Blob | Uint8Array | string,
  options: PartialOptions,
): Response | null {
  const { size } = options;

  if (!ifRangeSatisfied(request.headers.get("if-range"), options.etag ?? null)) return null;

  const ranges = parseRange(request.headers.get("range"), size);

  if (ranges === null) return null;

  const headers: Record<string, string> = {
    ...options.headers,
    "accept-ranges": "bytes",
    ...(options.contentType === undefined ? {} : { "content-type": options.contentType }),
  };

  if (ranges.length === 0) {
    return new Response(null, {
      status: 416,
      headers: { ...headers, "content-range": unsatisfiedContentRange(size) },
    });
  }

  const range = ranges[0] as ByteRange;

  return new Response(slice(range), {
    status: 206,
    headers: {
      ...headers,
      "content-range": contentRange(range, size),
      "content-length": String(rangeLength(range)),
    },
  });
}

/**
 * The header that tells a client ranges are available at all.
 *
 * Worth sending on every whole-file response, not only on partial ones: a
 * player decides whether it can seek from this before it ever asks for a
 * range, and without it will not try.
 */
export const ACCEPT_RANGES: Record<string, string> = { "accept-ranges": "bytes" };
