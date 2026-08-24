/**
 * Altair's logger against the ones people usually reach for.
 *
 * Committed because the framework has a logger of its own rather than a
 * dependency, and a claim like that should be checkable rather than believed.
 * The competitors are *not* dependencies of this repository — install them
 * where you run this, so measuring the alternatives does not mean shipping
 * them:
 *
 *     mkdir /tmp/logbench && cd /tmp/logbench
 *     echo '{"name":"x","private":true,"type":"module"}' > package.json
 *     bun add pino winston consola @logtape/logtape winston-transport
 *     bun run <this file>
 *
 * Every logger writes to a destination that discards, so what is measured is
 * the cost of making a log line and not the cost of a terminal. That flatters
 * pino slightly, since its usual production setup moves formatting to a worker
 * thread and this measures its in-process path — the fast one.
 *
 * The second table is the more interesting one. A `debug` call left in a hot
 * path costs whatever its logger charges for deciding not to log, and the
 * spread there is three orders of magnitude.
 */

import { jsonFormatter, Logger } from "../packages/support/src/index.js";

const N = Number(process.env.ITERATIONS ?? 300_000);
const WARM = 30_000;

const MESSAGE = "completed";
const PAYLOAD = { method: "GET", path: "/posts", status: 200, durationMs: 12.4, queries: 3 };

interface Result {
  name: string;
  ns: number;
}

function bench(name: string, fn: () => void): Result {
  for (let index = 0; index < WARM; index += 1) fn();

  const started = Bun.nanoseconds();
  for (let index = 0; index < N; index += 1) fn();

  return { name, ns: (Bun.nanoseconds() - started) / N };
}

/** Absent is fine: the point is to compare what is installed. */
async function optional<T>(specifier: string): Promise<T | undefined> {
  try {
    return (await import(specifier)) as T;
  } catch {
    return undefined;
  }
}

function report(title: string, rows: Result[]): void {
  console.log(`\n${title}`);
  console.log(`  Bun ${Bun.version}, ${N.toLocaleString()} iterations\n`);

  const fastest = Math.min(...rows.map((row) => row.ns));

  for (const row of [...rows].sort((a, b) => a.ns - b.ns)) {
    const ns = String(Math.round(row.ns)).padStart(6);
    console.log(`  ${row.name.padEnd(10)} ${ns} ns/op   ${(row.ns / fastest).toFixed(2)}x`);
  }
}

const enabled: Result[] = [];
const dropped: Result[] = [];

const altair = new Logger({ level: "info", formatter: jsonFormatter, sink: () => {} });
enabled.push(bench("altair", () => altair.info(MESSAGE, PAYLOAD)));

const quiet = new Logger({ level: "error", sink: () => {} });
dropped.push(bench("altair", () => quiet.debug(MESSAGE, PAYLOAD)));

const pino = await optional<{ default: (...args: never[]) => never }>("pino");
if (pino) {
  const make = (level: string) =>
    (pino.default as unknown as (options: unknown, stream: unknown) => Record<string, Function>)(
      { level },
      { write() {} },
    );

  const logger = make("info");
  enabled.push(bench("pino", () => logger.info?.(PAYLOAD, MESSAGE)));

  const off = make("error");
  dropped.push(bench("pino", () => off.debug?.(PAYLOAD, MESSAGE)));
}

const winston = await optional<Record<string, never>>("winston");
const transport = await optional<{ default: new () => never }>("winston-transport");

if (winston && transport) {
  const Base = transport.default as unknown as new () => object;

  class Discard extends Base {
    log(_info: unknown, next: () => void): void {
      next();
    }
  }

  const api = winston as unknown as {
    createLogger: (options: unknown) => Record<string, Function>;
    format: { json: () => unknown };
  };

  const logger = api.createLogger({
    level: "info",
    format: api.format.json(),
    transports: [new Discard()],
  });
  enabled.push(bench("winston", () => logger.info?.(MESSAGE, PAYLOAD)));

  const off = api.createLogger({ level: "error", transports: [new Discard()] });
  dropped.push(bench("winston", () => off.debug?.(MESSAGE, PAYLOAD)));
}

const consola = await optional<{ createConsola: (options: unknown) => Record<string, Function> }>(
  "consola",
);
if (consola) {
  const logger = consola.createConsola({ level: 3, reporters: [{ log() {} }] });
  enabled.push(bench("consola", () => logger.info?.(MESSAGE, PAYLOAD)));
}

const logtape = await optional<{
  configure: (options: unknown) => Promise<void>;
  getLogger: (category: string[]) => Record<string, Function>;
}>("@logtape/logtape");

if (logtape) {
  await logtape.configure({
    sinks: { none: () => {} },
    loggers: [
      { category: ["bench"], lowestLevel: "info", sinks: ["none"] },
      // Its own diagnostics, silenced so the table is not preceded by a notice.
      { category: ["logtape", "meta"], lowestLevel: "error", sinks: [] },
    ],
    reset: true,
  });

  const logger = logtape.getLogger(["bench"]);
  enabled.push(bench("logtape", () => logger.info?.(MESSAGE, PAYLOAD)));
}

report("An enabled call, output discarded", enabled);
report("A call below the level, dropped", dropped);

if (enabled.length === 1) {
  console.log("\n  Only Altair measured. Install the others where you run this to compare.");
}
