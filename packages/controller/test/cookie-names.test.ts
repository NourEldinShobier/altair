/**
 * Cookie names and attributes that would write a different cookie.
 *
 * Mirrors the ground actionpack/test/dispatch/cookies_test.rb covers around
 * malformed names.
 *
 * The value was never the problem — it is percent-encoded, so a `;` in it
 * stays a `;` in it. The name is interpolated straight into the header, and a
 * name of `sess=stolen; x` sets a cookie called `sess`: any cookie, the
 * session included, from a call that looks like it writes something harmless.
 */

import { describe, expect, it } from "bun:test";
import { Secrets } from "@altair/support";
import { CookieJar, UnsafeCookie, serializeCookie } from "../src/index.js";

const request = new Request("https://app.example/");
const jar = () => new CookieJar(request, new Secrets("x".repeat(64)));

const headerFor = (name: string, value = "v") => {
  const cookies = jar();
  cookies.set(name, value);
  return cookies.toHeaders()[0] as string;
};

describe("a cookie name", () => {
  it("is written when it is an ordinary token", () => {
    expect(headerFor("session")).toStartWith("session=v");
    expect(headerFor("_altair_session")).toStartWith("_altair_session=v");
    expect(headerFor("a.b-c")).toStartWith("a.b-c=v");
  });

  // The one that gets through everything else: no line break, so the Headers
  // API is happy, and a whole extra cookie all the same.
  it("cannot smuggle a second cookie", () => {
    expect(() => headerFor("sess=stolen; x")).toThrow(UnsafeCookie);
  });

  it("cannot contain a separator", () => {
    for (const name of [";", "=", ",", " ", "a b", "a;b", "a=b", 'a"b', "a@b", "a/b"]) {
      expect(() => headerFor(name)).toThrow(UnsafeCookie);
    }
  });

  it("cannot contain a line break or a control character", () => {
    for (const name of ["a\r\nSet-Cookie: evil=1", "a\nb", "a\u0000b"]) {
      expect(() => headerFor(name)).toThrow(UnsafeCookie);
    }
  });

  it("cannot be empty", () => {
    expect(() => headerFor("")).toThrow(UnsafeCookie);
  });

  // Failing at `set` rather than at the flush means the stack names the code
  // that built the name, which is the code with the bug.
  it("is refused where it is written, not where it is sent", () => {
    expect(() => jar().set("a;b", "v")).toThrow(UnsafeCookie);
  });

  it("is refused at the chokepoint too, however it got there", () => {
    expect(() => serializeCookie({ name: "a;b", value: "v" } as never)).toThrow(UnsafeCookie);
  });
});

// Interpolated the same way the name is, one attribute further along.
describe("a cookie attribute", () => {
  it("cannot break out of the path", () => {
    expect(() => jar().set("ok", "v", { path: "/; Domain=evil.example" })).toThrow(UnsafeCookie);
  });

  it("cannot break out of the domain", () => {
    expect(() => jar().set("ok", "v", { domain: "app.example; Secure" })).toThrow(UnsafeCookie);
  });

  it("leaves an ordinary path and domain alone", () => {
    const cookies = jar();
    cookies.set("ok", "v", { path: "/admin", domain: "app.example" });

    expect(cookies.toHeaders()[0]).toContain("Path=/admin");
    expect(cookies.toHeaders()[0]).toContain("Domain=app.example");
  });
});

// The half that was already right, kept honest.
describe("a cookie value", () => {
  it("is encoded rather than refused", () => {
    expect(headerFor("ok", "a; HttpOnly")).toContain("ok=a%3B%20HttpOnly");
  });

  it("survives a round trip through the encoding", () => {
    const cookies = jar();
    cookies.set("ok", "a; b=c");

    const header = cookies.toHeaders()[0] as string;
    const raw = header.slice(header.indexOf("=") + 1, header.indexOf(";"));

    expect(decodeURIComponent(raw)).toBe("a; b=c");
  });
});
