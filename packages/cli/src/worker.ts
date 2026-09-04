/**
 * `altair jobs:work`, the process that actually runs what `performLater`
 * enqueued.
 *
 * Without it an application could enqueue and never run anything: the queue
 * filled up in production and nothing on the other end took work off it. Rails
 * has `bin/jobs` for the same reason — enqueuing and performing are two
 * processes, and the framework has to ship both.
 */

import { Glob } from "bun";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Job } from "@altair/jobs";

/**
 * Imports the application's jobs so a name off the queue resolves to a class.
 *
 * A job registers itself when it builds a payload, which covers the process
 * that enqueued it — and not this one, which has never seen the class. Rails
 * autoloads; this walks `app/jobs` for the same effect, so an application does
 * not keep a list of its own jobs in step by hand.
 */
export async function registerJobs(root: string): Promise<string[]> {
  const registered: string[] = [];
  const directory = join(root, "app", "jobs");

  // An application with no jobs has no directory, which `Glob.scan` reports as
  // ENOENT rather than as an empty result — so `jobs:work` in an application
  // that has not written a job yet crashed instead of idling.
  if (!existsSync(directory)) return registered;

  for await (const file of new Glob("**/*.{ts,tsx}").scan(directory)) {
    const module = (await import(
      Bun.pathToFileURL(join(root, "app", "jobs", file)).href
    )) as Record<string, unknown>;

    for (const exported of Object.values(module)) {
      // A class extending Job, and not Job itself — an application that
      // re-exports it should not register the base class as a job.
      if (typeof exported !== "function" || exported === Job) continue;
      if (!(exported.prototype instanceof Job)) continue;

      // Nor a base class of its own. `app/jobs/application-job.ts` holds the
      // `ApplicationJob` every job inherits, exactly as Rails does, and it
      // extends `Job` without implementing `perform` — there is nothing for a
      // worker to run. Registering it made `jobs:work` report one job in an
      // application that has written none.
      if (!implementsPerform(exported as new () => unknown)) continue;

      Job.register(exported as typeof Job);
      registered.push((exported as typeof Job).jobName);
    }
  }

  return registered.sort();
}

/**
 * Whether a job class actually defines the work, rather than inheriting the
 * promise of it.
 *
 * Walks from the class down to `Job`, so an application with its own
 * intermediate base — `ApplicationJob` implementing `perform` and calling
 * `super` — still registers the jobs beneath it. Only a class where nothing
 * between it and `Job` owns a `perform` is treated as a base class.
 */
function implementsPerform(klass: new () => unknown): boolean {
  for (
    let prototype: object | null = klass.prototype as object;
    prototype && prototype !== Job.prototype;
    prototype = Object.getPrototypeOf(prototype) as object | null
  ) {
    if (Object.hasOwn(prototype, "perform")) return true;
  }

  return false;
}

/** `--queue=mailers`, or the default queue. */
export function queueFrom(args: readonly string[]): string {
  const flag = args.find((argument) => argument.startsWith("--queue"));
  if (!flag) return "default";

  const value = flag.includes("=")
    ? flag.slice(flag.indexOf("=") + 1)
    : args[args.indexOf(flag) + 1];

  return value && value.length > 0 ? value : "default";
}
