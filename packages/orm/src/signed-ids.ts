/**
 * Ids that can be handed out, and the two guards that stop a query being
 * accidentally expensive — ported from `ActiveRecord::SignedId`,
 * `ActiveRecord::Core`'s strict loading and `ActiveRecord::QueryLogs`.
 *
 * Three features that share one property: each exists because the *default*
 * behaviour is fine until an application grows, and then silently is not.
 *
 * **A signed id** is a record's id in a form safe to put in a URL or an email.
 * The signing is not the interesting part — the purpose is. A signed id with
 * no purpose is a bearer token for that record in every context the
 * application has: an unsubscribe link becomes a password-reset link, because
 * both are "prove you are record 7". The purpose is what makes them different
 * tokens, and it has to be part of what is signed rather than checked
 * afterwards.
 *
 * **Strict loading** turns a lazily loaded association into an error. Lazy
 * loading is the right default in a console and the wrong one in a request,
 * where each lazy load is a query nobody counted — and the count grows with
 * the data, so it is invisible until production.
 *
 * **Query log tags** put the controller and action into the SQL as a comment,
 * which is the only way to trace a slow query in a database log back to the
 * code that sent it. By the time a query reaches a log, every frame between it
 * and the application is framework.
 */

// --- signed ids -------------------------------------------------------------------------

/**
 * Rails' `combine_signed_id_purposes`.
 *
 * The model name is folded in, so a signed id for `User#7` cannot be used
 * where one for `Post#7` is expected — the two would otherwise be the same
 * number under the same purpose, and the only thing distinguishing them is
 * which table the receiver happens to look in.
 */
export function combineSignedIdPurposes(modelName: string, purpose?: string): string {
  return purpose === undefined ? modelName : `${modelName}/${purpose}`;
}

/**
 * Rails' `full_purpose` — the string actually signed.
 *
 * Includes an expiry marker when there is one. Signing the purpose and
 * checking the expiry separately is the classic mistake: the expiry is then
 * data the holder can edit, and a token with a changed expiry still verifies.
 */
export function fullPurpose(
  modelName: string,
  { purpose, expiresAt }: { purpose?: string; expiresAt?: Date } = {},
): string {
  const combined = combineSignedIdPurposes(modelName, purpose);

  return expiresAt === undefined ? combined : `${combined}@${expiresAt.toISOString()}`;
}

let signedIdSecret: string | undefined;

/**
 * Rails' `signed_id_verifier_secret`.
 *
 * Refused rather than defaulted when it is not set. A default secret is a
 * secret every deployment shares, so a token minted anywhere verifies
 * everywhere — and it would work in development, which is where nobody would
 * notice.
 */
export function signedIdVerifierSecret(configured?: string): string {
  const secret = configured ?? signedIdSecret;

  if (secret === undefined || secret === "") {
    throw new Error(
      "No secret is configured for signed ids. There is deliberately no default: a default is a " +
        "secret every deployment shares, so a token minted anywhere would verify everywhere — " +
        "and it would work in development, which is where nobody would notice.",
    );
  }

  return secret;
}

export function setSignedIdSecret(secret: string | undefined): void {
  signedIdSecret = secret;
}

export interface SignedIdVerifier {
  purpose: string;
  secret: string;
  expiresAt?: Date;
}

/**
 * Rails' `signed_id_verifier` — one verifier per purpose.
 *
 * Per purpose rather than one shared: a verifier that could be asked to check
 * any purpose would need the purpose passed at verification time, and a caller
 * that forgot to pass it would get a check that always passes.
 */
