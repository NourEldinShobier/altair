/**
 * SQL comments naming the code that issued the query, ported from
 * `ActiveRecord::QueryLogs`.
 *
 *     SELECT * FROM posts WHERE id = $1  <- plus a trailing comment naming
 *     the application, controller and action that issued it.
 *
 * The problem it solves belongs to whoever is looking at the database rather
 * than at the application. A slow-query log, `pg_stat_statements`, a lock graph
 * at three in the morning — all of them show the statement and none of them
 * show which line of which action produced it. On an application of any size
 * that is an afternoon of grepping for a `WHERE` clause.
 *
 * Off by default, because the comment defeats a prepared-statement cache keyed
 * on the statement text and because it makes every query a little longer. Rails
 * generates it enabled in development for the same trade.
 */

import { Current } from "@altair/support";

/** Something that names part of the context, or nothing when it does not apply. */
export type QueryLogTag = string | (() => string | undefined);

export interface QueryLogOptions {
  /**
   * The tags to write, in order.
   *
   * Strings name the built-ins; a function is the application's own. A tag that
   * answers undefined is left out rather than written empty, so a query from a
   * job does not carry `controller:`.
   */
  tags?: QueryLogTag[];
  /** The application's name, for the `application` tag. */
  application?: string;
}

/**
 * Read through a guard, because `Current` throws outside a scope.
 *
 * A query from a migration or a console has no request, and the diagnostics
 * must not be the thing that makes it fail.
 */
function fromCurrent(key: string): string | undefined {
  if (!Current.isActive) return undefined;

  const value = Current.get(key as never) as unknown;

  return typeof value === "string" && value.length > 0 ? value : undefined;
}

const BUILT_IN: Record<string, () => string | undefined> = {
  application: () => configured.application,
  controller: () => fromCurrent("controller"),
  action: () => fromCurrent("action"),
  request_id: () => fromCurrent("requestId"),
  job: () => fromCurrent("job"),
};

let enabled = false;
let configured: { tags: QueryLogTag[]; application?: string } = { tags: [] };

/**
 * Turns query comments on.
 *
 *     configureQueryLogs({ tags: ["application", "controller", "action"] })
 */
export function configureQueryLogs(options: QueryLogOptions = {}): void {
  configured = {
    tags: options.tags ?? ["application", "controller", "action", "request_id"],
    ...(options.application === undefined ? {} : { application: options.application }),
  };
  enabled = true;
}

/** Turns them off again, and forgets the tags. */
export function disableQueryLogs(): void {
  enabled = false;
  configured = { tags: [] };
}

export function queryLogsEnabled(): boolean {
  return enabled;
}

/**
 * A value with anything that could end a comment taken out.
 *
 * The tags come from a request — a controller name from a route, an id from a
 * header — so a value containing the comment terminator would end the comment
 * early and put the rest of it into the statement. That is SQL injection
 * through the diagnostics, which is a poor way to find out you had them on.
 */
function sanitize(value: string): string {
  return value.replaceAll("*/", "").replaceAll("/*", "").replaceAll("\n", " ").trim();
}

/** The comment for right now, or an empty string when there is nothing to say. */
export function queryLogComment(): string {
  if (!enabled) return "";

  const parts: string[] = [];

  for (const tag of configured.tags) {
    if (typeof tag === "function") {
      const value = tag();
      if (value) parts.push(sanitize(value));
      continue;
    }

    const resolve = BUILT_IN[tag];
    const value = resolve?.();

    // A tag nobody defined is a typo in the configuration, and writing it as
    // an empty pair would hide that. Left out, like any tag with no value.
    if (value) parts.push(`${sanitize(tag)}:${sanitize(value)}`);
  }

  return parts.length === 0 ? "" : ` /*${parts.join(",")}*/`;
}

/**
 * The statement with its comment.
 *
 * Appended rather than prepended: a leading comment confuses anything that
 * decides what a statement is by looking at its first word, and every database
 * this targets keeps a trailing comment in the text it logs.
 */
export function withQueryLog(sql: string): string {
  if (!enabled) return sql;

  // A statement that already carries one — from `annotate` — keeps it and gains
  // this one; they are answering different questions and both are wanted.
  return sql + queryLogComment();
}
