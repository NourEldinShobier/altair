/**
 * The cable server, ported from `ActionCable::Connection::Base`.
 *
 * Produces the `websocket` handlers `Bun.serve` takes, so the cable mounts into
 * the same server as the rest of the application rather than running beside it.
 *
 * Bun's pub/sub sends identical bytes to every subscriber, which is perfect for
 * the ping — one publish, every socket — and wrong for channel messages, which
 * the protocol frames under each subscriber's own identifier. So the ping goes
 * through Bun's pub/sub and channel messages go through a stream registry that
 * frames per subscription. Forcing one mechanism to do both would have meant
 * sending every client another client's identifier.
 */

import { connectionIdentifier, trackConnection } from "./identity.js";
import { UnauthorizedConnection, allowRequestOrigin, type OriginPolicy } from "./origin.js";
import type { Broadcaster, CableSocket, ChannelContext, ConnectionContext } from "./channel.js";
import { Channel, topicFor } from "./channel.js";
import {
  DEFAULT_MOUNT_PATH,
  DISCONNECT_REASONS,
  confirmationFrame,
  disconnectFrame,
  messageFrame,
  parseData,
  parseFrame,
  parseIdentifier,
  pingFrame,
  rejectionFrame,
  welcomeFrame,
} from "./protocol.js";

/** Per-socket state Bun carries for us via the upgrade's `data`. */
export interface SocketData {
  connection: ConnectionContext;
  /** Live channels, keyed by the raw identifier string the client sent. */
  subscriptions: Map<string, Channel>;
  /**
   * Forgets this socket from the identity registry. Set when it opens.
   *
   * Held here rather than looked up on close, because by then the connection
   * may already have been disconnected from elsewhere and searching for it
   * would either find nothing or find somebody else's socket.
   */
  untrack?: () => void;
}

export interface CableOptions {
  /** Where the cable is mounted. Rails defaults to /cable. */
  path?: string;
  channels?: (typeof Channel)[];
  /**
   * Decides who is connecting. Rails' `Connection#connect` with
   * `identified_by`. Returning null refuses the connection.
   */
  authorize?: (request: Request) => ConnectionContext | null | Promise<ConnectionContext | null>;
  /** Seconds between pings. Rails uses 3; the client watches for gaps. */
  pingInterval?: number;
  onError?: (error: unknown, context: { command?: string; identifier?: string }) => void;
  /**
   * Who may open a socket. Rails' `allowed_request_origins` and friends.
   *
   * Defaults to the request's own host and nothing else, which is what makes
   * cross-site WebSocket hijacking not work: a WebSocket handshake carries the
   * user's cookies and is not subject to the same-origin policy, so a page on
   * any other site could otherwise connect as the user and read everything
   * they are subscribed to.
   */
  origins?: OriginPolicy;
}

/** Publishes through a Bun server. The default when everything is one process. */
export class BunBroadcaster implements Broadcaster {
  constructor(private readonly server: { publish(topic: string, data: string): unknown }) {}

  publish(topic: string, payload: string): unknown {
    return this.server.publish(topic, payload);
  }
}

/**
 * Delivers to the sockets streaming from each name, framing per subscription.
 *
 * This is what a broadcast actually goes through. It is in-process; reaching
 * another server means republishing through Redis, which is why `Broadcaster`
 * stays an interface.
 */
export class StreamRegistry implements Broadcaster {
  readonly published: { topic: string; payload: string }[] = [];
  readonly #streams = new Map<string, Set<CableSocket & { data: SocketData }>>();

  /**
   * Told when a stream gains its first local socket, or loses its last.
   *
   * What a cross-process adapter needs: a process has to subscribe because
   * somebody here is listening, not because somebody here is broadcasting. A
   * worker that only receives would otherwise never subscribe at all.
   */
  onInterest?: (stream: string, interested: boolean) => void;

  add(stream: string, socket: CableSocket & { data: SocketData }): void {
    const sockets = this.#streams.get(stream) ?? new Set();
    const first = sockets.size === 0;

    sockets.add(socket);
    this.#streams.set(stream, sockets);

    if (first) this.onInterest?.(stream, true);
  }

