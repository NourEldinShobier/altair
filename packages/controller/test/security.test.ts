/**
 * Cookies, sessions, flash and CSRF.
 *
 * Mirrors actionpack/test/dispatch/cookies_test.rb,
 * controller/request_forgery_protection_test.rb and the flash tests. This is
 * the security tier, so the tests assert the failure cases as hard as the
 * happy ones.
 */

import { describe, expect, it } from "bun:test";
import {
  InvalidSignature,
  KeyGenerator,
  MessageEncryptor,
  MessageVerifier,
  Secrets,
  secureToken,
} from "@altair/support";
import { Controller, beforeAction } from "../src/controller.js";
import { CookieJar, parseCookieHeader, serializeCookie } from "../src/cookies.js";
import { Session, Flash } from "../src/session.js";
import {
  CSRF_HEADER,
  CSRF_PARAM,
  InvalidAuthenticityToken,
  isSafeMethod,
  maskedToken,
  realToken,
  unmaskToken,
  verifyToken,
} from "../src/csrf.js";

const SECRET = "a".repeat(64);
const secrets = new Secrets(SECRET);

function request(init: RequestInit & { cookie?: string } = {}): Request {
  const { cookie, ...rest } = init;
  return new Request("http://test.host/posts", {
    ...rest,
    headers: { ...(cookie ? { cookie } : {}), ...rest.headers },
  });
}

function jarFor(cookie?: string): CookieJar {
  return new CookieJar(request({ cookie }), secrets);
}

function sessionFor(cookie?: string): Session {
  return new Session(jarFor(cookie));
}

describe("message verifier", () => {
  const verifier = new MessageVerifier("secret".repeat(6));

  it("round-trips a value", () => {
    expect(verifier.verified<{ id: number }>(verifier.generate({ id: 1 }))).toEqual({ id: 1 });
  });

  it("rejects a tampered payload", () => {
    const message = verifier.generate({ admin: false });
    const [payload, signature] = message.split(".");
    const forged = `${payload}x.${signature}`;

    expect(verifier.verified(forged)).toBeNull();
  });

  it("rejects a tampered signature", () => {
    const message = verifier.generate("value");
    expect(verifier.verified(`${message.split(".")[0]}.deadbeef`)).toBeNull();
  });

  it("rejects a message with no signature", () => {
    expect(verifier.verified("just-a-string")).toBeNull();
    expect(verifier.verified(null)).toBeNull();
    expect(verifier.verified("")).toBeNull();
  });

  // A token signed for one job must not be usable for another.
  it("binds a message to its purpose", () => {
    const message = verifier.generate("value", "login");

    expect(verifier.verified<string>(message, "login")).toBe("value");
    expect(verifier.verified(message, "password-reset")).toBeNull();
    expect(verifier.verified(message)).toBeNull();
  });

  it("rejects a message signed with another secret", () => {
    const other = new MessageVerifier("different".repeat(4));
    expect(verifier.verified(other.generate("value"))).toBeNull();
  });

  // The same collision applied to signatures, where the payload could end in
  // `-` and shift where the separator was found.
  it("verifies reliably across many random payloads", () => {
    for (let index = 0; index < 500; index += 1) {
      const value = secureToken(32);
      expect(verifier.verified<string>(verifier.generate(value))).toBe(value);
    }
  });

  it("throws from verify", () => {
    expect(() => verifier.verify("nope")).toThrow(InvalidSignature);
  });
});

