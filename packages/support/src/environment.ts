/**
 * Which environment this is, ported from `Rails.env`.
 *
 * Here rather than in core because the packages that need it most are the ones
 * that cannot depend on core: a mailer deciding whether it is safe to write
 * messages to the terminal instead of sending them is asking this question,
 * and so is a queue deciding whether to run a job inline.
 *
 * `ALTAIR_ENV` wins over `NODE_ENV`, as `RAILS_ENV` does over `RACK_ENV`, so a
 * tool that insists on setting `NODE_ENV` cannot decide this on the
 * application's behalf.
 */

export type Environment = "development" | "test" | "production";

/** Reads the environment, defaulting to development as Rails does. */
export function currentEnvironment(
  env: Record<string, string | undefined> = process.env,
): Environment {
  const value = env.ALTAIR_ENV ?? env.NODE_ENV;
  if (value === "production" || value === "test") return value;
  return "development";
}
