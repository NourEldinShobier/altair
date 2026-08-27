/**
 * What a mailbox does with mail it cannot process, ported from
 * `ActionMailbox::Base`'s bouncing and status handling.
 *
 * An inbound message that names nothing — a reply to a deleted thread, an
 * address that was never a person — has three possible answers, and Rails
 * names all three because they mean different things to whoever sent it.
 *
 *   - bounced:  we understood, and the answer is no. Tell them.
 *   - failed:   we broke. Try again later.
 *   - delivered: done.
 *
 * Silence is the fourth, and the worst: the sender believes their reply landed.
 */

import type { MessageFields } from "./message.js";
import type { InboundResult } from "./mailbox.js";

export function delivered(): InboundResult {
  return { status: "delivered" };
}

/**
 * We broke. Rails' `transient_failure`.
 *
 * The sender is told nothing, because there is nothing to tell them yet — a
 * queue that is down is our problem and a retry may fix it. Bouncing here
 * would tell somebody their perfectly good reply was rejected.
 */
export function transientFailure(reason: string): InboundResult {
  return { status: "failed", reason };
}

/** We broke and retrying will not help. Rails' `permanent_failure`. */
export function permanentFailure(reason: string): InboundResult {
  return { status: "failed", reason };
}

/**
 * We understood, and the answer is no. Rails' `bounce_with`.
 *
 * The reply goes to whoever sent the original, which is the one address a
 * bounce may ever go to: replying to anything the message named — a `To`, a
 * `Reply-To` — is how a mailbox becomes a way to send mail to strangers.
 */
export function bounceWith(
  inbound: MessageFields,
  reply: Omit<MessageFields, "to">,
): InboundResult {
  const sender = senderOf(inbound);

  if (!sender) {
    return transientFailure("The message had no sender to bounce to.");
  }

  return {
    status: "bounced",
    bounce: { ...reply, to: sender },
  };
}

/**
 * Who sent it, as far as a bounce is concerned.
 *
 * `From` and nothing else. A bounce sent to `Reply-To` would let one person
 * make this mailbox mail another, and a bounce sent to `To` would mail the
 * mailbox itself — which is a loop.
 */
export function senderOf(message: MessageFields): string | null {
  const from = message.from;
  if (!from) return null;

  const address = typeof from === "string" ? from : from.address;

  // A bounce to a list address is how a loop starts, and these are the headers
  // that say "do not reply to this automatically".
  if (looksAutomated(message)) return null;

  return address ?? null;
}

/**
 * Whether a message says it is itself automatic.
 *
 * Bouncing to one is how two mail servers spend a weekend talking to each
 * other. `Auto-Submitted` is the header that exists to prevent exactly this.
 */
export function looksAutomated(message: MessageFields): boolean {
  const headers = message.headers ?? {};

  const auto = headers["auto-submitted"] ?? headers["Auto-Submitted"];
  if (auto && auto.toLowerCase() !== "no") return true;

  if (headers["list-id"] ?? headers["List-Id"]) return true;
  if ((headers["precedence"] ?? headers["Precedence"])?.toLowerCase() === "bulk") return true;

  const from = typeof message.from === "string" ? message.from : message.from?.address;

  // The null sender is what a bounce itself uses, and bouncing a bounce is the
  // loop this whole function exists to stop.
  return from === "" || from === "<>";
}

/** Every address a message was sent to, across the headers that carry them. */
export function recipientsOf(message: MessageFields): string[] {
  const addresses = [message.to, message.cc, message.bcc]
    .flatMap((one) => (Array.isArray(one) ? one : one ? [one] : []))
    .map((one) => (typeof one === "string" ? one : one.address))
    .filter((one): one is string => Boolean(one));

  return [...new Set(addresses.map((one) => one.toLowerCase()))];
}

export function toAddresses(message: MessageFields): string[] {
  return listOf(message.to);
}

export function ccAddresses(message: MessageFields): string[] {
  return listOf(message.cc);
}

export function bccAddresses(message: MessageFields): string[] {
  return listOf(message.bcc);
}

export function fromAddress(message: MessageFields): string | null {
  const from = message.from;
  if (!from) return null;

  return typeof from === "string" ? from : (from.address ?? null);
}

export function replyToAddress(message: MessageFields): string | null {
  const replyTo = message.replyTo;
  if (!replyTo) return null;

  return typeof replyTo === "string" ? replyTo : (replyTo.address ?? null);
}

function listOf(value: MessageFields["to"] | undefined): string[] {
  if (!value) return [];

  return (Array.isArray(value) ? value : [value])
    .map((one) => (typeof one === "string" ? one : one.address))
    .filter((one): one is string => Boolean(one));
}
