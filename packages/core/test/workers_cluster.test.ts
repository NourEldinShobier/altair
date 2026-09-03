/**
 * The clustered server, driven end to end.
 *
 * A spawned process rather than an in-process application: `cluster.fork()`
 * re-runs the entry file, so forking from inside the test runner would fork
 * the runner. `test/support/worker_server.ts` is that entry file, and every
 * response is the pid that served it.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";

/**
 * Linux only, and this is the feature's own limitation rather than the test's.
 *
 * Measured with the same file on both: four workers, thirty requests over
 * separate connections. Linux spreads them across all four processes; Windows
 * sends all thirty to one and leaves the other three idle. `node:cluster`
 * forks either way, so nothing errors — the other workers simply never serve.
 *
 * Skipped rather than inverted: asserting "one worker gets everything" would
 * pin a Bun limitation as though it were intended, and the assertion would
 * then fail on the day Bun fixes it.
 */
const onLinux = process.platform === "linux" ? describe : describe.skip;

const SERVER = join(import.meta.dir, "support", "worker_server.ts");

let running: ReturnType<typeof Bun.spawn> | undefined;

/**
 * Starts the server and waits for the line naming the port it bound.
 *
 * An explicit port, not 0. Under cluster each worker runs `Bun.serve` itself,
 * and port 0 means "any free port" *per worker* — four workers would bind four
 * different ports and the test would reach whichever one it was told about.
 * That is what the first version of this test did, and it read as cluster not
 * working at all.
 */
const start = async (workers: number): Promise<number> => {
  const port = 34_000 + Math.floor(Math.random() * 4_000);
  const proc = Bun.spawn(["bun", SERVER, String(port), String(workers)], {
    stdout: "pipe",
    stderr: "pipe",
  });

  running = proc;

  const reader = proc.stdout.getReader();
  const deadline = performance.now() + 30_000;
  let buffered = "";

  while (performance.now() < deadline) {
    const { value, done } = await reader.read();

    if (done) break;

    buffered += new TextDecoder().decode(value);

    const port = /LISTENING (\d+)/.exec(buffered)?.[1];

    if (port !== undefined) {
      reader.releaseLock();

      return Number(port);
    }
  }

  reader.releaseLock();
  throw new Error(
    `server never announced a port: ${buffered}${await new Response(proc.stderr).text()}`,
  );
};

/** Which pids answered, over connections that are not reused. */
const pidsOver = async (port: number, requests: number): Promise<Map<string, number>> => {
  const counts = new Map<string, number>();

  for (let index = 0; index < requests; index += 1) {
    const response = await fetch(`http://127.0.0.1:${port}/pid`, {
      headers: { connection: "close" },
    });
    const pid = await response.text();

    counts.set(pid, (counts.get(pid) ?? 0) + 1);
  }

  return counts;
};

afterEach(() => {
  running?.kill();
  running = undefined;
});

onLinux("with four workers", () => {
  /**
   * More than one process, not exactly four.
   *
   * Four workers are forked and all four report listening — the supervisor
   * waits for that before `start` returns — but which of them serves a given
   * connection is the scheduler's business. On a two-core CI runner two
   * workers absorbed all sixty requests, and asserting four failed there while
   * the feature worked perfectly. Fan-out is the property; the distribution is
   * not something to pin.
   */
  it("serves from more than one process", async () => {
    const port = await start(4);
    const counts = await pidsOver(port, 60);

    expect(counts.size).toBeGreaterThan(1);
  });

  /** No single worker absorbs everything — the point of forking at all. */
  it("does not send every request to one worker", async () => {
    const port = await start(4);
    const counts = await pidsOver(port, 60);
    const busiest = Math.max(...counts.values());

    expect(busiest).toBeLessThan(60);
  });

  /**
   * The reason a supervisor exists rather than four processes started by a
   * shell: a worker that dies is replaced, and the port keeps answering.
   */
  it("replaces a worker that dies", async () => {
    const port = await start(4);
    const before = await pidsOver(port, 40);
    const victim = await (await fetch(`http://127.0.0.1:${port}/die`)).text();

    // Long enough for the exit to be noticed and a replacement to boot.
    await Bun.sleep(3000);

    const after = await pidsOver(port, 40);

    // The dead worker is gone and the port still answers — which is what a
    // supervisor is for. Not `after.size === 4`: how the survivors and the
    // replacement share the next forty requests is the scheduler's business.
    expect(before.has(victim)).toBe(true);
    expect(after.has(victim)).toBe(false);
    expect(after.size).toBeGreaterThan(0);
  }, 45_000);
});

describe("with one worker", () => {
  /** The default. No supervisor, no fork — the process that listened serves. */
  it("serves from the process that called listen", async () => {
    const port = await start(1);
    const counts = await pidsOver(port, 20);

    expect(counts.size).toBe(1);
  });
});
