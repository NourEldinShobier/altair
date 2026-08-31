/**
 * Driving a controller from a test, ported from
 * `ActionController::TestCase` and `ActionDispatch::IntegrationTest`.
 *
 * `request.ts` already sends requests and asserts on responses. This is the
 * layer a *controller* test needs: building the request, reading the response
 * in whatever form the test wants it, and — the part that actually matters —
 * making sure one request in a test cannot contaminate the next.
 *
 * That last point is the whole reason `recycle` exists. A controller test that
 * makes two requests reuses one harness, and anything left over from the first
 * changes the second: a flash message set by the first request is still there,
 * so a test asserting "no flash" passes for the wrong reason; parameters from
 * the first are still assigned, so the second request appears to send fields it
 * never sent. Neither fails — they pass, differently, and the test that later
 * breaks is the one that was written second.
 */

/** What a test says it is sending. */
export interface TestRequestSpec {
  method: string;
  path: string;
  params?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: string;
  format?: string;
}

/**
 * The environment a request is built from. Rails' `default_env` / `normalize_env`.
 *
 * A fixed default rather than whatever the machine happens to have, because a
 * controller test that depended on the host it ran on would pass locally and
 * fail in CI for a reason nobody would look for.
 */
export function defaultEnv(): Record<string, string> {
  return {
    HTTP_HOST: "test.host",
    REMOTE_ADDR: "0.0.0.0",
    HTTP_USER_AGENT: "Altair Test",
    SERVER_PORT: "80",
    "rack.url_scheme": "http",
  };
}

/** Rails' `normalize_env` — the caller's overrides on top of the defaults. */
export function normalizeEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const normalized: Record<string, string> = { ...defaultEnv() };

  for (const [key, value] of Object.entries(overrides)) {
    // Header names arrive in either form depending on whether the caller is
    // thinking in HTTP or in Rack; normalising here means a test can write
    // whichever reads better without the two diverging.
    normalized[key.startsWith("HTTP_") || key.includes(".") ? key : headerToEnv(key)] = value;
  }

  return normalized;
}

function headerToEnv(name: string): string {
  return `HTTP_${name.toUpperCase().replaceAll("-", "_")}`;
}

/**
 * Rails' `assign_parameters` — the parameters a request carries.
 *
 * Query parameters for a body-less method and a body otherwise, because a test
 * that sent parameters in the wrong place would exercise a path the
 * application never sees: a `GET` with a body is not what a browser sends, and
 * a controller reading `params` would not notice the difference until
 * something downstream did.
 */
export function assignParameters(spec: TestRequestSpec): {
  path: string;
  body?: string;
  headers: Record<string, string>;
} {
  const params = spec.params ?? {};
  const headers = { ...spec.headers };

  if (Object.keys(params).length === 0) return { path: spec.path, headers };

  const encoded = new URLSearchParams(
    Object.entries(params).map(([key, value]) => [key, String(value)] as [string, string]),
  ).toString();

  if (["GET", "HEAD", "DELETE", "OPTIONS"].includes(spec.method.toUpperCase())) {
    const separator = spec.path.includes("?") ? "&" : "?";

    return { path: `${spec.path}${separator}${encoded}`, headers };
  }

  return {
    path: spec.path,
    body: encoded,
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
  };
}

/** Rails' `build_request` — a `Request` from a spec. */
export function buildRequest(spec: TestRequestSpec, env = defaultEnv()): Request {
  const { path, body, headers } = assignParameters(spec);
  const url = new URL(
    path,
    `${env["rack.url_scheme"] ?? "http"}://${env["HTTP_HOST"] ?? "test.host"}`,
  );

  return new Request(url.toString(), {
    method: spec.method.toUpperCase(),
    headers: { "user-agent": env["HTTP_USER_AGENT"] ?? "Altair Test", ...headers },
    ...(body === undefined ? {} : { body }),
  });
}

/** Rails' `build_response`. */
export function buildResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, ...init });
}

/** Rails' `make_response!` — an empty response a test can fill in. */
export function makeResponse(): Response {
  return new Response(null, { status: 200 });
}

/** Rails' `rack_status_code`. */
export function rackStatusCode(response: Response): number {
  return response.status;
}

// --- reading a response ----------------------------------------------------

export class NotAnHtmlResponse extends Error {
  constructor(contentType: string | null) {
    super(
      `Cannot read this as HTML: it is ${contentType ?? "untyped"}. Parsing a JSON body as HTML ` +
        `would find no elements and the assertion would fail saying the element is missing, ` +
        `which sends the reader looking in the template.`,
    );
    this.name = "NotAnHtmlResponse";
  }
}

/**
 * Rails' `html_document`.
 *
 * Refuses a response that is not HTML rather than parsing it anyway. Parsing
 * JSON as HTML finds no elements, so the assertion fails saying the element is
 * missing — which sends the reader to the template instead of to the format.
 */
