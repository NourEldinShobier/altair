/**
 * The health check, ported from Rails 7.1's `Rails::HealthController`.
 *
 *     app.use(healthCheck())            // answers /up
 *
 * What it is for is narrower than it looks, and Rails is deliberate about it:
 * the check answers "did this process boot and can it serve a request", and
 * **not** "is the database up".
 *
 * That restraint is the whole design. A load balancer takes an instance out of
 * rotation when its health check fails, so a check that touches the database
 * takes *every* instance out the moment the database has a bad second — and
 * removing all the servers is a much worse outage than the blip that caused
 * it. The same is true of a cache, a queue, or anything else shared: a
 * dependency they all share turns a per-instance check into a global switch.
 *
 * Checks can be added for the cases where an instance genuinely cannot serve
 * without one, and they are opt-in for the reason above rather than by
 * oversight.
 */

export interface HealthCheck {
  /** Returns true when this part is working. Anything thrown counts as false. */
  (): boolean | Promise<boolean>;
}

export interface HealthCheckOptions {
  path?: string;
  /**
   * Extra checks, by name. Add one only when an instance failing it genuinely
   * cannot serve — see above.
   */
  checks?: Record<string, HealthCheck>;
  /** How long a check may take before it counts as failed. */
  timeout?: number;
}

async function settle(check: HealthCheck, timeout: number): Promise<boolean> {
  try {
    // A check that hangs is a check that fails. Without a timeout, a health
    // endpoint waiting on a wedged connection stops answering at all, and a
    // load balancer reads no answer the same way it reads a failure — after
    // waiting out its own, much longer, timeout.
    return await Promise.race([
      Promise.resolve(check()),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeout)),
    ]);
  } catch {
    return false;
  }
}

/**
 * Answers the health path.
 *
 * A failure names which check failed but nothing about why. The endpoint is
 * usually reachable from outside, and "connection refused to
 * 10.0.1.7:5432" is a description of the internal network.
 */
export function healthCheck(options: HealthCheckOptions = {}) {
  const path = options.path ?? "/up";
  const checks = options.checks ?? {};
  const timeout = options.timeout ?? 2000;

  return async (request: Request, next: (request: Request) => Response | Promise<Response>) => {
    if (new URL(request.url).pathname !== path) return await next(request);

    const names = Object.keys(checks);
    const results = await Promise.all(
      names.map(
        async (name) => [name, await settle(checks[name] as HealthCheck, timeout)] as const,
      ),
    );

    const failed = results.filter(([, ok]) => !ok).map(([name]) => name);

    return Response.json(
      {
        status: failed.length === 0 ? "ok" : "error",
        ...(failed.length > 0 ? { failed } : {}),
      },
      {
        status: failed.length === 0 ? 200 : 503,
        headers: {
          // Never cached. A cached health check is a load balancer reading a
          // reply from before the thing it is checking broke.
          "cache-control": "no-store",
        },
      },
    );
  };
}
