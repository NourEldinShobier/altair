/**
 * Building inbound messages for tests, ported from
 * `ActionMailbox::TestHelper`.
 *
 *     const mail = createInboundEmailFromSource(raw)
 *     const result = await receiveInboundEmail(router, mail)
 *
 * A mailbox test is about routing and about what the mailbox did with the
 * message — not about the provider's webhook shape. Writing the message
 * literal by hand means restating every required field in every test, and the
 * ones a test does not care about are exactly the ones it gets wrong.
 */

import {
  addressOf,
  parseInbound,
  type InboundMessage,
  type InboundResult,
  type MailboxRouter,
} from "./mailbox.js";

// Re-exported so a test keeps importing them from here, though they live with
// the routing now: they are what decides which mailbox a message reaches, not
// a testing convenience.
export { recipientsAddresses, xForwardedToAddresses, xOriginalToAddresses } from "./mailbox.js";

/**
 * A message from the parts a test actually cares about.
 *
 * Everything else is filled in: a message id, an empty subject, a delivery
 * time. Rails' `create_inbound_email_from_mail`.
 */
export function createInboundEmailFromMail(parts: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: parts.messageId ?? `test-${String(parts.subject ?? "message")}@example.com`,
    from: parts.from ?? "sender@example.com",
    to: parts.to ?? ["recipient@example.com"],
    subject: parts.subject ?? "",
    ...parts,
  };
}

/**
 * A message from a raw RFC 5322 source. Rails'
 * `create_inbound_email_from_source`.
 *
 * Only the headers a mailbox routes on are read — the address fields, the
 * subject, the message id — and the rest of the source becomes the body. A
 * full MIME parse is the provider's job, and a test that needed one would be
 * testing the parser rather than the mailbox.
 */
export function createInboundEmailFromSource(source: string): InboundMessage {
  const [rawHeaders = "", ...rest] = source.split(/\r?\n\r?\n/);
  const headers: Record<string, string> = {};

  for (const line of rawHeaders.split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at === -1) continue;

    headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }

  const list = (name: string): string[] =>
    (headers[name] ?? "")
      .split(",")
      .map((one) => addressOf(one.trim()))
      .filter((one) => one.length > 0);

  return {
    messageId: headers["message-id"] ?? `source-${String(rawHeaders.length)}@example.com`,
    from: addressOf(headers.from ?? "sender@example.com"),
    to: list("to"),
    cc: list("cc"),
    subject: headers.subject ?? "",
    text: rest.join("\n\n"),
    headers,
  };
}

/** The same, from a fixture file's contents. Rails' `create_inbound_email_from_fixture`. */
export function createInboundEmailFromFixture(source: string): InboundMessage {
  return createInboundEmailFromSource(source);
}

/** Routes a message and gives back what the mailbox did. Rails' `receive_inbound_email`. */
export async function receiveInboundEmail(
  router: MailboxRouter,
  message: InboundMessage,
): Promise<InboundResult> {
  return await router.receive(message);
}

/** Rails' `receive_inbound_email_from_source`. */
export async function receiveInboundEmailFromSource(
  router: MailboxRouter,
  source: string,
): Promise<InboundResult> {
  return await receiveInboundEmail(router, createInboundEmailFromSource(source));
}

/** Rails' `receive_inbound_email_from_mail`. */
export async function receiveInboundEmailFromMail(
  router: MailboxRouter,
  parts: Partial<InboundMessage> = {},
): Promise<InboundResult> {
  return await receiveInboundEmail(router, createInboundEmailFromMail(parts));
}

/** Rails' `receive_inbound_email_from_fixture`. */
export async function receiveInboundEmailFromFixture(
  router: MailboxRouter,
  source: string,
): Promise<InboundResult> {
  return await receiveInboundEmailFromSource(router, source);
}

/** The same, from a provider's webhook payload. */
export function createInboundEmailFromPayload(body: unknown): InboundMessage {
  return parseInbound(body);
}
