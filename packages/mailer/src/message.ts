import { errors } from "@altair/support";
/**
 * Mail messages and delivery, ported from `ActionMailer` and the `mail` gem.
 *
 * The delivery interface is declared here rather than depended on. Nodemailer's
 * transporter shape is the de facto standard — `sendMail(message)` — so
 * declaring it means this package has no dependencies and works with
 * Nodemailer, an SES client, or anything else that exposes the same method.
 */

export type Address = string | { name?: string; address: string };

export interface Attachment {
  filename: string;
  content: string | Uint8Array;
  contentType?: string;
}

export interface MessageFields {
  from?: Address;
  to: Address | Address[];
  cc?: Address | Address[];
  bcc?: Address | Address[];
  replyTo?: Address;
  subject: string;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
  attachments?: Attachment[];
}

/** The shape Nodemailer's transporter exposes, and that SES clients mimic. */
export interface DeliveryMethod {
  sendMail(message: MessageFields): Promise<unknown>;
}

/** Raised when a value would end a header and start another one. */
export class HeaderInjection extends Error {
  constructor(
    readonly field: string,
    readonly value: string,
  ) {
    super(
      `Refusing to build the ${field} header from ${JSON.stringify(value)}: a header value cannot contain a line break or a null.`,
    );
    this.name = "HeaderInjection";
  }
}

/**
 * Refuses a value that would break out of its header.
 *
 * A header ends at a line break, so a value holding one does not stay a value:
 * `"Ada\r\nBcc: attacker@example.com"` in a display name is a second header,
 * and the message goes to somewhere the sender never named. This is live
 * wherever a name reaches a header from outside — "Message from {user.name}"
 * is the usual way in.
 *
 * Refused rather than stripped. Stripping turns an attack into a slightly odd
 * name and delivers it; a caller that has built a header out of unchecked
 * input wants to hear about it.
 */
export function assertHeaderSafe(value: string, field: string): void {
  if (HEADER_BREAK.test(value)) throw new HeaderInjection(field, value);
}

/**
 * A line break in any of its spellings, plus a null.
 *
 * A bare CR and a bare LF both count: agreement between parsers on what ends a
 * line is exactly what an attacker is looking for, so neither is allowed
 * through on the grounds that the other is the real terminator.
 */
const HEADER_BREAK = new RegExp(
  `[${String.fromCodePoint(13)}${String.fromCodePoint(10)}${String.fromCodePoint(0)}${String.fromCodePoint(0x0b)}${String.fromCodePoint(0x0c)}]`,
);

/**
 * Changes a message on its way out, or stops it.
 *
 * Rails' `register_interceptor`. The reason this exists rather than a wrapper
 * around each mailer: the thing people need it for is a rule that must hold
 * for every message an application sends, and one mailer that forgot to opt in
 * is the one that emails a customer from staging.
 *
 * Returning `false` drops the message.
 */
export type DeliveryInterceptor = (
  message: MessageFields,
) => boolean | void | Promise<boolean | void>;

/** Told about a message after it went. Rails' `register_observer`. */
export type DeliveryObserver = (message: MessageFields) => void | Promise<void>;

const interceptors: DeliveryInterceptor[] = [];
const observers: DeliveryObserver[] = [];

/**
 * Registers something to run before every delivery.
 *
 *     interceptDelivery((message) => {
 *       message.to = "staging@example.com"
 *     })
 *
 * The canonical one, and the reason to have it at all: a staging environment
 * that rewrites every recipient. Without it the rule lives in each mailer, and
 * the incident is the mailer that did not get it.
 */
export function interceptDelivery(interceptor: DeliveryInterceptor): () => void {
  interceptors.push(interceptor);

  // Returns its own removal, so a test can register one without leaking it
  // into every test that follows.
  return () => {
    const at = interceptors.indexOf(interceptor);
    if (at !== -1) interceptors.splice(at, 1);
  };
}

/** Registers something to run after every delivery. */
export function observeDelivery(observer: DeliveryObserver): () => void {
  observers.push(observer);

  return () => {
    const at = observers.indexOf(observer);
    if (at !== -1) observers.splice(at, 1);
  };
}

/** Forgets every interceptor and observer. */
export function resetDeliveryHooks(): void {
  interceptors.length = 0;
  observers.length = 0;
}

/**
 * Runs the interceptors, and says whether the message should still go.
 *
 * They run in the order they were registered, each seeing what the last one
 * did, so a rule that rewrites a recipient and a rule that reads it agree
 * about which recipient they mean.
 */
export async function runInterceptors(message: MessageFields): Promise<boolean> {
  for (const interceptor of interceptors) {
    if ((await interceptor(message)) === false) return false;
  }

  return true;
}

/**
 * Tells the observers a message went.
 *
 * An observer that throws does not fail the delivery: the message has already
 * been handed over, and there is nothing left to undo. It is reported and the
 * rest still run.
 */
export async function runObservers(message: MessageFields): Promise<void> {
  for (const observer of observers) {
    try {
      await observer(message);
    } catch (error) {
      // Reported rather than swallowed: something that watches deliveries and
      // fails silently is worse than no watcher at all. Through the error
      // reporter rather than the console, so an application decides where it
      // goes and a test suite is not made noisy by a case it is asserting on.
      errors.report(error, { source: "mailer.observer" });
    }
  }
}

/** Formats an address for a header, quoting a display name that needs it. */
export function formatAddress(address: Address): string {
  if (typeof address === "string") {
    assertHeaderSafe(address, "address");
    return address;
  }

  assertHeaderSafe(address.address, "address");
  if (address.name) assertHeaderSafe(address.name, "address name");

  if (!address.name) return address.address;

  // A name containing a comma or quote would otherwise split the header.
  const needsQuotes = /[",:;<>@\\]/.test(address.name);
  const name = needsQuotes ? `"${address.name.replaceAll('"', '\\"')}"` : address.name;

  return `${name} <${address.address}>`;
}

export function formatAddresses(addresses: Address | Address[] | undefined): string {
  if (!addresses) return "";
  return (Array.isArray(addresses) ? addresses : [addresses]).map(formatAddress).join(", ");
}

/**
 * Collects messages instead of sending them.
 *
 * Rails' test delivery method. A test asserts on what would have been sent,
 * and a development environment can show the same list.
 */
export class TestDelivery implements DeliveryMethod {
  readonly deliveries: MessageFields[] = [];

  async sendMail(message: MessageFields): Promise<MessageFields> {
    this.deliveries.push(message);
    return message;
  }

  clear(): void {
    this.deliveries.length = 0;
  }

  get last(): MessageFields | undefined {
    return this.deliveries.at(-1);
  }
}

/** Writes messages to a logger rather than sending them. */
export class LogDelivery implements DeliveryMethod {
  constructor(private readonly log: (line: string) => void = console.log) {}

  async sendMail(message: MessageFields): Promise<void> {
    this.log(
      [
        `To: ${formatAddresses(message.to)}`,
        `Subject: ${message.subject}`,
        "",
        message.text ?? message.html ?? "",
      ].join("\n"),
    );
  }
}

/**
 * Refuses to send.
 *
 * The default, so a misconfigured application fails loudly at the first
 * delivery rather than silently dropping mail — which is the failure mode
 * nobody notices until a customer asks where their receipt went.
 */
export class UnconfiguredDelivery implements DeliveryMethod {
  async sendMail(): Promise<never> {
    throw new Error(
      "No delivery method configured. Set Mailer.delivery to a transport, TestDelivery, or LogDelivery.",
    );
  }
}
