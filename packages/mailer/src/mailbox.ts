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

/**
 * What has become of an inbound message. Rails' `ActionMailbox::InboundEmail`
 * statuses.
 *
 * `processing` and `success` are separate from `delivered` because they answer
 * different questions: `processing` says a worker picked it up and did not
 * finish — which is how a message stuck in a crashed worker is found — and
 * `success` says the mailbox ran without deciding anything, where `delivered`
 * says a mailbox took it. A single flag collapses "nobody has looked at this"
 * and "something looked at it and crashed" into one state, and those need
 * different actions.
 */
export type InboundStatus =
  | "pending"
  | "processing"
  | "delivered"
  | "success"
  | "bounced"
  | "failed";

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

/** Something to run around handling a message. */
export type ProcessingHook = (mailbox: Mailbox) => void | Promise<void>;
export type AroundProcessingHook = (mailbox: Mailbox, body: () => Promise<void>) => Promise<void>;

interface Hooks {
  before: ProcessingHook[];
  after: ProcessingHook[];
  around: AroundProcessingHook[];
}

/**
 * Keyed by the class rather than stored on it, so a subclass declaring a hook
 * does not push it onto the base class's array and run it for every sibling.
 */
const HOOKS = new WeakMap<object, Hooks>();

function ownHooks(klass: object): Hooks {
  let own = HOOKS.get(klass);

  if (!own) {
    own = { before: [], after: [], around: [] };
    HOOKS.set(klass, own);
  }

  return own;
}

function hookChain<K extends keyof Hooks>(klass: object, kind: K): Hooks[K] {
  const chain: Hooks[K] = [] as Hooks[K];

  // Walked upwards and unshifted, so a base class's hook runs outside a
  // subclass's — an application-wide `beforeProcessing` that sets the current
  // account has to be in place before the mailbox that reads it.
  for (let at: object | null = klass; at; at = Object.getPrototypeOf(at)) {
    const own = HOOKS.get(at);
    if (own) chain.unshift(...(own[kind] as never[]));
  }

  return chain;
}

/** Thrown by `bounceNowWith` to stop processing where it stands. */
class Bounced extends Error {
  constructor(readonly fields: MessageFields) {
    super("The mailbox bounced this message.");
    this.name = "Bounced";
  }
}

export abstract class Mailbox {
  constructor(readonly message: InboundMessage) {}

  /** Handles the message. Throwing marks it failed, so the provider retries. */
  abstract process(): Promise<void>;

  /** Runs before `process`. Rails' `before_processing`. */
  static beforeProcessing(hook: ProcessingHook): void {
    ownHooks(this).before.push(hook);
  }

  /** Runs after `process` returns. Skipped when the message bounced or threw. */
  static afterProcessing(hook: ProcessingHook): void {
    ownHooks(this).after.push(hook);
  }

  /**
   * Wraps `process`. Rails' `around_processing`.
   *
   * For the things that have to happen on both sides of a failure — a
   * transaction, a timer, a tag on the log lines.
   */
  static aroundProcessing(hook: AroundProcessingHook): void {
    ownHooks(this).around.push(hook);
  }

  #outcome: InboundStatus = "pending";
  #bounce: MessageFields | undefined;

  /**
   * Refuses the message and stops. Rails' `bounce_now_with`.
   *
   * The reply is built and handed back rather than sent, for the same reason
   * the router does not send one: whether a bounce actually goes out is the
   * application's decision, and a mailbox that sent mail as a side effect of
   * being called would be untestable.
   */
  bounceNowWith(fields: MessageFields): never {
    this.#bounce = fields;
    this.#outcome = "bounced";

    throw new Bounced(fields);
  }

  /** Whether this message is no longer pending. Rails' `finished_processing?`. */
  finishedProcessing(): boolean {
    return this.#outcome !== "pending";
  }

