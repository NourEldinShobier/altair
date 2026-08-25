/**
 * Driving an application from a test, ported from
 * `ActionDispatch::IntegrationTest`.
 *
 *     const session = testSession(app)
 *
 *     await session.post("/session", { params: { email, password } })
 *     const response = await session.get("/account")
 *
 *     expect(response.status).toBe(200)
 *     expect(response.body).toContain("Signed in")
 *
 * A test can always build a `Request` and read a `Response` by hand, and that
 * is what these tests did before this existed. What it gets wrong is the part
 * between two requests: a browser carries cookies from one to the next, and a
 * hand-built request does not. So a test signs in, makes a second request
 * without the session cookie, and either quietly asserts against a signed-out
 * page or reaches for the session store directly — which tests the store
 * rather than the sign-in.
 *
 * The session here is a cookie jar and an encoder. It does not know how the
 * session is signed or what the CSRF token is made of; it holds what the
 * application set and sends it back, the way a browser would.
 */

/** A response, with the questions a test asks already answered. */
export class TestResponse {
  constructor(
    readonly raw: Response,
    /** Already read. A test that awaits `.text()` twice gets an empty string. */
    readonly body: string,
  ) {}

  get status(): number {
    return this.raw.status;
  }

  get headers(): Headers {
    return this.raw.headers;
  }

  /** Where a redirect points, or undefined. */
  get location(): string | undefined {
    return this.raw.headers.get("location") ?? undefined;
  }

  get contentType(): string | undefined {
    return this.raw.headers.get("content-type") ?? undefined;
  }

  /** The body parsed as JSON. Throws with the body in the message if it is not. */
  json<T = unknown>(): T {
    try {
      return JSON.parse(this.body) as T;
    } catch {
      throw new Error(
        `Expected JSON, got ${this.contentType ?? "no content type"}: ${this.body.slice(0, 200)}`,
      );
    }
  }

  /** Rails' `assert_response :success` and friends, as predicates. */
  get successful(): boolean {
    return this.status >= 200 && this.status < 300;
  }

  get redirect(): boolean {
    return this.status >= 300 && this.status < 400;
  }

  get clientError(): boolean {
    return this.status >= 400 && this.status < 500;
  }

  get serverError(): boolean {
    return this.status >= 500;
  }
}

export type Params = Record<string, unknown>;

export interface RequestOptions {
  /** Query string on a GET, body on anything else. */
  params?: Params;
  headers?: Record<string, string>;
  /** `json` posts a JSON body; the default posts a form, as a browser does. */
  as?: "form" | "json";
}

/** What this needs from an application, so the packages stay uncoupled. */
export interface HandlerLike {
  handler(): (request: Request) => Promise<Response>;
}

const BODYLESS = new Set(["GET", "HEAD", "DELETE"]);

/**
 * Flattens params the way a form does: `{post: {title: "x"}}` becomes
 * `post[title]=x`, which is the shape the parameter parser already reads.
 */
function encodeForm(params: Params, into = new URLSearchParams(), prefix = ""): URLSearchParams {
  for (const [key, value] of Object.entries(params)) {
    const name = prefix ? `${prefix}[${key}]` : key;

    if (value === null || value === undefined) continue;

    // An array posts its name repeated with `[]`, which is how a browser
    // sends a multi-select and how Rails reads one back.
    if (Array.isArray(value)) {
      for (const entry of value) into.append(`${name}[]`, String(entry));
      continue;
    }

    if (value instanceof Date) {
      into.append(name, value.toISOString());
      continue;
    }

    if (typeof value === "object") {
      encodeForm(value as Params, into, name);
      continue;
    }

    into.append(name, String(value));
  }

  return into;
}

/** The name and value of a cookie, ignoring the attributes after it. */
function parseCookie(header: string): { name: string; value: string; expired: boolean } | null {
  const [pair, ...attributes] = header.split(";");
  const at = pair?.indexOf("=") ?? -1;
  if (!pair || at < 1) return null;

  // `Max-Age=0` and a past `Expires` are both how a server deletes a cookie,
  // and a jar that ignored them would carry a session the app just cleared.
  const expired = attributes.some((attribute) => {
    const [key, value] = attribute.split("=").map((part) => part.trim());
    if (key?.toLowerCase() === "max-age") return Number(value) <= 0;
    if (key?.toLowerCase() === "expires") return new Date(value ?? "").getTime() <= Date.now();
    return false;
  });

  return { name: pair.slice(0, at).trim(), value: pair.slice(at + 1).trim(), expired };
}

