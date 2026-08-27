/**
 * Inbound mail, ported from `ActionMailbox`.
 *
 * The half of email an application usually ignores: what happens when someone
 * replies. Rails routes an incoming message to a mailbox class by matching the
 * address it was sent to, which turns "reply to this ticket" from a parsing
 * problem into a route.
 *
 *     const router = new MailboxRouter()
 *       .route(/^reply\+(.+)@/, RepliesMailbox)
 *       .route("support@example.com", SupportMailbox)
 *
 * A message that no mailbox claims is bounced rather than dropped, and a
 * message that has already been processed is not processed twice — an inbound
 * provider retries on any response it does not like, and an application that
 * files a duplicate ticket for every retry is worse than one that misses mail.
 */

import type { Address, MessageFields } from "./message.js";

/** A message as it arrived. */
export interface InboundMessage {
  /** The provider's identifier, used to recognise a redelivery. */
  messageId: string;
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
  attachments?: { filename: string; content: Uint8Array; contentType?: string }[];
  /** When the provider says it arrived. */
  receivedAt?: Date;
}

export type InboundStatus = "pending" | "delivered" | "bounced" | "failed";

/** What a mailbox did with a message. */
export interface InboundResult {
  status: InboundStatus;
  mailbox?: string;
  reason?: string;
  /**
   * The reply to send back, when the answer is a bounce.
   *
   * Built rather than sent here: whether a bounce actually goes out is the
   * application's decision, and a mailbox that sent mail as a side effect of
   * being called would be untestable.
   */
  bounce?: MessageFields;
}

/** A route's pattern: an exact address, or something matching one. */
export type MailboxPattern = string | RegExp | ((address: string) => boolean);

export abstract class Mailbox {
  constructor(readonly message: InboundMessage) {}

  /** Handles the message. Throwing marks it failed, so the provider retries. */
  abstract process(): Promise<void>;

  /**
   * Whether this mailbox will take the message.
   *
   * Rails' `bounce_with`, checked before anything is done rather than partway
   * through. Declining bounces the message; it does not hand it to whichever
   * route would have matched next, because a message has one destination and
   * delivering it somewhere nobody wrote down is worse than refusing it.
   */
  async accepts(): Promise<boolean> {
    return true;
  }

  /** The address the message was routed on. */
  get recipient(): string {
    return this.message.to[0] ?? "";
  }

  /** The body, preferring what a person actually typed. */
  get body(): string {
    return this.message.text ?? this.message.html ?? "";
  }
}

export type MailboxClass = new (message: InboundMessage) => Mailbox;

interface Route {
  pattern: MailboxPattern;
  mailbox: MailboxClass;
}

/** Where processed message ids are remembered, so a retry is not a duplicate. */
export interface InboundLog {
  seen(messageId: string): Promise<boolean>;
  record(messageId: string, result: InboundResult): Promise<void>;
}

/** The default log: in this process, which is right for tests and one server. */
export class MemoryInboundLog implements InboundLog {
  readonly entries = new Map<string, InboundResult>();

  async seen(messageId: string): Promise<boolean> {
    return this.entries.has(messageId);
  }

  async record(messageId: string, result: InboundResult): Promise<void> {
    this.entries.set(messageId, result);
  }
}

/** Does the address match this pattern? */
export function matchesPattern(pattern: MailboxPattern, address: string): boolean {
  if (typeof pattern === "function") return pattern(address);
  if (pattern instanceof RegExp) return pattern.test(address);

  return pattern.toLowerCase() === address.toLowerCase();
}

/** The address part of `Name <a@b.com>`, lowercased. */
export function addressOf(value: Address | string): string {
  const raw = typeof value === "string" ? value : value.address;
  const angled = /<([^>]+)>/.exec(raw);

  return (angled ? angled[1]! : raw).trim().toLowerCase();
}

export class MailboxRouter {
  readonly routes: Route[] = [];

  #log: InboundLog;

  constructor(options: { log?: InboundLog } = {}) {
    this.#log = options.log ?? new MemoryInboundLog();
  }

  /** Routes matching addresses to a mailbox. First match wins, as in Rails. */
  route(pattern: MailboxPattern, mailbox: MailboxClass): this {
    this.routes.push({ pattern, mailbox });
    return this;
  }

  /** The mailbox for an address, or undefined. */
  mailboxFor(address: string): MailboxClass | undefined {
    const normalized = addressOf(address);
    return this.routes.find((route) => matchesPattern(route.pattern, normalized))?.mailbox;
  }

