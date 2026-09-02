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

import { componentLogger, setComponentLogger, type Logger } from "@altair/support";
import { smtpDeliveryFromUrl } from "./smtp.js";
import {
  addDeliveryMethod,
  deliveryMethodNames,
  wrapDeliveryBehavior,
  type DeliveryMethodBuilder,
} from "./delivery_registry.js";
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

    // This mailer's own callbacks, inside the global ones. An interceptor is
    // for a rule that holds across the application — rewriting every recipient
    // in staging — and these are for one mailer's business, which is why both
    // exist and why the narrower one runs closer to the send.
    for (const hook of deliveryHooks(this.mailer, "before")) await hook(message);

    await this.mailer.delivery.sendMail(message);

    // After the send, so a callback that records what went out records only
    // what actually went. A send that throws runs neither these nor the
    // observers, which is the same shape `afterCreate` has for a save.
    for (const hook of deliveryHooks(this.mailer, "after")) await hook(message);

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

/** Something to run around one mailer's own deliveries. */
export type DeliveryHook = (message: MessageFields) => void | Promise<void>;

interface DeliveryHooks {
  before: DeliveryHook[];
  after: DeliveryHook[];
}

/**
 * Keyed by the class rather than stored on it, so a subclass declaring a hook
 * does not push it onto the base class's array and run it for every sibling.
 */
const DELIVERY_HOOKS = new WeakMap<object, DeliveryHooks>();

function ownDeliveryHooks(klass: object): DeliveryHooks {
  let own = DELIVERY_HOOKS.get(klass);

  if (!own) {
    own = { before: [], after: [] };
    DELIVERY_HOOKS.set(klass, own);
  }

  return own;
}

/**
 * A class's hooks and everything it inherits, outermost first.
 *
 * Walked upwards and unshifted, so a base class's hook runs before a
 * subclass's — an application-wide `beforeDeliver` that stamps a header has to
 * be in place before the mailer that reads it.
 */
export function deliveryHooks(klass: object, kind: keyof DeliveryHooks): DeliveryHook[] {
  const chain: DeliveryHook[] = [];

  for (let at: object | null = klass; at; at = Object.getPrototypeOf(at)) {
    const own = DELIVERY_HOOKS.get(at);
    if (own) chain.unshift(...own[kind]);
  }

  return chain;
}

export class Mailer {
  /** Applied to every message this mailer builds. Rails' `default from:`. */
  static defaults: MailerDefaults = {};

  /**
   * Runs before this mailer's messages are sent. Rails' `before_deliver`.
   *
   *     class OrderMailer extends Mailer {
   *       static { this.beforeDeliver((message) => tagForBilling(message)) }
   *     }
   *
   * For one mailer's business. A rule that holds across the application —
   * rewriting every recipient in staging — belongs in an interceptor, which
   * runs outside these and applies to every mailer there is.
   */
  static beforeDeliver(hook: DeliveryHook): void {
    ownDeliveryHooks(this).before.push(hook);
  }

  /**
   * Runs after this mailer's messages are sent. Rails' `after_deliver`.
   *
   * After the send rather than around it, so a callback that records what went
   * out records only what actually went: a send that throws runs neither these
   * nor the observers.
   */
  static afterDeliver(hook: DeliveryHook): void {
    ownDeliveryHooks(this).after.push(hook);
  }

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
  // Never from a test, whatever the environment says — and before the named
  // method too. A suite that sends real mail is one that sends it to real
  // people the first time it runs somewhere with the production variables set,
  // and a variable naming a live method is exactly how that happens.
  if (env === "test") return new TestDelivery();

  // A registered method wins, so an application that plugged in a
  // transactional-email API gets it without the framework knowing the API
  // exists. An unregistered name throws rather than falling through to SMTP:
  // a typo that quietly resolves to the real thing is how a staging box mails
  // a customer.
  const named = process.env.MAIL_DELIVERY_METHOD;

  if (named) {
    registerBuiltInDeliveryMethods();

    return wrapDeliveryBehavior(named, { url: process.env.SMTP_URL });
  }

  // One variable and an application can send. `smtp://user:pass@host:587`,
  // which is the shape every hosted mail service already hands you.
  const url = process.env.SMTP_URL;
  if (url) return smtpDeliveryFromUrl(url);

  if (env === "development") return new LogDelivery();

  return new UnconfiguredDelivery();
}

/**
 * The methods this package brings, so `MAIL_DELIVERY_METHOD` works on a fresh
 * application. Rails registers `:smtp`, `:file` and the rest the same way.
 *
 * Registered here rather than in `delivery_registry.ts` so the registry stays
 * a registry: it knows how to hold a builder and nothing about what any of
 * them do.
 *
 * Called when a method is asked for rather than when this module is imported.
 * An import-time side effect makes the order of imports decide what is
 * registered, which is a thing nobody can see and everybody trips on — and it
 * is unobservable to a test suite that shares one process between files, which
 * is how this was found.
 *
 * A name already registered is left alone, so calling this again cannot
 * replace an application's own `smtp` with the built-in one.
 */
export function registerBuiltInDeliveryMethods(): void {
  register("smtp", (settings) => {
    const url = settings["url"];

    if (typeof url !== "string" || url === "") {
      throw new Error(
        "The smtp delivery method needs a URL. Set SMTP_URL to something like " +
          "smtp://user:pass@host:587 — it is the shape every hosted mail service hands you.",
      );
    }

    return smtpDeliveryFromUrl(url);
  });

  register("log", () => new LogDelivery());
  register("test", () => new TestDelivery());
}

/** Adds one only if nothing owns the name. */
function register(name: string, build: DeliveryMethodBuilder): void {
  if (!deliveryMethodNames().includes(name)) addDeliveryMethod(name, build);
}

/**
 * The logger this package writes through. Rails' `logger` on each base class.
 *
 * Its own rather than the shared one so an application can quieten mail
 * without quietening itself — which with a single logger means turning
 * everything down and then not being able to see its own lines either.
 */
export function defaultLogger(): Logger {
  return componentLogger("mailer");
}

/** Gives this package a logger of its own. Undefined puts the shared one back. */
export function setDefaultLogger(logger: Logger | undefined): void {
  setComponentLogger("mailer", logger);
}
