/**
 * Uploaded files and how parameters are encoded, ported from
 * `ActionDispatch::Http::UploadedFile`, `Request::Utils` and the multipart half
 * of `ActionDispatch::Http::Parameters`.
 *
 * A filename that arrives with an upload is the most hostile ordinary input a
 * web application handles: it is chosen by the person uploading, travels
 * through a header format that predates Unicode, and is then very often used
 * to name a file on disk. Almost every rule here is about that one value.
 *
 * - **The filename is never used as a path.** A browser sends `foo.png` and an
 *   attacker sends `../../etc/passwd`, and the two are the same field.
 *   `send.ts`'s `safeFilename` is what strips it; the two halves of the
 *   `Content-Disposition` header live here, and it now builds the header from
 *   them rather than inlining its own versions.
 * - **A non-ASCII filename has two encodings on the wire**, and old clients
 *   send only the first. RFC 5987's `filename*` is the correct one and
 *   `filename` is the fallback, so both are written and the ASCII one is a
 *   transliteration rather than a mangling.
 * - **The declared content type is not the file's type.** It is a claim by the
 *   uploader. It is kept because most upload handling is *about* the claim —
 *   including the case where it disagrees with the bytes — and never trusted
 *   for anything that matters.
 */

import { safeFilename } from "./send.js";

// --- filenames ------------------------------------------------------------------------

/**
 * The last path segment, whatever separator was used.
 *
 * Both separators are checked because the sender's filesystem is not the
 * receiver's: a Windows client sends `C:\Users\ada\photo.png` and a server
 * splitting on `/` alone keeps the whole thing as one "filename".
 */
export function basename(filename: string): string {
  const segments = filename.split(/[/\\]/);

  return segments.at(-1) ?? "";
}

/**
 * Rails' `ascii_filename` — the `filename=` half of a Content-Disposition.
 *
 * A transliteration, not a truncation: dropping the non-ASCII characters
 * outright turns `résumé.pdf` into `rsum.pdf`, which is a name nobody
 * recognises. Anything with no ASCII equivalent becomes an underscore so the
 * extension survives, since that is the part the receiving system acts on.
 *
 * A name where *nothing* transliterates — one written entirely in a non-Latin
 * script — becomes `download` plus whatever extension there was. A row of
 * underscores is not a name, and a browser's save dialog is where it would be
 * read.
 */
export function asciiFilename(filename: string): string {
  const normalized = safeFilename(filename)
    .normalize("NFKD")
    .replaceAll(/[̀-ͯ]/g, "");

  // Quotes are already gone: `safeFilename` strips them, because one inside a
  // header parameter ends it and lets the rest be read as another.
  const transliterated = normalized.replaceAll(/[^ -~]/g, "_");

  const stem = transliterated.replace(/\.[^.]*$/, "");

  if (/[A-Za-z0-9]/.test(stem)) return transliterated;

  const extension = /\.[A-Za-z0-9]+$/.exec(transliterated)?.[0] ?? "";

  return `download${extension}`;
}

/**
 * Rails' `utf8_filename` — the RFC 5987 `filename*` half.
 *
 * Percent-encoded with the charset named, which is what lets a client show the
 * real name. Both halves are sent because a client that does not understand
 * `filename*` silently uses `filename`, and one that does ignores it.
 */
export function utf8Filename(filename: string): string {
  return `UTF-8''${encodeURIComponent(safeFilename(filename)).replaceAll("'", "%27")}`;
}

// --- an uploaded file --------------------------------------------------------------------

export interface UploadedFile {
  /** As the client sent it, unsanitised — the sanitised form is derived. */
  originalFilename: string;
  /** What the *uploader* claims it is. Never trusted. */
  contentType: string;
  bytes: Uint8Array;
  headers?: Record<string, string>;
}

export function uploadedFile(
  originalFilename: string,
  bytes: Uint8Array,
  contentType = "application/octet-stream",
): UploadedFile {
  return { originalFilename, contentType, bytes };
}

/**
 * Rails' `UploadedFile#to_io`.
 *
 * A fresh view each call. Handing out one shared reader means a second consumer
 * — a virus scanner, a checksum, a thumbnailer — finds it already at the end
 * and reads zero bytes, which looks exactly like an empty upload.
 */
