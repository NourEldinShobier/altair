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
  if (!(error instanceof Error)) return 500;

  return overrides[error.name] ?? RESCUE_RESPONSES[error.name] ?? 500;
}
