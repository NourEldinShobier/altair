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

  for await (const file of new Glob("**/*.{ts,tsx}").scan(join(root, "app", "jobs"))) {
    const module = (await import(
      Bun.pathToFileURL(join(root, "app", "jobs", file)).href
    )) as Record<string, unknown>;

    for (const exported of Object.values(module)) {
      // A class extending Job, and not Job itself — an application that
      // re-exports it should not register the base class as a job.
      if (typeof exported !== "function" || exported === Job) continue;
      if (!(exported.prototype instanceof Job)) continue;

      Job.register(exported as typeof Job);
      registered.push((exported as typeof Job).jobName);
    }
  }

  return registered.sort();
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
