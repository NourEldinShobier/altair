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
  generateChannel,
  generateJob,
  generateMailer,
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
    case "mailer":
      return generateMailer(name, fieldArgs);
    case "job":
      return generateJob(name);
    case "channel":
      return generateChannel(name);
    default:
      throw new Error(
        `Unknown generator "${kind}". Available: model, controller, migration, scaffold, mailer, job, channel.`,
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
          // One entry per directory a generator writes into. A missing one is
          // not a missing feature: `altair generate mailer User` wrote a test
          // importing `#mailers/user_mailer`, which resolved to nothing.
          imports: {
            "#models/*": "./app/models/*.ts",
            "#controllers/*": "./app/controllers/*.ts",
            "#mailers/*": "./app/mailers/*.tsx",
            "#jobs/*": "./app/jobs/*.ts",
            "#channels/*": "./app/channels/*.ts",
            "#db/*": "./db/*.ts",
          },
          // Every package a generated file imports. The mailer, job and
          // channel generators name three that were not here.
          dependencies: {
            "@altair/core": "workspace:*",
            "@altair/controller": "workspace:*",
            "@altair/orm": "workspace:*",
            "@altair/view": "workspace:*",
            "@altair/mailer": "workspace:*",
            "@altair/jobs": "workspace:*",
            "@altair/cable": "workspace:*",
            "@altair/cli": "workspace:*",
          },
          // `tsconfig.json` asks for the bun types by name, so something has
          // to provide them. Without this a new application installs, runs,
          // and fails to typecheck: "Cannot find type definition file for
          // 'bun'".
          devDependencies: {
            "@types/bun": "latest",
            typescript: "^5",
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
import { mountCable } from "@altair/cable";
import { mountPreviews } from "@altair/mailer";
import routes from "../config/routes.js";
import { HomeController } from "#controllers/home_controller";

const app = createApplication({
  routes,
  controllers: { home: HomeController },
});

// Every channel in app/channels, served at /cable. Here rather than something
// to remember later: a generated channel that nothing mounts cannot receive a
// connection however correct it is.
await mountCable(app);

// The mailer previews, at /altair/mailers. Off in production by default,
// because a preview builds a message from sample data and shows it to whoever
// asks for it.
await mountPreviews(app);

const server = await app.listen();
console.log(\`Listening on http://localhost:\${server.port}\`);
`,
    },
    {
      // The scripts in package.json call this, and until now it was not
      // written: `bun run db:migrate` in a new application failed on a file
      // the generator had never made. Rails' `bin/rails` is the same idea.
      path: "bin/altair.ts",
      contents: `import "@altair/cli/bin";
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
      path: "config/environments/development.ts",
      contents: `import type { ApplicationConfig } from "@altair/core";

// What changes in development. Everything else comes from the defaults.
export default {
  showDetailedErrors: true,
  log: { level: "debug", format: "text", queries: true },
} satisfies Partial<ApplicationConfig>;
`,
    },
    {
      path: "config/environments/production.ts",
      contents: `import type { ApplicationConfig } from "@altair/core";

// The strict settings are the defaults; this is where to relax or tighten
// them. A function gets the defaults, for anything that depends on them.
export default {
  forceSsl: true,
  showDetailedErrors: false,
  log: { level: "info", format: "json", queries: false },
} satisfies Partial<ApplicationConfig>;
`,
    },
    {
      path: "config/environments/test.ts",
      contents: `import type { ApplicationConfig } from "@altair/core";

export default {
  database: { url: "sqlite://:memory:" },
  log: { level: "fatal", format: "json", queries: false },
} satisfies Partial<ApplicationConfig>;
`,
    },
    // Served when a request fails, and editable — an application should be
    // able to put a 404 in its own design without the framework having an
    // opinion about typography. Rails generates these for the same reason.
    {
      path: "public/404.html",
      contents: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Page not found</title>
    <style>
      body {
        font-family: system-ui, sans-serif;
        margin: 0;
        display: grid;
        place-items: center;
        min-height: 100vh;
        color: #1f2328;
        background: #fff;
      }
      main { text-align: center; padding: 2rem; }
      h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
      p { margin: 0; color: #59636e; }
      @media (prefers-color-scheme: dark) {
        body { color: #f0f6fc; background: #0d1117; }
        p { color: #9198a1; }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Page not found</h1>
      <p>The page you were looking for does not exist.</p>
    </main>
  </body>
</html>
`,
    },
    {
      path: "public/500.html",
      contents: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Something went wrong</title>
    <style>
      body {
        font-family: system-ui, sans-serif;
        margin: 0;
        display: grid;
        place-items: center;
        min-height: 100vh;
        color: #1f2328;
        background: #fff;
      }
      main { text-align: center; padding: 2rem; }
      h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
      p { margin: 0; color: #59636e; }
      @media (prefers-color-scheme: dark) {
        body { color: #f0f6fc; background: #0d1117; }
        p { color: #9198a1; }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Something went wrong</h1>
      <p>We have been notified and are looking into it.</p>
    </main>
  </body>
</html>
`,
    },
    {
      // Rails writes one too. It is also the smallest proof that the static
      // file server in the default stack is actually reachable.
      path: "public/robots.txt",
      contents: `# See https://www.robotstxt.org/robotstxt.html
User-agent: *
Disallow:
`,
    },
    {
      path: "config/initializers/.gitkeep",
      contents: "",
    },
    {
      path: "db/seeds.ts",
      contents: `// Run with \`altair db:seed\`. Written to be safe to run twice: seeding is
// something people do on a whim, and a script that duplicates every row when
// it runs again is a script nobody dares run.
//
//   import { User } from "#models/user"
//
//   export default async function seed(): Promise<void> {
//     await User.findOrCreateBy({ email: "admin@example.com" }, { name: "Admin" })
//   }

export default async function seed(): Promise<void> {}
`,
    },
    {
      path: "db/.gitkeep",
      contents: "",
    },
    {
      path: ".gitignore",
      // The master key is the one thing that must not be committed:
      // everything encrypted beside it is readable the moment it is.
      contents:
        "node_modules/\ndb/*.sqlite3\n.env\n.env.*\n!.env.example\n" +
        "config/master.key\nconfig/credentials/*.key\n",
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
            // Without this, `target: ESNext` pulls in the DOM library, whose
            // `Response` and `BodyInit` are not Bun's — and the framework then
            // does not typecheck inside the application that installed it. An
            // application that runs on a server has no DOM to describe.
            lib: ["ESNext"],
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
    "  generate KIND NAME        model, controller, migration, scaffold, mailer, job, channel",
    "  destroy, d KIND NAME      Remove what generate wrote",
    "  db:create                 Create the database",
    "  db:drop                   Drop the database",
    "  db:prepare                Create it, migrate it, and seed it if it was new",
    "  db:reset                  Drop it, then prepare it again",
    "  db:migrate                Run pending migrations",
    "  db:rollback [STEPS]       Roll back the last migration",
    "  db:status                 Show which migrations have run",
    "  db:seed                   Run db/seeds.ts",
    "  db:schema:dump            Write db/schema.ts from the database",
    "  db:schema:load            Load db/schema.ts into the database",
    "  routes                    List the route table",
    "  routes:types              Generate typed path helpers into config/paths.ts",
    "  server, s                 Run the application with reloading",
    "  console, c                A prompt with the application booted",
    "  runner, r                 Run a script, or -e 'code', against the application",
    "  jobs:work [--queue=NAME]  Run queued jobs until stopped",
    "  storage:install           Write the migration Active Storage needs",
    "  richtext:install          Write the migration rich text needs",
    "  secret                    Print a new SECRET_KEY_BASE",
    "  credentials:edit          Edit the encrypted credentials in $EDITOR",
    "  credentials:show          Print the decrypted credentials",
    "",
    "Options:",
    "  --environment ENV         Which environment a command applies to",
  ].join("\n");
}