  /**
   * Routes and processes a message.
   *
   * Every recipient is considered, because a message addressed to a person and
   * copied to a mailbox is still for the mailbox.
   */
  async receive(message: InboundMessage): Promise<InboundResult> {
    // A provider retries anything it does not like the look of, and an
    // application that files a duplicate ticket per retry is worse than one
    // that misses mail.
    if (await this.#log.seen(message.messageId)) {
      return { status: "delivered", reason: "already processed" };
    }

    const recipients = [...message.to, ...(message.cc ?? [])];

    // The first route that matches any recipient takes it, as in Rails: a
    // message has one destination, and trying later routes when the first
    // declines would deliver it somewhere nobody wrote down.
    let claimed: { mailbox: MailboxClass; recipient: string } | undefined;

    for (const recipient of recipients) {
      const mailboxClass = this.mailboxFor(recipient);
      if (mailboxClass) {
        claimed = { mailbox: mailboxClass, recipient };
        break;
      }
    }

    if (!claimed) return await this.#bounce(message, "no mailbox for this address");

    const mailbox = new claimed.mailbox({ ...message, to: [claimed.recipient, ...message.to] });

    // Rails' `bounce_with`: a mailbox that declines is refusing the message,
    // not passing it along.
    if (!(await mailbox.accepts())) {
      return await this.#bounce(message, `${claimed.mailbox.name} declined the message`);
    }

    try {
      await mailbox.process();
      const result: InboundResult = { status: "delivered", mailbox: claimed.mailbox.name };
      await this.#log.record(message.messageId, result);
      return result;
    } catch (error) {
      // Failed rather than bounced: a mailbox that threw may work on the next
      // attempt, and telling the sender their message was rejected when the
      // fault was ours is the wrong answer. Not recorded either, so the
      // provider's retry is a real second attempt.
      return { status: "failed", mailbox: claimed.mailbox.name, reason: String(error) };
    }
  }

  async #bounce(message: InboundMessage, reason: string): Promise<InboundResult> {
    const bounced: InboundResult = { status: "bounced", reason };
    await this.#log.record(message.messageId, bounced);
    return bounced;
  }
}

/** What a middleware is handed to continue the chain. */
type Next = (request: Request) => Promise<Response>;

export interface IngressOptions {
  path?: string;
  /**
   * The shared secret the provider sends back. Required.
   *
   * Not optional, and it used to be: without one the endpoint accepts mail
   * from anyone who finds the URL, and an inbound address is printed on
   * websites and in email headers. An application that can be told anything by
   * anybody is one where a support ticket, a password reset reply or an
   * invoice can be forged by a stranger.
   *
   * Rails refuses to mount an ingress without a password for the same reason.
   */
  secret: string;
  /** Reads the provider's own body shape into a message. */
  parse?: (body: unknown) => InboundMessage;
}

/** Reads the shape most providers post: a flat JSON object. */
export function parseInbound(body: unknown): InboundMessage {
  const payload = body as Record<string, unknown>;
  const list = (value: unknown): string[] =>
    Array.isArray(value) ? value.map(String) : value ? [String(value)] : [];

  return {
    messageId: String(payload.messageId ?? payload["message-id"] ?? crypto.randomUUID()),
    from: String(payload.from ?? ""),
    to: list(payload.to),
    cc: list(payload.cc),
    subject: String(payload.subject ?? ""),
    text: payload.text === undefined ? undefined : String(payload.text),
    html: payload.html === undefined ? undefined : String(payload.html),
  };
}

/**
 * The endpoint a provider posts inbound mail to.
 *
 * Rails calls these ingresses and ships one per provider. This takes the shape
 * they have in common and a hook for the ones that differ.
 */
export function inboundIngress(router: MailboxRouter, options: IngressOptions) {
  const path = options.path ?? "/altair/inbound";
  const parse = options.parse ?? parseInbound;

  // Refused at construction rather than at the first request: an endpoint that
  // is open is open from the moment it is mounted, and a boot that fails is
  // seen immediately by whoever mounted it.
  if (!options.secret) {
    throw new Error(
      "An inbound ingress needs a secret. Without one it accepts mail from anyone who finds the URL, and an inbound address is public by design. Pass the value your provider is configured to send back.",
    );
  }

  return async (request: Request, next: Next): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname !== path) return await next(request);
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const given = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";

    // Constant time: comparing secrets with === leaks their length and prefix
    // to anyone willing to measure.
    if (!timingSafeEqual(given, options.secret)) {
      return new Response("Unauthorized", { status: 401 });
    }

    let message: InboundMessage;
    try {
      message = parse(await request.json());
    } catch {
      return new Response("Could not read the message", { status: 400 });
    }

    const result = await router.receive(message);

    // A provider decides whether to retry from the status, so these are the
    // answer rather than decoration: 2xx means done, 5xx means try again.
    const status = result.status === "failed" ? 500 : 200;
    return Response.json(result, { status });
  };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }

  return difference === 0;
}
