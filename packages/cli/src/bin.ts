#!/usr/bin/env bun
/**
 * The `altair` command.
 *
 * The only place in the CLI that touches stdout or the filesystem; everything
 * it calls returns data, which is what makes the commands testable.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  generate,
  generateSecret,
  helpText,
  newApplication,
  type GeneratedFile,
} from "./commands.js";

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
