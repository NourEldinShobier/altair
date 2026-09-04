/**
 * Reading a raw email off the wire, ported from
 * `ActionMailbox::InboundEmail.from_source` and `ActionMailbox::Relayer`.
 *
 * The mailbox router takes an `InboundMessage` — a parsed shape — which is
 * what a provider like Mailgun or SendGrid posts. It is not what everything
 * posts. Postmark's raw mode, an SMTP server piping to a command, and anything
 * relaying through `exim` all hand over the RFC 822 source, and without a
 * parser those simply cannot be received.
 *
 * What this is not: a complete MIME implementation. It handles the shapes real
 * mail arrives in — headers, folded headers, a plain body, a multipart body
 * with text and HTML alternatives, and base64 or quoted-printable encodings —
 * and says so rather than pretending. Nested multiparts beyond one level and
 * attachments inside them are read as parts but not descended into.
 */

import type { InboundMessage } from "./mailbox.js";

/** One header, keeping the case it was written in for anything that cares. */
interface Headers {
  ordered: [string, string][];
  lookup: Map<string, string>;
}

function readHeaders(lines: string[]): { headers: Headers; body: string[] } {
  const ordered: [string, string][] = [];
  const lookup = new Map<string, string>();
  let index = 0;

  for (; index < lines.length; index += 1) {
    const line = lines[index] as string;

    // A blank line ends the headers. That is the whole framing of the format,
    // and the reason a stray blank line in a header block turns the rest of
    // the message into a body.
    if (line === "") {
      index += 1;
      break;
    }

    // A continuation: a long header wrapped onto the next line, which starts
    // with whitespace. Missing this splits `Subject: a very long ...` in two
    // and loses the tail.
    if (/^[ \t]/.test(line) && ordered.length > 0) {
      const last = ordered[ordered.length - 1] as [string, string];

      last[1] += ` ${line.trim()}`;
      lookup.set(last[0].toLowerCase(), last[1]);
      continue;
    }

    const split = line.indexOf(":");

    if (split === -1) continue;

    const name = line.slice(0, split).trim();
    const value = line.slice(split + 1).trim();

    ordered.push([name, value]);

    // First wins, as every mail parser does: a second `From` is either a
    // mistake or an attempt to confuse something downstream, and preferring
    // the later one is how a spoofed header ends up believed.
    if (!lookup.has(name.toLowerCase())) lookup.set(name.toLowerCase(), value);
  }

  return { headers: { ordered, lookup }, body: lines.slice(index) };
}

/** `Name <a@b.test>` and `a@b.test`, reduced to the address. */
export function addressIn(value: string): string {
  const angled = /<([^>]+)>/.exec(value);

  return (angled?.[1] ?? value).trim();
}

/** A comma-separated recipient list, as addresses. */
export function addressesIn(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") return [];

  // Split on commas outside angle brackets, so `"Smith, J" <j@b.test>` is one
  // recipient rather than two — a display name with a comma in it is ordinary
  // and splitting naively drops half of everybody called that.
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = "";

  for (const character of value) {
    // Quotes as well as angle brackets. A display name is quoted precisely
    // when it contains something that would otherwise be punctuation — which
    // is to say, precisely when the comma inside it would split it.
    if (character === '"') quoted = !quoted;
    if (!quoted && character === "<") depth += 1;
    if (!quoted && character === ">") depth -= 1;

    if (character === "," && depth === 0 && !quoted) {
      parts.push(current);
      current = "";
      continue;
    }

    current += character;
  }

  parts.push(current);

  return parts.map((part) => addressIn(part)).filter((one) => one !== "");
}

/**
 * Bytes through a named charset, falling back to UTF-8.
 *
 * A charset the runtime has never heard of is a header somebody wrote by
 * hand. UTF-8 is the right guess, and a wrong guess is mojibake rather than a
 * lost message.
 */
function decodeBytes(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset as ConstructorParameters<typeof TextDecoder>[0]).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

/**
 * A `=` at the end of a line: the line was wrapped and continues.
 *
 * Not a character, and leaving it in puts an `=` in the middle of words.
 */
const SOFT_LINE_BREAK = /=\r?\n/g;

function decodeBody(body: string, encoding: string | undefined, charset = "utf-8"): string {
  const how = encoding?.toLowerCase().trim();

  if (how === "base64") {
    const bytes = Buffer.from(body.replace(/\s+/g, ""), "base64");

    return decodeBytes(bytes, charset);
  }

  if (how === "quoted-printable") {
    // Decoded to bytes and then through the charset, not character by
    // character. `=C3=A9` is two bytes that mean one `é`, and turning each
    // hex pair straight into a code point gives `Ã©` — a message that looks
    // corrupted to the reader and blames the sender.
    const unwrapped = body.replace(SOFT_LINE_BREAK, "");
    const bytes: number[] = [];

    for (let index = 0; index < unwrapped.length; index += 1) {
      const character = unwrapped[index] as string;

      if (character === "=" && /^[0-9A-Fa-f]{2}$/.test(unwrapped.slice(index + 1, index + 3))) {
        bytes.push(Number.parseInt(unwrapped.slice(index + 1, index + 3), 16));
        index += 2;
        continue;
      }

      // Anything not part of an escape is already a byte in this charset.
      bytes.push(character.charCodeAt(0));
    }

    return decodeBytes(new Uint8Array(bytes), charset);
  }

  return body;
}