export function toIo(file: UploadedFile): Uint8Array {
  return file.bytes.slice();
}

/** The name safe to write to disk. */
export function storedFilename(file: UploadedFile): string {
  return safeFilename(file.originalFilename);
}

// --- deciding how to encode a request ------------------------------------------------------

export interface ParamValue {
  [key: string]: unknown;
}

/**
 * Rails' `should_multipart?`.
 *
 * Multipart if anything in the parameters is a file, at any depth. A form
 * posted as urlencoded with a file in it sends the file's *inspect output* as a
 * string — the request succeeds, the record saves, and the attachment is the
 * text `#<File:...>`.
 */
export function shouldMultipart(params: unknown): boolean {
  if (params instanceof Uint8Array) return true;
  if (isUploadedFile(params)) return true;
  if (Array.isArray(params)) return params.some((each) => shouldMultipart(each));

  if (typeof params === "object" && params !== null) {
    return Object.values(params).some((each) => shouldMultipart(each));
  }

  return false;
}

function isUploadedFile(value: unknown): value is UploadedFile {
  return (
    typeof value === "object" && value !== null && "originalFilename" in value && "bytes" in value
  );
}

/**
 * Rails' `FormData` construction for a test request.
 *
 * Nested keys become `post[tags][]`, which is the shape a Rails parameter
 * parser reads back. Building `post.tags` instead produces a request the
 * server accepts and parses into one flat parameter with a dot in its name.
 */
export function formData(params: ParamValue, prefix = ""): [string, unknown][] {
  const entries: [string, unknown][] = [];

  for (const [key, value] of Object.entries(params)) {
    const name = prefix === "" ? key : `${prefix}[${key}]`;

    if (Array.isArray(value)) {
      // The trailing `[]` is not decoration: without it a repeated parameter
      // parses as a single value — the last one — rather than as a list.
      for (const each of value) entries.push([`${name}[]`, each]);
      continue;
    }

    if (isUploadedFile(value) || value instanceof Uint8Array || value === null) {
      entries.push([name, value]);
      continue;
    }

    if (typeof value === "object") {
      entries.push(...formData(value as ParamValue, name));
      continue;
    }

    entries.push([name, value]);
  }

  return entries;
}

// --- parameter encoding ---------------------------------------------------------------------

const actionEncodings = new Map<string, string>();

/**
 * Rails' `param_encoding` — a parameter read as raw bytes rather than UTF-8.
 *
 * For an action receiving something that is not text: a binary blob in a
 * parameter, or a value in an encoding the application knows and the framework
 * does not. Declared per action *and* parameter, because doing it per action
 * would turn every other parameter of that action into bytes too — and those
 * are compared against strings everywhere.
 */
export function setupParamEncode(
  controller: string,
  action: string,
  parameter: string,
  encoding: string,
): void {
  actionEncodings.set(`${controller}#${action}#${parameter}`, encoding);
}

/** Rails' `action_encoding_template` — what one action asked for. */
export function actionEncodingTemplate(controller: string, action: string): Record<string, string> {
  const template: Record<string, string> = {};

  for (const [key, encoding] of actionEncodings) {
    const [owner, actionName, parameter] = key.split("#");

    if (owner === controller && actionName === action && parameter !== undefined) {
      template[parameter] = encoding;
    }
  }

  return template;
}

export function resetParamEncodings(): void {
  actionEncodings.clear();
}

/**
 * Rails' `normalize_encode_params`.
 *
 * Applies a per-parameter encoding and leaves everything else as text. A
 * parameter with no declared encoding stays a string, because the alternative
 * — decoding everything as bytes and letting callers convert — moves the
 * decision to every reader instead of the one declaration.
 */
export function normalizeEncodeParams(
  params: Record<string, unknown>,
  template: Record<string, string>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(params).map(([name, value]) => {
      const encoding = template[name];

      if (encoding === undefined || typeof value !== "string") return [name, value];

      return [name, encodeParams(value, encoding)];
    }),
  );
}

