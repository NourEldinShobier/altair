/**
 * A logger per component, ported from Rails' `ActiveRecord::Base.logger`,
 * `ActiveJob::Base.logger` and the rest of the family.
 *
 * There was one logger for everything, which makes the commonest thing anybody
 * wants to do impossible: quieten one component. An application drowning in
 * query lines wants the ORM at `warn` and its own code at `debug`, and with a
 * single logger the only choices are both or neither — so people turn the whole
 * thing down and then cannot see their own logs either.
 *
 * Each component gets its own, defaulting to the shared one, so nothing has to
 * be configured for the ordinary case and one line configures the exceptional
 * one.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { Logger, logger as shared } from "./logger.js";

const components = new Map<string, Logger>();

/**
 * The logger a component writes through. Rails' `logger` on each base class.
 *
 * The shared one until something replaces it, rather than a copy: an
 * application that configures the shared logger — a JSON formatter, a sink
 * shipping elsewhere — expects every component to follow, and a copy taken at
 * import time would leave whichever components loaded first writing somewhere
 * else.
 */
/**
 * The loggers a `silenceComponent` block installed, if one is running.
 *
 * Separate from the process's, because they answer different questions.
 * `setComponentLogger` is configuration; silencing is a decision about one
 * block, and a shared map made it a decision about every request logging
 * beside it — their lines went missing and nothing said so.
 */
const silenced = new AsyncLocalStorage<Map<string, Logger>>();

export function componentLogger(component: string): Logger {
  return silenced.getStore()?.get(component) ?? components.get(component) ?? shared;
}

/**
 * Gives one component a logger of its own. Rails' `logger=`.
 *
 * Passing undefined puts it back to the shared one, which is what makes this
 * usable from a test: set it for the duration, unset it afterwards, and
 * nothing has to remember what was there before.
 */
export function setComponentLogger(component: string, logger: Logger | undefined): void {
  if (logger === undefined) components.delete(component);
  else components.set(component, logger);
}

/** Every component that has been given one of its own. */
export function configuredComponents(): string[] {
  return [...components.keys()];
}

/** Puts every component back to the shared logger. For a test, and for a reload. */
export function resetComponentLoggers(): void {
  components.clear();
}

/**
 * Quietens one component for the duration of a block.
 *
 * The shape a test wants: a job that logs on failure should not print six
 * lines of expected failure into a passing suite, and remembering to put the
 * level back is exactly what nobody does.
 */
export async function silenceComponent<T>(
  component: string,
  body: () => T | Promise<T>,
): Promise<T> {
  // A copy of whatever is already silenced, so nesting adds rather than
  // replaces, and so nothing has to be put back.
  const quiet = new Map(silenced.getStore());

  quiet.set(component, new Logger({ level: "fatal", sink: () => undefined }));

  return await silenced.run(quiet, async () => await body());
}
