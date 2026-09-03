/**
 * A real clustered application, for `workers_cluster.test.ts`.
 *
 * Spawned as its own process because `cluster.fork()` re-runs the entry file:
 * doing that inside the test runner would fork the runner. Every endpoint
 * answers with the pid that served it, which is how the test tells four
 * workers from one.
 *
 *     bun test/support/worker_server.ts <port> <workers>
 */

import { Controller } from "@altair/controller";
import cluster from "node:cluster";
import { createApplication } from "../../src/index.js";

const [port = "0", workers = "4"] = process.argv.slice(2);

class PidController extends Controller {
  index(): void {
    this.render.text(String(process.pid));
  }

  /** Kills this worker, so the test can watch the supervisor replace it. */
  die(): void {
    this.render.text(String(process.pid));
    setTimeout(() => process.exit(1), 10);
  }
}

const app = createApplication({
  env: "production",
  secretKeyBase: "w".repeat(64),
  database: { url: "sqlite://:memory:" },
  log: { level: "fatal", format: "json", queries: false },
  hosts: [],
  forceSsl: false,
  server: { port: Number(port), workers: Number(workers) },
  routes: (r) => {
    r.get("/pid", { to: "pid#index" });
    r.get("/die", { to: "pid#die" });
  },
  controllers: { pid: PidController },
});

// Printed by each worker as it starts serving, so the test can count the
// workers that actually came up. Distribution of connections across them is
// the kernel's business and not assertable; how many are serving is the
// framework's contract and is.
if (!cluster.isPrimary) console.log(`WORKER ${process.pid}`);

const server = await app.listen(Number(port));

// Only the supervisor reaches this with the port to announce; a worker prints
// it too, but the test reads the first line and both agree.
console.log(`LISTENING ${server.port}`);
