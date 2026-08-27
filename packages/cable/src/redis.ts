/**
 * Broadcasting across processes, ported from
 * `ActionCable::SubscriptionAdapter::Redis`.
 *
 * Without this a broadcast reaches the sockets held by the process that made
 * it and no others — so an application behind two workers delivers to half its
 * users, and behind an autoscaler delivers to an arbitrary fraction. Nothing
 * fails; the message simply does not arrive, for some people, sometimes.
 *
 *     const cable = new Cable({ channels })
 *     await useRedis(cable, { url: process.env.REDIS_URL })
 *
 * Bun ships a Redis client, so this needs no dependency: one connection
 * publishes and a second subscribes, which Redis requires — a connection in
 * subscribe mode will not accept anything else.
 */

import type { Broadcaster } from "./channel.js";

/** The part of `Cable` this needs, so it can be tested without a server. */
export interface BroadcastHost {
  broadcaster: Broadcaster;
  /** Hands local delivery back whatever arrives from elsewhere. */
  streams: Broadcaster & { onInterest?: (stream: string, interested: boolean) => void };
}

export interface RedisOptions {
  url?: string;
  /**
   * What every channel name is prefixed with.
   *
   * Two applications sharing a Redis is the ordinary case — a review app beside
   * production, two services on one plan — and without a prefix they deliver
   * each other's messages.
   */
  prefix?: string;
  /** Told when the connection drops, since the alternative is silence. */
  onError?: (error: unknown) => void;
}

/** What a Bun Redis client offers, narrowed to what is used here. */
interface RedisLike {
  connect?(): Promise<unknown>;
  close?(): void;
  publish(channel: string, message: string): Promise<unknown> | unknown;
  subscribe(
    channel: string,
    listener: (message: string, channel: string) => void,
  ): Promise<unknown> | unknown;
  unsubscribe(channel: string): Promise<unknown> | unknown;
}

/**
 * A broadcaster that puts every message on Redis instead of delivering it.
 *
 * Delivery happens on the way back: every process, including the one that
 * published, receives its own message from Redis and hands it to the local
 * sockets. Publishing locally as well would deliver it twice to whoever was
 * connected here.
 */
export class RedisBroadcaster implements Broadcaster {
  readonly #publisher: RedisLike;
  readonly #prefix: string;
  readonly #subscribed = new Set<string>();

  constructor(
    publisher: RedisLike,
    private readonly subscriber: RedisLike,
    private readonly local: Broadcaster,
    options: RedisOptions = {},
  ) {
    this.#publisher = publisher;
    this.#prefix = options.prefix ?? "altair";
  }

  #channelFor(topic: string): string {
    return `${this.#prefix}:${topic}`;
  }

  /**
   * Starts listening for a stream, because something here is on it.
   *
   * Subscribing on first publish was wrong and the cross-process case caught
   * it: a worker that only receives never publishes, so it never subscribed
   * and never heard anything. Interest is the trigger, not traffic.
   */
  listenTo(topic: string): void {
    if (this.#subscribed.has(topic)) return;

    this.#subscribed.add(topic);

    void Promise.resolve(
      this.subscriber.subscribe(this.#channelFor(topic), (message) => {
        this.local.publish(topic, message);
      }),
    );
  }

  /** Stops, when the last socket here has gone. */
  stopListeningTo(topic: string): void {
    if (!this.#subscribed.delete(topic)) return;

    void Promise.resolve(this.subscriber.unsubscribe(this.#channelFor(topic)));
  }

  publish(topic: string, payload: string): unknown {
    // Also on publish, for a process that broadcasts to a stream it holds no
    // sockets on — a job server talking to the web processes.
    this.listenTo(topic);

    return this.#publisher.publish(this.#channelFor(topic), payload);
  }

  /** Stops listening, for a worker shutting down. */
  async close(): Promise<void> {
    for (const topic of this.#subscribed) {
      await this.subscriber.unsubscribe(this.#channelFor(topic));
    }

    this.#subscribed.clear();
    this.subscriber.close?.();
    this.#publisher.close?.();
  }
}

/**
 * Points a cable at Redis.
 *
 * Two clients rather than one, because Redis will not take a command on a
 * connection that is subscribed — the second is not a pool, it is a
 * requirement of the protocol.
 */
export async function useRedis(
  cable: BroadcastHost & { useBroadcaster?(broadcaster: Broadcaster): void },
  options: RedisOptions = {},
): Promise<RedisBroadcaster> {
  const url = options.url ?? process.env.REDIS_URL;

  if (!url) {
    throw new Error(
      "Action Cable needs a Redis URL to broadcast across processes. Pass one, or set REDIS_URL.",
    );
  }

  const make = () =>
    new (Bun as unknown as { RedisClient: new (url: string) => RedisLike }).RedisClient(url);

  const publisher = make();
  const subscriber = make();

  const broadcaster = new RedisBroadcaster(publisher, subscriber, cable.streams, options);

  // The registry says when a stream gains its first local socket, which is
  // when this process needs to start hearing about it.
  cable.streams.onInterest = (stream, interested) => {
    if (interested) broadcaster.listenTo(stream);
    else broadcaster.stopListeningTo(stream);
  };

  cable.useBroadcaster?.(broadcaster);

  return broadcaster;
}
