/**
 * Getting from an HTTP request to a live socket, ported from
 * `ActionCable::Server::Socket` and `Server::Connections`.
 *
 * `connection_lifecycle.ts` handles a socket once it is open, including the
 * callbacks around each command. This is the part before that, which is where
 * the awkwardness lives: a WebSocket begins as an
 * ordinary HTTP request and stops being one partway through, and the server
 * has to hand the underlying socket off to something that is no longer
 * speaking HTTP.
 *
 * - **The handshake response is not a response.** After the upgrade the server
 *   must not write a status line, a body, or a `Content-Length`, because the
 *   bytes after the handshake are WebSocket frames and anything else on the
 *   wire corrupts the first one. Rails signals this with a status of `-1`,
 *   which every Rack server understands as "I have taken the socket".
 * - **The heartbeat is a server timer, not a per-connection one.** One timer
 *   ticking every few seconds and walking the connections, rather than one
 *   timer per connection: at ten thousand connections the second arrangement
 *   is ten thousand timers, and the work is identical.
 * - **A connection that has stopped answering has to be found by the server.**
 *   A TCP connection to a client that vanished — a laptop lid closing, a phone
 *   changing network — stays open indefinitely from the server's side. Nothing
 *   arrives, nothing errors, and the connection is counted, subscribed and
 *   consuming memory forever. The ping exists to make that state observable.
 */

/** The status Rack servers read as "the socket has been taken over". */
export const HIJACKED_STATUS = -1;

export interface SocketEnv {
  hijack?: () => unknown;
  hijackIo?: unknown;
  asyncCallback?: (response: [number, Record<string, string>, unknown]) => void;
}

/**
 * Rails' `hijack_rack_socket`.
 *
 * Takes the underlying socket from the server. Returns nothing when the server
 * does not support it rather than raising, because that is a deployment fact
 * rather than a bug — and the caller has a fallback.
 */
export function hijackRackSocket(env: SocketEnv): unknown {
  if (env.hijack === undefined) return undefined;

  // Some servers return the io; others only set it. Both are in the Rack spec,
  // and a server doing the second would otherwise look like one that failed.
  return env.hijack() ?? env.hijackIo;
}

export interface Driver {
  started: boolean;
  stream: unknown;
}

/**
 * Rails' `start_driver` — begin speaking WebSocket on the taken socket.
 *
 * Idempotent, because the handshake and the first read can both reach it and
 * starting twice would install two frame parsers on one socket — which
 * produces a stream of protocol errors rather than a clean failure.
 */
export function startDriver(driver: Driver | undefined, env: SocketEnv): boolean {
  if (driver === undefined || driver.started) return false;

  driver.stream = hijackRackSocket(env);

  // Servers using the async callback need to be told the switch happened; ones
  // that hijacked already know.
  env.asyncCallback?.([101, {}, driver.stream]);

  driver.started = true;

  return true;
}

/**
 * Rails' `rack_response` — what the request handler returns after upgrading.
 *
 * A status of -1 and nothing else. A real status line, or a body, or a
 * `Content-Length`, would be written after the handshake — where the next
 * bytes are supposed to be a WebSocket frame, so anything else corrupts it.
 */
export function rackResponse(
  driver: Driver | undefined,
  env: SocketEnv,
): [number, Record<string, string>, unknown[]] {
  startDriver(driver, env);

  return [HIJACKED_STATUS, {}, []];
}

// --- the server's shared machinery ------------------------------------------

/**
 * Rails' `event_loop` — one per server, built on first use.
 *
 * One loop rather than one per connection: every connection's readable socket
 * is registered with it, so the cost of ten thousand idle connections is ten
 * thousand file descriptors rather than ten thousand threads.
 */
export function eventLoop<T>(server: { eventLoop?: T }, build: () => T): T {
  server.eventLoop ??= build();

  return server.eventLoop;
}

/** How often the server pings. Rails' `BEAT_INTERVAL`. */
export const BEAT_INTERVAL_SECONDS = 3;

export interface Timer {
  cancel(): void;
}

/**
 * Rails' `setup_heartbeat_timer`.
 *
 * One timer for the server, walking every connection, rather than a timer per
 * connection — at ten thousand connections the second arrangement is ten
 * thousand timers doing identical work.
 *
 * The ping is what makes a dead connection observable at all: a TCP connection
 * to a client that vanished stays open indefinitely from the server's side,
 * so without it a laptop lid closing leaves a connection counted, subscribed
 * and consuming memory forever.
 */
export function setupHeartbeatTimer(
  server: { heartbeatTimer?: Timer },
  every: (seconds: number, tick: () => void) => Timer,
  beatAll: () => void,
): Timer {
  server.heartbeatTimer ??= every(BEAT_INTERVAL_SECONDS, beatAll);

  return server.heartbeatTimer;
}

/**
 * Rails' `determine_url` — the URL clients connect to.
 *
 * Absolute, and `wss` wherever the page was served over HTTPS: a browser
 * refuses a `ws` connection from an `https` page, and the refusal is a console
 * message rather than an error the application sees.
 */
export function determineUrl(
  mountPath: string,
  { host, secure = false }: { host?: string; secure?: boolean } = {},
): string {
  if (/^wss?:\/\//.test(mountPath)) return mountPath;

  if (host === undefined) return mountPath;

  return `${secure ? "wss" : "ws"}://${host}${mountPath.startsWith("/") ? "" : "/"}${mountPath}`;
}

/**
 * Rails' `redis_connection_for_subscriptions`.
 *
 * A connection of its own. A Redis client in subscribe mode accepts only
 * subscribe and unsubscribe commands until it leaves, so sharing the
 * application's client would make every unrelated Redis call fail for as long
 * as the server is listening.
 */
export function redisConnectionForSubscriptions<T>(
  server: { subscriptionsClient?: T },
  build: () => T,
): T {
  server.subscriptionsClient ??= build();

  return server.subscriptionsClient;
}
