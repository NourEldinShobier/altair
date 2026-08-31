/**
 * Running channel work off the socket loop, ported from
 * `ActionCable::Server::Worker`, `RemoteConnections` and the pub/sub adapter
 * registry in `ActionCable::Server::Broadcasting`.
 *
 * `server.ts` handles a message inline, on the same task that read it. That is
 * fine until a channel action does something slow — one query, one HTTP call —
 * and then the socket is not being read while it happens. Under a burst that
 * shows up as messages arriving out of order and heartbeats going unanswered,
 * which the client reports as a dropped connection rather than a slow action.
 *
 * So work is posted to a bounded pool. Three properties matter, and each of
 * them is here because the obvious version is wrong:
 *
 * **Bounded, and it refuses when full.** An unbounded queue does not remove the
 * limit, it moves it: work piles up until memory does, and by then the socket
 * has been unresponsive for a while. Refusing immediately is a fast failure the
 * caller can report.
 *
 * **Ordered per connection.** Two messages from one client have an order the
 * client meant, and running them concurrently reorders them — a `subscribe`
 * that lands after the `message` it was meant to receive looks like a dropped
 * message. Different connections are independent and run in parallel.
 *
 * **A failing action does not take the pool with it.** An exception in one
 * channel must not stop the pool draining, and must not reach the socket loop.
 */

/** What a worker is holding while it runs. Rails' `thread_mattr_accessor :connection`. */
export interface WorkContext {
  connectionId: string;
  tags: string[];
}

let current: WorkContext | undefined;

/** The connection whose work is running, for a logger or an error report. */
export function currentWork(): WorkContext | undefined {
  return current;
}

/** A logger that stamps every line with whose connection it came from. */
export interface TaggedLogger {
  tags: readonly string[];
  info(message: string): void;
  error(message: string): void;
}

/**
 * Rails' `new_tagged_logger` / `tag`.
 *
 * The tags are the point. A cable server multiplexes every client onto one
 * log, and a line saying "rejected subscription" with nothing else in it
 * cannot be traced to a user — so the connection identifier goes on every
 * line rather than being something the caller remembers to include.
 */
export function newTaggedLogger(
  write: (line: string) => void,
  tags: readonly string[] = [],
): TaggedLogger {
  const prefix = (extra: readonly string[]) =>
    [...tags, ...extra].map((tag) => `[${tag}]`).join(" ");

  return {
    tags: [...tags],
    info(message) {
      write(`${prefix(current?.tags ?? [])} ${message}`.trim());
    },
    error(message) {
      write(`${prefix([...(current?.tags ?? []), "ERROR"])} ${message}`.trim());
    },
  };
}

/** Rails' `add_tags`. */
export function addTags(logger: TaggedLogger, ...tags: string[]): TaggedLogger {
  return newTaggedLogger(
    (line) => {
      logger.info(line);
    },
    [...logger.tags, ...tags],
  );
}

// --- hooks around one unit of work ----------------------------------------

export type WorkHook = (context: WorkContext) => void | Promise<void>;
export type AroundWorkHook = (context: WorkContext, proceed: () => Promise<void>) => Promise<void>;

const before: WorkHook[] = [];
const after: WorkHook[] = [];
const around: AroundWorkHook[] = [];

/** Rails' worker `:work` callbacks. Named for the callback, not the connection's
 * `around_command`, which `connection_lifecycle.ts` already owns. */
export function beforeWork(hook: WorkHook): void {
  before.push(hook);
}

export function afterWork(hook: WorkHook): void {
  after.push(hook);
}

/**
 * The hook a database connection is checked out in: a channel action needs one
 * for its whole run and has to return it afterwards, and a `before`/`after`
 * pair cannot guarantee the return when the body throws.
 */
export function aroundWork(hook: AroundWorkHook): void {
  around.push(hook);
}

export function clearWorkHooks(): void {
  before.length = 0;
  after.length = 0;
  around.length = 0;
}

/**
 * Runs one unit of work with the hooks around it. Rails' `work`.
 *
 * `after` hooks run in a `finally`. They are where a connection is returned
 * and a tag is popped, and skipping them on the failure path leaks exactly the
 * resource that the failing action was using.
 */
export async function performWork(context: WorkContext, body: () => Promise<void>): Promise<void> {
  const held = current;
  current = context;

  try {
    for (const hook of before) await hook(context);

    let run = body;

    // Applied outermost-first, so the first hook registered is the outermost
    // — which is what lets a connection-management hook wrap everything a
    // later hook does.
    for (const hook of [...around].reverse()) {
      const inner = run;
      run = () => hook(context, inner);
    }

    await run();
  } finally {
    try {
      for (const hook of after) await hook(context);
    } finally {
      current = held;
    }
  }
}

