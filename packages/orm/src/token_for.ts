/**
 * Signed tokens tied to a record's state, ported from Rails 7.1's
 * `generates_token_for`.
 *
 *     class User extends Model<UserRow>("users") {
 *       static {
 *         this.generatesTokenFor("passwordReset", { expiresIn: 15 * 60 }, (user) =>
 *           String(user.password_digest ?? "").slice(-10),
 *         )
 *       }
 *     }
 *
 *     const token = user.generateTokenFor("passwordReset")
 *     const found = await User.findByTokenFor("passwordReset", token)
 *
 * There is no column and no row: the token carries the id and is signed, so a
 * forged one is not merely wrong but unverifiable.
 *
 * The part that earns its keep is the third argument. Whatever it returns is
 * signed into the token and recomputed when the token is used, so a password
 * reset link stops working the moment the password changes. Without that a
 * reset link keeps working after the reset — and somebody who read the email
 * once keeps a way in, which is the failure the feature exists to prevent.
 */

import { KeyGenerator, MessageVerifier } from "@altair/support";

/** How a token is built for one purpose. */
export interface TokenDefinition {
  /** Seconds the token stays valid. Absent means it does not expire. */
  expiresIn?: number;
  /**
   * What the token is tied to. Anything that changes here invalidates every
   * token already issued for this purpose.
   */
  fingerprint?: (record: never) => unknown;
}

interface Payload {
  id: unknown;
  fingerprint: unknown;
  /** When it stops being valid, as epoch milliseconds. Null never expires. */
  expiresAt: number | null;
}

let verifier: MessageVerifier | undefined;

/** Derives the signing key from the application's secret. */
export function configureTokens(secretKeyBase: string): void {
  verifier = new MessageVerifier(new KeyGenerator(secretKeyBase).generate("active record tokens"));
}

export function resetTokens(): void {
  verifier = undefined;
}

function requireVerifier(): MessageVerifier {
  if (!verifier) {
    throw new Error(
      "Tokens need a signing key. An application configures one at boot; call configureTokens(secretKeyBase) if you are using the ORM on its own.",
    );
  }

  return verifier;
}

/**
 * The purpose a token is signed under.
 *
 * Namespaced, and part of the signature rather than the payload: a token for
 * one purpose cannot be presented for another, so a password reset link is not
 * also an email confirmation. Rails scopes them the same way, and it is the
 * difference between one leaked token and every token.
 */
function purposeFor(model: string, purpose: string): string {
  return `active_record/token_for/${model}/${purpose}`;
}

/** Signs a token for one record under one purpose. */
export function generateToken(
  model: string,
  purpose: string,
  definition: TokenDefinition,
  record: object,
  id: unknown,
): string {
  const payload: Payload = {
    id,
    fingerprint: definition.fingerprint
      ? ((definition.fingerprint as (value: object) => unknown)(record) ?? null)
      : null,
    // Carried in the signed payload rather than checked outside it, so the
    // expiry cannot be edited without breaking the signature.
    expiresAt: definition.expiresIn === undefined ? null : Date.now() + definition.expiresIn * 1000,
  };

  return requireVerifier().generate(payload, purposeFor(model, purpose));
}

/**
 * Reads a token back, or null.
 *
 * Null for every way it can fail — a bad signature, the wrong purpose, an
 * expired token, a missing record, a fingerprint that no longer matches. The
 * caller has one thing to check, and none of the answers tell an attacker
 * which of those it was.
 */
export function readToken(
  model: string,
  purpose: string,
  token: string,
): { id: unknown; fingerprint: unknown } | null {
  const payload = requireVerifier().verified<Payload>(token, purposeFor(model, purpose));

  if (payload === null || typeof payload !== "object") return null;

  // Read through `Date.now`, so a test that travels in time sees what the
  // application would see at that moment.
  if (payload.expiresAt !== null && Date.now() >= payload.expiresAt) return null;

  return { id: payload.id, fingerprint: payload.fingerprint };
}

/**
 * Whether a record still matches the token that named it.
 *
 * Compared as JSON so a fingerprint may be anything the signer returns and
 * still compares by value — an array of columns is the usual shape, and
 * comparing those by reference would never match.
 */
export function fingerprintMatches(
  definition: TokenDefinition,
  record: object,
  signed: unknown,
): boolean {
  if (!definition.fingerprint) return signed === null;

  const current = (definition.fingerprint as (value: object) => unknown)(record) ?? null;

  return JSON.stringify(current ?? null) === JSON.stringify(signed ?? null);
}
