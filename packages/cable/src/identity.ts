/**
 * Who a connection is, and what that lets you do with it. Ported from
 * `ActionCable::Connection::Identification` and `RemoteConnections`.
 *
 *     identifiedBy("currentUser", (user) => `user:${user.id}`)
 *
 * A socket is long-lived and anonymous by default, which makes two ordinary
 * operations impossible: disconnecting a user when their session is revoked,
 * and knowing whether a user is connected at all. Both need a name for the
 * connection that outlives the request that opened it, and that is what an
 * identifier is.
 *
 * Rails builds a `connection_identifier` by joining the declared identifiers,
 * so a user with three tabs open has three connections under one name — which
 * is what makes "disconnect this user" mean all of them.
 */

import type { ConnectionContext } from "./channel.js";

/** How one declared identifier turns a value into a stable string. */
export interface Identifier {
  name: string;
  key: (value: unknown) => string;
}

const identifiers: Identifier[] = [];

/**
 * Declares an attribute of the connection as part of its identity. Rails'
 * `identified_by`.
 *
 * The key function exists because the value is usually a record and a record
 * is not a name. Left to a default, an object would stringify to
 * `[object Object]` and every connection would share one identity — which
 * reads as working until the first attempt to disconnect one user takes out
 * everybody.
 */
export function identifiedBy(name: string, key: (value: unknown) => string = String): void {
  identifiers.push({ name, key });
}

/** Every declared identifier, in declaration order. Rails' `identifiers`. */
export function connectionIdentifiers(): Identifier[] {
  return [...identifiers];
}

/** Forgets the declarations. For tests that declare their own. */
export function resetIdentifiers(): void {
  identifiers.length = 0;
}

/**
 * The name a connection goes by. Rails' `connection_identifier`.
 *
 * Undefined when the connection carries none of the declared attributes —
 * an anonymous visitor on a public channel — and that is a real state rather
 * than an error: such a connection simply cannot be found by name later.
 */
export function connectionIdentifier(connection: ConnectionContext): string | undefined {
  const parts = identifiers
    .filter((one) => connection[one.name] !== null && connection[one.name] !== undefined)
    .map((one) => one.key(connection[one.name]));

  return parts.length > 0 ? parts.join(":") : undefined;
}

/** One live socket, under the identity it was opened with. */
interface Tracked {
  identifier: string;
  disconnect: () => void;
}

/**
 * The connections this process is holding, by identity.
 *
 * Per process, and the file says so because the limitation matters: a
 * deployment behind several processes can only reach the sockets its own
 * process holds. Rails solves that by broadcasting a disconnect over the same
 * pub/sub the channels use, and the same route is open here — `disconnectAll`
 * is what such a subscriber would call on each process.
 */
const tracked = new Set<Tracked>();

/** Records a connection so it can be found by identity later. */
export function trackConnection(identifier: string, disconnect: () => void): () => void {
  const entry: Tracked = { identifier, disconnect };
  tracked.add(entry);

  return () => tracked.delete(entry);
}

/** Every identity currently connected. Rails' `RemoteConnections`. */
export function connectedIdentifiers(): string[] {
  return [...new Set([...tracked].map((one) => one.identifier))];
}

/** Whether anyone is connected under this identity. */
export function isConnected(identifier: string): boolean {
  return [...tracked].some((one) => one.identifier === identifier);
}

/** How many sockets one identity holds — usually one per open tab. */
export function connectionCount(identifier: string): number {
  return [...tracked].filter((one) => one.identifier === identifier).length;
}

/**
 * Disconnects every socket under an identity. Rails' `remote_connections.where(...).disconnect`.
 *
 * All of them, not one: a revoked session should not survive because the user
 * had a second tab open, which is exactly the case a per-socket disconnect
 * misses.
 */
export function disconnectAll(identifier: string): number {
  const matching = [...tracked].filter((one) => one.identifier === identifier);

  for (const entry of matching) {
    tracked.delete(entry);
    entry.disconnect();
  }

  return matching.length;
}

/** How many sockets this process is holding. Rails' `open_connections_statistics`. */
export function openConnectionsStatistics(): { identifier: string; count: number }[] {
  return connectedIdentifiers().map((identifier) => ({
    identifier,
    count: connectionCount(identifier),
  }));
}

/** Forgets every tracked connection. For tests. */
export function resetConnections(): void {
  tracked.clear();
}
