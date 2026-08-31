/**
 * Broadcasting over PostgreSQL's `LISTEN`/`NOTIFY`, ported from
 * `ActionCable::SubscriptionAdapter::PostgreSQL`.
 *
 * `redis.ts` is the adapter most applications use. This one exists because
 * many applications already run Postgres and would rather not add a second
 * piece of infrastructure for the one feature — and the constraints it works
 * under are what make it interesting:
 *
 * - **Two connections, not one.** A connection issuing `LISTEN` is committed
 *   to waiting for notifications and cannot be used for anything else, so
 *   subscribing takes a connection of its own. Broadcasting borrows one from
 *   the pool for the length of one `NOTIFY` — sharing the listening connection
 *   for that would mean a broadcast blocking behind whatever the listener is
 *   waiting on, which is by definition indefinite.
 * - **The listening connection is deliberately outside the pool.** Checked out
 *   permanently, it is a connection the pool has lost; taken from the pool, it
 *   is a connection the pool believes it can hand to a request. Neither is
 *   what is wanted, so it is opened directly.
 * - **Channel names are identifiers, and identifiers have a length limit.**
 *   Postgres truncates one past 63 bytes, so two long channel names that agree
 *   in their first 63 bytes silently become one channel — every subscriber to
 *   either receives both. Hashed rather than truncated for exactly that.
 * - **Everything is escaped, twice over.** A channel name reaches `LISTEN` as
 *   an identifier and a payload reaches `NOTIFY` as a string literal. Both
 *   come from application code that may have built them out of user data.
 */

/** Postgres' identifier limit. Anything past this is truncated, not refused. */
export const MAX_IDENTIFIER_BYTES = 63;

/**
 * Rails' `channel_identifier` — the Postgres channel a cable stream maps to.
 *
 * Hashed when it would not fit. Truncation is worse than a hash here: two
 * names agreeing in their first 63 bytes become one channel, and every
 * subscriber to either receives both — a cross-tenant leak from nothing but a
 * long prefix.
 */
export function pgChannelIdentifier(stream: string): string {
  if (new TextEncoder().encode(stream).length <= MAX_IDENTIFIER_BYTES) return stream;

  return `ac_${digestOf(stream)}`;
}

function digestOf(value: string): string {
  // FNV-1a. Not a security primitive — the only requirement is that two
  // different streams do not land on one channel.
  let hash = 0x811c9dc5;

  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193) >>> 0;
  }

  return hash.toString(16).padStart(8, "0");
}

/**
 * Rails' `escape_identifier` — quoting a channel name for `LISTEN`.
 *
 * An embedded quote is doubled. Without that a name containing one ends the
 * identifier and turns the rest into SQL, on a statement built from a stream
 * name an application may well have derived from a record's attributes.
 */
export function escapeIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Rails' `escape_string` — quoting a payload for `NOTIFY`. */
export function escapeString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Postgres' payload limit before the `NOTIFY` is rejected. */
export const MAX_PAYLOAD_BYTES = 8000;

export class PayloadTooLarge extends Error {
  constructor(bytes: number) {
    super(
      `This broadcast is ${bytes} bytes; Postgres refuses a NOTIFY payload past ` +
        `${MAX_PAYLOAD_BYTES}. Broadcast an id and let the subscriber fetch the record — a ` +
        `payload near the limit is one field away from a broadcast that stops arriving in ` +
        `production and nowhere else.`,
    );
    this.name = "PayloadTooLarge";
  }
}

/** The statement that broadcasts one message. */
export function notifyStatement(channel: string, payload: string): string {
  const bytes = new TextEncoder().encode(payload).length;

  if (bytes > MAX_PAYLOAD_BYTES) throw new PayloadTooLarge(bytes);

  return `NOTIFY ${escapeIdentifier(pgChannelIdentifier(channel))}, ${escapeString(payload)}`;
}

/** The statements that start and stop listening. */
export function listenStatement(channel: string): string {
  return `LISTEN ${escapeIdentifier(pgChannelIdentifier(channel))}`;
}

export function unlistenStatement(channel: string): string {
  return `UNLISTEN ${escapeIdentifier(pgChannelIdentifier(channel))}`;
}

// --- the two connections ---------------------------------------------------

export interface PgConnection {
  execute(sql: string): Promise<unknown>;
  close?(): Promise<void> | void;
}

export interface ConnectionSource {
  /** A connection outside the pool, for listening. Rails' `new_connection`. */
  newConnection(): Promise<PgConnection>;
  /** One borrowed from the pool for the length of a statement. */
  withConnection<T>(body: (connection: PgConnection) => Promise<T>): Promise<T>;
}

