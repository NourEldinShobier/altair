/**
 * Message expiry and encryptor key rotation, ported from
 * `activesupport/test/message_verifier_test.rb` and
 * `activesupport/test/message_encryptor_test.rb` — the `expires_in`,
 * `expires_at` and `rotate` cases.
 *
 * A signature says who made a message and says nothing about when. Without an
 * expiry, a token that turns up in a log, a referrer header, or somebody's
 * browser history stays valid for as long as the secret does — which is
 * normally the life of the application.
 */

import { describe, expect, it } from "bun:test";
import { KeyGenerator, MessageEncryptor, MessageVerifier } from "../src/messages.js";
import { travel } from "../src/time-travel.js";

/** What `messages.ts` joins a payload to its signature with. */
const SEPARATOR = ".";

const SECRET = "a".repeat(64);
const OTHER_SECRET = "b".repeat(64);

function keyFor(seed: string): Buffer {
  return Buffer.from(new KeyGenerator(seed).generate("test"));
}

describe("a verified message that expires", () => {
  it("verifies before it runs out", () => {
    const verifier = new MessageVerifier(SECRET);
    const message = verifier.generate({ id: 1 }, { expiresIn: 60_000 });

    expect(verifier.verified<{ id: number }>(message)).toEqual({ id: 1 });
  });

  it("stops verifying after it runs out", async () => {
    const verifier = new MessageVerifier(SECRET);
    const message = verifier.generate({ id: 1 }, { expiresIn: 60_000 });

    await travel(61, () => {
      expect(verifier.verified(message)).toBeNull();
    });
  });

  it("takes a moment rather than a duration", async () => {
    const verifier = new MessageVerifier(SECRET);
    const message = verifier.generate({ id: 1 }, { expiresAt: new Date(Date.now() + 60_000) });

    expect(verifier.verified<{ id: number }>(message)).toEqual({ id: 1 });

    await travel(61, () => {
      expect(verifier.verified(message)).toBeNull();
    });
  });

  it("prefers the moment when given both", async () => {
    const verifier = new MessageVerifier(SECRET);
    const message = verifier.generate(
      { id: 1 },
      { expiresIn: 60_000, expiresAt: new Date(Date.now() + 1000) },
    );

    await travel(2, () => {
      expect(verifier.verified(message)).toBeNull();
    });
  });

  it("carries a purpose alongside an expiry", () => {
    const verifier = new MessageVerifier(SECRET);
    const message = verifier.generate({ id: 1 }, { purpose: "reset", expiresIn: 60_000 });

    expect(verifier.verified<{ id: number }>(message, "reset")).toEqual({ id: 1 });
    expect(verifier.verified(message, "login")).toBeNull();
  });

  it("throws from verify once it has run out", async () => {
    const verifier = new MessageVerifier(SECRET);
    const message = verifier.generate({ id: 1 }, { expiresIn: 60_000 });

    await travel(61, () => {
      expect(() => verifier.verify(message)).toThrow();
    });
  });

  /** A message with no expiry must not read as one that expired at the epoch. */
  it("leaves a message with no expiry alone", async () => {
    const verifier = new MessageVerifier(SECRET);
    const message = verifier.generate({ id: 1 });

    await travel(60 * 60 * 24 * 365, () => {
      expect(verifier.verified<{ id: number }>(message)).toEqual({ id: 1 });
    });
  });

  it("still takes a bare purpose, which is what most callers pass", () => {
    const verifier = new MessageVerifier(SECRET);

    expect(
      verifier.verified<{ id: number }>(verifier.generate({ id: 1 }, "reset"), "reset"),
    ).toEqual({ id: 1 });
  });

  /** Expiry is inside the signed payload, so it cannot be edited in transit. */
  it("cannot have its expiry moved without breaking the signature", () => {
    const verifier = new MessageVerifier(SECRET);
    const message = verifier.generate({ id: 1 }, { expiresIn: 60_000 });
    const [payload, signature] = message.split(SEPARATOR) as [string, string];

    const envelope = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      exp: number;
    };
    envelope.exp = Date.now() + 1000 * 60 * 60 * 24;

    const forged = `${Buffer.from(JSON.stringify(envelope)).toString("base64url")}${SEPARATOR}${signature}`;

    expect(verifier.verified(forged)).toBeNull();
  });
});