/**
 * Checks a database connection out around a command. Rails'
 * `ActiveRecordConnectionManagement`.
 *
 * Registered as an `around` hook rather than a pair, so the connection goes
 * back even when the action throws. A cable server holds connections for as
 * long as a client is connected, and one leaked per failed action exhausts the
 * pool in an afternoon.
 */
export function withDatabaseConnections(
  checkout: () => Promise<unknown>,
  checkin: (connection: unknown) => Promise<void>,
): void {
  aroundWork(async (_context, proceed) => {
    const connection = await checkout();

    try {
      await proceed();
    } finally {
      await checkin(connection);
    }
  });
}

// --- the pool --------------------------------------------------------------

export class WorkerPoolFull extends Error {
  constructor(maxQueue: number) {
    super(
      `The cable worker pool has ${maxQueue} items queued and will not take more. An unbounded ` +
        `queue does not remove this limit, it moves it to memory — and by the time that is hit ` +
        `the socket has been unresponsive for a while.`,
    );
    this.name = "WorkerPoolFull";
  }
}

interface Queued {
  context: WorkContext;
  body: () => Promise<void>;
}

/**
 * A bounded pool that keeps one connection's work in order. Rails'
 * `Server::Worker`.
 */
export class WorkerPool {
  readonly #queues = new Map<string, Queued[]>();
  readonly #running = new Set<string>();
  #stopping = false;
  #onError: (error: unknown, context: WorkContext) => void = () => undefined;

  constructor(
    readonly maxSize = 5,
    readonly maxQueue = 100,
  ) {}

  onError(report: (error: unknown, context: WorkContext) => void): void {
    this.#onError = report;
  }

  /**
   * Work outstanding: waiting plus in flight. The limit has to count what is
   * running, or a pool whose every connection is busy reports an empty queue
   * and accepts unlimited more.
   */
  get outstanding(): number {
    return this.queued + this.active;
  }

