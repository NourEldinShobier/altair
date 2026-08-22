/**
 * CLI commands, ported from `Rails::Command`.
 *
 * Commands return their output as a string rather than printing it, so the
 * tests assert on what a person would see and the bin script is the only place
 * that touches stdout.
 */

import { Migrator, type Connection, type Migration } from "@altair/orm";
import type { Router } from "@altair/router";
import { secureToken } from "@altair/support";
import { tableize } from "@altair/support";
import {
  generateController,
  generateMigration,
  generateModel,
  generateScaffold,
  parseFields,
  type GeneratedFile,
} from "./generators.js";

export type { GeneratedFile } from "./generators.js";

/** Rails' `bin/rails routes`: every route, aligned. */
export function routesTable(router: Router): string {
  const rows = router.routes.map((route) => ({
    name: route.name ?? "",
    verb: route.method,
    path: route.pattern,
    action: `${route.controller}#${route.action}`,
  }));

  if (rows.length === 0) return "No routes defined.";

  const width = (key: keyof (typeof rows)[number]) =>
    Math.max(key.length, ...rows.map((row) => row[key].length));

  const widths = {
    name: width("name"),
    verb: width("verb"),
    path: width("path"),
  };

  const line = (name: string, verb: string, path: string, action: string) =>
    `${name.padStart(widths.name)} ${verb.padEnd(widths.verb)} ${path.padEnd(widths.path)} ${action}`;

  return [
    line("Prefix", "Verb", "URI Pattern", "Controller#Action"),
    ...rows.map((row) => line(row.name, row.verb, row.path, row.action)),
  ].join("\n");
}

export interface MigrateResult {
  output: string;
  applied: string[];
}

/** Rails' `db:migrate`. */
export async function migrate(
  connection: Connection,
  migrations: Migration[],
): Promise<MigrateResult> {
  const migrator = new Migrator(connection, migrations);
  const applied = await migrator.up();

  if (applied.length === 0) return { output: "Already up to date.", applied: [] };

  const lines = applied.map((migration) =>
    `  migrated  ${migration.version} ${migration.name ?? ""}`.trimEnd(),
  );
  return {
    output: [
      `Migrating ${applied.length} migration${applied.length === 1 ? "" : "s"}:`,
      ...lines,
    ].join("\n"),
    applied: applied.map((migration) => migration.version),
  };
}

/** Rails' `db:rollback`. */
export async function rollback(
  connection: Connection,
  migrations: Migration[],
  steps = 1,
): Promise<MigrateResult> {
  const migrator = new Migrator(connection, migrations);
  const reverted = await migrator.down(steps);

  if (reverted.length === 0) return { output: "Nothing to roll back.", applied: [] };

  const lines = reverted.map((migration) =>
    `  reverted  ${migration.version} ${migration.name ?? ""}`.trimEnd(),
  );
  return {
    output: [`Rolling back ${reverted.length}:`, ...lines].join("\n"),
    applied: reverted.map((migration) => migration.version),
  };
}

/** Rails' `db:migrate:status`. */
export async function migrationStatus(
  connection: Connection,
  migrations: Migration[],
): Promise<string> {
  const migrator = new Migrator(connection, migrations);
  const applied = new Set(await migrator.appliedVersions());

  if (migrations.length === 0) return "No migrations found.";

  const rows = [...migrations]
    .sort((a, b) => a.version.localeCompare(b.version))
    .map((migration) =>
      `${applied.has(migration.version) ? "   up  " : " down  "} ${migration.version}  ${migration.name ?? ""}`.trimEnd(),
    );

  return ["Status   Migration ID    Name", ...rows].join("\n");
}

export interface GenerateOptions {
  now?: Date;
}

/**
 * Dispatches `altair generate <kind> <name> [fields]`.
 *
 * Returns the files rather than writing them, so a caller can preview, and so
 * the tests do not need a filesystem.
 */
export function generate(
  kind: string,
  name: string,
  fieldArgs: string[] = [],
  options: GenerateOptions = {},
): GeneratedFile[] {
  const now = options.now ?? new Date();
  const fields = parseFields(fieldArgs);

  switch (kind) {
    case "model":
      return [
        generateMigration(`create_${tableize(name)}`, fields, now),
        generateModel(name, fields),
      ];
    case "controller":
      return [generateController(name, fieldArgs)];
    case "migration":
      return [generateMigration(name, fields, now)];
    case "scaffold":
      return generateScaffold(name, fields, now);
    default:
      throw new Error(
        `Unknown generator "${kind}". Available: model, controller, migration, scaffold.`,
      );
  }
}