export function htmlDocument(response: { headers: Headers }, body: string): string {
  const contentType = response.headers.get("content-type");

  if (!contentType?.includes("html")) throw new NotAnHtmlResponse(contentType);

  return body;
}

/** Rails' `document_root_element` — the outermost tag, for an assertion to scope to. */
export function documentRootElement(html: string): string | undefined {
  return /<\s*([a-zA-Z][\w-]*)/.exec(html)?.[1]?.toLowerCase();
}

/**
 * Rails' `parsed_body`.
 *
 * Parsed according to what the response *says it is*, not guessed from the
 * text. A JSON body served as HTML is a bug worth failing on, and guessing
 * would hide it.
 */
export function parsedBody(contentType: string | null, body: string): unknown {
  if (contentType?.includes("json")) return JSON.parse(body);

  return body;
}

/** Rails' `assert_template` — which template a render used. */
export function assertTemplate(rendered: readonly string[], expected: string): void {
  if (!rendered.includes(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)} to have been rendered, but ` +
        `${rendered.length === 0 ? "nothing was" : `these were: ${rendered.join(", ")}`}.`,
    );
  }
}

/** A file a test uploads. Rails' `file_fixture_upload`. */
export interface UploadedFixture {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

/**
 * Rails' `file_fixture_upload`.
 *
 * Carries the content type explicitly rather than deriving it from the
 * extension, because the point of most upload tests is what the application
 * does with a *declared* type — including one that disagrees with the bytes,
 * which is the case worth testing.
 */
export function fileFixtureUpload(
  filename: string,
  bytes: Uint8Array,
  contentType = "application/octet-stream",
): UploadedFixture {
  return { filename, contentType, bytes };
}

// --- between requests ------------------------------------------------------

export interface HarnessState {
  flash: Record<string, unknown>;
  params: Record<string, unknown>;
  session: Record<string, unknown>;
  renderedViews: string[];
}

export function newHarnessState(): HarnessState {
  return { flash: {}, params: {}, session: {}, renderedViews: [] };
}

/**
 * Rails' `recycle!` — clears what must not survive into the next request.
 *
 * The flash, the parameters and the record of what rendered go; the session
 * stays, because a test signing in and then making a second request is the
 * normal case and clearing it would make every multi-request test re-sign-in.
 *
 * Both halves matter. Left uncleared, a flash from the first request makes a
 * "no flash" assertion pass for the wrong reason. Cleared too eagerly, a
 * signed-in test silently becomes a signed-out one and fails somewhere that
 * has nothing to do with the session.
 */
export function recycle(state: HarnessState): HarnessState {
  state.flash = {};
  state.params = {};
  state.renderedViews.length = 0;

  return state;
}

/** Rails' `rendered_views` for the last request. */
export function renderedViews(state: HarnessState): string[] {
  return [...state.renderedViews];
}

// --- what a failure prints -------------------------------------------------

/**
 * Rails' `debug_params` / `debug_headers` / `debug_hash`.
 *
 * Sorted, because a failure message that reordered between runs cannot be
 * diffed against the last one — and diffing two failures is how anybody works
 * out what changed.
 */
export function debugHash(hash: Record<string, unknown>): string {
  return Object.entries(hash)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`)
    .join("\n");
}

export function debugParams(state: HarnessState): string {
  return debugHash(state.params);
}

export function debugHeaders(headers: Headers): string {
  return debugHash(Object.fromEntries(headers.entries()));
}

/**
 * Rails' `filtered_env` — the environment with secrets removed.
 *
 * A failing controller test prints its environment, and an environment printed
 * in CI ends up in a log anybody with access to the build can read.
 */
export function filteredEnv(
  env: Record<string, string>,
  sensitive: readonly string[] = ["SECRET", "PASSWORD", "TOKEN", "KEY"],
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [
      key,
      sensitive.some((pattern) => key.toUpperCase().includes(pattern)) ? "[FILTERED]" : value,
    ]),
  );
}

/**
 * Rails' `filtered_location` — a redirect target with its query filtered.
 *
 * A redirect after sign-in has carried a token in the query more than once,
 * and the assertion message is exactly where it would be written down.
 */
export function filteredLocation(
  location: string,
  sensitive: readonly string[] = ["token", "secret", "key"],
): string {
  const [path, query] = location.split("?");

  if (!query) return location;

  const filtered = new URLSearchParams(query);

  // Collected first: `set` during iteration of a live `URLSearchParams` is not
  // defined to be safe the way deleting from a Map is.
  const keys = Array.from(filtered.keys());

  for (const key of keys) {
    if (sensitive.some((pattern) => key.toLowerCase().includes(pattern))) {
      filtered.set(key, "[FILTERED]");
    }
  }

  return `${path}?${filtered.toString()}`;
}
