/**
 * Knowing when a secret can be retired, ported from
 * `activesupport/test/message_verifier_test.rb` and
 * `activesupport/test/message_encryptor_test.rb` — the `on_rotation`,
 * `rotate_defaults` and `valid_message?` cases.
 *
 * `rotation.test.ts` covers that an older secret still reads. This is the other
 * half: rotating is only finished when the old secret is gone, and nothing tells
 * you it is safe to remove unless the read reports it.
 */

import { describe, expect, it } from "bun:test";
import {
  DEFAULT_CIPHER,
  MessageEncryptor,
  MessageVerifier,
  defaultCipher,
  expectedKeyLength,
  keyLen,
} from "../src/messages.js";

const NEW_SECRET = "new-secret-that-is-long-enough-for-hmac";
const OLD_SECRET = "old-secret-that-is-long-enough-for-hmac";

const key = (fill: string): Buffer => Buffer.alloc(keyLen(), fill);

describe("what a cipher needs", () => {
  it("is read out of the cipher's name", () => {
    expect(keyLen("aes-256-gcm")).toBe(32);
    expect(keyLen("aes-128-gcm")).toBe(16);
  });

  it("defaults to the cipher an encryptor uses", () => {
    expect(defaultCipher()).toBe(DEFAULT_CIPHER);
    expect(keyLen()).toBe(32);
  });

  /**
   * Guessing would derive a key of the wrong length, which fails at encryption
   * time — in a deploy, not in a test.
   */
  it("refuses a cipher it cannot read a length from", () => {
    expect(() => keyLen("chacha20-poly1305")).toThrow("Unknown cipher");
  });

  /** Twice, because a key file holds hex. */
  it("is twice that for a key file", () => {
    expect(expectedKeyLength()).toBe(64);
    expect(expectedKeyLength("aes-128-gcm")).toBe(32);
  });

  it("is what an encryptor checks its key against", () => {
    expect(() => new MessageEncryptor(Buffer.alloc(keyLen() - 1))).toThrow(DEFAULT_CIPHER);
  });
});

describe("a verifier told a message was read by an older secret", () => {
  /**
   * The only way to answer "is anything still using the old key". Without it
   * the old key is kept for ever — the same as not having rotated — or dropped
   * on a guess, and the guess signs some fraction of visitors out.
   */
  it("says so when the older secret answered", () => {
    let rotations = 0;
    const old = new MessageVerifier(OLD_SECRET);
    const current = new MessageVerifier(NEW_SECRET).rotate(OLD_SECRET).onRotation(() => {
      rotations += 1;
    });

    expect(current.verified<string>(old.generate("hello"))).toBe("hello");
    expect(rotations).toBe(1);
  });

  /** Otherwise the count is "how many messages were read", which answers nothing. */
  it("says nothing when the current secret answered", () => {
    let rotations = 0;
    const current = new MessageVerifier(NEW_SECRET).rotate(OLD_SECRET).onRotation(() => {
      rotations += 1;
    });

    expect(current.verified<string>(current.generate("hello"))).toBe("hello");
    expect(rotations).toBe(0);
  });

  it("says nothing when no secret could read it", () => {
    let rotations = 0;
    const current = new MessageVerifier(NEW_SECRET).rotate(OLD_SECRET).onRotation(() => {
      rotations += 1;
    });

    expect(current.verified<string>("nonsense.nonsense")).toBeNull();
    expect(rotations).toBe(0);
  });

  /**
   * Once per message read, not once per secret tried: a count that grew with
   * the number of rotations would say a busier fallback was a more used one.
   */
  it("says so once however many secrets were tried", () => {
    let rotations = 0;
    const oldest = new MessageVerifier("oldest-secret-long-enough-for-hmac-x");
    const current = new MessageVerifier(NEW_SECRET)
      .rotate(OLD_SECRET)
      .rotate("oldest-secret-long-enough-for-hmac-x")
      .onRotation(() => {
        rotations += 1;
      });

    expect(current.verified<string>(oldest.generate("hello"))).toBe("hello");
    expect(rotations).toBe(1);
  });
});

describe("an encryptor told a message was read by an older key", () => {
  it("says so when the older key answered", () => {
    let rotations = 0;
    const old = new MessageEncryptor(key("a"));
    const current = new MessageEncryptor(key("b")).rotate(key("a")).onRotation(() => {
      rotations += 1;
    });

    expect(current.decrypt<string>(old.encrypt("hello"))).toBe("hello");
    expect(rotations).toBe(1);
  });

  it("says nothing when the current key answered", () => {
    let rotations = 0;
    const current = new MessageEncryptor(key("b")).rotate(key("a")).onRotation(() => {
      rotations += 1;
    });

    expect(current.decrypt<string>(current.encrypt("hello"))).toBe("hello");
    expect(rotations).toBe(0);
  });

  it("says nothing when the message could not be read at all", () => {
    let rotations = 0;
    const current = new MessageEncryptor(key("b")).rotate(key("a")).onRotation(() => {
      rotations += 1;
    });

    expect(current.decrypt<string>("a.b.c")).toBeNull();
    expect(rotations).toBe(0);
  });
});

