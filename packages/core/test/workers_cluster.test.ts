/**
 * The clustered server, driven end to end.
 *
 * A spawned process rather than an in-process application: `cluster.fork()`
 * re-runs the entry file, so forking from inside the test runner would fork
 * the runner. `test/support/worker_server.ts` is that entry file.
 *
 * What is asserted is what the framework controls: that `workers` forks that
 * many processes, that each of them serves, and that one which dies is
 * replaced. What is *not* asserted is which worker answers a given request.
 *
 * That distinction was learned from CI. An earlier version sent sixty requests
 * and asserted they reached more than one process. It passed on a developer
 * machine and in a two-core Linux container, and failed on GitHub's runner,
 * where all sixty went to one worker although all four were forked and
 * listening. Spreading connections is the kernel's business, and whether it
 * spreads sixty sequential requests depends on the kernel, the load and the
 * timing. Asserting it tests the environment rather than the code.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";

/**
 * Linux only, and this is the feature's own limitation rather than the test's.
 *
 * `node:cluster` forks on every platform, but only Linux hands the connections
 * to the workers. Measured with the same file on both: four workers and thirty
 * requests give four distinct pids on Linux and one on Windows. Skipped rather
 * than inverted, because asserting the broken behaviour would pin a Bun
 * limitation as though it were intended.
 */
const onLinux = process.platform === "linux" ? describe : describe.skip;

const SERVER = join(import.meta.dir, "support", "worker_server.ts");

let running: ReturnType<typeof Bun.spawn> | undefined;

interface Started {
  port: number;
  /** The pids that announced themselves as serving. Empty for a single process. */
  workers: Set<string>;
}

/**
 * Starts the server and waits until it is serving.
 *
 * An explicit port, not 0: under cluster each worker runs `Bun.serve` itself,
 * and port 0 means "any free port" *per worker*, so four workers would bind
 * four different ports and the test would reach whichever one it was told
 * about. That is what the first version did, and it read as cluster not
 * working at all.
 */
const start = async (workers: number): Promise<Started> => {
  const expected = workers > 1 ? workers : 0;
  const port = 34_000 + Math.floor(Math.random() * 4_000);
  const proc = Bun.spawn(["bun", SERVER, String(port), String(workers)], { stdout: "pipe", stderr: "pipe" });

  running = proc;

  const reader = proc.stdout.getReader();
  const deadline = performance.now() + 30_000;
  let buffered = "";

  while (performance.now() < deadline) {
    const { value, done } = await reader.read();

    if (done) break;

    buffered += new TextDecoder().decode(value);

    const announced = /LISTENING (\d+)/.exec(buffered)?.[1];
    const pids = [...buffered.matchAll(/WORKER (\d+)/g)].map((match) => match[1] as string);

    if (announced !== undefined && pids.length >= expected) {
      reader.releaseLock();

      return { port: Number(announced), workers: new Set(pids) };
    }
  }

  reader.releaseLock();
  throw new Error(`server never came up: ${buffered}${await new Response(proc.stderr).text()}`);
};

const get = async (port: number, path = "/pid"): Promise<string> => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { connection: "close" } });

  return await response.text();
};

afterEach(() => {
  running?.kill();
  running = undefined;
});

onLinux("with four workers", () => {
  it("forks four processes, all of them serving", async () => {
    const started = await start(4);

    expect(started.workers.size).toBe(4);
  });

  it("answers on the one port they share", async () => {
    const started = await start(4);
    const pid = await get(started.port);

    expect(started.workers.has(pid)).toBe(true);
  });

  /**
   * The reason a supervisor exists rather than four processes started by a
   * shell: a worker that dies is replaced, and the port keeps answering.
   */
  it("replaces a worker that dies", async () => {
    const started = await start(4);
    const victim = await get(started.port, "/die");

    expect(started.workers.has(victim)).toBe(true);

    // Long enough for the exit to be noticed and a replacement to boot.
    await Bun.sleep(3000);

    // Asked repeatedly because which worker replies is not ours to say. The
    // claim is only that the port still serves and the dead one does not.
    const answers = new Set<string>();

    for (let index = 0; index < 12; index += 1) answers.add(await get(started.port));

    expect(answers.has(victim)).toBe(false);
    expect(answers.size).toBeGreaterThan(0);
  }, 45_000);
});

describe("with one worker", () => {
  /** The default. No supervisor, no fork — the process that listened serves. */
  it("serves from the process that called listen", async () => {
    const started = await start(1);
    const pids = new Set<string>();

    for (let index = 0; index < 12; index += 1) pids.add(await get(started.port));

    expect(pids.size).toBe(1);
  });
});
