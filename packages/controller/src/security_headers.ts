/**
 * The challenges and headers a controller sends to establish who is asking and
 * what the browser may run — ported from `ActionController::HttpAuthentication`
 * (Basic, Digest and Token), `ActionDispatch::ContentSecurityPolicy` and the
 * HSTS half of `ActionDispatch::SSL`.
 *
 * These look like three features and are one: each is a header whose *absence*
 * is the dangerous state, and each has a way of being present and doing
 * nothing.
 *
 * - **A Basic challenge without a realm** is accepted by browsers and makes
 *   every credential the user has for the host a candidate, because the realm
 *   is what scopes a stored password.
 * - **A CSP with a nonce the page never uses** blocks nothing and reports
 *   nothing: the policy is present, the header is correct, and every inline
 *   script still runs because `unsafe-inline` was left beside the nonce for
 *   compatibility. A nonce also has to be new per response — reused, it is a
 *   value an attacker can read from one page and replay into another.
 * - **HSTS with a short max-age** is the one that reads as configured and is
 *   not: a browser only enforces it for as long as the header said, so a
 *   five-minute policy protects nobody who did not visit in the last five
 *   minutes.
 *
 * Comparisons here are constant-time where they touch a secret. A comparison
 * that returns early on the first differing byte leaks the position of that
 * byte, and a few thousand requests turn that into the value.
 */

// --- comparing secrets -----------------------------------------------------------

/**
 * Rails' `secure_compare`.
 *
 * Fixed work regardless of where the strings differ, and the lengths are
 * folded in rather than checked first: an early length check tells an attacker
 * the length of the secret, which is most of the search space for a short one.
 * The fold also does real work on the bytes — the padding past the end of the
 * shorter string is a zero byte, so without it a secret and that same secret
 * plus a trailing NUL would compare equal.
 *
 * The loop runs to the *longer* length rather than the shorter one. That is a
 * timing property rather than a correctness one and no assertion here can see
 * it: stopping at the shorter length would return the same answers while
 * making the loop count reveal the shorter of the two lengths.
 */
export function secureCompare(given: string, expected: string): boolean {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  const length = Math.max(a.length, b.length);

  let difference = a.length ^ b.length;

  for (let index = 0; index < length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }

  return difference === 0;
}

// --- basic authentication -----------------------------------------------------------

/**
 * Rails' `authentication_request` header.
 *
 * The realm is required and quoted. Without one a browser offers every stored
 * credential for the host, since the realm is what scopes a saved password to
 * a part of a site.
 */
export function authenticationHeader(realm = "Application", scheme = "Basic"): string {
  // A quote inside the realm would close the parameter early and let the rest
  // be read as another one — a header the browser parses differently from what
  // the application wrote.
  return `${scheme} realm="${realm.replaceAll('"', "")}"`;
}

/** Rails' `user_name_and_password` — the credentials out of a Basic header. */
export function userNameAndPassword(header: string | null): [string, string] | undefined {
  if (header === null) return undefined;

  const match = /^Basic\s+(\S+)$/i.exec(header.trim());

  if (match === null) return undefined;

  let decoded: string;

  try {
    decoded = atob(match[1]!);
  } catch {
    return undefined;
  }

  const separator = decoded.indexOf(":");

  if (separator === -1) return undefined;

  // Split on the *first* colon only: a password may contain one, and splitting
  // on all of them silently truncates it — the user is refused with a correct
  // password and nothing says why.
  return [decoded.slice(0, separator), decoded.slice(separator + 1)];
}

/**
 * Rails' `http_basic_authenticate_with` — check, and say nothing else.
 *
 * Both halves compared in constant time, and both compared even when the name
 * is already wrong. Stopping early would make a wrong name measurably faster
 * than a right one with a wrong password, which is enough to enumerate users.
 */
export function httpBasicAuthenticateWith(
  header: string | null,
  expectedName: string,
  expectedPassword: string,
): boolean {
  const credentials = userNameAndPassword(header) ?? ["", ""];

  // Both compared before either is consulted. Returning early on a wrong name
  // is another timing property no assertion here can see — it makes a wrong
  // name measurably faster than a right one with a wrong password, which is
  // enough to enumerate users.
  const nameMatches = secureCompare(credentials[0], expectedName);
  const passwordMatches = secureCompare(credentials[1], expectedPassword);

  return nameMatches && passwordMatches;
}

/**
 * Rails' `http_basic_authenticate_or_request_with`.
 *
 * A failure is a 401 with the challenge, not a 403. The distinction is what
 * makes a browser prompt: a 403 says "you may not", a 401 says "who are you",
 * and only the second causes the dialog the whole scheme depends on.
 */