describe("message encryptor", () => {
  const key = new KeyGenerator(SECRET).generate("test");
  const encryptor = new MessageEncryptor(key);

  it("round-trips a value", () => {
    expect(encryptor.decrypt<{ id: number }>(encryptor.encrypt({ id: 7 }))).toEqual({ id: 7 });
  });

  // The point of encrypting rather than signing: the client cannot read it.
  it("hides the plaintext", () => {
    expect(encryptor.encrypt({ role: "admin" })).not.toContain("admin");
  });

  // GCM authenticates, so tampering fails to decrypt rather than decrypting
  // into something else.
  it("rejects a tampered payload", () => {
    const message = encryptor.encrypt("value");
    const parts = message.split(".");
    parts[0] = `${parts[0]!.slice(0, -2)}AA`;

    expect(encryptor.decrypt(parts.join("."))).toBeNull();
  });

  it("rejects a wrong key", () => {
    const other = new MessageEncryptor(new KeyGenerator("other".repeat(10)).generate("test"));
    expect(other.decrypt(encryptor.encrypt("value"))).toBeNull();
  });

  it("binds to a purpose", () => {
    const message = encryptor.encrypt("value", "session");
    expect(encryptor.decrypt<string>(message, "session")).toBe("value");
    expect(encryptor.decrypt(message, "other")).toBeNull();
  });

  it("uses a fresh iv each time", () => {
    expect(encryptor.encrypt("same")).not.toBe(encryptor.encrypt("same"));
  });

  // Regression: with `--` as the separator, roughly one message in fifty
  // contained `--` inside its base64url payload and silently failed to
  // decrypt. This loop reproduced it within a few hundred iterations.
  it("round-trips reliably across many random payloads", () => {
    for (let index = 0; index < 500; index += 1) {
      const value = { token: secureToken(32), index };
      expect(encryptor.decrypt<typeof value>(encryptor.encrypt(value))).toEqual(value);
    }
  });

  it("refuses a key of the wrong size", () => {
    expect(() => new MessageEncryptor("short")).toThrow("32-byte key");
  });
});

describe("secrets", () => {
  it("derives different keys per purpose", () => {
    const signed = secrets.verifier("cookie").generate("v");
    expect(secrets.verifier("other").verified(signed)).toBeNull();
  });

  it("requires a long enough secret", () => {
    expect(() => new Secrets("short")).toThrow("at least 32");
  });

  it("produces random tokens", () => {
    expect(secureToken()).not.toBe(secureToken());
    expect(secureToken(16)).toHaveLength(22);
  });
});

describe("cookie parsing and serializing", () => {
  it("parses a header", () => {
    expect(parseCookieHeader("a=1; b=two; c=%20spaced")).toEqual({
      a: "1",
      b: "two",
      c: " spaced",
    });
  });

  it("survives a malformed header", () => {
    expect(parseCookieHeader("novalue; =empty; a=1")).toEqual({ a: "1" });
    expect(parseCookieHeader(null)).toEqual({});
  });

  // Defaults lean secure, because a permissive default costs a session.
  it("defaults to HttpOnly, Path and SameSite=Lax", () => {
    expect(serializeCookie({ name: "a", value: "1" })).toBe("a=1; Path=/; HttpOnly; SameSite=Lax");
  });

  it("writes every option", () => {
    const header = serializeCookie({
      name: "a",
      value: "1",
      path: "/admin",
      domain: "example.com",
      maxAge: 60,
      secure: true,
      sameSite: "strict",
    });

    expect(header).toContain("Path=/admin");
    expect(header).toContain("Domain=example.com");
    expect(header).toContain("Max-Age=60");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Strict");
  });

  it("can opt out of HttpOnly", () => {
    expect(serializeCookie({ name: "a", value: "1", httpOnly: false })).not.toContain("HttpOnly");
  });

  it("escapes the value", () => {
    expect(serializeCookie({ name: "a", value: "a b;c" })).toContain("a=a%20b%3Bc");
  });
});

describe("cookie jar", () => {
  it("reads incoming cookies", () => {
    expect(jarFor("session=abc").get("session")).toBe("abc");
  });

  it("reads back what it just set", () => {
    const jar = jarFor();
    jar.set("a", "1");
    expect(jar.get("a")).toBe("1");
    expect(jar.has("a")).toBe(true);
  });

  it("expires a deleted cookie", () => {
    const jar = jarFor("a=1");
    jar.delete("a");

    expect(jar.get("a")).toBeUndefined();
    expect(jar.toHeaders()[0]).toContain("Max-Age=0");
  });

  it("appends one Set-Cookie header per cookie", () => {
    const jar = jarFor();
    jar.set("a", "1");
    jar.set("b", "2");

    const response = jar.applyTo(new Response("ok"));
    expect(response.headers.getSetCookie()).toHaveLength(2);
  });

  it("leaves a response alone when nothing was set", () => {
    const response = new Response("ok");
    expect(jarFor().applyTo(response)).toBe(response);
  });
});