/**
 * A browser, roughly: one cookie jar making requests against one application.
 *
 * Rails calls this an integration session, and it is what makes a test read
 * like a user's visit rather than a sequence of unrelated requests.
 */
export class TestSession {
  /** The cookies the application has set, by name. */
  readonly cookies = new Map<string, string>();
  /** The last response, for a test that wants it after a helper call. */
  response?: TestResponse;

  constructor(
    private readonly handler: (request: Request) => Promise<Response>,
    private readonly host = "http://test.host",
  ) {}

  get(path: string, options: RequestOptions = {}): Promise<TestResponse> {
    return this.request("GET", path, options);
  }

  post(path: string, options: RequestOptions = {}): Promise<TestResponse> {
    return this.request("POST", path, options);
  }

  patch(path: string, options: RequestOptions = {}): Promise<TestResponse> {
    return this.request("PATCH", path, options);
  }

  put(path: string, options: RequestOptions = {}): Promise<TestResponse> {
    return this.request("PUT", path, options);
  }

  delete(path: string, options: RequestOptions = {}): Promise<TestResponse> {
    return this.request("DELETE", path, options);
  }

  head(path: string, options: RequestOptions = {}): Promise<TestResponse> {
    return this.request("HEAD", path, options);
  }

  async request(method: string, path: string, options: RequestOptions = {}): Promise<TestResponse> {
    const url = new URL(path, this.host);
    const headers = new Headers(options.headers);
    let body: string | undefined;

    const bodyless = BODYLESS.has(method.toUpperCase());

    if (options.params && bodyless) {
      for (const [key, value] of encodeForm(options.params)) url.searchParams.append(key, value);
    } else if (options.params) {
      if (options.as === "json") {
        body = JSON.stringify(options.params);
        if (!headers.has("content-type")) headers.set("content-type", "application/json");
      } else {
        body = encodeForm(options.params).toString();
        if (!headers.has("content-type")) {
          headers.set("content-type", "application/x-www-form-urlencoded");
        }
      }
    }

    // A request with `as: "json"` and no params still says what it wants back,
    // which is the case for a GET asking an endpoint for JSON.
    if (options.as === "json" && !headers.has("accept")) {
      headers.set("accept", "application/json");
    }

    if (this.cookies.size > 0 && !headers.has("cookie")) {
      headers.set(
        "cookie",
        [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "),
      );
    }

    const raw = await this.handler(new Request(url.toString(), { method, headers, body }));

    this.store(raw);

    // Read once and hold it: a `Response` body is a stream, and a test that
    // awaited `.text()` after asserting on `.body` would get an empty string.
    const response = new TestResponse(raw, raw.body ? await raw.text() : "");
    this.response = response;

    return response;
  }

  /**
   * Follows the last redirect, the way `follow_redirect!` does.
   *
   * Rails raises when the last response was not a redirect rather than
   * quietly doing nothing, because a test that meant to follow one and did
   * not goes on to assert against the wrong page.
   */
  async followRedirect(): Promise<TestResponse> {
    const location = this.response?.location;

    if (!this.response?.redirect || !location) {
      throw new Error(
        `Expected a redirect to follow, got ${this.response?.status ?? "no response"}.`,
      );
    }

    return await this.get(location);
  }

  /** Empties the jar, for a test that wants a signed-out visitor next. */
  reset(): void {
    this.cookies.clear();
    this.response = undefined;
  }

  private store(response: Response): void {
    // `getSetCookie` rather than `get`, which joins the headers with a comma —
    // and `Expires=Wed, 21 Oct 2026` contains one, so splitting the joined
    // string cuts a cookie in half.
    for (const header of response.headers.getSetCookie()) {
      const cookie = parseCookie(header);
      if (!cookie) continue;

      if (cookie.expired) this.cookies.delete(cookie.name);
      else this.cookies.set(cookie.name, cookie.value);
    }
  }
}

/** A session against an application. The usual entry point. */
export function testSession(app: HandlerLike, host?: string): TestSession {
  return new TestSession(app.handler(), host);
}
