/**
 * Sending a file back, ported from `ActionController::DataStreaming`
 * (`send_data` and `send_file`).
 *
 *     this.send(csv, { filename: "report.csv", type: "text/csv" })
 *     await this.sendFile("/var/exports/report.csv")
 *
 * Most of this is one header, and that header is where the mistakes live.
 * `Content-Disposition` carries a filename supplied by the application and
 * often derived from something a person typed, and it is a header — so a
 * newline in it ends the header and starts writing others, and a quote in it
 * ends the filename and starts writing parameters.
 */

/** How the browser should treat it. */
import { asciiFilename, utf8Filename } from "./multipart.js";
import { ACCEPT_RANGES, partialResponse } from "./ranges.js";

export type Disposition = "attachment" | "inline";

export interface SendOptions {
  /**
   * The request, so a `Range` can be honoured.
   *
   * Optional because a caller with no request — a job writing a file, a test —
   * still wants to build the response. Given one, a media file becomes
   * seekable and a large download resumable.
   */
  request?: { headers: { get(name: string): string | null } };
  filename?: string;
  /** The content type. Guessed from the filename when it is not given. */
  type?: string;
  disposition?: Disposition;
  status?: number;
}

/**
 * Makes a filename safe to put in a header.
 *
 * Control characters and quotes come out rather than being escaped: a header
 * has no escaping to speak of, and a newline in one ends it — everything after
 * would be read as a header of its own, which is response splitting.
 *
 * Directory separators go too. A filename is not a path, and `../../etc` in
 * one is either a mistake or an attempt.
 */
export function safeFilename(filename: string): string {
  const flattened = filename
    // oxlint-disable-next-line no-control-regex
    .replaceAll(/[\u0000-\u001f\u007f]/gu, "")
    .replaceAll(/[\\/]/gu, "")
    .replaceAll('"', "");

  const trimmed = flattened.trim();
  return trimmed === "" || trimmed === "." || trimmed === ".." ? "download" : trimmed;
}

/**
 * Builds the `Content-Disposition` value.
 *
 * A non-ASCII name gets both spellings: `filename=` transliterated, for
 * anything old, and RFC 5987's `filename*=UTF-8''…` for everything else.
 * Sending only the second loses the name on old clients; sending only the
 * first turns every name that is not English into mojibake.
 *
 * The two halves are `multipart.ts`'s `asciiFilename` and `utf8Filename` —
 * Rails names them separately because they are separately useful, and building
 * them inline here would be a second implementation to keep in step.
 */
export function contentDisposition(disposition: Disposition, filename: string | undefined): string {
  if (!filename) return disposition;

  const ascii = asciiFilename(filename);
  const parameters = [`filename="${ascii}"`];

  // Only when they differ: a client that understands `filename*` ignores
  // `filename`, so sending both for a plain ASCII name is a longer header
  // saying the same thing twice.
  if (safeFilename(filename) !== ascii) parameters.push(`filename*=${utf8Filename(filename)}`);

  return `${disposition}; ${parameters.join("; ")}`;
}

/** Guesses a content type from the extension, as Rails does. */
export function typeForFilename(filename: string | undefined): string {
  if (!filename) return "application/octet-stream";

  const type = Bun.file(filename).type;
  return type.startsWith("application/octet-stream") ? "application/octet-stream" : type;
}

/** A response carrying some bytes. Rails' `send_data`. */
export function sendData(
  data: Uint8Array | ArrayBuffer | string | Blob,
  options: SendOptions = {},
): Response {
  const disposition = options.disposition ?? "attachment";

  return new Response(data as Uint8Array | string | Blob, {
    status: options.status ?? 200,
    headers: {
      "content-type": options.type ?? typeForFilename(options.filename),
      "content-disposition": contentDisposition(disposition, options.filename),
      // Nothing else may rewrite it. A proxy that helpfully compresses or
      // transcodes a download is a proxy that corrupts it.
      "cache-control": "private, no-transform",
    },
  });
}

/**
 * A response streaming a file from disk. Rails' `send_file`.
 *
 * The body is the file itself rather than its contents read into memory, so
 * sending a large one costs a file handle instead of its size in bytes.
 */
export async function sendFile(path: string, options: SendOptions = {}): Promise<Response> {
  const file = Bun.file(path);

  if (!(await file.exists())) throw new FileNotFound(path);

  const filename = options.filename ?? path.split(/[\\/]/u).pop();
  const type = options.type ?? file.type;

  if (options.request) {
    // `file.slice` is a range over the file on disk, so a partial response
    // still costs a handle rather than the file's size — which is the reason
    // to send a file this way at all, and would be lost by reading it in
    // order to slice it.
    const partial = partialResponse(
      options.request,
      (range) => file.slice(range.start, range.end + 1),
      {
        size: file.size,
        contentType: type,
        headers: {
          "content-disposition": contentDisposition(options.disposition ?? "attachment", filename),
          "cache-control": "private, no-transform",
        },
      },
    );

    if (partial) return partial;
  }

  const whole = sendData(file, { ...options, filename, type });

  // Advertised on the whole response too: a player decides whether it can seek
  // from this before it ever asks for a range, and without it will not try.
  for (const [name, value] of Object.entries(ACCEPT_RANGES)) whole.headers.set(name, value);

  return whole;
}

export class FileNotFound extends Error {
  constructor(path: string) {
    super(`No file to send at ${path}.`);
    this.name = "FileNotFound";
  }
}