/** A new secret, for `SECRET_KEY_BASE`. */
export function generateSecret(): string {
  return secureToken(64);
}

/** The files `altair new` writes. */
export function newApplication(name: string): GeneratedFile[] {
  const appName = name.replaceAll(/[^a-z0-9-_]/gi, "-").toLowerCase();

  return [
    {
      path: "package.json",
      contents: `${JSON.stringify(
        {
          name: appName,
          private: true,
          type: "module",
          scripts: {
            dev: "bun run --hot bin/server.ts",
            start: "bun run bin/server.ts",
            test: "bun test",
            "db:migrate": "bun run bin/altair.ts db:migrate",
            routes: "bun run bin/altair.ts routes",
          },
          imports: {
            "#models/*": "./app/models/*.ts",
            "#controllers/*": "./app/controllers/*.ts",
            "#db/*": "./db/*.ts",
          },
          dependencies: {
            "@altair/core": "workspace:*",
            "@altair/controller": "workspace:*",
            "@altair/orm": "workspace:*",
            "@altair/view": "workspace:*",
          },
        },
        null,
        2,
      )}\n`,
    },
    {
      path: "config/routes.ts",
      contents: `import type { Mapper } from "@altair/router";

export default function routes(r: Mapper): void {
  r.root("home#index");
}
`,
    },
    {
      path: "app/controllers/home_controller.ts",
      contents: `import { Controller } from "@altair/controller";

export class HomeController extends Controller {
  index(): void {
    this.render.json({ message: "Welcome aboard" });
  }
}
`,
    },
    {
      path: "bin/server.ts",
      contents: `import { createApplication } from "@altair/core";
import routes from "../config/routes.js";
import { HomeController } from "#controllers/home_controller";

const app = createApplication({
  routes,
  controllers: { home: HomeController },
});

const server = await app.listen();
console.log(\`Listening on http://localhost:\${server.port}\`);
`,
    },
    {
      path: "config/console.ts",
      contents: `// What \`altair console\` puts in scope. Add models as you write them.
//
//   import { Post } from "#models/post"
//   export default { Post }

export default {};
`,
    },
    {
      path: ".env.example",
      contents: `# Signs and encrypts cookies and sessions. Required in production.
# Generate one with: altair secret
SECRET_KEY_BASE=

# Defaults to a local SQLite file.
# DATABASE_URL=postgres://localhost/${appName}_development
`,
    },
    {
      path: "db/.gitkeep",
      contents: "",
    },
    {
      path: ".gitignore",
      contents: "node_modules/\ndb/*.sqlite3\n.env\n.env.*\n!.env.example\n",
    },
    {
      path: "tsconfig.json",
      contents: `${JSON.stringify(
        {
          compilerOptions: {
            target: "ESNext",
            module: "Preserve",
            moduleResolution: "bundler",
            jsx: "react-jsx",
            jsxImportSource: "@altair/view",
            strict: true,
            noUncheckedIndexedAccess: true,
            noEmit: true,
            skipLibCheck: true,
            types: ["bun"],
          },
          include: ["app/**/*.ts", "app/**/*.tsx", "config/**/*.ts", "db/**/*.ts", "bin/**/*.ts"],
        },
        null,
        2,
      )}\n`,
    },
  ];
}

/** The help text `altair` prints with no arguments. */
export function helpText(): string {
  return [
    "Usage: altair <command> [options]",
    "",
    "Commands:",
    "  new NAME                  Create a new application",
    "  generate KIND NAME        Generate model, controller, migration or scaffold",
    "  db:migrate                Run pending migrations",
    "  db:rollback [STEPS]       Roll back the last migration",
    "  db:status                 Show which migrations have run",
    "  routes                    List the route table",
    "  routes:types              Generate typed path helpers into config/paths.ts",
    "  server, s                 Run the application with reloading",
    "  console, c                A prompt with the application booted",
    "  secret                    Print a new SECRET_KEY_BASE",
  ].join("\n");
}
