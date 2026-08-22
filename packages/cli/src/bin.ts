#!/usr/bin/env bun
/**
 * The `altair` command.
 *
 * The only place in the CLI that touches stdout or the filesystem; everything
 * it calls returns data, which is what makes the commands testable.
 */

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
import { loadMigrations } from "./loader.js";
import { Connection } from "@altair/orm";

/**
 * The database this command should talk to.
 *
 * Mirrors the application's own default, so `altair db:migrate` and a booted
 * application disagree only if DATABASE_URL does.
 */
async function connect(): Promise<Connection> {
  const env = process.env.ALTAIR_ENV ?? process.env.NODE_ENV ?? "development";
  const url =
    process.env.DATABASE_URL ??
    (env === "test" ? "sqlite://:memory:" : `sqlite://${process.cwd()}/db/${env}.sqlite3`);

  // SQLite will not create a database in a directory that does not exist, and
  // "unable to open database file" is a poor way to learn that db/ is missing.
  if (url.startsWith("sqlite:") && !url.includes(":memory:")) {
    const file = url.replace(/^sqlite:\/\//, "");
    await mkdir(dirname(file), { recursive: true });
  }

  return new Connection(url);
}

const MIGRATIONS_DIR = join(process.cwd(), "db", "migrate");

async function write(files: GeneratedFile[], root: string): Promise<void> {
  for (const file of files) {
    const target = join(root, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.contents);
    console.log(`      create  ${file.path}`);
  }
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
    await write(generate(kind, name, fields), process.cwd());
    break;
  }

  case "db:migrate": {
    const connection = await connect();
    const { output } = await migrate(connection, await loadMigrations(MIGRATIONS_DIR));
    console.log(output);
    await connection.close();
    break;
  }

  case "db:rollback": {
    const connection = await connect();
    const steps = Number(args[0] ?? 1);
    const { output } = await rollback(connection, await loadMigrations(MIGRATIONS_DIR), steps);
    console.log(output);
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

  case "secret":
    console.log(generateSecret());
    break;

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
