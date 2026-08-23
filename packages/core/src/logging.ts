/**
 * Request and query logging, ported from Rails' log subscribers.
 *
 * Rails prints two lines per request and a summary of what the database did
 * inside it:
 *
 *     Started GET "/posts" for 127.0.0.1
 *     Completed 200 OK in 15ms (ActiveRecord: 3.1ms | 4 queries)
 *
 * The second line is the useful one, and the parenthesis is the useful part of
 * it: a request that spent 3ms of its 15 in the database is a different
 * problem from one that spent 14, and no amount of staring at the total tells
 * you which you have.
 *
 * Everything hangs off the notifications bus the ORM already reports through,
 * so this adds no calls to any query path.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { logger as defaultLogger, notifications, type Event, type Logger } from "@altair/support";
import type { Middleware } from "@altair/controller";

interface QueryStats {
  count: number;
  duration: number;
}

const stats = new AsyncLocalStorage<QueryStats>();

/** What the database did during the current request, if anyone is counting. */
export function currentQueryStats(): QueryStats | undefined {
  return stats.getStore();
}

export interface QueryLogOptions {
  logger?: Logger;
  /** Only log queries slower than this. 0 logs them all. */
  slowerThan?: number;
}

/**
 * Logs every statement, and counts them for the request summary.
 *
 * Returns an unsubscribe, because a test that subscribes and never stops
 * leaks into every test after it.
 */
export function logQueries(options: QueryLogOptions = {}): { unsubscribe(): void } {
  const log = options.logger ?? defaultLogger;
  const threshold = options.slowerThan ?? 0;

  return notifications.subscribe<{ sql: string; bindings?: unknown[] }>(
    "sql.altair",
    (event: Event<{ sql: string; bindings?: unknown[] }>) => {
      const counted = stats.getStore();
      if (counted) {
        counted.count += 1;
        counted.duration += event.duration;
      }

      if (event.duration < threshold) return;

      // The statement, not the values. Bindings are the part most likely to be
      // somebody's email address or password reset token, and a log is copied
      // into places the database never goes.
      log.debug("sql", {
        sql: event.payload.sql,
        durationMs: round(event.duration),
        ...(event.error ? { failed: true } : {}),
      });
    },
  );
}

function round(milliseconds: number): number {
  return Math.round(milliseconds * 10) / 10;
}

export interface RequestLogOptions {
  logger?: Logger;
  /** Paths to say nothing about — a health check every second is noise. */
  ignore?: (path: string) => boolean;
}

/**
 * Logs one line per request, tagged so every line inside it is attributable.
 *
 * The tag is the point. A process interleaves a hundred requests, and a log
 * line that does not say which one it belongs to is nearly useless when
 * something has gone wrong.
 */
export function requestLogging(options: RequestLogOptions = {}): Middleware {
  const log = options.logger ?? defaultLogger;

  return async (request, next) => {
    const url = new URL(request.url);
    if (options.ignore?.(url.pathname)) return await next(request);

    const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
    const startedAt = performance.now();
    const counted: QueryStats = { count: 0, duration: 0 };

    return await stats.run(
      counted,
      async () =>
        await log.tagged({ requestId }, async () => {
          log.info("started", { method: request.method, path: url.pathname });

          try {
            const response = await next(request);

            // At error level for a 5xx. The dispatcher catches an exception
            // and turns it into a 500 before this ever sees it, so without
            // this a failed request is an info line and an operator grepping
            // for level=error finds nothing.
            log.log(response.status >= 500 ? "error" : "info", "completed", {
              method: request.method,
              path: url.pathname,
              status: response.status,
              durationMs: round(performance.now() - startedAt),
              queries: counted.count,
              queryMs: round(counted.duration),
            });

            return response;
          } catch (error) {
            // Logged here and re-thrown: the handler above decides what the
            // person sees, and this decides what the operator sees. Neither
            // should have to do the other's job.
            log.error("failed", {
              method: request.method,
              path: url.pathname,
              durationMs: round(performance.now() - startedAt),
              queries: counted.count,
              error,
            });

            throw error;
          }
        }),
    );
  };
}
