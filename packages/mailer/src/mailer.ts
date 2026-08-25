/**
 * Mailers, ported from `ActionMailer::Base`.
 *
 *     class UserMailer extends Mailer {
 *       static welcome(user: User) {
 *         return this.mail({
 *           to: user.email,
 *           subject: "Welcome aboard",
 *           html: <WelcomeEmail user={user} />,
 *         })
 *       }
 *     }
 *
 *     await UserMailer.welcome(user).deliverNow()
 *     await UserMailer.welcome(user).deliverLater()
 *
 * The methods are static so the call reads as it does in Rails, and a body may
 * be TSX rather than a template.
 *
 * One deliberate difference: `deliverLater` queues the rendered message, where
 * Rails queues the mailer name and its arguments and re-renders in the worker.
 * Rails does that because a Ruby object cannot be put on a queue, only a
 * GlobalID that reloads it. Queuing the rendered message instead means no
 * method-name string to keep in sync with the method, the message that was
 * built is the message that gets sent, and a mailer that renders fine now
 * cannot fail to render in a worker after a deploy. The cost is a larger
 * payload and a body rendered at enqueue time rather than at send time.
 */

import { renderToString, type Node } from "@altair/view";
import {
  assertHeaderSafe,
  UnconfiguredDelivery,
  type Address,
  type DeliveryMethod,
  type MessageFields,
} from "./message.js";

export interface MailOptions extends Omit<MessageFields, "html" | "to"> {
  to: Address | Address[];
  /** A string, or TSX rendered when the message is built. */
  html?: string | Node;
}

export interface MailerDefaults {
  from?: Address;
  replyTo?: Address;
  headers?: Record<string, string>;
}

/** Where `deliverLater` puts a rendered message. Supplied by the application. */
export interface DeliveryQueue {
  enqueue(message: MessageFields): Promise<unknown>;
}

/**
 * A built message, not yet delivered.
 *
 * Rails returns a `MessageDelivery` for the same reason: it lets the caller
 * choose now or later without the mailer knowing which.
 */
export class MailMessage {
  constructor(
    readonly options: MailOptions,
    private readonly mailer: typeof Mailer,
  ) {}

  /** Renders the body and hands the message to the delivery method. */
  async deliverNow(): Promise<MessageFields> {
    const message = await this.toMessage();
    await this.mailer.delivery.sendMail(message);
    return message;
  }

  /** Renders the body and puts the message on the queue. */
  async deliverLater(): Promise<unknown> {
    if (!this.mailer.queue) {
      throw new Error(
        "No delivery queue configured. Set Mailer.queue before calling deliverLater().",
      );
    }
    return await this.mailer.queue.enqueue(await this.toMessage());
  }

  /** The message as a delivery method receives it, with the body rendered. */
  async toMessage(): Promise<MessageFields> {
    const defaults = this.mailer.defaults;
    const { html, ...rest } = this.options;

    const message: MessageFields = {
      ...defaults,
      ...rest,
      headers: { ...defaults.headers, ...rest.headers },
    };

    // Checked here because this is the one place every message passes through,
    // whether it is delivered now or queued. The addresses are checked as they
    // are formatted; these two are not, and a subject is as likely to carry a
    // user's words as a display name is.
    if (message.subject) assertHeaderSafe(message.subject, "Subject");

    for (const [name, value] of Object.entries(message.headers ?? {})) {
      assertHeaderSafe(name, "header name");
      assertHeaderSafe(String(value), `${name} header`);
    }

    if (html !== undefined) {
      message.html = typeof html === "string" ? html : await renderToString(html);
    }

    if (!message.from) {
      throw new Error(
        `${this.mailer.mailerName} has no from address. Set it on the message or in the mailer's defaults.`,
      );
    }

    if (!message.to || (Array.isArray(message.to) && message.to.length === 0)) {
      throw new Error(`${this.mailer.mailerName} has no recipient.`);
    }

    return message;
  }
}

export class Mailer {
  /** Applied to every message this mailer builds. Rails' `default from:`. */
  static defaults: MailerDefaults = {};

  /**
   * Where messages go.
   *
   * Refuses by default, so a misconfigured application fails at the first
   * delivery rather than silently dropping mail — the failure nobody notices
   * until a customer asks where their receipt went.
   */
  static delivery: DeliveryMethod = new UnconfiguredDelivery();

  /** Used by `deliverLater`. */
  static queue: DeliveryQueue | undefined;

  static get mailerName(): string {
    return this.name;
  }

  /** Builds a message. Called from a static mailer method. */
  static mail(options: MailOptions): MailMessage {
    return new MailMessage(options, this);
  }
}
