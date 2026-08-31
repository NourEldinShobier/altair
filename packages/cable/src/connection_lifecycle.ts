/**
 * A socket's life from open to close, and the commands that arrive over it.
 * Ported from `ActionCable::Connection::Base` and `Connection::Subscriptions`.
 *
 * `server.ts` accepts sockets and routes frames. What it does not model is the
 * part that goes wrong in production rather than in a test: a socket that is
 * open as far as the process is concerned and dead as far as the network is.
 *
 * TCP does not tell you the other end went away. A laptop closing its lid, a
 * phone leaving a tunnel, a NAT box forgetting a mapping — all of these leave
 * a socket that reads and writes without error and delivers nothing. The
 * process then holds the connection, its subscriptions, and whatever they
 * stream, forever. On a server with ten thousand connections this is not a
 * leak you notice; it is the memory graph slowly going up and nobody knowing
 * which deploy started it.
 *
 * So the server sends a beat and expects one back, and a connection that has
 * missed enough of them is treated as gone. That is the whole reason a
 * heartbeat exists, and why `clientGone` is a decision made from a timestamp
 * rather than from anything the socket reports.
 *
 * The command half is the other side: a client asks to subscribe, unsubscribe,
 * or perform, and each of those has to be checked before it is obeyed —
 * because the client chooses the channel name and the action.
 */

import { parseFrame } from "./protocol.js";
import type { IncomingFrame } from "./protocol.js";

export type { IncomingFrame };

/** Raised when a command is structurally valid but cannot be obeyed. */
export class InvalidCommand extends Error {
  constructor(received: unknown) {
    super(`Not a command this connection can act on: ${JSON.stringify(received)}.`);
    this.name = "InvalidCommand";
  }
}

/**
 * Reads a frame into a command. Rails' `dispatch_websocket_message`.
 *
 * Through `parseFrame`, which already validates every field and returns null
 * rather than throwing — a socket is an untrusted input and one bad frame must
 * not take down a connection carrying a hundred subscriptions. Answering that
 * question twice, differently, is how the two answers drift.
 */
export function dispatchWebsocketMessage(frame: string): IncomingFrame | null {
  return parseFrame(frame);
}

/** What a connection does when a command arrives. */
export interface CommandHandlers {
  subscribe(identifier: string): Promise<void> | void;
  unsubscribe(identifier: string): Promise<void> | void;
  message(identifier: string, data: string): Promise<void> | void;
}

export type CommandHook = (command: IncomingFrame) => Promise<void> | void;

/** An around hook decides whether the rest of the command runs at all. */
export type AroundCommandHook = (
  command: IncomingFrame,
  next: () => Promise<void>,
) => Promise<void> | void;

export interface CommandCallbacks {
  before: CommandHook[];
  after: CommandHook[];
  around: AroundCommandHook[];
}

export function newCommandCallbacks(): CommandCallbacks {
  return { before: [], after: [], around: [] };
}

/**
 * Rails' `before_command`.
 *
 * Around each command rather than around the connection, because a connection
 * lasts for hours and what these hooks exist for — a database connection, a
 * logging tag, a current-attributes scope — is per unit of work. Set up once
 * per connection instead, a database connection would be held for the whole
 * session and a logging tag would describe the command that opened it rather
 * than the one running.
 */
export function beforeCommand(callbacks: CommandCallbacks, hook: CommandHook): void {
  callbacks.before.push(hook);
}

export function afterCommand(callbacks: CommandCallbacks, hook: CommandHook): void {
  callbacks.after.push(hook);
}

export function aroundCommand(callbacks: CommandCallbacks, hook: AroundCommandHook): void {
  callbacks.around.push(hook);
}

