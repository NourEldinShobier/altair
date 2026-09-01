/**
 * Signed ids, strict loading and query log tags, ported from
 * `activerecord/test/cases/signed_id_test.rb`,
 * `activerecord/test/cases/strict_loading_test.rb` and
 * `activerecord/test/cases/query_logs_test.rb`.
 *
 * Each of these exists because the default is fine until an application grows
 * and then silently is not, so the cases are mostly about the growing.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  IGNORED_PAYLOAD_NAMES,
  InvalidSignedId,
  combineSignedIdPurposes,
  fullPurpose,
  ignorePayload,
  payloadFor,
  queryLogTagsConfig,
  queryLogTagsFormat,
  queryLogTagsPrependComment,
  setSignedIdSecret,
  setStrictLoading,
  setStrictLoadingViolation,
  signedIdVerifier,
  signedIdVerifierSecret,
  sqlNotifications,
  strictLoadingValue,
  strictLoadingViolationMessage,
  strictMode,
  taggedStatement,
  taggings,
  tagsFormatter,
  verifySignedId,
  violatesStrictLoading,
} from "../src/signed_ids.js";

// Captured at import, before any hook can have set it: the default is what
// this asserts about, and an afterEach that resets it would mask a wrong one.
const STRICT_LOADING_AT_IMPORT = strictLoadingValue();

afterEach(() => {
  setSignedIdSecret(undefined);
  setStrictLoading(false);
  setStrictLoadingViolation("raise");
});

describe("what a signed id is signed against", () => {
  /**
   * Without the purpose, an unsubscribe link becomes a password-reset link —
   * both are "prove you are record 7".
   */
  it("folds in the purpose", () => {
    expect(combineSignedIdPurposes("User", "password_reset")).toBe("User/password_reset");
    expect(combineSignedIdPurposes("User")).toBe("User");
  });

  /**
   * Otherwise `User#7` and `Post#7` are the same number under the same
   * purpose, and the only thing distinguishing them is which table the
   * receiver happens to look in.
   */
  it("folds in the model", () => {
    expect(combineSignedIdPurposes("User", "x")).not.toBe(combineSignedIdPurposes("Post", "x"));
  });

  /**
   * Signing the purpose and checking the expiry separately makes the expiry
   * data the holder can edit — a token with a changed expiry still verifies.
   */
  it("signs the expiry rather than checking it separately", () => {
    const at = new Date("2026-01-01T00:00:00Z");

    expect(fullPurpose("User", { purpose: "reset", expiresAt: at })).toBe(
      "User/reset@2026-01-01T00:00:00.000Z",
    );
    expect(fullPurpose("User", { purpose: "reset" })).toBe("User/reset");
  });
});

describe("the secret", () => {
  /**
   * A default is a secret every deployment shares, so a token minted anywhere
   * verifies everywhere — and it would work in development, where nobody
   * would notice.
   */
  it("has no default", () => {
    expect(() => signedIdVerifierSecret()).toThrow("nobody would notice");
    expect(() => signedIdVerifierSecret("")).toThrow();
  });

  it("takes one that was configured", () => {
    setSignedIdSecret("from-config");

    expect(signedIdVerifierSecret()).toBe("from-config");
    expect(signedIdVerifierSecret("explicit")).toBe("explicit");
  });
});