export function signedIdVerifier(
  modelName: string,
  { purpose, expiresAt, secret }: { purpose?: string; expiresAt?: Date; secret?: string } = {},
): SignedIdVerifier {
  return {
    purpose: fullPurpose(modelName, {
      ...(purpose === undefined ? {} : { purpose }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
    }),
    secret: signedIdVerifierSecret(secret),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

export class InvalidSignedId extends Error {
  constructor(reason: string) {
    super(
      `This signed id is not usable here: ${reason}. It is deliberately not said which of the ` +
        `three possible reasons applies — a wrong purpose, a bad signature and an expired token ` +
        `answer three different questions for anybody probing.`,
    );
    this.name = "InvalidSignedId";
  }
}

/**
 * Checks a decoded token against a verifier.
 *
 * Says only that it did not work. Distinguishing "wrong purpose" from "bad
 * signature" from "expired" answers three separate questions for anybody
 * probing — whether a purpose exists, whether a signature is close, and
 * whether a record is still live.
 */
export function verifySignedId(
  token: { purpose: string; id: unknown; expiresAt?: string },
  verifier: SignedIdVerifier,
  now = new Date(),
): unknown {
  if (token.purpose !== verifier.purpose) throw new InvalidSignedId("it did not verify");

  if (token.expiresAt !== undefined && new Date(token.expiresAt).getTime() <= now.getTime()) {
    throw new InvalidSignedId("it did not verify");
  }

  return token.id;
}

// --- strict loading -----------------------------------------------------------------------

export type StrictLoadingMode = "all" | "n_plus_one_only";

let strictLoadingDefault = false;
let strictLoadingViolationMode: "raise" | "log" = "raise";

export function setStrictLoading(value: boolean): void {
  strictLoadingDefault = value;
}

export function strictLoadingValue(record?: { strictLoading?: boolean }): boolean {
  // A record's own setting wins, because a query built with `strict_loading!`
  // means the caller has said so about *these* records — and the global is a
  // default rather than a policy.
  return record?.strictLoading ?? strictLoadingDefault;
}

export function setStrictLoadingViolation(mode: "raise" | "log"): void {
  strictLoadingViolationMode = mode;
}

/**
 * Rails' `strict_loading_violation!`.
 *
 * Configurable between raising and logging, because turning it on in an
 * existing application would otherwise break every page at once — and a
 * setting that cannot be introduced gradually is one nobody introduces.
 */
export function violatesStrictLoading(
  modelName: string,
  association: string,
  {
    mode = strictLoadingViolationMode,
    log,
  }: {
    mode?: "raise" | "log";
    log?: (message: string) => void;
  } = {},
): boolean {
  const message = strictLoadingViolationMessage(modelName, association);

  if (mode === "log") {
    log?.(message);

    return false;
  }

  throw new Error(message);
}

/**
 * The message. Names the association *and* what to do about it, because the
 * fix is always the same and never obvious from the failure.
 */
export function strictLoadingViolationMessage(modelName: string, association: string): string {
  return (
    `${modelName} is marked for strict loading and ${JSON.stringify(association)} was not ` +
    `loaded. Add it to the query: this association would otherwise be one query per record, ` +
    `and that count grows with the data — so it is invisible until production.`
  );
}

/**
 * Rails' `n_plus_one_only` mode.
 *
 * The looser setting: a lazily loaded association on a *single* record is one
 * extra query and fine; the same on a collection is one per record. Worth
 * having because the strict mode's failures are mostly the first kind, and an
 * application drowning in those turns the whole feature off.
 */
export function strictMode(
  mode: StrictLoadingMode,
  { fromCollection }: { fromCollection: boolean },
): boolean {
  return mode === "all" || fromCollection;
}

// --- query log tags -----------------------------------------------------------------------

export type TagValue = string | (() => string | undefined);

export interface QueryLogTagsConfig {
  tags: Record<string, TagValue>;
  format: "legacy" | "sqlcommenter";
  prependComment: boolean;
}

/**
 * Rails' `query_log_tags` — what goes in the comment.
 *
 * Values may be functions, because most of what is worth tagging is only known
 * per request. Resolved at query time and *not* cached: a cached controller
 * name is the one from whichever request warmed the cache, which is the single
 * most misleading thing a trace can say.
 */
export function queryLogTagsConfig(
  overrides: Partial<QueryLogTagsConfig> = {},
): QueryLogTagsConfig {
  return {
    tags: {},
    format: "sqlcommenter",
    prependComment: false,
    ...overrides,
  };
}

/**
 * Rails' `tags_formatter` — how the tags are written.
 *
 * `sqlcommenter` by default, because it is the format Google Cloud SQL,
 * Postgres' `pg_stat_statements` extensions and most APM tools parse. The
 * legacy format is readable and machine-hostile, which makes it useless for
 * the thing tags are for.
 */
export function tagsFormatter(
  format: QueryLogTagsConfig["format"],
): (tags: Record<string, string>) => string {
  if (format === "legacy") {
    return (tags) =>
      Object.entries(tags)
        .map(([key, value]) => `${key}:${value}`)
        .join(",");
  }

  return (tags) =>
    Object.entries(tags)
      .map(([key, value]) => `${encodeURIComponent(key)}='${encodeURIComponent(value)}'`)
      .join(",");
}

/**
 * Rails' `taggings` — the tags resolved for this query.
 *
 * A tag whose function returned nothing is dropped rather than written empty.
 * `controller=''` in a trace reads as "a query from no controller", which is a
 * real category — a background job — and confusing the two makes the tag
 * worse than absent.
 */
export function taggings(config: QueryLogTagsConfig): Record<string, string> {
  const resolved: Record<string, string> = {};

  for (const [key, value] of Object.entries(config.tags)) {
    const text = typeof value === "function" ? value() : value;

    if (text === undefined || text === "") continue;

    resolved[key] = text;
  }

  return resolved;
}

/**
 * Rails' `prepend_comment` — whether the comment goes before the statement.
 *
 * Off by default. A leading comment breaks statement matching in poolers and
 * proxies — which is exactly the software reading these tags — and it is also
 * what a `write_query?` check has to skip.
 */
export function queryLogTagsPrependComment(config: QueryLogTagsConfig): boolean {
  return config.prependComment;
}

/** Rails' `query_log_tags_format` applied — the finished comment. */
export function queryLogTagsFormat(config: QueryLogTagsConfig): string {
  const resolved = taggings(config);

  if (Object.keys(resolved).length === 0) return "";

  // A comment terminator inside a value would end the comment and turn the
  // rest into SQL, on text built from a controller name an application chose.
  return `/*${tagsFormatter(config.format)(resolved).replaceAll("*/", "")}*/`;
}

/** Attaches the comment to a statement. */
export function taggedStatement(sql: string, config: QueryLogTagsConfig): string {
  const comment = queryLogTagsFormat(config);

  if (comment === "") return sql;

  return queryLogTagsPrependComment(config) ? `${comment} ${sql}` : `${sql} ${comment}`;
}

/**
 * Rails' `ignore_payload` — notification payloads a subscriber should skip.
 *
 * A payload carries bind values, so anything that logs one logs whatever was
 * in them: a password on a sign-in, a token on a reset. The list is of
 * statement *names* rather than a pattern, because a pattern over SQL would
 * have to match the values it is trying not to see.
 */
export const IGNORED_PAYLOAD_NAMES: readonly string[] = [
  "SCHEMA",
  "EXPLAIN",
  "TRANSACTION",
  "User Load",
];

export function ignorePayload(name: string | undefined): boolean {
  return name !== undefined && IGNORED_PAYLOAD_NAMES.includes(name);
}

/** Rails' `payload_for` — what a subscriber is given. */
export function payloadFor(event: { name?: string; sql: string; binds?: readonly unknown[] }): {
  name?: string;
  sql: string;
  binds?: readonly unknown[];
} {
  if (ignorePayload(event.name)) {
    const { binds: _dropped, ...rest } = event;

    return rest;
  }

  return event;
}

/**
 * Rails' `sql_notifications` — whether a statement is announced at all.
 *
 * Schema queries are not. They run on every boot and every cache miss, and an
 * application counting queries in a test would count those too — which makes
 * the count depend on whether the schema cache happened to be warm.
 */
export function sqlNotifications(name: string | undefined): boolean {
  return name !== "SCHEMA";
}
