#!/usr/bin/env bun
/**
 * The `altair` command.
 *
 * The only place in the CLI that touches stdout or the filesystem; everything
 * it calls returns data, which is what makes the commands testable.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  generate,
  generateSecret,
  helpText,
  migrate,
  migrationStatus,
  newApplication,
  rollback,
  routesTable,
  type GeneratedFile,
} from "./commands.js";
import { createDatabase, dropDatabase, targetFor, type MaintenanceConnection } from "./database.js";
import { editCredentials, ignoreMasterKey, showCredentials } from "./credentials.js";
import { loadMigrations } from "./loader.js";
import { Connection, dumpSchema, dumpTypes, introspect, loadSchema } from "@altair/orm";
import type { Environment } from "@altair/core";
import { currentEnvironment } from "@altair/support";

/**
 * The database this command should talk to.
 *
 * Mirrors the application's own default, so `altair db:migrate` and a booted
 * application disagree only if DATABASE_URL does.
 */
/**
 * The database this CLI would connect to.
 *
 * Named separately because `db:create` and `db:drop` need it *before* there is
 * anything to connect to, which is the one thing every other task can assume.
 */
function databaseUrl(): string {
  const env = currentEnvironment();

  return (
    process.env.DATABASE_URL ??
    (env === "test" ? "sqlite://:memory:" : `sqlite://${process.cwd()}/db/${env}.sqlite3`)
  );
}

/** The environment the CLI is acting on. */
function environment(): string {
  return currentEnvironment();
}

/** Opens the connection `CREATE DATABASE` is run from. */
async function openMaintenance(url: string): Promise<MaintenanceConnection> {
  return new Connection(url) as unknown as MaintenanceConnection;
}

