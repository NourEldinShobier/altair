/**
 * Working out who sent a request, ported from `ActionDispatch::RemoteIp`.
 *
 *     clientIp(request, { trustedProxies: 1 })
 *
 * `X-Forwarded-For` is a list a client can write. Anyone can send
 * `X-Forwarded-For: 1.2.3.4` and, if the application reads the first entry,
 * be 1.2.3.4 for the rest of the request — which is enough to walk around a
 * rate limit, poison an audit log, or appear in someone else's country in the
 * analytics.
 *
 * What makes the header usable is that each proxy *appends*, so the entries
 * nearest the end were written by infrastructure that is yours. The only safe
 * reading is to count back from the right by however many proxies you actually
 * run, and that number cannot be guessed — it is a property of the deployment,
 * so it has to be configured.
 *
 * The default is to trust nothing and use the socket address, because an
 * application that has not been told its shape is an application behind zero
 * proxies until somebody says otherwise. Being wrong in that direction costs
 * accuracy behind a load balancer; being wrong in the other direction is a
 * spoofable identity.
 */

export interface ClientIpOptions {
  /**
   * How many proxies of your own sit in front of this application.
   *
   * One for a single load balancer, two for a CDN in front of it. Zero — the
   * default — reads nothing from the header at all.
   */
  trustedProxies?: number;
  /** The socket address, when the server can supply one. */
  socketAddress?: string;
  /** Which header the proxies write. */
  header?: string;
}

/** Splits and tidies an `X-Forwarded-For`. */
export function forwardedFor(header: string | null): string[] {
  if (!header) return [];

  return header
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(stripPort);
}

/**
 * Removes a port, and the brackets IPv6 wears when it has one.
 *
 * `[2001:db8::1]:443` and `203.0.113.5:9000` both name an address that a
 * comparison against a string of digits and dots would otherwise miss.
 */
function stripPort(entry: string): string {
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(entry);
  if (bracketed) return bracketed[1] as string;

  // Only strip a port from IPv4: a bare IPv6 address is full of colons.
  const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(entry);
  return withPort ? (withPort[1] as string) : entry;
}

/**
 * The address to treat as the client's.
 *
 * Counts back from the end of the forwarded list by the number of proxies that
 * were declared, so the entries a client wrote itself are never reached.
 */
export function clientIp(request: Request, options: ClientIpOptions = {}): string | undefined {
  const trusted = Math.max(0, Math.floor(options.trustedProxies ?? 0));
  const socket = options.socketAddress;

  if (trusted === 0) return socket;

  const entries = forwardedFor(request.headers.get(options.header ?? "x-forwarded-for"));
  if (entries.length === 0) return socket;

  // The last entry was written by the proxy nearest this process, so it names
  // the hop before it. Stepping back `trusted` places lands on the address the
  // outermost trusted proxy saw — and one short of anything a client forged.
  const index = entries.length - trusted;

  // Fewer entries than declared proxies means the request did not come through
  // them. Reading the first entry here is exactly the spoof this exists to
  // prevent, so the socket address is the honest answer.
  if (index < 0) return socket;

  return entries[index] ?? socket;
}