/**
 * Runs a command with anything registered around it. Rails'
 * `execute_command` with its callbacks.
 *
 * A `before` hook that throws stops the command. That is what makes it a place
 * to put an authorisation check: a hook that could not stop anything would be
 * a log line.
 *
 * `after` runs in a `finally`, because a connection is long-lived — a database
 * connection or a lock taken by `before` and released by `after` would
 * otherwise leak for the rest of the session on the first command that
 * raised, so the tenth failure exhausts the pool rather than the first.
 *
 * An around hook genuinely wraps: it is handed the rest of the command and
 * decides whether to run it. Running them in sequence before the body instead
 * would make "around" mean "before", and a hook that wanted to time the
 * command, retry it, or refuse it could do none of those.
 */
export async function executeCommand(
  command: IncomingFrame,
  handlers: CommandHandlers,
  hooks: Partial<CommandCallbacks> = {},
): Promise<void> {
  const run = async (): Promise<void> => {
    for (const hook of hooks.before ?? []) await hook(command);

    try {
      await handleChannelCommand(command, handlers);
    } finally {
      for (const hook of hooks.after ?? []) await hook(command);
    }
  };

  // Applied outermost-first, so the hook declared first wraps the rest — the
  // order somebody reading the class top to bottom would expect.
  let next = run;

  for (const around of [...(hooks.around ?? [])].reverse()) {
    const inner = next;
    next = async () => {
      await around(command, inner);
    };
  }

  await next();
}

/** Routes one command to the right handler. Rails' `handle_channel_command`. */
export async function handleChannelCommand(
  command: IncomingFrame,
  handlers: CommandHandlers,
): Promise<void> {
  switch (command.command) {
    case "subscribe":
      await handlers.subscribe(command.identifier);

      return;
    case "unsubscribe":
      await handlers.unsubscribe(command.identifier);

      return;
    case "message":
      // A `message` with no data is a client bug, not a message with an empty
      // payload — passing "" on would have the channel act on nothing.
      if (command.data === undefined) throw new InvalidCommand(command);

      await handlers.message(command.identifier, command.data);
  }
}

/** Stops the rest of a command from running. Rails' `halt`. */
export class Halted extends Error {
  constructor(reason = "halted") {
    super(reason);
    this.name = "Halted";
  }
}

export function halt(reason?: string): never {
  throw new Halted(reason);
}

/** Runs a callback, reporting whether it halted rather than letting it escape. */
export async function invokeCallback(hook: CommandHook, command: IncomingFrame): Promise<boolean> {
  try {
    await hook(command);

    return true;
  } catch (error) {
    if (error instanceof Halted) return false;

    throw error;
  }
}

/** How long a connection may go unheard from before it is treated as gone. */
export const BEAT_INTERVAL_MS = 3000;
export const STALE_AFTER_MS = BEAT_INTERVAL_MS * 2;

/** One connection's liveness. */
export class Heartbeat {
  #lastSeen: number;
  readonly staleAfterMs: number;

  constructor(now: number = Date.now(), staleAfterMs: number = STALE_AFTER_MS) {
    this.#lastSeen = now;
    this.staleAfterMs = staleAfterMs;
  }

  /** Records that something arrived. Rails' `beat`. */
  beat(now: number = Date.now()): void {
    this.#lastSeen = now;
  }

  get lastSeen(): number {
    return this.#lastSeen;
  }

  /**
   * Whether the other end is still there, as far as anything can tell. Rails'
   * `alive?`.
   *
   * From a timestamp rather than from the socket, because the socket is the
   * thing that lies: TCP reports no error when the other end simply stopped
   * existing.
   */
  alive(now: number = Date.now()): boolean {
    return now - this.#lastSeen < this.staleAfterMs;
  }

  /** Rails' `client_gone?`. */
  clientGone(now: number = Date.now()): boolean {
    return !this.alive(now);
  }

  /** Moves the clock, for a test that must not sleep. Rails' `advance_time`. */
  advanceTime(by: number): void {
    this.#lastSeen -= by;
  }
}

/** Every connection the process holds, and the beat that culls them. */
export class HeartbeatMonitor<T> {
  readonly #beats = new Map<T, Heartbeat>();
  readonly staleAfterMs: number;

