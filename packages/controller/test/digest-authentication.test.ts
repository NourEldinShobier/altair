/**
 * Digest authentication, ported from
 * `actionpack/test/controller/http_digest_authentication_test.rb`.
 */

import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  authParam,
  authScheme,
  authenticateOrRequestWithHttpDigest,
  authenticateWithHttpDigest,
  authenticationRequest,
  decodeCredentialsHeader,
  expectedResponse,
  ha1,
  hasBasicCredentials,
  hasDigestCredentials,
  nonce,
  opaque,
  validateDigestResponse,
  validateNonce,
} from "../src/digest-authentication.js";

const SECRET = "a-server-secret";
const REALM = "Example";
const PASSWORDS: Record<string, string> = { ada: "lovelace" };

function md5(value: string): string {
  return createHash("md5").update(value).digest("hex");
}

/** Builds the header a well-behaved client would send. */
function clientHeader(
  options: {
    username?: string;
    password?: string;
    method?: string;
    uri?: string;
    nonceValue?: string;
    qop?: boolean;
  } = {},
): string {
  const username = options.username ?? "ada";
  const password = options.password ?? "lovelace";
  const method = options.method ?? "GET";
  const uri = options.uri ?? "/secret";
  const nonceValue = options.nonceValue ?? nonce(SECRET);
  const cnonce = "0a4f113b";
  const nc = "00000001";

  const a1 = ha1(REALM, username, password);
  const a2 = md5(`${method}:${uri}`);

  const response =
    options.qop === false
      ? md5(`${a1}:${nonceValue}:${a2}`)
      : md5([a1, nonceValue, nc, cnonce, "auth", a2].join(":"));

  const parts = [
    `username="${username}"`,
    `realm="${REALM}"`,
    `nonce="${nonceValue}"`,
    `uri="${uri}"`,
    `response="${response}"`,
  ];

  if (options.qop !== false) parts.push(`qop=auth`, `nc=${nc}`, `cnonce="${cnonce}"`);

  return `Digest ${parts.join(", ")}`;
}

function request(header?: string, method = "GET"): Request {
  return new Request("https://example.com/secret", {
    method,
    headers: header ? { authorization: header } : {},
  });
}

describe("decodeCredentialsHeader", () => {
  it("takes the header apart", () => {
    const credentials = decodeCredentialsHeader('Digest username="ada", realm="Example"');

    expect(credentials?.username).toBe("ada");
    expect(credentials?.realm).toBe("Example");
  });

  /** qop=auth and qop="auth" both occur in the wild. */
  it("accepts bare and quoted values alike", () => {
    const credentials = decodeCredentialsHeader('Digest qop=auth, nc=00000001, cnonce="abc"');

    expect(credentials?.qop).toBe("auth");
    expect(credentials?.nc).toBe("00000001");
    expect(credentials?.cnonce).toBe("abc");
  });

  /** A query string with two parameters is enough to break a plain split. */
  it("keeps a comma inside a quoted value", () => {
    const credentials = decodeCredentialsHeader('Digest uri="/a?x=1,y=2", username="ada"');

    expect(credentials?.uri).toBe("/a?x=1,y=2");
    expect(credentials?.username).toBe("ada");
  });

  it("refuses a header of another scheme", () => {
    expect(decodeCredentialsHeader("Basic abc")).toBeNull();
  });

  it("refuses nothing at all", () => {
    expect(decodeCredentialsHeader(null)).toBeNull();
    expect(decodeCredentialsHeader("Digest")).toBeNull();
  });

  it("names the scheme and pulls one parameter", () => {
    expect(authScheme('Digest username="ada"')).toBe("digest");
    expect(authParam('Digest username="ada"', "username")).toBe("ada");
    expect(authParam('Digest username="ada"', "absent")).toBeUndefined();
  });

  it("reports which scheme a request carries", () => {
    expect(hasDigestCredentials(request(clientHeader()))).toBe(true);
    expect(hasBasicCredentials(request("Basic abc"))).toBe(true);
    expect(hasDigestCredentials(request("Basic abc"))).toBe(false);
  });
});

describe("nonces", () => {
  it("accepts one it issued", () => {
    expect(validateNonce(SECRET, nonce(SECRET))).toBe(true);
  });

  /** Unsigned, a client could mint its own and replay for ever. */
  it("refuses one signed with another secret", () => {
    expect(validateNonce(SECRET, nonce("a-different-secret"))).toBe(false);
  });

  it("refuses one that is not base64 at all", () => {
    expect(validateNonce(SECRET, "not-a-nonce")).toBe(false);
  });

  it("refuses a tampered one", () => {
    const tampered = Buffer.from("9999999999:deadbeef").toString("base64");

    expect(validateNonce(SECRET, tampered)).toBe(false);
  });

  /** Unexpired, a captured response stays good for ever. */
  it("refuses one that has expired", () => {
    const issued = Date.now();

    expect(validateNonce(SECRET, nonce(SECRET, issued), 300, issued + 301_000)).toBe(false);
    expect(validateNonce(SECRET, nonce(SECRET, issued), 300, issued + 299_000)).toBe(true);
  });

  it("has a stable opaque value", () => {
    expect(opaque(SECRET)).toBe(opaque(SECRET));
    expect(opaque(SECRET)).not.toBe(opaque("other"));
  });
});

