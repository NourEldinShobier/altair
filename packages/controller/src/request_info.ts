/**
 * Reading a request, ported from `ActionDispatch::Http::Request`.
 *
 * The Web `Request` covers the method, the URL and the headers; these are the
 * questions Rails answers on top of it — which subdomain, which format, which
 * address the person is actually at when three proxies are in the way.
 */

/** Suffixes that are part of the registry rather than part of a name. */
const PUBLIC_SUFFIXES = new Set(["co.uk", "com.au", "co.nz", "co.jp", "com.br", "co.za"]);

/**
 * The registrable domain — `example.co.uk` out of `shop.example.co.uk`.
 *
 * Two labels usually, three when the second-to-last is a public suffix.
 * Getting this wrong is how a cookie set for `.co.uk` reaches every site in
 * the country, which browsers refuse but applications still try.
 */
export function extractDomain(host: string, levels?: number): string {
  const labels = host.split(".").filter(Boolean);

  if (labels.length <= 1) return host;

  const wanted = levels ?? (PUBLIC_SUFFIXES.has(labels.slice(-2).join(".")) ? 3 : 2);

  return labels.slice(-wanted).join(".");
}

/** Everything in front of the domain, as one string. Rails' `subdomain`. */
export function extractSubdomain(host: string, levels?: number): string {
  return extractSubdomains(host, levels).join(".");
}

/** Everything in front of the domain, as its labels. Rails' `subdomains`. */
export function extractSubdomains(host: string, levels?: number): string[] {
  // An address is not a name, and slicing labels off one produces nonsense
  // that looks like a subdomain.
  if (/^[\d.]+$/.test(host) || host.includes(":")) return [];

  const labels = host.split(".").filter(Boolean);
  const domain = extractDomain(host, levels).split(".").length;

  return labels.slice(0, Math.max(0, labels.length - domain));
}

/** The content type without its parameters. Rails' `content_mime_type`. */
export function contentMimeType(request: Request): string | null {
  const header = request.headers.get("content-type");

  return header ? (header.split(";")[0] as string).trim().toLowerCase() : null;
}

/**
 * What the client said it accepts, best first.
 *
 * Sorted by the `q` value, which is the whole point of the header and the part
 * a naive split ignores — `text/html;q=0.8, application/json` prefers JSON,
 * and reading them in order gets it backwards.
 */
export function acceptedTypes(request: Request): string[] {
  const header = request.headers.get("accept");
  if (!header) return [];

  return header
    .split(",")
    .map((one) => {
      const [type, ...parameters] = one.split(";").map((part) => part.trim());
      const quality = parameters
        .map((part) => /^q=([\d.]+)$/.exec(part)?.[1])
        .find((value) => value !== undefined);

      return { type: (type ?? "").toLowerCase(), quality: quality ? Number(quality) : 1 };
    })
    .filter((one) => one.type.length > 0)
    .sort((left, right) => right.quality - left.quality)
    .map((one) => one.type);
}

/** The format a request is asking for: the extension, or the Accept header. */
export function requestFormat(request: Request): string | null {
  const path = new URL(request.url).pathname;
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1];

  if (extension) return extension.toLowerCase();

  const accepted = acceptedTypes(request)[0];
  if (!accepted || accepted === "*/*") return null;

  return accepted.split("/")[1]?.replace(/^.*\+/, "") ?? null;
}

export interface AddressOptions {
  /**
   * How many proxies of your own sit in front of this.
   *
   * The client's address is the last entry a proxy you control did *not* add,
   * and only you know how many those are. Taking the first entry trusts a
   * header anybody can send; taking the last trusts your own proxy and nobody
   * else, which is why this counts from the right.
   */
  trustedProxies?: number;
}

/**
 * The address a request appears to come from. Rails' `remote_ip`.
 *
 * Defaults to the last entry, which is your own proxy's opinion. Say how many
 * hops you control and it walks back that far.
 */
export function remoteAddress(request: Request, options: AddressOptions = {}): string | null {
  const forwarded = request.headers.get("x-forwarded-for");

  if (forwarded) {
    const chain = forwarded
      .split(",")
      .map((one) => one.trim())
      .filter(Boolean);
    const hops = options.trustedProxies ?? 0;
    const index = Math.max(0, chain.length - 1 - hops);

    return chain[index] ?? null;
  }

  return request.headers.get("x-real-ip");
}

/** Whether this looks like a fetch rather than a page load. Rails' `xhr?`. */
export function isXhr(request: Request): boolean {
  return (
    request.headers.get("x-requested-with")?.toLowerCase() === "xmlhttprequest" ||
    request.headers.get("sec-fetch-mode") === "cors"
  );
}

/** The path with its query, which is what a log line wants. Rails' `fullpath`. */
export function fullPath(request: Request): string {
  const url = new URL(request.url);

  return `${url.pathname}${url.search}`;
}

/** Whether the request came in over TLS, a proxy's word included. */
export function isSsl(request: Request): boolean {
  const url = new URL(request.url);

  return (request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "")) === "https";
}