  remove(stream: string, socket: CableSocket & { data: SocketData }): void {
    const sockets = this.#streams.get(stream);
    if (!sockets) return;

    sockets.delete(socket);

    if (sockets.size === 0) {
      this.#streams.delete(stream);
      this.onInterest?.(stream, false);
    }
  }

  /**
   * Drops a socket from every stream it was on.
   *
   * Goes through `remove` rather than deleting directly, so a stream losing
   * its last local subscriber reports that exactly as it would have on an
   * explicit unsubscribe. Deleting here instead meant a cross-process adapter
   * was never told, and every disconnect leaked the upstream subscription for
   * each stream that socket was the last one on — a Redis connection that
   * accumulates channels for as long as the process runs.
   *
   * The names are copied first because `remove` deletes from the map this
   * would otherwise be iterating.
   */
  removeEverywhere(socket: CableSocket): void {
    const streams = Array.from(this.#streams.keys());

    for (const stream of streams) {
      this.remove(stream, socket as CableSocket & { data: SocketData });
    }
  }

  /** How many distinct streams have a local subscriber. */
  get streamCount(): number {
    return this.#streams.size;
  }

  subscriberCount(stream: string): number {
    return this.#streams.get(stream)?.size ?? 0;
  }

  publish(topic: string, payload: string): void {
    this.published.push({ topic, payload });

    let parsed: { stream: string; message: unknown };
    try {
      parsed = JSON.parse(payload) as { stream: string; message: unknown };
    } catch {
      return;
    }

    for (const socket of this.#streams.get(parsed.stream) ?? []) {
      // Each subscription gets the message under its own identifier, which is
      // why this cannot be one publish of one payload.
      for (const frame of frameFor(socket.data.subscriptions, payload)) socket.send(frame);
    }
  }
}

/**
 * Wraps a broadcast payload back into a protocol frame.
 *
 * A broadcast names a stream, but each subscriber needs the message under
 * *its own* identifier — two clients on the same stream have different
 * identifiers, so the frame cannot be built once at publish time.
 */
export function frameFor(subscriptions: Map<string, Channel>, payload: string): string[] {
  let parsed: { stream: string; message: unknown };
  try {
    parsed = JSON.parse(payload) as { stream: string; message: unknown };
  } catch {
    return [];
  }

  const frames: string[] = [];
  for (const [identifier, channel] of subscriptions) {
    if (channel.streams.includes(parsed.stream)) {
      frames.push(messageFrame(identifier, parsed.message));
    }
  }
  return frames;
}

export class Cable {
  readonly path: string;
  readonly streams = new StreamRegistry();
  /**
   * The sockets this process is holding. Rails' `ActionCable::Server#connections`.
   *
   * Per process, like the identity registry, and for the same reason: a socket
   * is held by the machine it connected to and nowhere else. A deployment
   * behind several processes reads these from each and adds them up.
   */
  readonly #connections = new Set<CableSocket & { data: SocketData }>();
  #broadcaster: Broadcaster = this.streams;
  #ping: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: CableOptions = {}) {
    this.path = options.path ?? DEFAULT_MOUNT_PATH;
    if (options.channels) Channel.register(...options.channels);
  }

  get broadcaster(): Broadcaster {
    return this.#broadcaster;
  }

  /**
   * Sends broadcasts somewhere other than this process.
   *
   * The local registry stays as it is and keeps delivering to the sockets held
   * here; what changes is where a broadcast goes first. `useRedis` puts it on
   * Redis, and every process — including this one — hears it back.
   */
  useBroadcaster(broadcaster: Broadcaster): void {
    this.#broadcaster = broadcaster;
  }