describe("verifying a signed id", () => {
  const verifier = () => signedIdVerifier("User", { purpose: "reset", secret: "s" });

  it("hands back the id when everything matches", () => {
    expect(verifySignedId({ purpose: "User/reset", id: 7 }, verifier())).toBe(7);
  });

  it("refuses a token for another purpose", () => {
    expect(() => verifySignedId({ purpose: "User/unsubscribe", id: 7 }, verifier())).toThrow(
      InvalidSignedId,
    );
  });

  it("refuses a token for another model", () => {
    expect(() => verifySignedId({ purpose: "Post/reset", id: 7 }, verifier())).toThrow(
      InvalidSignedId,
    );
  });

  it("refuses an expired token", () => {
    const token = { purpose: "User/reset", id: 7, expiresAt: "2020-01-01T00:00:00.000Z" };

    expect(() => verifySignedId(token, verifier())).toThrow(InvalidSignedId);
  });

  it("accepts one that has not expired", () => {
    const token = { purpose: "User/reset", id: 7, expiresAt: "2099-01-01T00:00:00.000Z" };

    expect(verifySignedId(token, verifier())).toBe(7);
  });

  /**
   * A wrong purpose, a bad signature and an expired token answer three
   * different questions for anybody probing — whether a purpose exists,
   * whether a signature is close, and whether a record is still live.
   */
  it("says only that it did not work", () => {
    let wrongPurpose = "";
    let expired = "";

    try {
      verifySignedId({ purpose: "User/other", id: 7 }, verifier());
    } catch (error) {
      wrongPurpose = (error as Error).message;
    }

    try {
      verifySignedId(
        { purpose: "User/reset", id: 7, expiresAt: "2020-01-01T00:00:00Z" },
        verifier(),
      );
    } catch (error) {
      expired = (error as Error).message;
    }

    expect(wrongPurpose).toBe(expired);
  });

  it("builds a verifier per purpose", () => {
    expect(signedIdVerifier("User", { purpose: "a", secret: "s" }).purpose).toBe("User/a");
    expect(signedIdVerifier("User", { purpose: "b", secret: "s" }).purpose).toBe("User/b");
  });
});

describe("strict loading", () => {
  it("is off by default", () => {
    expect(STRICT_LOADING_AT_IMPORT).toBe(false);
  });

  /**
   * A query built with `strict_loading!` has said so about *these* records,
   * and the global is a default rather than a policy.
   */
  it("lets a record's own setting win", () => {
    setStrictLoading(true);

    expect(strictLoadingValue()).toBe(true);
    expect(strictLoadingValue({ strictLoading: false })).toBe(false);
  });

  /**
   * The fix is always the same and never obvious from the failure, so the
   * message says it.
   */
  it("names the association and what to do", () => {
    const message = strictLoadingViolationMessage("Post", "comments");

    expect(message).toContain("comments");
    expect(message).toContain("Add it to the query");
    expect(message).toContain("invisible until production");
  });

  it("raises by default", () => {
    expect(() => violatesStrictLoading("Post", "comments")).toThrow("comments");
  });

  /**
   * Turning it on in an existing application would otherwise break every page
   * at once — and a setting that cannot be introduced gradually is one nobody
   * introduces.
   */
  it("can log instead", () => {
    const logged: string[] = [];

    expect(
      violatesStrictLoading("Post", "comments", { mode: "log", log: (m) => logged.push(m) }),
    ).toBe(false);
    expect(logged).toHaveLength(1);
  });

  it("takes the mode from configuration too", () => {
    setStrictLoadingViolation("log");

    expect(violatesStrictLoading("Post", "comments")).toBe(false);
  });

  /**
   * A lazily loaded association on a single record is one extra query and
   * fine; the same on a collection is one per record. An application drowning
   * in the first kind turns the whole feature off.
   */
  it("has a looser mode for the single-record case", () => {
    expect(strictMode("n_plus_one_only", { fromCollection: false })).toBe(false);
    expect(strictMode("n_plus_one_only", { fromCollection: true })).toBe(true);
    expect(strictMode("all", { fromCollection: false })).toBe(true);
  });
});