export function httpBasicAuthenticateOrRequestWith(
  header: string | null,
  expectedName: string,
  expectedPassword: string,
  realm = "Application",
):
  | { authenticated: true }
  | { authenticated: false; status: number; headers: Record<string, string> } {
  if (httpBasicAuthenticateWith(header, expectedName, expectedPassword)) {
    return { authenticated: true };
  }

  return {
    authenticated: false,
    status: 401,
    headers: { "WWW-Authenticate": authenticationHeader(realm) },
  };
}

// --- digest and token authentication ---------------------------------------------------

/**
 * Rails' `token_and_options` — the token and parameters from an
 * `Authorization: Bearer`/`Token` header.
 *
 * Parameters are parsed from the rest of the header rather than assumed
 * absent, because a client that sends them and is ignored looks to itself like
 * it authenticated with them.
 */
export function tokenAndOptions(
  header: string | null,
): { token: string; options: Record<string, string> } | undefined {
  if (header === null) return undefined;

  const match = /^(?:Token|Bearer)\s+(.*)$/i.exec(header.trim());

  if (match === null) return undefined;

  const rest = match[1]!;
  const quoted = /^token=("?)([^",]+)\1\s*(?:,\s*(.*))?$/i.exec(rest);

  if (quoted === null) return { token: rest.trim(), options: {} };

  return { token: quoted[2]!, options: tokenParamsFrom(quoted[3] ?? "") };
}

/** Rails' `token_params_from` — the `key="value"` pairs after the token. */
export function tokenParamsFrom(rest: string): Record<string, string> {
  const params: Record<string, string> = {};

  for (const pair of rest.split(",")) {
    const match = /^\s*(\w+)\s*=\s*"?([^"]*)"?\s*$/.exec(pair);

    if (match !== null) params[match[1]!] = match[2]!;
  }

  return params;
}

/**
 * Rails' `request_http_digest_authentication` — the Digest challenge.
 *
 * A fresh nonce each time, and the opaque value carried through. Digest is
 * only as good as its nonce: a reused one lets a captured response be replayed
 * against a later request, which is the whole thing Digest exists to prevent.
 */
export function requestHttpDigestAuthentication(
  realm: string,
  nonce: string,
  { opaque, stale = false }: { opaque?: string; stale?: boolean } = {},
): string {
  const parts = [`realm="${realm.replaceAll('"', "")}"`, `nonce="${nonce}"`, "qop=auth"];

  if (opaque !== undefined) parts.push(`opaque="${opaque}"`);
  // `stale=true` tells the client to retry with the same credentials rather
  // than prompting again. Omitting it turns an expired nonce into a password
  // prompt the user reads as a rejected password.
  if (stale) parts.push("stale=true");

  return `Digest ${parts.join(", ")}`;
}

// --- content security policy ------------------------------------------------------------

/**
 * The directives a nonce applies to. Rails' `content_security_policy_nonce_directives`.
 *
 * Scripts and styles only. A nonce on `img-src` means nothing — the attribute
 * does not exist on an image — so listing more directives produces a policy
 * that looks stricter and is not.
 */
export const NONCE_DIRECTIVES: readonly string[] = ["script-src", "style-src"];

export function contentSecurityPolicyNonceDirectives(): string[] {
  return [...NONCE_DIRECTIVES];
}

/**
 * Rails' `content_security_policy_nonce_generator`.
 *
 * A new value per response. Reused, a nonce is a value an attacker can read
 * from one page and replay into another — which turns the policy into a
 * formality that reports success.
 */
export function contentSecurityPolicyNonceGenerator(
  random: () => Uint8Array = () => crypto.getRandomValues(new Uint8Array(16)),
): string {
  return btoa(String.fromCharCode(...random())).replaceAll("=", "");
}

const nonces = new WeakMap<object, string>();

/**
 * Rails' `content_security_policy_nonce` — the one for this response.
 *
 * Memoised per request, because the value in the header and the value in the
 * page have to be the same one. Generated twice, the policy blocks exactly the
 * scripts it was written to allow — and the failure shows up in a browser
 * console rather than anywhere the application can see.
 */
export function contentSecurityPolicyNonce(
  request: object,
  generate = contentSecurityPolicyNonceGenerator,
): string {
  const held = nonces.get(request);

  if (held !== undefined) return held;

  const fresh = generate();
  nonces.set(request, fresh);

  return fresh;
}

/**
 * Builds the policy header.
 *
 * `unsafe-inline` is dropped from any directive that got a nonce. Browsers
 * ignore `unsafe-inline` when a nonce is present, so leaving both is not
 * *wrong* — but it reads as though inline scripts are allowed, and somebody
 * removing the nonce later would silently re-enable them.
 */
export function buildContentSecurityPolicy(
  directives: Record<string, readonly string[]>,
  nonce?: string,
): string {
  return Object.entries(directives)
    .map(([directive, sources]) => {
      const applies = nonce !== undefined && NONCE_DIRECTIVES.includes(directive);
      const values = applies
        ? [...sources.filter((source) => source !== "'unsafe-inline'"), `'nonce-${nonce}'`]
        : [...sources];

      return `${directive} ${values.join(" ")}`;
    })
    .join("; ");
}

