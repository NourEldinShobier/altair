/**
 * Changing a secret without signing everybody out, ported from
 * `activesupport/test/message_verifier_test.rb`.
 *
 * The reason this exists: a cookie signed with the old secret is still in
 * somebody's browser. A deploy that only knows the new one rejects it, and
 * every session ends at once — which looks like an outage and is one.
 */

import { describe, expect, it } from "bun:test";
import { MessageVerifier } from "../src/messages.js";

const OLD = "old-secret-".repeat(4);
const NEW = "new-secret-".repeat(4);
const OLDER = "older-secret-".repeat(3);

describe("a rotated secret", () => {
  it("still reads a message signed with the old one", () => {
    const signed = new MessageVerifier(OLD).generate({ user: 1 });

    const now = new MessageVerifier(NEW).rotate(OLD);

    expect(now.verified<{ user: number }>(signed)).toEqual({ user: 1 });
  });

  it("signs new messages with the new one", () => {
    const now = new MessageVerifier(NEW).rotate(OLD);
    const signed = now.generate({ user: 1 });

    // The old secret alone cannot read it, which is what makes the rotation a
    // rotation rather than two secrets that both work forever.
    expect(new MessageVerifier(OLD).verified(signed)).toBeNull();
    expect(new MessageVerifier(NEW).verified<{ user: number }>(signed)).toEqual({ user: 1 });
  });

  it("takes more than one older secret", () => {
    const signed = new MessageVerifier(OLDER).generate("x");
    const now = new MessageVerifier(NEW).rotate(OLD).rotate(OLDER);

    expect(now.verified<string>(signed)).toBe("x");
  });

  it("still refuses a secret it was never told about", () => {
    const signed = new MessageVerifier("a-secret-nobody-mentioned-here").generate("x");

    expect(new MessageVerifier(NEW).rotate(OLD).verified(signed)).toBeNull();
  });

  it("still refuses a tampered message", () => {
    const now = new MessageVerifier(NEW).rotate(OLD);
    const signed = now.generate("x");

    expect(now.verified(`${signed.slice(0, -4)}AAAA`)).toBeNull();
  });

  // A message signed for one purpose must not be accepted for another, and a
  // rotation must not be a way around that.
  it("keeps the purpose check across a rotation", () => {
    const signed = new MessageVerifier(OLD).generate("x", "login");
    const now = new MessageVerifier(NEW).rotate(OLD);

    expect(now.verified<string>(signed, "login")).toBe("x");
    expect(now.verified(signed, "password-reset")).toBeNull();
  });

  it("can forget them again", () => {
    const signed = new MessageVerifier(OLD).generate("x");
    const now = new MessageVerifier(NEW).rotate(OLD);

    expect(now.verified<string>(signed)).toBe("x");

    now.clearRotations();

    expect(now.verified(signed)).toBeNull();
  });
});