describe("query log tags", () => {
  /**
   * A cached controller name is the one from whichever request warmed the
   * cache, which is the single most misleading thing a trace can say.
   */
  it("resolves a function tag at query time", () => {
    let current = "posts";
    const config = queryLogTagsConfig({ tags: { controller: () => current } });

    expect(taggings(config)).toEqual({ controller: "posts" });

    current = "comments";

    expect(taggings(config)).toEqual({ controller: "comments" });
  });

  /**
   * `controller=''` reads as "a query from no controller", which is a real
   * category — a background job — so confusing the two makes the tag worse
   * than absent.
   */
  it("drops a tag that resolved to nothing", () => {
    const config = queryLogTagsConfig({
      tags: { controller: () => undefined, action: () => "", app: "blog" },
    });

    expect(taggings(config)).toEqual({ app: "blog" });
  });

  /**
   * sqlcommenter is what Cloud SQL, pg_stat_statements extensions and most APM
   * tools parse; the legacy format is readable and machine-hostile.
   */
  it("writes sqlcommenter by default", () => {
    expect(tagsFormatter("sqlcommenter")({ controller: "posts" })).toBe("controller='posts'");
    expect(tagsFormatter("legacy")({ controller: "posts" })).toBe("controller:posts");
  });

  it("escapes a value that would break the format", () => {
    expect(tagsFormatter("sqlcommenter")({ a: "b c" })).toContain("b%20c");
  });

  /**
   * A leading comment breaks statement matching in poolers and proxies — which
   * is exactly the software reading these tags.
   */
  it("appends rather than prepending by default", () => {
    const config = queryLogTagsConfig({ tags: { app: "blog" } });

    expect(queryLogTagsPrependComment(config)).toBe(false);
    expect(taggedStatement("SELECT 1", config)).toBe("SELECT 1 /*app='blog'*/");
  });

  it("prepends when asked", () => {
    const config = queryLogTagsConfig({ tags: { app: "blog" }, prependComment: true });

    expect(taggedStatement("SELECT 1", config)).toBe("/*app='blog'*/ SELECT 1");
  });

  it("adds nothing when every tag resolved to nothing", () => {
    const config = queryLogTagsConfig({ tags: { controller: () => undefined } });

    expect(queryLogTagsFormat(config)).toBe("");
    expect(taggedStatement("SELECT 1", config)).toBe("SELECT 1");
  });

  /**
   * A terminator inside a value would end the comment and turn the rest into
   * SQL, on text built from a name the application chose.
   */
  it("strips a comment terminator from a value", () => {
    // The legacy format, where it matters: sqlcommenter percent-encodes the
    // slash, so a terminator cannot survive it — the legacy one writes the
    // value as it is.
    const config = queryLogTagsConfig({
      format: "legacy",
      tags: { app: "a*/ DROP TABLE posts --" },
    });

    expect(taggedStatement("SELECT 1", config)).not.toContain("*/ DROP");
  });
});

describe("what a notification carries", () => {
  /**
   * A payload carries bind values, so anything logging one logs whatever was
   * in them — a password on a sign-in, a token on a reset.
   */
  it("drops the binds for a statement on the list", () => {
    expect(payloadFor({ name: "User Load", sql: "SELECT 1", binds: ["secret"] })).toEqual({
      name: "User Load",
      sql: "SELECT 1",
    });
  });

  it("keeps them for anything else", () => {
    expect(payloadFor({ name: "Post Load", sql: "SELECT 1", binds: [1] }).binds).toEqual([1]);
  });

  it("names what it drops them for", () => {
    expect(ignorePayload("SCHEMA")).toBe(true);
    expect(ignorePayload("Post Load")).toBe(false);
    expect(ignorePayload(undefined)).toBe(false);
    expect(IGNORED_PAYLOAD_NAMES).toContain("TRANSACTION");
  });

  /**
   * Schema queries run on every boot and cache miss, so counting them makes a
   * test's query count depend on whether the cache happened to be warm.
   */
  it("does not announce a schema query at all", () => {
    expect(sqlNotifications("SCHEMA")).toBe(false);
    expect(sqlNotifications("Post Load")).toBe(true);
    expect(sqlNotifications(undefined)).toBe(true);
  });
});
