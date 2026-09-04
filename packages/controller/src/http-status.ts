/**
 * HTTP status codes by name, ported from `Rack::Utils::SYMBOL_TO_STATUS_CODE`
 * and the way Rails lets a controller write `status: :unprocessable_entity`.
 *
 * The names exist because the numbers do not read. `422` and `409` are both
 * "the request was wrong somehow", and which one a reviewer thinks a line
 * means depends on whether they remember the table. `unprocessableEntity` and
 * `conflict` do not need remembering.
 */

/** Every status Rails names, under the camelCase spelling of its Rails symbol. */
export const STATUS_CODES = {
  continue: 100,
  switchingProtocols: 101,
  processing: 102,
  earlyHints: 103,

  ok: 200,
  created: 201,
  accepted: 202,
  nonAuthoritativeInformation: 203,
  noContent: 204,
  resetContent: 205,
  partialContent: 206,
  multiStatus: 207,
  alreadyReported: 208,
  imUsed: 226,

  multipleChoices: 300,
  movedPermanently: 301,
  found: 302,
  seeOther: 303,
  notModified: 304,
  useProxy: 305,
  temporaryRedirect: 307,
  permanentRedirect: 308,

  badRequest: 400,
  unauthorized: 401,
  paymentRequired: 402,
  forbidden: 403,
  notFound: 404,
  methodNotAllowed: 405,
  notAcceptable: 406,
  proxyAuthenticationRequired: 407,
  requestTimeout: 408,
  conflict: 409,
  gone: 410,
  lengthRequired: 411,
  preconditionFailed: 412,
  payloadTooLarge: 413,
  uriTooLong: 414,
  unsupportedMediaType: 415,
  rangeNotSatisfiable: 416,
  expectationFailed: 417,
  misdirectedRequest: 421,
  unprocessableEntity: 422,
  locked: 423,
  failedDependency: 424,
  tooEarly: 425,
  upgradeRequired: 426,
  preconditionRequired: 428,
  tooManyRequests: 429,
  requestHeaderFieldsTooLarge: 431,
  unavailableForLegalReasons: 451,

  internalServerError: 500,
  notImplemented: 501,
  badGateway: 502,
  serviceUnavailable: 503,
  gatewayTimeout: 504,
  httpVersionNotSupported: 505,
  variantAlsoNegotiates: 506,
  insufficientStorage: 507,
  loopDetected: 508,
  notExtended: 510,
  networkAuthenticationRequired: 511,
} as const;

export type StatusName = keyof typeof STATUS_CODES;

const MESSAGES: Record<number, string> = {
  100: "Continue",
  101: "Switching Protocols",
  102: "Processing",
  103: "Early Hints",
  200: "OK",
  201: "Created",
  202: "Accepted",
  203: "Non-Authoritative Information",
  204: "No Content",
  205: "Reset Content",
  206: "Partial Content",
  207: "Multi-Status",
  208: "Already Reported",
  226: "IM Used",
  300: "Multiple Choices",
  301: "Moved Permanently",
  302: "Found",
  303: "See Other",
  304: "Not Modified",
  305: "Use Proxy",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  407: "Proxy Authentication Required",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  411: "Length Required",
  412: "Precondition Failed",
  413: "Payload Too Large",
  414: "URI Too Long",
  415: "Unsupported Media Type",
  416: "Range Not Satisfiable",
  417: "Expectation Failed",
  421: "Misdirected Request",
  422: "Unprocessable Entity",
  423: "Locked",
  424: "Failed Dependency",
  425: "Too Early",
  426: "Upgrade Required",
  428: "Precondition Required",
  429: "Too Many Requests",
  431: "Request Header Fields Too Large",
  451: "Unavailable For Legal Reasons",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
  505: "HTTP Version Not Supported",
  506: "Variant Also Negotiates",
  507: "Insufficient Storage",
  508: "Loop Detected",
  510: "Not Extended",
  511: "Network Authentication Required",
};

/**
 * The number for a name, or the number itself if that is what was passed.
 * Rails' `Rack::Utils.status_code`.
 *
 * Both accepted, because a controller writing `status: 404` is not wrong and
 * forcing it to look up a name would be a worse API than the one it replaced.
 */
export function statusCode(status: StatusName | number): number {
  return typeof status === "number" ? status : STATUS_CODES[status];
}

/** The reason phrase for a status. Rails' `status_message`. */
export function statusMessage(status: StatusName | number): string {
  return MESSAGES[statusCode(status)] ?? "";
}

/** The name and the number together, as Rails writes it in a log. */
export function codeAndName(status: StatusName | number): string {
  const code = statusCode(status);

  return `${code} ${statusMessage(code)}`;
}

/** Whether a name is one this knows. */
export function statusRegistered(name: string): name is StatusName {
  return name in STATUS_CODES;
}

/** Every status name, for introspection and error messages. */
export function statusNames(): StatusName[] {
  return Object.keys(STATUS_CODES) as StatusName[];
}

/** 1xx. */
export function isInformational(status: StatusName | number): boolean {
  const code = statusCode(status);

  return code >= 100 && code < 200;
}

/** 2xx. */
export function isSuccessful(status: StatusName | number): boolean {
  const code = statusCode(status);

  return code >= 200 && code < 300;
}

/** 3xx. */
export function isRedirection(status: StatusName | number): boolean {
  const code = statusCode(status);

  return code >= 300 && code < 400;
}

/** 4xx. */
export function isClientError(status: StatusName | number): boolean {
  const code = statusCode(status);

  return code >= 400 && code < 500;
}

/** 5xx. */
export function isServerError(status: StatusName | number): boolean {
  const code = statusCode(status);

  return code >= 500 && code < 600;
}

/**
 * Statuses that must not carry a body. Rails' `NO_CONTENT_CODES`.
 *
 * Sending one anyway is not a cosmetic mistake: a 204 with bytes after it
 * desynchronises a keep-alive connection, because the client stops reading
 * where the spec says the response ended and takes the body as the start of
 * the next response.
 */
const BODYLESS = new Set([100, 101, 102, 103, 204, 205, 304]);

export function allowsBody(status: StatusName | number): boolean {
  return !BODYLESS.has(statusCode(status));
}
