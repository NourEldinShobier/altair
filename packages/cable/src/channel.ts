/**
 * Channels, ported from `ActionCable::Channel::Base`.
 *
 *     class ChatChannel extends Channel {
 *       async subscribed() {
 *         if (!this.connection.currentUser) return this.reject()
 *         this.streamFrom(`chat:${this.params.room}`)
 *       }
 *
 *       async speak({ message }: { message: string }) {
 *         Channel.broadcastTo(`chat:${this.params.room}`, { message })
 *       }
 *     }
 *
 * `streamFrom` puts the socket on a stream, and a broadcast reaches everyone on
 * it. Delivery goes through a registry rather than Bun's pub/sub, because the
 * protocol frames each message under the receiving subscription's own
 * identifier and pub/sub sends identical bytes to everyone. Reaching another
 * process means republishing through Redis, which is why `Broadcaster` is an
 * interface rather than a concrete thing.
 */

import { messageFrame } from "./protocol.js";

/** The socket a channel talks through — the slice of Bun's ServerWebSocket used. */
export interface CableSocket {
  send(data: string): unknown;
  subscribe(topic: string): unknown;
  unsubscribe(topic: string): unknown;
  isSubscribed?(topic: string): boolean;
  close(code?: number, reason?: string): unknown;
}

/** Fans a message out to every socket on a topic, in this process or beyond. */
export interface Broadcaster {
  publish(topic: string, payload: string): unknown;
}

export interface ConnectionContext {
  /** Whoever the connection identified. Rails' `identified_by`. */
  currentUser?: unknown;
  request: Request;
  [key: string]: unknown;
}

export interface ChannelContext {
  socket: CableSocket;
  connection: ConnectionContext;
  identifier: string;
  params: Record<string, unknown>;
  broadcaster: Broadcaster;
}

/**
 * The topic a stream maps to.
 *
 * Namespaced so an application's stream name cannot collide with an internal
 * topic, and so a broadcaster shared with the job queue stays separable.
 */
/**
 * Names a record for a stream.
 *
 * A record is `Model/id`; anything else is its own string. The model name
 * comes from the constructor, so two records with id 1 from different tables
 * do not share a stream — which is the failure that would look like one user
 * receiving another's messages.
 *
 * A record with no id is refused rather than named `Room/undefined`, which
 * every unsaved record would share.
 */
export function identify(model: unknown): string {
  if (model === null || model === undefined) {
    throw new TypeError("Cannot build a stream name from null or undefined.");
  }

  if (typeof model !== "object") return String(model);

  const id = (model as { id?: unknown }).id;

  if (id === null || id === undefined || id === "") {
    throw new TypeError(
      `Cannot build a stream name from an unsaved ${model.constructor.name}: it has no id, and every unsaved record would share the stream.`,
    );
  }

  // `modelName` when the record has one: it is what the rest of the framework
  // calls a model, and unlike a constructor name it survives minification.
  const named = (model.constructor as { modelName?: { name?: unknown } }).modelName;
  const name = typeof named?.name === "string" ? named.name : model.constructor.name;

  return `${name}/${String(id)}`;
}

export function topicFor(stream: string): string {
  return `cable:${stream}`;
}

const registry = new Map<string, typeof Channel>();

export class Channel {
  readonly socket: CableSocket;
  readonly connection: ConnectionContext;
  readonly identifier: string;
  readonly params: Record<string, unknown>;

  #broadcaster: Broadcaster;
  #streams: string[] = [];
  #rejected = false;

  constructor(context: ChannelContext) {
    this.socket = context.socket;
    this.connection = context.connection;
    this.identifier = context.identifier;
    this.params = context.params;
    this.#broadcaster = context.broadcaster;
  }

  /** Registers channels by the name a client subscribes with. */
  static register(...channels: (typeof Channel)[]): void {
    for (const channel of channels) registry.set(channel.channelName, channel);
  }

  static get channelName(): string {
    return this.name;
  }

  static lookup(name: string): typeof Channel | undefined {
    return registry.get(name);
  }

  static resetRegistry(): void {
    registry.clear();
  }

  /**
   * Sends a message to everyone streaming from a name.
   *
   * The static form is what a controller or job calls, so broadcasting does not
   * need a socket.
   */
  static broadcastTo(broadcaster: Broadcaster, stream: string, message: unknown): void {
    broadcaster.publish(topicFor(stream), JSON.stringify({ stream, message }));
  }

  /** Called when a client subscribes. Call `reject()` to refuse. */
  async subscribed(): Promise<void> {}

  /** Called when a client unsubscribes or disconnects. */
  async unsubscribed(): Promise<void> {}

  /** Called for a message with no matching action method. */
  async receive(data: Record<string, unknown>): Promise<void> {
    void data;
  }

  /**
   * The stream name a record broadcasts on. Rails' `broadcasting_for`.
   *
   * Rails encodes a GlobalID here, which is opaque by design because it also
   * travels in URLs. A cable stream name never leaves the server, so this
   * stays readable — `ChatChannel:Room/1` is something you can find in a log.
   *
   * The channel name is part of it so two channels streaming the same record
   * do not deliver each other's messages.
   */
  static broadcastingFor(model: unknown): string {
    return `${this.channelName}:${identify(model)}`;
  }

  /**
   * Subscribes this socket to a record's stream. Rails' `stream_for`.
   *
   *     override async subscribed() {
   *       this.streamFor(await Room.find(this.params.id))
   *     }
   */
  streamFor(model: unknown): void {
    this.streamFrom((this.constructor as typeof Channel).broadcastingFor(model));
  }