describe("signed and encrypted cookies", () => {
  it("round-trips a signed cookie", () => {
    const jar = jarFor();
    jar.signed.set("user_id", 7);

    const value = jar.toHeaders()[0]!.split("=")[1]!.split(";")[0]!;
    const next = jarFor(`user_id=${value}`);

    expect(next.signed.get<number>("user_id")).toBe(7);
  });

  // A signed cookie is readable — that is the difference from encrypted.
  it("leaves a signed value readable", () => {
    const jar = jarFor();
    jar.signed.set("plan", "pro");

    const cookie = decodeURIComponent(jar.toHeaders()[0]!.split("=")[1]!.split(";")[0]!);
    const payload = Buffer.from(cookie.split(".")[0]!, "base64url").toString("utf8");

    expect(payload).toContain("pro");
  });

  it("rejects a forged signed cookie", () => {
    expect(jarFor("user_id=999.deadbeef").signed.get("user_id")).toBeNull();
  });

  it("round-trips an encrypted cookie", () => {
    const jar = jarFor();
    jar.encrypted.set("secret", { role: "admin" });

    const value = jar.toHeaders()[0]!.split("=")[1]!.split(";")[0]!;
    const next = jarFor(`secret=${decodeURIComponent(value)}`);

    expect(next.encrypted.get<{ role: string }>("secret")).toEqual({ role: "admin" });
  });

  it("hides an encrypted value", () => {
    const jar = jarFor();
    jar.encrypted.set("secret", "admin");
    expect(jar.toHeaders()[0]).not.toContain("admin");
  });

  // The cookie name is the purpose, so a value cannot be moved between cookies.
  it("refuses a value lifted into another cookie", () => {
    const jar = jarFor();
    jar.signed.set("readonly_id", 1);
    const value = jar.toHeaders()[0]!.split("=")[1]!.split(";")[0]!;

    expect(jarFor(`admin_id=${value}`).signed.get("admin_id")).toBeNull();
  });

  it("needs secrets", () => {
    const jar = new CookieJar(request());
    expect(() => jar.signed.get("a")).toThrow("need secrets");
  });
});

describe("session", () => {
  it("starts empty", () => {
    expect(sessionFor().keys).toEqual([]);
  });

  it("round-trips through its cookie", () => {
    const jar = jarFor();
    const session = new Session(jar);
    session.set("user_id", 7);
    session.commit();

    const value = jar.toHeaders()[0]!.split("=")[1]!.split(";")[0]!;
    const next = new Session(jarFor(`_altair_session=${decodeURIComponent(value)}`));

    expect(next.get("user_id")).toBe(7);
  });

  it("writes nothing when unchanged", () => {
    const jar = jarFor();
    new Session(jar).commit();
    expect(jar.toHeaders()).toHaveLength(0);
  });

  it("tracks dirtiness", () => {
    const session = sessionFor();
    expect(session.isDirty).toBe(false);
    session.set("a", 1);
    expect(session.isDirty).toBe(true);
  });

  it("deletes a key", () => {
    const session = sessionFor();
    session.set("a", 1);
    session.delete("a");
    expect(session.has("a")).toBe(false);
  });

  // Rails' reset_session, called on sign-in to stop session fixation.
  it("resets", () => {
    const session = sessionFor();
    session.set("user_id", 1);
    session.reset();
    expect(session.keys).toEqual([]);
  });

  it("expires the cookie when destroyed", () => {
    const jar = jarFor();
    const session = new Session(jar);
    session.set("a", 1);
    session.destroy();
    session.commit();

    expect(jar.toHeaders()[0]).toContain("Max-Age=0");
  });
});

describe("flash", () => {
  it("is readable on the next request only", () => {
    const first = sessionFor();
    const flash = new Flash(first);
    flash.set("notice", "Saved");
    flash.commit();

    // Next request: the message is there.
    const second = new Session(jarFor());
    second.set("__flash", first.get("__flash"));
    const secondFlash = new Flash(second);
    expect(secondFlash.get("notice")).toBe("Saved");
    secondFlash.commit();

    // Request after that: swept.
    const third = new Session(jarFor());
    third.set("__flash", second.get("__flash"));
    expect(new Flash(third).get("notice")).toBeUndefined();
  });

  it("shows a now message this request without carrying it", () => {
    const session = sessionFor();
    const flash = new Flash(session);
    flash.now("alert", "Careful");

    expect(flash.get("alert")).toBe("Careful");
    flash.commit();
    expect(session.has("__flash")).toBe(false);
  });

  it("keeps a message for another request", () => {
    const session = sessionFor();
    session.set("__flash", { notice: "Saved" });

    const flash = new Flash(session);
    flash.keep();
    flash.commit();

    expect(session.get("__flash")).toEqual({ notice: "Saved" });
  });

  it("reports presence", () => {
    const session = sessionFor();
    session.set("__flash", { notice: "Saved" });
    expect(new Flash(session).has("notice")).toBe(true);
  });
});