/**
 * Rails' `content_security_policy_report_only`.
 *
 * A different header name, not a flag inside the policy. Sent under the
 * enforcing name a report-only policy would block things nobody has tested,
 * which is the failure mode the report-only mode exists to avoid.
 */
export function contentSecurityPolicyReportOnly(reportOnly: boolean): string {
  return reportOnly ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy";
}

// --- strict transport security ------------------------------------------------------------

export interface HstsOptions {
  maxAge?: number;
  subdomains?: boolean;
  preload?: boolean;
}

/** Two years, which is what the preload list requires. */
export const DEFAULT_HSTS_MAX_AGE = 63_072_000;

/**
 * Rails' `default_hsts_options`.
 *
 * Two years, subdomains included, preload off. The long max-age is the point:
 * a browser enforces the policy only for as long as the header said, so a
 * short one protects nobody who has not visited recently — and that reads as
 * configured while doing nearly nothing.
 *
 * Preload is off by default because it is close to irreversible: getting a
 * domain off the list takes months, during which every browser refuses plain
 * HTTP to it whatever the site now sends.
 */
export function defaultHstsOptions(): Required<HstsOptions> {
  return { maxAge: DEFAULT_HSTS_MAX_AGE, subdomains: true, preload: false };
}

export function hstsHeader(options: HstsOptions = {}): string {
  const { maxAge, subdomains, preload } = { ...defaultHstsOptions(), ...options };

  const parts = [`max-age=${Math.floor(maxAge)}`];

  if (subdomains) parts.push("includeSubDomains");

  // The preload list requires both a long max-age and includeSubDomains, so
  // sending `preload` without them produces a header that is rejected on
  // submission — after somebody has already relied on it.
  if (preload) {
    if (!subdomains || maxAge < DEFAULT_HSTS_MAX_AGE) {
      throw new Error(
        "preload needs includeSubDomains and a max-age of at least two years. Without both, the " +
          "header is rejected when the domain is submitted — after somebody has relied on it.",
      );
    }

    parts.push("preload");
  }

  return parts.join("; ");
}

// --- signed and encrypted cookies --------------------------------------------------------

/**
 * Rails' `cookies_digest`.
 *
 * SHA-256 by default. The digest is named in the configuration rather than
 * fixed because changing it invalidates every existing signed cookie, so an
 * application has to be able to say which one it is currently using while it
 * rotates.
 */
export function cookiesDigest(configured?: string): string {
  return configured ?? "SHA256";
}

export interface Rotation {
  secret: string;
  digest?: string;
  salt?: string;
}

const rotations: Rotation[] = [];

/**
 * Rails' `cookies_rotations` — the older secrets a cookie may still be signed
 * with.
 *
 * Tried in order after the current one, and only for *reading*. Writing with
 * an old secret would extend its life indefinitely and there would be no
 * moment at which the rotation finished.
 */
export function cookiesRotations(): Rotation[] {
  return [...rotations];
}

export function rotate(rotation: Rotation): void {
  rotations.push(rotation);
}

export function resetRotations(): void {
  rotations.length = 0;
}

/**
 * Reads a cookie against the current secret and then each rotated one.
 *
 * Reports which secret worked, so an application can tell whether a rotation
 * is finished. Without that the old secret is kept forever "just in case",
 * which is the state a rotation was supposed to end.
 */
export function readWithRotation(
  value: string,
  current: Rotation,
  verify: (value: string, rotation: Rotation) => string | undefined,
): { value: string; rotated: boolean } | undefined {
  const fresh = verify(value, current);

  if (fresh !== undefined) return { value: fresh, rotated: false };

  for (const old of rotations) {
    const recovered = verify(value, old);

    if (recovered !== undefined) return { value: recovered, rotated: true };
  }

  return undefined;
}

/**
 * Rails' `secret_token` — the legacy key, refused rather than supported.
 *
 * Rails carried a compatibility path for it for years and then removed it. The
 * key derivation behind it is weak enough that supporting it quietly gives an
 * application worse security than it believes it has, so this raises and names
 * the replacement.
 */
export function secretToken(): never {
  throw new Error(
    "secret_token is not supported. Its key derivation is weak enough that supporting it " +
      "quietly would give an application worse security than it believes it has — use " +
      "secret_key_base, and rotate existing cookies through cookiesRotations.",
  );
}

/**
 * Rails' `request_forgery_protection_token` — the parameter name a form uses.
 *
 * Configurable, because the default is well known and an application behind a
 * filter that strips or logs parameters by name may need another. The name is
 * not a secret and changing it is not protection; it is there so the parameter
 * can be moved out of the way of something else.
 */
export function requestForgeryProtectionToken(configured?: string): string {
  return configured ?? "authenticity_token";
}