  /** Subscribes this socket to a stream. Rails' `stream_from`. */
  streamFrom(stream: string): void {
    const topic = topicFor(stream);
    this.#streams.push(stream);
    this.socket.subscribe(topic);
  }

  /**
   * Stops streaming from one name. Rails' `stop_stream_from`.
   *
   * For a channel that follows something moving — the room a person is looking
   * at, the order being watched. Without it the only way off a stream is off
   * all of them, so switching rooms means unsubscribing from the presence
   * stream too and quietly going offline.
   */
  stopStreamFrom(stream: string): void {
    const at = this.#streams.indexOf(stream);
    if (at === -1) return;

    this.#streams.splice(at, 1);
    this.socket.unsubscribe(topicFor(stream));
  }

  /** Stops streaming from a record's stream. Rails' `stop_stream_for`. */
  stopStreamFor(model: unknown): void {
    this.stopStreamFrom((this.constructor as typeof Channel).broadcastingFor(model));
  }

  /** Stops streaming from everything this channel subscribed to. */
  stopAllStreams(): void {
    for (const stream of this.#streams) this.socket.unsubscribe(topicFor(stream));
    this.#streams = [];
  }

  #timers: ReturnType<typeof setInterval>[] = [];

  /**
   * Runs something on this channel every so often. Rails' `periodically`.
   *
   *     override async subscribed() {
   *       this.streamFrom("dashboard")
   *       this.periodically(() => this.transmit({ online: count() }), 5)
   *     }
   *
   * For state that changes without anything to broadcast from — a count of who
   * is online, a queue depth, a clock. The alternative is the client polling
   * over HTTP, which is a request, a session lookup and a connection for every
   * tick on every open tab.
   *
   * The interval is seconds, as Rails writes it. Timers are cleared when the
   * subscription ends: a timer that outlives its socket transmits into a
   * closed connection forever, and there is one per subscriber.
   */
  periodically(body: () => void | Promise<void>, everySeconds: number): void {
    if (!(everySeconds > 0)) {
      throw new Error(
        `A periodic timer needs an interval greater than zero, not ${everySeconds}. A zero interval is a busy loop on the server for every subscriber.`,
      );
    }

    const timer = setInterval(() => {
      // Swallowed rather than left to reject: an unhandled rejection in a
      // timer takes the process down, and one subscriber's failing tick is not
      // a reason to drop every other connection on the server.
      void (async () => {
        try {
          await body();
        } catch (error) {
          this.onPeriodicError(error);
        }
      })();
    }, everySeconds * 1000);

    // Or a channel with a timer keeps the process alive after everything else
    // has finished — which is a test suite that hangs and a worker that will
    // not shut down.
    timer.unref?.();

    this.#timers.push(timer);
  }

  /**
   * What to do when a periodic tick throws. Overridable; logs by default.
   *
   * Somewhere rather than nowhere: a timer that fails silently every five
   * seconds is a dashboard that stopped updating for a reason nobody can find.
   */
  protected onPeriodicError(error: unknown): void {
    console.error("A periodic timer on %s failed:", this.identifier, error);
  }

  /**
   * Clears this channel's periodic timers.
   *
   * Called for you when the subscription ends. Public because a channel that
   * stops needing its timer before then should be able to say so.
   */
  clearTimers(): void {
    for (const timer of this.#timers) clearInterval(timer);
    this.#timers = [];
  }

  get streams(): readonly string[] {
    return [...this.#streams];
  }

  /** Refuses the subscription. Rails' `reject`. */
  reject(): void {
    this.#rejected = true;
  }

  get isRejected(): boolean {
    return this.#rejected;
  }

  /** Sends a message to this subscriber only. Rails' `transmit`. */
  transmit(message: unknown): void {
    this.socket.send(messageFrame(this.identifier, message));
  }

  /** Broadcasts to a stream from inside a channel. */
  broadcast(stream: string, message: unknown): void {
    Channel.broadcastTo(this.#broadcaster, stream, message);
  }

  /** Broadcasts to a record's stream from inside a channel. */
  broadcastToRecord(model: unknown, message: unknown): void {
    this.broadcast((this.constructor as typeof Channel).broadcastingFor(model), message);
  }

  /**
   * Routes an incoming message to an action method.
   *
   * Rails dispatches on `action` and refuses anything not declared as a public
   * method. The allowlist matters: without it a client could call `reject`,
   * `stopAllStreams`, or anything else on the class.
   */
  async dispatch(data: Record<string, unknown>): Promise<void> {
    const action = data.action;

    if (typeof action !== "string") {
      await this.receive(data);
      return;
    }

    const declared = (this.constructor as typeof Channel).actions;
    if (!declared.includes(action)) {
      throw new Error(
        `${(this.constructor as typeof Channel).channelName} does not expose an action named "${action}". Add it to the class's static actions list.`,
      );
    }

    const method = (this as unknown as Record<string, unknown>)[action];
    if (typeof method !== "function") {
      throw new Error(
        `${(this.constructor as typeof Channel).channelName}#${action} is not a method.`,
      );
    }

    const { action: _ignored, ...rest } = data;
    await (method as (payload: Record<string, unknown>) => unknown).call(this, rest);
  }

  /**
   * The actions a client may invoke.
   *
   * Declared rather than derived. Rails uses "public instance methods minus
   * the base class's", which is implicit and easy to widen by accident; naming
   * them makes the surface obvious in review.
   */
  static actions: string[] = [];
}