describe("csrf", () => {
  it("treats read methods as safe", () => {
    expect(isSafeMethod("GET")).toBe(true);
    expect(isSafeMethod("head")).toBe(true);
    expect(isSafeMethod("OPTIONS")).toBe(true);
    expect(isSafeMethod("POST")).toBe(false);
    expect(isSafeMethod("DELETE")).toBe(false);
  });

  it("keeps one token per session", () => {
    const session = sessionFor();
    expect(realToken(session)).toBe(realToken(session));
  });

  // Without masking, a token repeated in a page is a BREACH oracle.
  it("masks differently every time", () => {
    const session = sessionFor();
    expect(maskedToken(session)).not.toBe(maskedToken(session));
  });

  it("unmasks back to the session token", () => {
    const session = sessionFor();
    const expected = Buffer.from(realToken(session), "base64url");

    expect(unmaskToken(maskedToken(session))).toEqual(expected);
  });

  it("verifies a masked token", () => {
    const session = sessionFor();
    expect(verifyToken(session, maskedToken(session))).toBe(true);
  });

  it("verifies an unmasked token", () => {
    const session = sessionFor();
    expect(verifyToken(session, realToken(session))).toBe(true);
  });

  it("rejects a token from another session", () => {
    expect(verifyToken(sessionFor(), maskedToken(sessionFor()))).toBe(false);
  });

  it("rejects nonsense", () => {
    const session = sessionFor();
    expect(verifyToken(session, "")).toBe(false);
    expect(verifyToken(session, null)).toBe(false);
    expect(verifyToken(session, "short")).toBe(false);
  });
});

describe("forgery protection in a controller", () => {
  class GuardedController extends Controller {
    @beforeAction
    protect(): void {
      this.verifyAuthenticityToken();
    }

    index(): void {
      this.render.json({ ok: true });
    }
    create(): void {
      this.render.json({ created: true });
    }
  }

  function controller(init: RequestInit & { cookie?: string } = {}) {
    return new GuardedController({ request: request(init), secrets });
  }

  it("lets a GET through", async () => {
    expect((await controller().processAction("index")).status).toBe(200);
  });

  it("blocks a POST with no token", async () => {
    await expect(controller({ method: "POST" }).processAction("create")).rejects.toThrow(
      InvalidAuthenticityToken,
    );
  });

  it("accepts a POST with the token in a header", async () => {
    const setup = controller();
    const token = setup.authenticityToken;

    // The token is only valid alongside the session it was issued to.
    const jar = new CookieJar(request(), secrets);
    const session = new Session(jar);
    session.set("_csrf_token", realToken(setup.session));
    session.commit();
    const cookie = jar.toHeaders()[0]!.split(";")[0]!;

    const response = await new GuardedController({
      request: request({ method: "POST", cookie, headers: { [CSRF_HEADER]: token } }),
      secrets,
    }).processAction("create");

    expect(response.status).toBe(200);
  });

  it("accepts a POST with the token as a parameter", async () => {
    const setup = controller();
    const token = setup.authenticityToken;

    const jar = new CookieJar(request(), secrets);
    const session = new Session(jar);
    session.set("_csrf_token", realToken(setup.session));
    session.commit();
    const cookie = jar.toHeaders()[0]!.split(";")[0]!;

    const response = await new GuardedController({
      request: request({ method: "POST", cookie }),
      params: { [CSRF_PARAM]: token },
      secrets,
    }).processAction("create");

    expect(response.status).toBe(200);
  });

  it("blocks a token from a different session", async () => {
    const stolen = controller().authenticityToken;

    await expect(
      controller({ method: "POST", headers: { [CSRF_HEADER]: stolen } }).processAction("create"),
    ).rejects.toThrow(InvalidAuthenticityToken);
  });
});