describe("an encrypted message that expires", () => {
  it("decrypts before it runs out", () => {
    const encryptor = new MessageEncryptor(keyFor(SECRET));
    const message = encryptor.encrypt({ id: 1 }, { expiresIn: 60_000 });

    expect(encryptor.decrypt<{ id: number }>(message)).toEqual({ id: 1 });
  });

  it("stops decrypting after it runs out", async () => {
    const encryptor = new MessageEncryptor(keyFor(SECRET));
    const message = encryptor.encrypt({ id: 1 }, { expiresIn: 60_000 });

    await travel(61, () => {
      expect(encryptor.decrypt(message)).toBeNull();
    });
  });

  it("takes a moment", async () => {
    const encryptor = new MessageEncryptor(keyFor(SECRET));
    const message = encryptor.encrypt({ id: 1 }, { expiresAt: new Date(Date.now() + 1000) });

    await travel(2, () => {
      expect(encryptor.decrypt(message)).toBeNull();
    });
  });

  it("leaves a message with no expiry alone", async () => {
    const encryptor = new MessageEncryptor(keyFor(SECRET));
    const message = encryptor.encrypt({ id: 1 });

    await travel(60 * 60 * 24 * 365, () => {
      expect(encryptor.decrypt<{ id: number }>(message)).toEqual({ id: 1 });
    });
  });

  it("still takes a bare purpose", () => {
    const encryptor = new MessageEncryptor(keyFor(SECRET));
    const message = encryptor.encrypt({ id: 1 }, "reset");

    expect(encryptor.decrypt<{ id: number }>(message, "reset")).toEqual({ id: 1 });
    expect(encryptor.decrypt(message, "login")).toBeNull();
  });
});

describe("rotating an encryptor's key", () => {
  /**
   * What makes changing a key possible at all. An encrypted cookie written
   * with the old key is still in somebody's browser, and a deploy that only
   * knows the new one signs everybody out.
   */
  it("reads a message written with the old key", () => {
    const old = new MessageEncryptor(keyFor(OTHER_SECRET));
    const message = old.encrypt({ id: 1 });

    const current = new MessageEncryptor(keyFor(SECRET)).rotate(keyFor(OTHER_SECRET));

    expect(current.decrypt<{ id: number }>(message)).toEqual({ id: 1 });
  });

  it("writes with the new key", () => {
    const current = new MessageEncryptor(keyFor(SECRET)).rotate(keyFor(OTHER_SECRET));
    const message = current.encrypt({ id: 1 });

    expect(new MessageEncryptor(keyFor(SECRET)).decrypt<{ id: number }>(message)).toEqual({
      id: 1,
    });
    expect(new MessageEncryptor(keyFor(OTHER_SECRET)).decrypt(message)).toBeNull();
  });

  it("reads a message written with the new key too", () => {
    const current = new MessageEncryptor(keyFor(SECRET)).rotate(keyFor(OTHER_SECRET));

    expect(current.decrypt<{ id: number }>(current.encrypt({ id: 1 }))).toEqual({ id: 1 });
  });

  it("refuses a message written with a key it has never known", () => {
    const stranger = new MessageEncryptor(keyFor("c".repeat(64)));
    const current = new MessageEncryptor(keyFor(SECRET)).rotate(keyFor(OTHER_SECRET));

    expect(current.decrypt(stranger.encrypt({ id: 1 }))).toBeNull();
  });

  it("takes more than one older key", () => {
    const oldest = new MessageEncryptor(keyFor("c".repeat(64)));
    const current = new MessageEncryptor(keyFor(SECRET))
      .rotate(keyFor(OTHER_SECRET))
      .rotate(keyFor("c".repeat(64)));

    expect(current.decrypt<{ id: number }>(oldest.encrypt({ id: 1 }))).toEqual({ id: 1 });
  });

  it("still honours the purpose across a rotation", () => {
    const old = new MessageEncryptor(keyFor(OTHER_SECRET));
    const message = old.encrypt({ id: 1 }, "reset");
    const current = new MessageEncryptor(keyFor(SECRET)).rotate(keyFor(OTHER_SECRET));

    expect(current.decrypt<{ id: number }>(message, "reset")).toEqual({ id: 1 });
    expect(current.decrypt(message, "login")).toBeNull();
  });

  /** An expired message stays expired however many keys can read it. */
  it("still honours an expiry across a rotation", async () => {
    const old = new MessageEncryptor(keyFor(OTHER_SECRET));
    const message = old.encrypt({ id: 1 }, { expiresIn: 60_000 });
    const current = new MessageEncryptor(keyFor(SECRET)).rotate(keyFor(OTHER_SECRET));

    await travel(61, () => {
      expect(current.decrypt(message)).toBeNull();
    });
  });

  it("forgets its older keys when told to", () => {
    const old = new MessageEncryptor(keyFor(OTHER_SECRET));
    const message = old.encrypt({ id: 1 });
    const current = new MessageEncryptor(keyFor(SECRET)).rotate(keyFor(OTHER_SECRET));

    current.clearRotations();

    expect(current.decrypt(message)).toBeNull();
  });
});