describe("a verifier that changed its digest", () => {
  /**
   * A secret and a digest usually change together — a new secret is generated
   * with the current defaults, and the old one is kept as it was applied. A
   * rotation that assumed the default digest would reject every message the old
   * secret signed, which is the whole failure rotation exists to avoid.
   */
  it("reads an older secret that used a different digest", () => {
    const before = new MessageVerifier(OLD_SECRET, "sha512");
    const after = new MessageVerifier(NEW_SECRET).rotate(OLD_SECRET, "sha512");

    expect(after.verified<string>(before.generate("hello"))).toBe("hello");
    expect(
      new MessageVerifier(NEW_SECRET).rotate(OLD_SECRET).verified<string>(before.generate("hello")),
    ).toBeNull();
  });

  /**
   * The messages already in browsers were signed with the default. Without
   * this, the day the digest changes is the day every session ends.
   */
  it("still reads what the default digest signed", () => {
    const before = new MessageVerifier(NEW_SECRET);
    const after = new MessageVerifier(NEW_SECRET, "sha512").rotateDefaults();

    expect(after.verified<string>(before.generate("hello"))).toBe("hello");
  });

  /** The secret did not change — only how it was applied. */
  it("signs new messages with the new digest", () => {
    const before = new MessageVerifier(NEW_SECRET);
    const after = new MessageVerifier(NEW_SECRET, "sha512").rotateDefaults();

    expect(before.verified<string>(after.generate("hello"))).toBeNull();
  });

  it("reports the rotation like any other", () => {
    let rotations = 0;
    const before = new MessageVerifier(NEW_SECRET);
    const after = new MessageVerifier(NEW_SECRET, "sha512").rotateDefaults().onRotation(() => {
      rotations += 1;
    });

    after.verified<string>(before.generate("hello"));

    expect(rotations).toBe(1);
  });

  /** Nothing to fall back to when the verifier is already on the default. */
  it("adds nothing when the digest is already the default", () => {
    let rotations = 0;
    const already = new MessageVerifier(NEW_SECRET).rotateDefaults().onRotation(() => {
      rotations += 1;
    });

    expect(already.verified<string>(already.generate("hello"))).toBe("hello");
    expect(rotations).toBe(0);
  });
});

describe("whether a message is ours at all", () => {
  /**
   * The signature alone. It separates "somebody is forging messages" from "this
   * link is three months old" in a log, which are the same rejection otherwise.
   */
  it("is true for an expired message we signed", () => {
    const verifier = new MessageVerifier(NEW_SECRET);
    const message = verifier.generate("hello", { expiresIn: -1 });

    expect(verifier.verified<string>(message)).toBeNull();
    expect(verifier.validMessage(message)).toBe(true);
  });

  it("is true for a message signed for another purpose", () => {
    const verifier = new MessageVerifier(NEW_SECRET);
    const message = verifier.generate("hello", "login");

    expect(verifier.verified<string>(message, "reset")).toBeNull();
    expect(verifier.validMessage(message)).toBe(true);
  });

  it("is false for a message signed with another secret", () => {
    const verifier = new MessageVerifier(NEW_SECRET);

    expect(verifier.validMessage(new MessageVerifier(OLD_SECRET).generate("hello"))).toBe(false);
  });

  it("is false for a tampered message", () => {
    const verifier = new MessageVerifier(NEW_SECRET);
    const [payload, signature] = verifier.generate("hello").split(".") as [string, string];

    expect(verifier.validMessage(`${payload}x.${signature}`)).toBe(false);
  });

  it("is false for nothing, and for a message of the wrong shape", () => {
    const verifier = new MessageVerifier(NEW_SECRET);

    expect(verifier.validMessage(null)).toBe(false);
    expect(verifier.validMessage("")).toBe(false);
    expect(verifier.validMessage("one-part")).toBe(false);
    expect(verifier.validMessage("a.b.c")).toBe(false);
  });
});

describe("the seam a rotation is defined against", () => {
  /**
   * One place writes and one place reads, which is what makes "a rotation only
   * ever reads" a fact about the code rather than a convention.
   */
  it("is what generating and verifying go through", () => {
    const verifier = new MessageVerifier(NEW_SECRET);

    expect(verifier.readMessage<string>(verifier.createMessage("hello"))).toBe("hello");
    expect(verifier.createMessage("hello")).toBe(verifier.generate("hello"));
  });

  it("is what encrypting and decrypting go through", () => {
    const encryptor = new MessageEncryptor(key("b"));

    expect(encryptor.readMessage<string>(encryptor.createMessage("hello"))).toBe("hello");
  });

  it("keeps the purpose and the expiry", () => {
    const verifier = new MessageVerifier(NEW_SECRET);

    expect(verifier.readMessage<string>(verifier.createMessage("hello", "login"), "login")).toBe(
      "hello",
    );
    expect(verifier.readMessage(verifier.createMessage("hello", "login"))).toBeNull();
    expect(verifier.readMessage(verifier.createMessage("hello", { expiresIn: -1 }))).toBeNull();
  });
});