/** Rails' `encode_params` — one value in a declared encoding. */
export function encodeParams(value: string, encoding: string): Uint8Array | string {
  if (encoding.toUpperCase() === "UTF-8") return value;

  if (encoding.toUpperCase() !== "BINARY" && encoding.toUpperCase() !== "ASCII-8BIT") {
    throw new Error(
      `Only UTF-8 and binary parameter encodings are supported, not ${JSON.stringify(encoding)}. ` +
        `Converting to an encoding the runtime cannot represent would produce a string that ` +
        `compares unequal to itself once it makes a round trip.`,
    );
  }

  const bytes = new Uint8Array(value.length);

  for (let index = 0; index < value.length; index += 1) {
    // No explicit mask: assigning into a Uint8Array already keeps the low
    // eight bits, so a character above 0xFF becomes its low byte either way.
    bytes[index] = value.charCodeAt(index);
  }

  return bytes;
}

// --- reading parameters back -------------------------------------------------------------------

/**
 * Rails' `params_array_from` — the `key[]` form back into a list.
 *
 * A single occurrence still produces a one-element list. Returning the bare
 * value for one and a list for two makes every consumer branch on the count,
 * and the branch is always missing for the one-element case — which is the
 * case a form produces when a user ticks a single box.
 */
export function paramsArrayFrom(value: unknown): unknown[] {
  if (value === undefined) return [];

  return Array.isArray(value) ? value : [value];
}

/**
 * Rails' `converted_arrays` — the arrays already turned into parameter
 * objects, remembered.
 *
 * Kept so the conversion happens once. Converting on each read means two reads
 * of the same nested parameter produce two different objects, so a caller that
 * assigned to the first sees nothing on the second.
 */
export function convertedArrays(
  cache: WeakMap<object, unknown[]>,
  source: object,
  convert: () => unknown[],
): unknown[] {
  const held = cache.get(source);

  if (held !== undefined) return held;

  const converted = convert();
  cache.set(source, converted);

  return converted;
}

/** Rails' `raw_params` — what arrived, before any filtering or conversion. */
export function rawParams(params: Record<string, unknown>): Record<string, unknown> {
  // A copy, so a caller inspecting the raw form cannot edit what the request
  // will be processed with — the two would then disagree and only one of them
  // is logged.
  return { ...params };
}

/**
 * Rails' `params_valid?` — whether the parameters decoded cleanly.
 *
 * An invalid byte sequence in a parameter is a 400, not an exception in
 * whichever model first touches it: the request is malformed, and reporting it
 * from the model sends the reader to a validation that is fine.
 */
export function paramsValid(params: Record<string, unknown>): boolean {
  return Object.values(params).every((value) => {
    if (typeof value !== "string") return true;

    // A lone surrogate is what a badly decoded byte sequence becomes.
    return !/[\uD800-\uDFFF]/.test(value.replaceAll(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""));
  });
}

/** Rails' `has_value?` — whether a parameter is present with a real value. */
export function hasValue(params: Record<string, unknown>, name: string): boolean {
  const value = params[name];

  // An empty string is what an untouched text field sends, so it is *present*
  // and not a value. Treating it as a value is how a blank field overwrites a
  // real one with nothing.
  if (value === undefined || value === null || value === "") return false;

  return !(Array.isArray(value) && value.length === 0);
}

/** Rails' `extract_value` — one value out of a nested parameter path. */
export function extractValue(params: Record<string, unknown>, path: string): unknown {
  const segments = path.split(/\]\[|\[|\]/).filter((part) => part !== "");

  let current: unknown = params;

  for (const segment of segments) {
    if (typeof current !== "object" || current === null) return undefined;

    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

/**
 * Rails' `deconstruct_keys` — parameters for a pattern match.
 *
 * Only the requested keys, and only those that are present. Returning an entry
 * for a missing key would make a pattern match succeed with `nil`, which is
 * the one thing a pattern match is supposed to prevent.
 */
export function deconstructKeys(
  params: Record<string, unknown>,
  keys: readonly string[] | undefined,
): Record<string, unknown> {
  const wanted = keys ?? Object.keys(params);

  return Object.fromEntries(wanted.filter((key) => key in params).map((key) => [key, params[key]]));
}