/**
 * Rails' `with_subscriptions_connection`.
 *
 * A connection of its own, opened directly rather than checked out. A
 * connection issuing `LISTEN` is committed to waiting and cannot serve
 * anything else: held from the pool it is one the pool has lost, and taken
 * from the pool it is one the pool believes it can still hand to a request.
 *
 * Closed in a `finally`, because the alternative is a Postgres backend per
 * restart that nothing will ever close.
 */
export async function withSubscriptionsConnection<T>(
  source: ConnectionSource,
  identifier: string,
  body: (connection: PgConnection) => Promise<T>,
): Promise<T> {
  const connection = await source.newConnection();

  // Named so `pg_stat_activity` shows which of these long-lived connections is
  // Action Cable's — otherwise it looks exactly like an application connection
  // that has been idle in transaction for days.
  await connection.execute(`SET application_name = ${escapeIdentifier(identifier)}`);

  try {
    return await body(connection);
  } finally {
    await connection.close?.();
  }
}

/**
 * Rails' `with_broadcast_connection` — a pooled connection for one statement.
 *
 * Borrowed rather than kept, because a broadcast is a single `NOTIFY` and
 * holding a connection between them would take one out of the pool for the
 * life of the process to do nothing most of the time.
 */
export function withBroadcastConnection<T>(
  source: ConnectionSource,
  body: (connection: PgConnection) => Promise<T>,
): Promise<T> {
  return source.withConnection(body);
}

// --- the listener ------------------------------------------------------------

type Subscriber = (message: string) => void;

export interface PendingCommand {
  action: "listen" | "unlisten";
  channel: string;
  onSuccess?: () => void;
}

/**
 * The listener's queue. Rails' `Listener`.
 *
 * Commands are queued rather than executed where they are asked for, because
 * the listening connection is blocked waiting for notifications: a `LISTEN`
 * issued from another task would have to wait for the wait to end, which it
 * does not. The listener drains the queue between notifications instead.
 */
export class Listener {
  readonly #queue: PendingCommand[] = [];
  readonly #subscribers = new Map<string, Set<Subscriber>>();

  /** Rails' `add_channel`. */
  addChannel(channel: string, onSuccess?: () => void): void {
    this.#queue.push({ action: "listen", channel, ...(onSuccess ? { onSuccess } : {}) });
  }

  /** Rails' `remove_channel`. */
  removeChannel(channel: string): void {
    this.#queue.push({ action: "unlisten", channel });
  }

  addSubscriber(channel: string, callback: Subscriber, onSuccess?: () => void): void {
    const existing = this.#subscribers.get(channel);

    if (existing === undefined) {
      this.#subscribers.set(channel, new Set([callback]));
      // Only the first subscriber issues LISTEN. Postgres ignores a duplicate,
      // but the queue would still carry one command per subscriber and the
      // matching UNLISTEN count would then be wrong.
      this.addChannel(channel, onSuccess);

      return;
    }

    existing.add(callback);
    onSuccess?.();
  }

  removeSubscriber(channel: string, callback: Subscriber): void {
    const existing = this.#subscribers.get(channel);

    if (existing === undefined) return;

    existing.delete(callback);

    // The last one out stops the LISTEN. Leaving it would keep delivering
    // notifications nothing reads, which is cheap per message and unbounded
    // over the life of a process.
    if (existing.size === 0) {
      this.#subscribers.delete(channel);
      this.removeChannel(channel);
    }
  }

  /** What the listening connection should run next. */
  drain(): PendingCommand[] {
    return this.#queue.splice(0, this.#queue.length);
  }

  /** Deliver one notification. */
  dispatch(channel: string, message: string): number {
    const subscribers = this.#subscribers.get(channel);

    if (subscribers === undefined) return 0;

    // Copied before iterating, deliberately: one subscriber's handler
    // unsubscribing another would otherwise cancel delivery to it mid-message,
    // and neither side can detect a message that was half-delivered.
    // eslint-disable-next-line unicorn/no-useless-spread -- the copy is the point
    for (const subscriber of [...subscribers]) subscriber(message);

    return subscribers.size;
  }

  get channels(): string[] {
    return [...this.#subscribers.keys()];
  }
}

/**
 * Runs a drained command against the listening connection.
 *
 * The success callback fires after the statement, not when it was queued: a
 * subscriber told it is listening before Postgres agrees will miss anything
 * broadcast in between, and missing the first message of a stream is the one
 * failure a subscriber cannot detect.
 */
export async function runCommand(connection: PgConnection, command: PendingCommand): Promise<void> {
  await connection.execute(
    command.action === "listen"
      ? listenStatement(command.channel)
      : unlistenStatement(command.channel),
  );

  command.onSuccess?.();
}