function parameterOf(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;

  const match = new RegExp(`${name}\\s*=\\s*"?([^";]+)"?`, "i").exec(header);

  return match?.[1]?.trim();
}

/**
 * Parses a raw RFC 822 message. Rails' `InboundEmail.from_source`.
 *
 * The message id is taken from the `Message-ID` header, because that is what
 * makes a redelivery recognisable — a provider that retries after a timeout
 * sends the same message again, and without a stable id the application
 * processes it twice.
 */
export function fromSource(source: string | Uint8Array): InboundMessage {
  const raw = typeof source === "string" ? source : new TextDecoder().decode(source);
  const { headers, body } = readHeaders(raw.split(/\r?\n/));
  const header = (name: string): string | undefined => headers.lookup.get(name.toLowerCase());

  const contentType = header("content-type");
  const boundary = parameterOf(contentType, "boundary");

  let text: string | undefined;
  let html: string | undefined;

  if (boundary !== undefined) {
    for (const part of splitParts(body.join("\n"), boundary)) {
      const parsed = readHeaders(part.split("\n"));
      const partType = parsed.headers.lookup.get("content-type") ?? "";
      const decoded = decodeBody(
        parsed.body.join("\n"),
        parsed.headers.lookup.get("content-transfer-encoding"),
        parameterOf(partType, "charset"),
      );

      if (partType.startsWith("text/html")) html ??= decoded.trim();
      else if (partType.startsWith("text/plain")) text ??= decoded.trim();
    }
  } else {
    const decoded = decodeBody(
      body.join("\n"),
      header("content-transfer-encoding"),
      parameterOf(contentType, "charset"),
    );

    if (contentType?.startsWith("text/html") === true) html = decoded.trim();
    else text = decoded.trim();
  }

  return {
    messageId: (header("message-id") ?? "").replace(/^<|>$/g, ""),
    from: addressIn(header("from") ?? ""),
    to: addressesIn(header("to")),
    ...(header("cc") === undefined ? {} : { cc: addressesIn(header("cc")) }),
    subject: header("subject") ?? "",
    ...(text === undefined ? {} : { text }),
    ...(html === undefined ? {} : { html }),
    headers: Object.fromEntries(headers.ordered),
    ...(header("date") === undefined ? {} : { receivedAt: new Date(header("date") as string) }),
  };
}

/**
 * The parts of a multipart body, without the boundary lines.
 *
 * Split on the literal marker rather than a regular expression: a boundary is
 * chosen by the sender and may contain anything, so building a pattern out of
 * it means escaping a string somebody else wrote — and getting that wrong on
 * one message in a thousand is a parser that fails only in production.
 */
function splitParts(body: string, boundary: string): string[] {
  const marker = `--${boundary}`;

  return (
    body
      .split(marker)
      // The closing boundary is the marker plus `--`, so the trailing dashes
      // land at the head of the chunk after it.
      .map((part) => part.replace(/^--/, "").replace(/^\r?\n/, ""))
      .filter((part) => part.trim() !== "")
  );
}

export interface RelayOptions {
  /** Where the application receives raw mail. */
  url: string;
  /** The shared secret the ingress checks. */
  password?: string;
  /** The user the ingress expects, if it wants one. Rails uses `actionmailbox`. */
  username?: string;
  fetch?: typeof globalThis.fetch;
}

/** What the ingress said. */
export interface RelayResult {
  status: number;
  /** Whether the message was accepted and should not be retried. */
  delivered: boolean;
  /** Whether the sender should try again — a 4xx that is not a refusal. */
  retryable: boolean;
  message: string;
}

/**
 * Hands a raw message to an application's ingress. Rails'
 * `ActionMailbox::Relayer`.
 *
 * This is the other half of `fromSource`: what an SMTP server runs to pass mail
 * to the application, rather than what the application runs to read it.
 *
 * The three-way answer matters more than it looks. An SMTP server needs to
 * know whether to bin the message, bounce it, or hold it and try again, and
 * collapsing those into success-or-failure means either losing mail or
 * retrying a message the application has already refused for ever.
 */
export async function relay(
  source: string | Uint8Array,
  options: RelayOptions,
): Promise<RelayResult> {
  const call = options.fetch ?? globalThis.fetch;
  const headers: Record<string, string> = { "content-type": "message/rfc822" };

  if (options.password !== undefined) {
    const user = options.username ?? "actionmailbox";

    headers.authorization = `Basic ${Buffer.from(`${user}:${options.password}`).toString("base64")}`;
  }

  const response = await call(options.url, { method: "POST", headers, body: source });

  return {
    status: response.status,
    delivered: response.status >= 200 && response.status < 300,
    // 404 and 422 are the application saying no on purpose — no ingress here,
    // or a message it will never accept — and retrying either is a message
    // that never stops arriving. Everything else in the 4xx and 5xx ranges is
    // worth another attempt.
    retryable: response.status >= 400 && response.status !== 404 && response.status !== 422,
    message: describeRelay(response.status),
  };
}

function describeRelay(status: number): string {
  if (status >= 200 && status < 300) return "Delivered to the application.";
  if (status === 401) return "The ingress refused the credentials.";
  if (status === 404) return "There is no ingress at that address.";
  if (status === 422) return "The application could not accept the message.";

  return `The ingress answered ${String(status)}.`;
}
