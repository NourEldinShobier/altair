/**
 * The Action Cable wire protocol.
 *
 * These constants are copied from actioncable/lib/action_cable.rb, not invented,
 * because speaking the protocol exactly means Rails' own `@rails/actioncable`
 * client works against this server unchanged. That is a whole client library we
 * do not have to write, test or maintain.
 */

export const MESSAGE_TYPES = {
  welcome: "welcome",
  disconnect: "disconnect",
  ping: "ping",
  confirmation: "confirm_subscription",
  rejection: "reject_subscription",
} as const;

export const DISCONNECT_REASONS = {
  unauthorized: "unauthorized",
  invalidRequest: "invalid_request",
  serverRestart: "server_restart",
  remote: "remote",
} as const;

export const DEFAULT_MOUNT_PATH = "/cable";
export const PROTOCOLS = ["actioncable-v1-json", "actioncable-unsupported"] as const;

export type Command = "subscribe" | "unsubscribe" | "message";

/**
 * A frame from the client.
 *
 * `identifier` and `data` are JSON *strings*, not objects — the protocol
 * double-encodes them, and a server that forgets is subtly incompatible.
 */
export interface IncomingFrame {
  command: Command;
  identifier: string;
  data?: string;
}

export interface OutgoingFrame {
  type?: string;
  identifier?: string;
  message?: unknown;
  reason?: string;
  reconnect?: boolean;
}

/** Names a channel and its parameters. Rails calls this the identifier. */
export interface ChannelIdentifier {
  channel: string;
  [param: string]: unknown;
}

/** Parses an identifier string, or null when it is not usable. */
export function parseIdentifier(identifier: string): ChannelIdentifier | null {
  try {
    const parsed: unknown = JSON.parse(identifier);
    if (typeof parsed !== "object" || parsed === null) return null;

    const record = parsed as Record<string, unknown>;
    if (typeof record.channel !== "string") return null;

    return record as ChannelIdentifier;
  } catch {
    return null;
  }
}

/**
 * Parses a client frame.
 *
 * Anything malformed returns null rather than throwing: a socket is an
 * untrusted input, and one bad frame must not take down the connection.
 */
export function parseFrame(raw: string | Buffer): IncomingFrame | null {
  try {
    const parsed: unknown = JSON.parse(String(raw));
    if (typeof parsed !== "object" || parsed === null) return null;

    const record = parsed as Record<string, unknown>;
    if (typeof record.command !== "string" || typeof record.identifier !== "string") return null;
    if (!["subscribe", "unsubscribe", "message"].includes(record.command)) return null;

    return {
      command: record.command as Command,
      identifier: record.identifier,
      data: typeof record.data === "string" ? record.data : undefined,
    };
  } catch {
    return null;
  }
}

/** Parses the double-encoded `data` field of a message frame. */
export function parseData(data: string | undefined): Record<string, unknown> {
  if (!data) return {};
  try {
    const parsed: unknown = JSON.parse(data);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function welcomeFrame(): string {
  return JSON.stringify({ type: MESSAGE_TYPES.welcome });
}

/** Rails sends the timestamp in seconds, and the client watches for gaps. */
export function pingFrame(at: number = Date.now()): string {
  return JSON.stringify({ type: MESSAGE_TYPES.ping, message: Math.floor(at / 1000) });
}

export function confirmationFrame(identifier: string): string {
  return JSON.stringify({ identifier, type: MESSAGE_TYPES.confirmation });
}

export function rejectionFrame(identifier: string): string {
  return JSON.stringify({ identifier, type: MESSAGE_TYPES.rejection });
}

export function disconnectFrame(reason: string, reconnect = false): string {
  return JSON.stringify({ type: MESSAGE_TYPES.disconnect, reason, reconnect });
}

/** A broadcast to one subscription. */
export function messageFrame(identifier: string, message: unknown): string {
  return JSON.stringify({ identifier, message });
}
