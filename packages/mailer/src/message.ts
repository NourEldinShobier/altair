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