describe("validateDigestResponse", () => {
  it("accepts a correct response", () => {
    expect(
      validateDigestResponse(
        request(clientHeader()),
        { realm: REALM, secret: SECRET },
        (name) => PASSWORDS[name],
      ),
    ).toBe(true);
  });

  it("accepts the qop-less form", () => {
    expect(
      validateDigestResponse(
        request(clientHeader({ qop: false })),
        { realm: REALM, secret: SECRET },
        (name) => PASSWORDS[name],
      ),
    ).toBe(true);
  });

  it("refuses a wrong password", () => {
    expect(
      validateDigestResponse(
        request(clientHeader({ password: "wrong" })),
        { realm: REALM, secret: SECRET },
        (name) => PASSWORDS[name],
      ),
    ).toBe(false);
  });

  it("refuses an unknown user", () => {
    expect(
      validateDigestResponse(
        request(clientHeader({ username: "eve" })),
        { realm: REALM, secret: SECRET },
        (name) => PASSWORDS[name],
      ),
    ).toBe(false);
  });

  /** The method is in the digest, so a captured GET cannot become a DELETE. */
  it("refuses a response computed for another method", () => {
    expect(
      validateDigestResponse(
        request(clientHeader({ method: "GET" }), "DELETE"),
        { realm: REALM, secret: SECRET },
        (name) => PASSWORDS[name],
      ),
    ).toBe(false);
  });

  it("refuses a response computed for another URI", () => {
    const header = clientHeader({ uri: "/other" }).replace('uri="/other"', 'uri="/secret"');

    expect(
      validateDigestResponse(
        request(header),
        { realm: REALM, secret: SECRET },
        (name) => PASSWORDS[name],
      ),
    ).toBe(false);
  });

  it("refuses a stale nonce", () => {
    const issued = Date.now() - 400_000;

    expect(
      validateDigestResponse(
        request(clientHeader({ nonceValue: nonce(SECRET, issued) })),
        { realm: REALM, secret: SECRET },
        (name) => PASSWORDS[name],
      ),
    ).toBe(false);
  });

  it("refuses a request with no credentials", () => {
    expect(
      validateDigestResponse(
        request(),
        { realm: REALM, secret: SECRET },
        (name) => PASSWORDS[name],
      ),
    ).toBe(false);
  });
});

describe("the challenge", () => {
  it("is a 401 naming the scheme and realm", () => {
    const response = authenticationRequest({ realm: REALM, secret: SECRET });
    const header = response.headers.get("www-authenticate") ?? "";

    expect(response.status).toBe(401);
    expect(header).toContain("Digest");
    expect(header).toContain(`realm="${REALM}"`);
    expect(header).toContain('qop="auth"');
  });

  /** A client that failed once must not keep retrying against the same nonce. */
  it("carries a fresh nonce each time", () => {
    const first = authenticationRequest({ realm: REALM, secret: SECRET }, 1_000_000);
    const second = authenticationRequest({ realm: REALM, secret: SECRET }, 2_000_000);

    expect(first.headers.get("www-authenticate")).not.toBe(second.headers.get("www-authenticate"));
  });

  /**
   * Null when authentic, so the caller writes `if (denied) return denied` —
   * the shape that makes the failure path impossible to forget.
   */
  it("answers null for an authentic request", () => {
    expect(
      authenticateOrRequestWithHttpDigest(
        request(clientHeader()),
        { realm: REALM, secret: SECRET },
        (name) => PASSWORDS[name],
      ),
    ).toBeNull();
  });

  it("answers a challenge for an unauthentic one", () => {
    const denied = authenticateOrRequestWithHttpDigest(
      request(),
      { realm: REALM, secret: SECRET },
      (name) => PASSWORDS[name],
    );

    expect(denied?.status).toBe(401);
  });

  it("exposes the bare check too", () => {
    expect(
      authenticateWithHttpDigest(
        request(clientHeader()),
        { realm: REALM, secret: SECRET },
        (name) => PASSWORDS[name],
      ),
    ).toBe(true);
  });
});

describe("expectedResponse", () => {
  it("is stable for the same inputs", () => {
    const credentials = decodeCredentialsHeader(clientHeader())!;

    expect(expectedResponse(credentials, "lovelace", "GET", REALM)).toBe(
      expectedResponse(credentials, "lovelace", "GET", REALM),
    );
  });

  it("changes with the password", () => {
    const credentials = decodeCredentialsHeader(clientHeader())!;

    expect(expectedResponse(credentials, "lovelace", "GET", REALM)).not.toBe(
      expectedResponse(credentials, "other", "GET", REALM),
    );
  });

  /** The realm is in ha1, so a digest cannot be replayed against another one. */
  it("changes with the realm", () => {
    expect(ha1("one", "ada", "lovelace")).not.toBe(ha1("two", "ada", "lovelace"));
  });
});