  /**
   * Starts the ping timer against a running server.
   *
   * Only the ping uses Bun's pub/sub: every socket gets the same bytes, so one
   * publish serves all of them instead of a timer per connection.
   */
  attach(server: { publish(topic: string, data: string): unknown }): void {
    const seconds = this.options.pingInterval ?? 3;
    this.#ping ??= setInterval(
      () => server.publish(topicFor("__ping__"), pingFrame()),
      seconds * 1000,
    );
    // A timer that keeps the process alive is a server that will not shut down.
    this.#ping.unref?.();
  }

  detach(): void {
    if (this.#ping) clearInterval(this.#ping);
    this.#ping = undefined;
  }

  /** Broadcasts from outside a socket — a controller, a job, a console. */
  broadcastTo(stream: string, message: unknown): void {
    Channel.broadcastTo(this.#broadcaster, stream, message);
  }

  /** Whether a request is for the cable, so `fetch` knows to upgrade it. */
  handles(request: Request): boolean {
    return new URL(request.url).pathname === this.path;
  }

  /** Whether this handshake may proceed at all. Rails' `allow_request_origin?`. */
  allowRequestOrigin(request: Request): boolean {
    return allowRequestOrigin(request, this.options.origins ?? {});
  }

  /**
   * Builds the per-socket data an upgrade should carry, or null to refuse.
   *
   * The origin is checked before `authorize` runs, so a page from somewhere
   * else never reaches application code — and so an `authorize` that reads a
   * session cookie cannot accidentally hand a connection to a site that only
   * had the cookie because the browser attached it.
   */
  async upgradeData(request: Request): Promise<SocketData | null> {
    if (!this.allowRequestOrigin(request)) return null;

    let connection: ConnectionContext | null;

    try {
      connection = this.options.authorize
        ? await this.options.authorize(request)
        : ({ request } as ConnectionContext);
    } catch (error) {
      // A rejection is an answer, not a failure: it means authorize identified
      // somebody and decided against them, which is exactly the null case.
      if (error instanceof UnauthorizedConnection) return null;

      throw error;
    }

    if (!connection) return null;
    return { connection, subscriptions: new Map() };
  }

  /** The handlers `Bun.serve({ websocket })` takes. */
  handlers(): {
    open(ws: CableSocket & { data: SocketData }): void;
    message(ws: CableSocket & { data: SocketData }, raw: string | Buffer): Promise<void>;
    close(ws: CableSocket & { data: SocketData }): Promise<void>;
  } {
    return {
      open: (ws) => {
        // Every socket joins the ping topic, so one publish reaches everyone
        // rather than one timer per connection.
        ws.subscribe(topicFor("__ping__"));

        // Recorded under whatever identity it opened with, so it can be found
        // and closed later. Without this the identity registry stays empty and
        // `disconnectAll` reports nothing to disconnect — so revoking a
        // session leaves the socket open, still receiving every broadcast the
        // user was subscribed to, until they happen to close the tab.
        const identifier = connectionIdentifier(ws.data.connection);

        if (identifier !== undefined) {
          ws.data.untrack = trackConnection(identifier, () => {
            this.disconnect(ws, DISCONNECT_REASONS.unauthorized);
          });
        }

        this.addConnection(ws);
        ws.send(welcomeFrame());
      },

      message: async (ws, raw) => {
        const frame = parseFrame(raw);
        // A socket is untrusted input: one bad frame must not end the
        // connection, so a malformed one is ignored.
        if (!frame) return;

        try {
          switch (frame.command) {
            case "subscribe":
              await this.#subscribe(ws, frame.identifier);
              return;
            case "unsubscribe":
              await this.#unsubscribe(ws, frame.identifier);
              return;
            case "message":
              await this.#message(ws, frame.identifier, parseData(frame.data));
              return;
          }
        } catch (error) {
          this.options.onError?.(error, { command: frame.command, identifier: frame.identifier });
        }
      },

      close: async (ws) => {
        this.removeConnection(ws);
        ws.data.untrack?.();
        ws.data.untrack = undefined;

        this.streams.removeEverywhere(ws);

        for (const channel of ws.data.subscriptions.values()) {
          channel.clearTimers();
          channel.stopAllStreams();
          await channel.unsubscribed();
        }
        ws.data.subscriptions.clear();
      },
    };
  }

  async #subscribe(ws: CableSocket & { data: SocketData }, identifier: string): Promise<void> {
    if (ws.data.subscriptions.has(identifier)) return;

    const parsed = parseIdentifier(identifier);
    if (!parsed) {
      ws.send(rejectionFrame(identifier));
      return;
    }

    const ChannelClass = Channel.lookup(parsed.channel);
    if (!ChannelClass) {
      ws.send(rejectionFrame(identifier));
      return;
    }

    const { channel: _name, ...params } = parsed;
    const context: ChannelContext = {
      socket: ws,
      connection: ws.data.connection,
      identifier,
      params,
      broadcaster: this.#broadcaster,
    };

    const channel = new ChannelClass(context);
    await channel.subscribed();

    if (channel.isRejected) {
      channel.clearTimers();
      channel.stopAllStreams();
      ws.send(rejectionFrame(identifier));
      return;
    }

    ws.data.subscriptions.set(identifier, channel);
    for (const stream of channel.streams) this.streams.add(stream, ws);

    ws.send(confirmationFrame(identifier));
  }

  async #unsubscribe(ws: CableSocket & { data: SocketData }, identifier: string): Promise<void> {
    const channel = ws.data.subscriptions.get(identifier);
    if (!channel) return;

    for (const stream of channel.streams) this.streams.remove(stream, ws);

    channel.clearTimers();
    channel.stopAllStreams();
    await channel.unsubscribed();
    ws.data.subscriptions.delete(identifier);
  }

  async #message(
    ws: CableSocket & { data: SocketData },
    identifier: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const channel = ws.data.subscriptions.get(identifier);
    // A message for a subscription that was never confirmed is dropped rather
    // than opening a path into a channel the client does not hold.
    if (!channel) return;

    await channel.dispatch(data);
  }

  /** Closes a connection with a protocol disconnect frame. */
  /** Records an open socket. Called by the open handler. */
  addConnection(ws: CableSocket & { data: SocketData }): void {
    this.#connections.add(ws);
  }

  /** Forgets a socket. Called by the close handler. */
  removeConnection(ws: CableSocket & { data: SocketData }): void {
    this.#connections.delete(ws);
  }

  /** How many sockets this process is holding. */
  get connectionCount(): number {
    return this.#connections.size;
  }

  /**
   * Runs a function for each open socket. Rails' `each_connection`.
   *
   * Over a copy. A Set tolerates deletion during iteration, so disconnecting
   * what the body is given — the ordinary use — would be safe either way; the
   * copy is for a body that opens something, where iterating the live set
   * would visit what it just added.
   */
  eachConnection(body: (ws: CableSocket & { data: SocketData }) => void): void {
    const open = Array.from(this.#connections);

    for (const ws of open) body(ws);
  }

  /**
   * What an ops endpoint or a health check reads. Rails'
   * `open_connections_statistics`.
   *
   * Subscriptions rather than only sockets, because the two come apart: one
   * browser tab holding twelve channel subscriptions is one connection and
   * twelve subscriptions, and it is the second number that says whether the
   * process is near its limit.
   */
  statistics(): { connections: number; subscriptions: number; streams: number } {
    let subscriptions = 0;

    for (const ws of this.#connections) subscriptions += ws.data.subscriptions.size;

    return {
      connections: this.#connections.size,
      subscriptions,
      streams: this.streams.streamCount,
    };
  }

  /**
   * Closes every socket, asking each client to reconnect. Rails' `shutdown`.
   *
   * For a deploy. Dropped without this frame, a client waits out its heartbeat
   * timeout before deciding the connection is gone — so a rolling restart
   * leaves every user disconnected for that long, staggered, which reads as
   * the application being flaky rather than as a deploy. Told to reconnect,
   * they come back to the new process at once.
   */
  shutdown(reason: string = DISCONNECT_REASONS.serverRestart): number {
    const closed = this.#connections.size;

    this.eachConnection((ws) => {
      ws.send(disconnectFrame(reason, true));
      ws.close(1000, reason);
    });

    this.#connections.clear();
    this.detach();

    return closed;
  }

  disconnect(ws: CableSocket, reason: string = DISCONNECT_REASONS.unauthorized): void {
    ws.send(disconnectFrame(reason, false));
    ws.close(1000, reason);
  }
}
