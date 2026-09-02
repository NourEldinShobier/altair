/**
 * Which status an exception means, ported from
 * `config.action_dispatch.rescue_responses`.
 *
 * Without this every exception is a 500, including the ones that are the
 * client's doing and not the server's. A scaffolded `show` for a row that is
 * not there answered 500 — so a crawler walking ids paged whoever was on call,
 * and a browser could not tell "you asked for something that is gone" from
 * "this application is broken".
 *
 * Matched on the error's `name` rather than by `instanceof`, as Rails matches
 * on the class name: an application can add its own without core having to
 * import it, and a class that arrives from a second copy of a package still
 * matches.
 */

export const RESCUE_RESPONSES: Readonly<Record<string, number>> = {
  // Asked for something that is not there.
  RecordNotFound: 404,
  RoutingError: 404,
  ActionNotFound: 404,

  // Sent something the application will not accept.
  ParameterMissing: 400,
  ParameterValidationError: 400,
  UnpermittedParameters: 400,
  BadRequest: 400,

  // Understood, and refused.
  InvalidAuthenticityToken: 422,
  RecordInvalid: 422,
  RecordNotSaved: 422,

  // Somebody else changed it first.
  StaleObjectError: 409,

  // Asked for a format or a method that is not on offer.
  UnknownFormat: 406,
  MethodNotAllowed: 405,
  UnsupportedMediaType: 415,
};

/**
 * The error underneath a wrapper. Rails' `unwrapped_exception`.
 *
 * A template that raises wraps what was raised, so the outer error names the
 * template and the inner one names the mistake. Classified by the wrapper,
 * every one of them is a 500 — including the `RecordNotFound` that a partial
 * raised, which is a 404 and was answered as a fault.
 *
 * The chain is walked to the first error that has a status, rather than to the
 * innermost: an application that deliberately wraps something in a
 * `BadRequest` means the `BadRequest`, and the driver error underneath is not
 * the answer.
 */
export function unwrappedException(
  error: unknown,
  overrides: Readonly<Record<string, number>> = {},
): unknown {
  let at = error;

  // Bounded rather than walked to the end. `cause` can be a cycle — an error
  // caught and rethrown with itself, or with something that already names it —
  // and a chain that long is a mistake either way: eight wrappers deep, the
  // exception at the bottom is not what the request should answer with.
  for (let depth = 0; depth < 8; depth += 1) {
    if (!(at instanceof Error)) return error;
    if (overrides[at.name] !== undefined || RESCUE_RESPONSES[at.name] !== undefined) return at;
    if (!(at.cause instanceof Error)) return error;

    at = at.cause;
  }

  return error;
}

/**
 * Whether an exception is one the framework has a status for. Rails'
 * `rescue_response?`.
 *
 * The question a development error page asks before deciding how much to show:
 * a classified exception is an expected outcome and gets its status, while an
 * unclassified one is a bug and gets the trace.
 */
export function rescueResponse(
  error: unknown,
  overrides: Readonly<Record<string, number>> = {},
): boolean {
  const unwrapped = unwrappedException(error, overrides);

  if (!(unwrapped instanceof Error)) return false;

  return overrides[unwrapped.name] !== undefined || RESCUE_RESPONSES[unwrapped.name] !== undefined;
}

/**
 * The message of the error itself, rather than of whatever wrapped it. Rails'
 * `original_message`.
 *
 * A wrapper's message names the template and the line; the useful half is
 * underneath it. Shown without unwrapping, an error page says a partial failed
 * and never says why.
 */
export function originalMessage(error: unknown): string {
  let at = error;

  for (let depth = 0; depth < 8; depth += 1) {
    if (!(at instanceof Error)) return String(at);
    if (!(at.cause instanceof Error)) return at.message;

    at = at.cause;
  }

  return error instanceof Error ? error.message : String(error);
}

/**
 * The status an error should answer with, or 500.
 *
 * 500 is the default on purpose: an exception nobody has classified is a bug
 * until somebody says otherwise, and reporting a bug as a 404 is how it stops
 * being noticed.
 */
export function statusForError(
  error: unknown,
  overrides: Readonly<Record<string, number>> = {},
): number {
  const unwrapped = unwrappedException(error, overrides);

  if (!(unwrapped instanceof Error)) return 500;

  return overrides[unwrapped.name] ?? RESCUE_RESPONSES[unwrapped.name] ?? 500;
}

/** The short name of a status, for an error body that has nothing else to say. */
const STATUS_TEXT: Readonly<Record<number, string>> = {
  400: "Bad Request",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  409: "Conflict",
  415: "Unsupported Media Type",
  422: "Unprocessable Entity",
  500: "Internal Server Error",
};

export function statusText(status: number): string {
  return STATUS_TEXT[status] ?? "Error";
}

/**
 * Whether the client asked for JSON.
 *
 * Both the header and the request's own content type, because a client that
 * `fetch`es an API with a JSON body and no `Accept` still cannot parse a
 * plain-text 404 — and answering one to `response.json()` is a parse error
 * rather than the 404 it actually got.
 */
export function wantsJson(request: Request): boolean {
  const accept = request.headers.get("accept") ?? "";

  if (accept.includes("application/json")) return true;
  // `*/*` is a browser or curl saying it has no preference, so it is not a
  // request for JSON — only an explicit one is.
  if (accept.includes("text/html")) return false;

  return (request.headers.get("content-type") ?? "").includes("application/json");
}