async function connect(): Promise<Connection> {
  const url = databaseUrl();

  // SQLite will not create a database in a directory that does not exist, and
  // "unable to open database file" is a poor way to learn that db/ is missing.
  if (url.startsWith("sqlite:") && !url.includes(":memory:")) {
    const file = url.replace(/^sqlite:\/\//, "");
    await mkdir(dirname(file), { recursive: true });
  }

  return new Connection(url);
}

const MIGRATIONS_DIR = join(process.cwd(), "db", "migrate");
const SCHEMA_FILE = join(process.cwd(), "db", "schema.ts");
const TYPES_FILE = join(process.cwd(), "db", "types.ts");

/**
 * Writes the schema and the generated attribute types.
 *
 * Run after every migration, so the types the compiler reads always describe
 * the database that exists. A column added in a migration and forgotten in an
 * interface is otherwise a silent lie.
 */
/**
 * Moves a generated migration off a version something already has.
 *
 * A version is the time to the second, so generating two models in one second
 * gives them the same one — and the second `db:migrate` then fails on a unique
 * constraint after the first has already run. A second later is still in
 * order, which is all the version has to be.
 */
async function withFreeVersion(files: GeneratedFile[]): Promise<GeneratedFile[]> {
  const taken = new Set(
    (await loadMigrations(MIGRATIONS_DIR).catch(() => [])).map((migration) => migration.version),
  );

  return files.map((file) => {
    const match = /^db\/migrate\/(\d+)_(.+)$/.exec(file.path);
    if (!match) return file;

    let version = match[1] as string;
    while (taken.has(version)) version = String(BigInt(version) + 1n);

    taken.add(version);

    return {
      path: `db/migrate/${version}_${match[2]}`,
      contents: file.contents.replace(/version: "\d+"/, `version: "${version}"`),
    };
  });
}

async function dump(connection: Connection): Promise<void> {
  const schema = await introspect(connection);

  await mkdir(dirname(SCHEMA_FILE), { recursive: true });
  await writeFile(SCHEMA_FILE, dumpSchema(schema));
  await writeFile(TYPES_FILE, dumpTypes(schema));

  console.log("      dumped  db/schema.ts");
  console.log("      dumped  db/types.ts");
}

async function write(files: GeneratedFile[], root: string): Promise<void> {
  for (const file of files) {
    const target = join(root, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.contents);
    console.log(`      create  ${file.path}`);
  }
}

/** `--environment production`, or the one the rest of the CLI is acting on. */
function environmentArgument(argv: string[]): Environment {
  const flag = argv.indexOf("--environment");
  const value = flag === -1 ? undefined : argv[flag + 1];

  if (value === undefined) return currentEnvironment();

  // Checked rather than cast. `--environment prod` used to become the string
  // "prod", which reads credentials from a file that does not exist and
  // reports it as a missing key rather than as a typo.
  if (value !== "development" && value !== "test" && value !== "production") {
    console.error(`Unknown environment "${value}". Expected development, test, or production.`);
    process.exit(1);
  }

  return value;
}

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case "new": {
    const name = args[0];
    if (!name) {
      console.error("Usage: altair new NAME");
      process.exit(1);
    }
    await write(newApplication(name), name);
    console.log(`\nNext:\n  cd ${name}\n  bun install\n  bun run dev`);
    break;
  }

  case "generate":
  case "g": {
    const [kind, name, ...fields] = args;
    if (!kind || !name) {
      console.error("Usage: altair generate KIND NAME [field:type ...]");
      process.exit(1);
    }
    await write(await withFreeVersion(generate(kind, name, fields)), process.cwd());
    break;
  }

  case "db:create": {
    const { output } = await createDatabase(targetFor(databaseUrl()), openMaintenance);
    console.log(output);
    break;
  }

  case "db:drop": {
    const { output } = await dropDatabase(targetFor(databaseUrl()), openMaintenance);
    console.log(output);
    break;
  }

  // Rails' `db:prepare`: get the database into a usable state from wherever it
  // is now. Safe to run on a machine that has never seen the application and
  // on one that is already up to date, which is what makes it the command to
  // put in a setup script.
  case "db:prepare": {
    console.log((await createDatabase(targetFor(databaseUrl()), openMaintenance)).output);

    const connection = await connect();
    const { output, applied } = await migrate(connection, await loadMigrations(MIGRATIONS_DIR));
    console.log(output);

    if (applied.length > 0) await dump(connection);
    await connection.close();
    break;
  }

  // Rails' `db:reset`: throw it away and build it again. Refused outside
  // development and test, because the command that drops a database should not
  // be one keystroke from a production console.
  case "db:reset": {
    if (environment() === "production") {
      console.error(
        "Refusing to drop the production database. Set ALTAIR_ENV if you meant another one.",
      );
      process.exitCode = 1;
      break;
    }

    const target = targetFor(databaseUrl());
    console.log((await dropDatabase(target, openMaintenance)).output);
    console.log((await createDatabase(target, openMaintenance)).output);

    const connection = await connect();
    const { output } = await migrate(connection, await loadMigrations(MIGRATIONS_DIR));
    console.log(output);

    await dump(connection);
    await connection.close();
    break;
  }

  case "db:migrate": {
    const connection = await connect();
    const { output, applied } = await migrate(connection, await loadMigrations(MIGRATIONS_DIR));
    console.log(output);

    if (applied.length > 0) await dump(connection);
    await connection.close();
    break;
  }

  case "db:rollback": {
    const connection = await connect();
    const steps = Number(args[0] ?? 1);
    const { output, applied } = await rollback(
      connection,
      await loadMigrations(MIGRATIONS_DIR),
      steps,
    );
    console.log(output);

    if (applied.length > 0) await dump(connection);
    await connection.close();
    break;
  }

  case "db:schema:dump": {
    const connection = await connect();
    await dump(connection);
    await connection.close();
    break;
  }

  case "db:schema:load": {
    // Rails prepares a test database this way rather than replaying every
    // migration, which is the difference between a suite that starts in
    // milliseconds and one that starts in seconds.
    const connection = await connect();
    const loaded = (await import(pathToFileURL(SCHEMA_FILE).href)) as {
      default?: Parameters<typeof loadSchema>[1];
    };

    if (!loaded.default) {
      console.error("db/schema.ts does not export a schema. Run `altair db:migrate` first.");
      process.exit(1);
    }

    await loadSchema(connection, loaded.default);
    console.log(`      loaded  db/schema.ts`);
    await connection.close();
    break;
  }

  case "db:status": {
    const connection = await connect();
    console.log(await migrationStatus(connection, await loadMigrations(MIGRATIONS_DIR)));
    await connection.close();
    break;
  }

  case "routes": {
    // The route table lives in the application, so this loads its config.
    const path = join(process.cwd(), "config", "routes.ts");
    const { Router } = await import("@altair/router");
    const loaded = (await import(pathToFileURL(path).href)) as {
      default?: (r: never) => void;
    };

    if (!loaded.default) {
      console.error("config/routes.ts must default-export a function that draws routes.");
      process.exit(1);
    }

    console.log(routesTable(new Router().draw(loaded.default as never)));
    break;
  }

  case "routes:types": {
    // The same bargain as db:schema:dump — read the real thing and emit types
    // from it, so a helper's name and its arity are both checked.
    const path = join(process.cwd(), "config", "routes.ts");
    const { Router, dumpRouteHelpers } = await import("@altair/router");
    const loaded = (await import(pathToFileURL(path).href)) as {
      default?: (r: never) => void;
    };

    if (!loaded.default) {
      console.error("config/routes.ts must default-export a function that draws routes.");
      process.exit(1);
    }

    const router = new Router().draw(loaded.default as never);
    const target = join(process.cwd(), "config", "paths.ts");

    await Bun.write(target, dumpRouteHelpers(router, { routesModule: "./routes.js" }));
    console.log(`Wrote ${router.routeNames.length} path helpers to config/paths.ts`);
    break;
  }

  case "console":
  case "c": {
    // The application's own entry boots it; the console just adds a prompt on
    // top of whatever that leaves in scope.
    const { startConsole } = await import("./console.js");
    const context: Record<string, unknown> = {};

    const boot = join(process.cwd(), "config", "console.ts");
    if (await Bun.file(boot).exists()) {
      const loaded = (await import(pathToFileURL(boot).href)) as { default?: unknown };
      Object.assign(context, loaded.default ?? loaded);
    }

    await startConsole(context, {
      banner: `Altair console — ${Object.keys(context).length} names in scope. Ctrl-D or .exit to leave.`,
    });
    break;
  }

  case "server":
  case "s": {
    // Bun's own --hot does the reloading, so this is about the entry point and
    // the flags rather than a watcher of our own.
    const entry = join(process.cwd(), "bin", "server.ts");
    if (!(await Bun.file(entry).exists())) {
      console.error("No bin/server.ts found. Run this from an Altair application.");
      process.exit(1);
    }

    const port = args[0]?.replace(/^--port=?/, "");

    // The bun binary rather than the name. On Windows the name resolves to a
    // shim, so this would start the shim and the real bun would be its child —
    // and when the shim goes, the server does not. That is a dev server still
    // holding the port after Ctrl-C, and "address already in use" on the next
    // `altair server`.
    const child = Bun.spawn([process.execPath, "run", "--hot", entry], {
      stdio: ["inherit", "inherit", "inherit"],
      env: { ...process.env, ...(port ? { PORT: port } : {}) },
    });

    // Passed on rather than left to the operating system. Ctrl-C reaches this
    // process, and the server is a child of it — without this the CLI exits
    // and the server carries on holding the port, so the next `altair server`
    // meets "address already in use" for a process nothing appears to own.
    //
    // Both signals: Ctrl-C sends SIGINT, and anything supervising this (a
    // container stopping, a test harness) sends SIGTERM.
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => {
        child.kill(signal);
      });
    }

    process.exit(await child.exited);
  }

  case "jobs:work": {
    const { loadApplication } = await import("@altair/core");
    const { Job, Worker } = await import("@altair/jobs");
    const { queueFrom, registerJobs } = await import("./worker.js");

    // Booted rather than merely connected: the initializers are where an
    // application sets its queue adapter, and a worker that skipped them would
    // poll a different queue than the one the web process enqueues to.
    const workerApp = await loadApplication();
    await workerApp.boot();

    const names = await registerJobs(process.cwd());
    const queue = queueFrom(args);

    console.log(
      names.length > 0
        ? `Working ${queue} with ${names.length} job(s): ${names.join(", ")}`
        : `Working ${queue}. No jobs found in app/jobs.`,
    );

    const worker = new Worker({
      adapter: Job.queue,
      queue,
      onError: (error, payload) => {
        console.error(`  ${payload.jobClass} failed:`, (error as Error).message);
      },
      onFailure: (error, payload) => {
        console.error(`  ${payload.jobClass} gave up:`, (error as Error).message);
      },
    });

    // Stops after the job in flight rather than in the middle of one, which is
    // the difference between a deploy and a half-charged card.
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => {
        console.log("\nFinishing the job in flight, then stopping.");
        void worker.stop();
      });
    }

    await worker.start();
    break;
  }

  case "storage:install":
  case "richtext:install": {
    const { generateRichTextInstall, generateStorageInstall } = await import("./generators.js");
    const file =
      command === "storage:install"
        ? generateStorageInstall(new Date())
        : generateRichTextInstall(new Date());

    // Through the same version check as `generate`: two of these written in
    // the same second would otherwise claim the same version, and db:migrate
    // refuses a table it cannot order.
    await write(await withFreeVersion([file]), process.cwd());
    console.log("Run altair db:migrate to apply it.");
    break;
  }

  case "runner":
  case "r": {
    const { runnerTarget, runTarget } = await import("./runner.js");

    let target;
    try {
      target = runnerTarget(args);
    } catch (error) {
      console.error((error as Error).message);
      process.exit(1);
    }

    // Booted, not merely connected. The initializers are where an application
    // configures its queue adapter, its storage services and its encryption
    // keys — so a script run without them got a different application than the
    // one serving requests. `performLater` was the loud case: with no adapter
    // configured it fell back to the development default and ran every job
    // inline, in this process, instead of enqueuing any of them.
    const { loadApplication: loadForRunner } = await import("@altair/core");
    const runnerApp = await loadForRunner();
    await runnerApp.boot();

    try {
      await runTarget(target, process.cwd());
    } finally {
      // Closed even when the script threw, or the process hangs on an open
      // pool rather than reporting what went wrong.
      await runnerApp.connection.close();
    }

    break;
  }

  case "secret":
    console.log(generateSecret());
    break;

  case "db:seed": {
    const seeds = join(process.cwd(), "db", "seeds.ts");

    if (!existsSync(seeds)) {
      console.error("No db/seeds.ts. Create one that exports a default function.");
      process.exit(1);
    }

    // Booted for the same reason `runner` is: seeds that attach a file or
    // enqueue a job need the services the initializers configure, and without
    // them they quietly get the defaults instead.
    const { loadApplication: loadForSeed } = await import("@altair/core");
    const seedApp = await loadForSeed();
    await seedApp.boot();

    const loaded = (await import(pathToFileURL(seeds).href)) as {
      default?: () => unknown | Promise<unknown>;
    };

    if (typeof loaded.default !== "function") {
      console.error("db/seeds.ts must export a default function.");
      process.exit(1);
    }

    await loaded.default();
    await seedApp.connection.close();

    console.log("      seeded  db/seeds.ts");
    break;
  }

  case "credentials:edit": {
    const environment = environmentArgument(args);
    // Ignored first, and every time. A first edit that fails after writing the
    // key would otherwise leave it uncommitted-but-untracked forever, since
    // the next edit finds a key already there and says nothing.
    ignoreMasterKey(process.cwd());

    console.log((await editCredentials({ env: environment })).output);
    break;
  }

  case "credentials:show": {
    console.log(showCredentials({ env: environmentArgument(args) }).output);
    break;
  }

  case undefined:
  case "help":
  case "--help":
  case "-h":
    console.log(helpText());
    break;

  default:
    console.error(`Unknown command "${command}".\n`);
    console.log(helpText());
    process.exit(1);
}
