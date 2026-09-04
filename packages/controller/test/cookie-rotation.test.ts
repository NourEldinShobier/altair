/**
 * Accepting cookies written with an older secret, ported from
 * `actionpack/test/dispatch/cookies_test.rb`'s rotation cases.
 *
 * What makes changing secret_key_base possible at all. Every signed and
 * encrypted cookie in every browser was written with the old one, so a deploy
 * that only knows the new secret signs every session out at once — which looks
 * to a user like being logged out for no reason, and to an operator like a
 * login storm.
 */

import { describe, expect, it } from "bun:test";
import { Secrets } from "@altair/support";
import { CookieJar } from "../src/cookies.js";

const OLD = new Secrets("o".repeat(64));
const NEW = new Secrets("n".repeat(64));
const STRANGER = new Secrets("s".repeat(64));

/** A jar holding whatever the given jar was about to send. */
function reread(from: CookieJar, secrets: Secrets, rotations: Secrets[] = []): CookieJar {
  const header = from
    .toHeaders()
    .map((one) => one.split(";")[0])
    .join("; ");

  return new CookieJar(
    new Request("https://app.test/", { headers: { cookie: header } }),
    secrets,
    rotations,
  );
}

function writtenWith(secrets: Secrets, kind: "signed" | "encrypted"): CookieJar {
  const jar = new CookieJar(new Request("https://app.test/"), secrets);

  jar[kind].set("session", { userId: 7 });

  return jar;
}

describe("signed cookies", () => {
  it("reads one written with the current secret", () => {
    const written = writtenWith(NEW, "signed");

    expect(reread(written, NEW).signed.get<{ userId: number }>("session")).toEqual({ userId: 7 });
  });

  /** Without a rotation this is the deploy that logs everybody out. */
  it("refuses one written with an older secret when nothing was rotated", () => {
    const written = writtenWith(OLD, "signed");

    expect(reread(written, NEW).signed.get("session")).toBeNull();
  });

  it("reads one written with an older secret once it is rotated", () => {
    const written = writtenWith(OLD, "signed");

    expect(reread(written, NEW, [OLD]).signed.get<{ userId: number }>("session")).toEqual({
      userId: 7,
    });
  });

  it("still reads one written with the current secret", () => {
    const written = writtenWith(NEW, "signed");

    expect(reread(written, NEW, [OLD]).signed.get<{ userId: number }>("session")).toEqual({
      userId: 7,
    });
  });

  it("refuses one written with a secret it has never known", () => {
    const written = writtenWith(STRANGER, "signed");

    expect(reread(written, NEW, [OLD]).signed.get("session")).toBeNull();
  });

  it("takes more than one older secret", () => {
    const written = writtenWith(STRANGER, "signed");

    expect(reread(written, NEW, [OLD, STRANGER]).signed.get<{ userId: number }>("session")).toEqual(
      { userId: 7 },
    );
  });

  /**
   * A rotation drains itself rather than needing a second deploy: every cookie
   * read under an old secret goes back out under the new one, so the old one
   * can be dropped once the longest lifetime has passed.
   */
  it("writes under the current secret whatever it read with", () => {
    const jar = reread(writtenWith(OLD, "signed"), NEW, [OLD]);

    jar.signed.set("session", jar.signed.get("session"));

    expect(reread(jar, NEW).signed.get<{ userId: number }>("session")).toEqual({ userId: 7 });
  });
});

describe("encrypted cookies", () => {
  it("reads one written with the current secret", () => {
    const written = writtenWith(NEW, "encrypted");

    expect(reread(written, NEW).encrypted.get<{ userId: number }>("session")).toEqual({
      userId: 7,
    });
  });

  it("refuses one written with an older secret when nothing was rotated", () => {
    const written = writtenWith(OLD, "encrypted");

    expect(reread(written, NEW).encrypted.get("session")).toBeNull();
  });

  it("reads one written with an older secret once it is rotated", () => {
    const written = writtenWith(OLD, "encrypted");

    expect(reread(written, NEW, [OLD]).encrypted.get<{ userId: number }>("session")).toEqual({
      userId: 7,
    });
  });

  it("refuses one written with a secret it has never known", () => {
    const written = writtenWith(STRANGER, "encrypted");

    expect(reread(written, NEW, [OLD]).encrypted.get("session")).toBeNull();
  });

  it("writes under the current secret", () => {
    const jar = reread(writtenWith(OLD, "encrypted"), NEW, [OLD]);

    jar.encrypted.set("session", jar.encrypted.get("session"));

    expect(reread(jar, NEW).encrypted.get<{ userId: number }>("session")).toEqual({ userId: 7 });
  });
});

describe("declaring a rotation", () => {
  it("can be added after the jar is built", () => {
    const written = writtenWith(OLD, "signed");
    const jar = reread(written, NEW);

    jar.rotate(OLD);

    expect(jar.signed.get<{ userId: number }>("session")).toEqual({ userId: 7 });
  });

  it("lists what it accepts", () => {
    const jar = new CookieJar(new Request("https://app.test/"), NEW, [OLD]);

    expect(jar.rotations).toHaveLength(1);
  });

  it("starts with none", () => {
    expect(new CookieJar(new Request("https://app.test/"), NEW).rotations).toHaveLength(0);
  });
});

describe("a jar with no secrets at all", () => {
  it("still refuses to read a signed cookie", () => {
    const jar = new CookieJar(
      new Request("https://app.test/", { headers: { cookie: "session=anything" } }),
    );

    expect(() => jar.signed.get("session")).toThrow("need secrets");
  });
});
