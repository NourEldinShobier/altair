/**
 * HTTP authentication, ported from
 * `actionpack/test/controller/http_basic_authentication_test.rb` and
 * `http_token_authentication_test.rb`.
 *
 * The cases that matter are the malformed headers — a client that sends
 * rubbish should be refused, not crash the request — and the password with a
 * colon in it, which a naive split truncates.
 */

import { describe, expect, it } from "bun:test";
import {
  authenticateBasic,
  authenticateOrRequestWithHttpBasic,
  authenticateOrRequestWithHttpToken,
  authenticateWithHttpBasic,
  authenticateWithHttpToken,
  bearerToken,
  decodeCredentials,
  encodeCredentials,
  httpBasicAuthenticate,
  requestHttpBasicAuthentication,
} from "../src/http-authentication.js";

const withHeader = (value?: string) =>
  new Request("https://app.example/admin", value ? { headers: { authorization: value } } : {});

const basic = (name: string, password: string) => withHeader(encodeCredentials(name, password));

describe("reading a Basic header", () => {
  it("takes the name and the password apart", () => {
    expect(decodeCredentials(basic("ada", "s3cret"))).toEqual({ name: "ada", password: "s3cret" });
  });

  /**
   * Only the first colon separates them. A password may contain colons, and a
   * split on all of them quietly truncates it — so the person is refused with
   * the right password and no explanation.
   */
  it("keeps a colon that is part of the password", () => {
    expect(decodeCredentials(basic("ada", "a:b:c"))?.password).toBe("a:b:c");
  });

  it("answers nothing when there is no header", () => {
    expect(decodeCredentials(withHeader())).toBeNull();
  });

  it("answers nothing for another scheme", () => {
    expect(decodeCredentials(withHeader("Bearer abc"))).toBeNull();
  });

  // A malformed header is a failed attempt, not a crash.
  it("answers nothing for rubbish", () => {
    expect(decodeCredentials(withHeader("Basic not-base64!!"))).toBeNull();
    expect(decodeCredentials(withHeader("Basic"))).toBeNull();
    expect(decodeCredentials(withHeader(`Basic ${btoa("nocolon")}`))).toBeNull();
  });

  it("round-trips what it encodes", () => {
    expect(encodeCredentials("ada", "s3cret")).toBe(`Basic ${btoa("ada:s3cret")}`);
  });
});

describe("checking credentials", () => {
  it("hands them to the check", async () => {
    const seen = await authenticateWithHttpBasic(basic("ada", "s3cret"), (name, password) => [
      name,
      password,
    ]);

    expect(seen).toEqual(["ada", "s3cret"]);
  });

  // So a caller can tell "wrong password" from "did not try".
  it("answers null when nothing was sent", async () => {
    expect(await authenticateWithHttpBasic(withHeader(), () => true)).toBeNull();
  });

  it("accepts the right pair and refuses the rest", async () => {
    expect(await authenticateBasic(basic("ada", "s3cret"), "ada", "s3cret")).toBe(true);
    expect(await authenticateBasic(basic("ada", "wrong"), "ada", "s3cret")).toBe(false);
    expect(await authenticateBasic(basic("eve", "s3cret"), "ada", "s3cret")).toBe(false);
    expect(await authenticateBasic(withHeader(), "ada", "s3cret")).toBe(false);
  });
});

describe("the challenge", () => {
  it("is a 401 that names the realm", async () => {
    const response = requestHttpBasicAuthentication("Admin");

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Basic realm="Admin", charset="UTF-8"');
  });

  /**
   * A realm containing a quote would end the header and start something else,
   * so the quotes come out rather than being escaped — there is nowhere for a
   * quote to go in a realm anybody would want.
   */
  it("cannot be broken by a realm with a quote in it", () => {
    const header = requestHttpBasicAuthentication('Ad"min').headers.get("www-authenticate");

    expect(header).toBe('Basic realm="Admin", charset="UTF-8"');
  });

  it("is what comes back when the check fails", async () => {
    const answer = await authenticateOrRequestWithHttpBasic(withHeader(), "Admin", () => true);

    expect((answer as Response).status).toBe(401);
  });

  it("is not what comes back when it succeeds", async () => {
    const answer = await authenticateOrRequestWithHttpBasic(
      basic("ada", "s3cret"),
      "Admin",
      (name) => name,
    );

    expect(answer).toBe("ada");
  });
});

describe("bearer tokens", () => {
  it("reads one", () => {
    expect(bearerToken(withHeader("Bearer abc123"))).toBe("abc123");
  });

  it("is not confused by Basic", () => {
    expect(bearerToken(basic("ada", "x"))).toBeNull();
    expect(bearerToken(withHeader())).toBeNull();
  });

  it("hands it to the check", async () => {
    expect(await authenticateWithHttpToken(withHeader("Bearer abc"), (token) => token)).toBe("abc");
  });

  it("challenges when there is none", async () => {
    const answer = await authenticateOrRequestWithHttpToken(withHeader(), "API", () => true);

    expect((answer as Response).status).toBe(401);
    expect((answer as Response).headers.get("www-authenticate")).toContain("Bearer");
  });
});

/**
 * For a staging site or an internal tool, which is what it is for and the only
 * thing it is good enough for: one name and password for everybody, and no way
 * to know who did anything.
 */
describe("guarding a whole application", () => {
  const ok = async () => new Response("secret");

  it("lets the right credentials through", async () => {
    const guard = httpBasicAuthenticate("ada", "s3cret");

    expect((await guard(basic("ada", "s3cret"), ok)).status).toBe(200);
  });

  it("refuses everything else", async () => {
    const guard = httpBasicAuthenticate("ada", "s3cret");

    expect((await guard(basic("ada", "wrong"), ok)).status).toBe(401);
    expect((await guard(withHeader(), ok)).status).toBe(401);
  });

  // A health check has nothing to authenticate with, and a load balancer that
  // gets a 401 takes the application out of rotation.
  it("leaves out what it is told to", async () => {
    const guard = httpBasicAuthenticate("ada", "s3cret", { exclude: (path) => path === "/up" });
    const health = new Request("https://app.example/up");

    expect((await guard(health, ok)).status).toBe(200);
  });
});