  /**
   * Handles the message with the hooks around it. Rails' `perform_processing`.
   *
   * This is what the router calls; `process` is what a mailbox writes. Calling
   * `process` directly skips every hook, which is the sort of thing that works
   * in a unit test and drops the account scope in production.
   */
  async performProcessing(): Promise<InboundResult> {
    const klass = this.constructor as typeof Mailbox;

    const body = async () => {
      for (const hook of hookChain(klass, "before")) await hook(this);

      await this.process();
      this.#outcome = "delivered";

      for (const hook of hookChain(klass, "after")) await hook(this);
    };

    // Folded from the inside out, so the first declared hook is the outermost.
    const wrapped = hookChain(klass, "around").reduceRight<() => Promise<void>>(
      (inner, hook) => () => hook(this, inner),
      body,
    );

    try {
      await wrapped();
    } catch (error) {
      if (error instanceof Bounced) {
        return {
          status: "bounced",
          mailbox: klass.name,
          reason: "the mailbox bounced it",
          bounce: this.#bounce,
        };
      }

      throw error;
    }

    return { status: "delivered", mailbox: klass.name };
  }

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

/**
 * Addresses a forwarding relay put the message through. Rails'
 * `x_forwarded_to_addresses`.
 *
 * The header a mail server adds when it forwards, and the reason a mailbox
 * cannot route on `to` alone: a message forwarded from `support@` to a
 * catch-all arrives addressed to the catch-all, and the address that decides
 * which mailbox handles it is in here instead.
 */
export function xForwardedToAddresses(message: InboundMessage): string[] {
  return splitAddresses(message.headers?.["x-forwarded-to"]);
}

/** The address a message was originally sent to. Rails' `x_original_to_addresses`. */
export function xOriginalToAddresses(message: InboundMessage): string[] {
  return splitAddresses(message.headers?.["x-original-to"]);
}

/**
 * Every address that could have brought this message here, in the order a
 * mailbox should try them. Rails' `recipients_addresses`.
 *
 * The forwarded and original addresses come first, because they are the
 * specific ones: `to` on a forwarded message is the catch-all that received
 * it, and routing on that would send everything to one mailbox.
 */
export function recipientsAddresses(message: InboundMessage): string[] {
  const all = [
    ...xForwardedToAddresses(message),
    ...xOriginalToAddresses(message),
    ...message.to,
    ...(message.cc ?? []),
  ];

  return [...new Set(all.map((one) => addressOf(one).toLowerCase()))];
}

function splitAddresses(header: string | undefined): string[] {
  if (!header) return [];

  return header
    .split(",")
    .map((one) => addressOf(one.trim()))
    .filter((one) => one.length > 0);
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

  /**
   * Several routes at once, in order. Rails' `add_routes`.
   *
   * Order is the whole of the semantics here — first match wins — so declaring
   * a set together reads better than a chain of calls whose sequence matters
   * but does not look like it does.
   */
  addRoutes(routes: readonly [MailboxPattern, MailboxClass][]): this {
    for (const [pattern, mailbox] of routes) this.route(pattern, mailbox);
    return this;
  }

  /** Every pattern this router will match, in order. */
  routingPatterns(): MailboxPattern[] {
    return this.routes.map((one) => one.pattern);
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

    // Every address that could have brought the message here, not just the
    // envelope ones. A message forwarded from support@ to a catch-all arrives
    // addressed to the catch-all, so routing on `to` alone sent every
    // forwarded message to whichever mailbox owns the catch-all.
    const recipients = recipientsAddresses(message);

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
      // `performProcessing` rather than `process`: the hooks are the point.
      const result = await mailbox.performProcessing();
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

/**
 * A base class that carries its own routes. Rails' `ApplicationMailbox`.
 *
 *     class ApplicationMailbox extends MailboxRoutes {}
 *
 *     ApplicationMailbox.routing(/^reply\+/, RepliesMailbox)
 *     ApplicationMailbox.routing("support@example.com", SupportMailbox)
 *
 *     app.middleware.use("inbound", inboundIngress(ApplicationMailbox.router(), { secret }))
 *
 * Rails puts this DSL on a class because Ruby autoloads the file that declares
 * it. The reason to have it here is different and better: first match wins, so
 * the order routes are added in *is* the routing, and a shared
 * `MailboxRouter` that several modules push onto at import time is routed by
 * whatever order the bundler settled on. Declaring on a class keeps a route
 * beside the mailbox it names, and `router()` reads them in declaration order
 * every time.
 *
 * Routes are copied to a subclass on its first write, the same rule the
 * callback chains and the model associations follow, so a mailbox class
 * declared for a test does not add a route to the application's.
 */
export class MailboxRoutes {
  static routes: readonly Route[] = [];

  /** Adds one route. Rails' `routing`. First match wins, as in Rails. */
  static routing(pattern: MailboxPattern, mailbox: MailboxClass): typeof MailboxRoutes {
    if (!Object.hasOwn(this, "routes")) this.routes = [...this.routes];

    (this.routes as Route[]).push({ pattern, mailbox });

    return this;
  }

  /** Every pattern this class routes on, in the order it will try them. */
  static routingPatterns(): MailboxPattern[] {
    return this.routes.map((one) => one.pattern);
  }

  /** A router carrying these routes, in order. */
  static router(options: { log?: InboundLog } = {}): MailboxRouter {
    const router = new MailboxRouter(options);

    for (const { pattern, mailbox } of this.routes) router.route(pattern, mailbox);

    return router;
  }

  /** Forgets them. For a test, which would otherwise inherit the last one's. */
  static resetRouting(): void {
    this.routes = [];
  }
}

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