  get queued(): number {
    let total = 0;

    for (const queue of this.#queues.values()) total += queue.length;

    return total;
  }

  get active(): number {
    return this.#running.size;
  }

  /** Rails' `stopping?`. */
  get stopping(): boolean {
    return this.#stopping;
  }

  /**
   * Rails' `halt` — anything not already started is discarded.
   *
   * Discarded rather than drained: a server that is shutting down has clients
   * that are going away with it, and finishing their queued work delays the
   * shutdown to deliver messages nobody will receive.
   */
  halt(): void {
    this.#stopping = true;
    this.#queues.clear();
  }

  /** Rails' `async_invoke`. */
  asyncInvoke(connectionId: string, body: () => Promise<void>, tags: string[] = []): void {
    if (this.#stopping) return;
    if (this.outstanding >= this.maxQueue) throw new WorkerPoolFull(this.maxQueue);

    const queue = this.#queues.get(connectionId) ?? [];
    queue.push({ context: { connectionId, tags }, body });
    this.#queues.set(connectionId, queue);

    void this.#drain(connectionId);
  }

  /** Rails' `async_exec` — the same, for a body that is already bound. */
  asyncExec(connectionId: string, body: () => Promise<void>): void {
    this.asyncInvoke(connectionId, body);
  }

  /** Waits for everything queued to finish. For tests and for shutdown. */
  async drained(): Promise<void> {
    while (this.queued > 0 || this.active > 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  async #drain(connectionId: string): Promise<void> {
    // One at a time per connection: two messages from one client have an order
    // the client meant, and running them concurrently reorders them.
    if (this.#running.has(connectionId)) return;
    if (this.#running.size >= this.maxSize) return;

    this.#running.add(connectionId);

    try {
      for (;;) {
        const queue = this.#queues.get(connectionId);
        const next = queue?.shift();

        if (!next) break;

        try {
          await performWork(next.context, next.body);
        } catch (error) {
          // Contained here: a failing action must not stop the pool draining
          // and must not reach the socket loop.
          this.#onError(error, next.context);
        }
      }
    } finally {
      this.#queues.delete(connectionId);
      this.#running.delete(connectionId);
    }

    // A connection that was refused a slot while the pool was full still has
    // work waiting, so hand the freed slot on rather than waiting for its next
    // message to notice.
    for (const waiting of this.#queues.keys()) {
      if (!this.#running.has(waiting)) {
        void this.#drain(waiting);
        break;
      }
    }
  }
}

let pool: WorkerPool | undefined;

/** Rails' `ActionCable.server.worker_pool`. */
export function workerPool(): WorkerPool {
  pool ??= new WorkerPool();

  return pool;
}

export function setWorkerPool(replacement: WorkerPool | undefined): void {
  pool = replacement;
}

/** Rails' `send_async`. */
export function sendAsync(connectionId: string, body: () => Promise<void>): void {
  workerPool().asyncInvoke(connectionId, body);
}

// --- pub/sub adapters ------------------------------------------------------

/** What a broadcaster has to do to carry messages between processes. */
export interface PubSubAdapter {
  broadcast(stream: string, message: string): Promise<void> | void;
  subscribe(stream: string, handler: (message: string) => void): Promise<void> | void;
  unsubscribe(stream: string, handler: (message: string) => void): Promise<void> | void;
}

const adapters = new Map<string, () => PubSubAdapter>();

export function registerPubSubAdapter(name: string, build: () => PubSubAdapter): void {
  adapters.set(name, build);
}

export function pubsubAdapterNames(): string[] {
  return [...adapters.keys()].sort();
}

export class UnknownPubSubAdapter extends Error {
  constructor(name: string, known: readonly string[]) {
    super(
      `No cable adapter called "${name}". Registered: ${known.join(", ") || "none"}. ` +
        `A misspelled adapter must not fall back to the in-process one: that works perfectly ` +
        `on one server and delivers nothing to the other three.`,
    );
    this.name = "UnknownPubSubAdapter";
  }
}

let adapter: PubSubAdapter | undefined;

/**
 * Rails' `pubsub` / `pubsub_adapter`.
 *
 * Refuses an unregistered name rather than falling back. The fallback is the
 * in-process adapter, which works perfectly in development and on a single
 * server, and silently delivers nothing across a cluster — a bug that appears
 * only once there is more than one process.
 */
export function pubsubAdapter(name: string): PubSubAdapter {
  const build = adapters.get(name);

  if (!build) throw new UnknownPubSubAdapter(name, pubsubAdapterNames());

  return build();
}

export function usePubSub(chosen: PubSubAdapter | undefined): void {
  adapter = chosen;
}

export function pubsub(): PubSubAdapter | undefined {
  return adapter;
}

/** Rails' `broadcaster_for` — a handle bound to one stream. */
export function broadcasterFor(stream: string): { broadcast(message: string): Promise<void> } {
  return {
    async broadcast(message: string): Promise<void> {
      await pubsub()?.broadcast(stream, message);
    },
  };
}

// --- remote connections ----------------------------------------------------

/**
 * Reaching a connection that lives in another process. Rails'
 * `RemoteConnections`.
 *
 * The identifiers are the addressing scheme: a signed-out user has to be
 * disconnected wherever their socket is, and the server handling the sign-out
 * is usually not the one holding it. So the disconnect is a broadcast on a
 * channel keyed by identifier rather than a direct call.
 */
export interface RemoteConnection {
  identifiers: Record<string, string>;
  disconnect(reconnect: boolean): Promise<void>;
}

export class RemoteConnections {
  readonly #subscribers = new Map<string, Set<(reconnect: boolean) => Promise<void>>>();

  /** Rails' `add_subscriber`. */
  addSubscriber(identifier: string, disconnect: (reconnect: boolean) => Promise<void>): void {
    const held = this.#subscribers.get(identifier) ?? new Set();
    held.add(disconnect);
    this.#subscribers.set(identifier, held);
  }

  /** Rails' `remove_subscriber`. */
  removeSubscriber(identifier: string, disconnect: (reconnect: boolean) => Promise<void>): void {
    const held = this.#subscribers.get(identifier);

    held?.delete(disconnect);

    // Dropped when empty, or a process that has served a million users holds a
    // million empty sets for the rest of its life.
    if (held && held.size === 0) this.#subscribers.delete(identifier);
  }

  /** Every identifier still being tracked, so a leak is visible from outside. */
  identifiers(): string[] {
    return [...this.#subscribers.keys()].sort();
  }

  subscriberCount(identifier: string): number {
    return this.#subscribers.get(identifier)?.size ?? 0;
  }

  /** Rails' `where(...).disconnect`. */
  async disconnect(identifier: string, reconnect = true): Promise<number> {
    const held = [...(this.#subscribers.get(identifier) ?? [])];

    for (const disconnect of held) await disconnect(reconnect);

    return held.length;
  }
}

const remote = new RemoteConnections();

export function remoteConnections(): RemoteConnections {
  return remote;
}