  constructor(staleAfterMs: number = STALE_AFTER_MS) {
    this.staleAfterMs = staleAfterMs;
  }

  add(connection: T, now: number = Date.now()): void {
    this.#beats.set(connection, new Heartbeat(now, this.staleAfterMs));
  }

  remove(connection: T): boolean {
    return this.#beats.delete(connection);
  }

  beat(connection: T, now: number = Date.now()): void {
    this.#beats.get(connection)?.beat(now);
  }

  get size(): number {
    return this.#beats.size;
  }

  alive(connection: T, now: number = Date.now()): boolean {
    return this.#beats.get(connection)?.alive(now) ?? false;
  }

  /**
   * Every connection that has stopped answering. Rails' the reaper's job.
   *
   * Reported rather than closed here, because what to do about one is the
   * caller's decision — a test wants to assert on them, and a server wants to
   * unsubscribe them before it closes them.
   */
  clientsGone(now: number = Date.now()): T[] {
    return Array.from(this.#beats)
      .filter(([, beat]) => beat.clientGone(now))
      .map(([connection]) => connection);
  }

  /** Drops them, and says how many. */
  reap(now: number = Date.now()): T[] {
    const gone = this.clientsGone(now);

    for (const connection of gone) this.#beats.delete(connection);

    return gone;
  }
}

/**
 * What a socket has queued but not yet sent. Rails' write buffer.
 *
 * A socket that is not draining is the other half of the dead-connection
 * problem: the writes queue in memory, the process reports nothing wrong, and
 * memory goes up until it does not.
 */
export class WriteBuffer {
  #pending: string[] = [];

  push(frame: string): void {
    this.#pending.push(frame);
  }

  /** Rails' `writes_pending?`. */
  writesPending(): boolean {
    return this.#pending.length > 0;
  }

  get size(): number {
    return this.#pending.length;
  }

  /**
   * Hands everything over and empties. Rails' `flush_write_buffer`.
   *
   * Taken and cleared before the writer runs, so a writer that throws does not
   * leave the frames queued to be sent twice — a duplicate frame is worse than
   * a dropped one, because a client acts on it.
   */
  flushWriteBuffer(write: (frame: string) => void): number {
    const frames = this.#pending;
    this.#pending = [];

    for (const frame of frames) write(frame);

    return frames.length;
  }
}

/** What a connection does at each end of its life. */
export interface ConnectionCallbacks {
  onOpen?(): Promise<void> | void;
  onClose?(): Promise<void> | void;
  onMessage?(frame: string): Promise<void> | void;
}

/**
 * Accepts a connection. Rails' `handle_open`.
 *
 * A failure here closes rather than leaving a half-open connection: one that
 * opened and then failed its own setup is subscribed to nothing and answers
 * nothing, and the client has no way to tell that from a quiet channel.
 */
export async function handleOpen(
  callbacks: ConnectionCallbacks,
  close: (reason: string) => void,
): Promise<boolean> {
  try {
    await callbacks.onOpen?.();

    return true;
  } catch (error) {
    close(error instanceof Error ? error.message : "failed to open");

    return false;
  }
}

/**
 * Closes one. Rails' `handle_close`.
 *
 * The callback's failure is swallowed. It runs while the connection is going
 * away, so there is nothing left to tell and nothing left to retry — and
 * letting it escape would take down whatever was closing the socket.
 */
export async function handleClose(callbacks: ConnectionCallbacks): Promise<void> {
  try {
    await callbacks.onClose?.();
  } catch {
    // Nothing to do about it, and nowhere to report it that still exists.
  }
}

/** Whether the request that opened the socket came over TLS. Rails' `secure_request?`. */
export function secureRequest(request: Request): boolean {
  const url = new URL(request.url);

  if (url.protocol === "https:" || url.protocol === "wss:") return true;

  return (request.headers.get("x-forwarded-proto") ?? "").split(",")[0]?.trim() === "https";
}
