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

import { currentEnvironment, type Environment } from "@altair/support";
import { renderToString, type Node } from "@altair/view";
import {
  assertHeaderSafe,
  runInterceptors,
  runObservers,
  LogDelivery,
  TestDelivery,
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

    // Between rendering and sending, which is the only place a rule that must
    // hold for every message can be applied once.
    if (!(await runInterceptors(message))) return message;

    await this.mailer.delivery.sendMail(message);
    await runObservers(message);

    return message;
  }

  /**
   * Renders the body and puts the message on the queue.
   *
   * Returns undefined when an interceptor dropped it, which is the same answer
   * `deliverNow` gives: nothing was sent.
   */
  async deliverLater(): Promise<unknown> {
    if (!this.mailer.queue) {
      throw new Error(
        "No delivery queue configured. Set Mailer.queue before calling deliverLater().",
      );
    }
    const message = await this.toMessage();

    // Run here rather than when the worker sends, so a queued message passes
    // through them exactly once and does not depend on what the application's
    // worker remembers to call. `deliverNow` runs them at the same point in
    // its own path: after rendering, before the message leaves.
    if (!(await runInterceptors(message))) return undefined;

    return await this.mailer.queue.enqueue(message);
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
   * Chosen from the environment, as Rails picks a delivery method per
   * environment: collected in test so a case can assert on them, written to
   * the terminal in development so somebody can read what would have been
   * sent, and refused in production.
   *
   * Production keeps refusing on purpose. A default that logged there would
   * drop mail silently — the failure nobody notices until a customer asks
   * where their receipt went.
   */
  static delivery: DeliveryMethod = defaultDelivery();

  /** Used by `deliverLater`. */
  static queue: DeliveryQueue | undefined;

  /**
   * The collected messages, when the environment collects them.
   *
   * Rails' `ActionMailer::Base.deliveries`. Empty rather than absent when the
   * delivery method is something else, so a test reads the same either way.
   */
  static get deliveries(): readonly MessageFields[] {
    return this.delivery instanceof TestDelivery ? this.delivery.deliveries : [];
  }

  static get mailerName(): string {
    return this.name;
  }

  /** Builds a message. Called from a static mailer method. */
  static mail(options: MailOptions): MailMessage {
    return new MailMessage(options, this);
  }
}

/**
 * The delivery method an environment gets when nothing says otherwise.
 *
 * Rails sets this per environment in `config/environments/*.rb`, which means a
 * generated application can send mail on the first day. Here it comes from the
 * environment itself, so an application that was not generated gets the same.
 */
export function defaultDelivery(env: Environment = currentEnvironment()): DeliveryMethod {
  if (env === "test") return new TestDelivery();
  if (env === "development") return new LogDelivery();

  return new UnconfiguredDelivery();
}
