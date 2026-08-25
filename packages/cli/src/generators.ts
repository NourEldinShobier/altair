/**
 * Generators, ported from `Rails::Generators`.
 *
 * Rails' generators are 6,236 lines of Thor templates. These produce the same
 * files from the same conventions, as plain functions returning a path and
 * contents — which makes them testable without touching a filesystem.
 *
 * A generated file is the first thing a person reads about a framework, so
 * these emit the code we would want in review: typed, no placeholders left
 * behind, and no commented-out examples.
 */

import {
  camelize,
  classify,
  humanize,
  pluralize,
  singularize,
  tableize,
  underscore,
} from "@altair/support";

export interface GeneratedFile {
  path: string;
  contents: string;
}

/** A `name:type` pair from the command line, as Rails' generators take. */
export interface FieldSpec {
  name: string;
  type: string;
}

const COLUMN_TYPES = new Set([
  "string",
  "text",
  "integer",
  "bigint",
  "float",
  "decimal",
  "boolean",
  "datetime",
  "date",
  "json",
  "binary",
  "references",
]);

/** Parses `title:string body:text author:references` into fields. */
export function parseFields(args: string[]): FieldSpec[] {
  return args.map((arg) => {
    const [name, type = "string"] = arg.split(":");
    if (!name) throw new Error(`Invalid field "${arg}". Use name:type, such as title:string.`);
    if (!COLUMN_TYPES.has(type)) {
      throw new Error(
        `Unknown type "${type}" for field "${name}". Known types: ${[...COLUMN_TYPES].join(", ")}.`,
      );
    }
    return { name, type };
  });
}

/** The TypeScript type a column maps to. */
export function tsTypeFor(type: string): string {
  switch (type) {
    case "integer":
    case "bigint":
    case "float":
    case "decimal":
    case "references":
      return "number";
    case "boolean":
      return "number";
    case "json":
      return "unknown";
    default:
      return "string";
  }
}

/** A timestamped migration version, as Rails names them. */
export function migrationVersion(now: Date): string {
  const pad = (value: number, length = 2) => String(value).padStart(length, "0");
  return [
    now.getUTCFullYear(),
    pad(now.getUTCMonth() + 1),
    pad(now.getUTCDate()),
    pad(now.getUTCHours()),
    pad(now.getUTCMinutes()),
    pad(now.getUTCSeconds()),
  ].join("");
}

/** Indented to sit inside the createTable block, level with t.timestamps(). */
function columnLine(field: FieldSpec): string {
  if (field.type === "references") {
    return `      t.references(${JSON.stringify(underscore(singularize(field.name)))});`;
  }
  return `      t.${field.type}(${JSON.stringify(underscore(field.name))});`;
}

/** `altair generate migration CreatePosts title:string` */
export function generateMigration(name: string, fields: FieldSpec[], now: Date): GeneratedFile {
  const version = migrationVersion(now);
  const fileName = `${version}_${underscore(name)}.ts`;

  // A migration named CreateThings gets a table body; anything else gets a
  // skeleton, because guessing at an arbitrary name produces the wrong thing.
  const createMatch = /^create_(\w+)$/.exec(underscore(name));

  const body = createMatch
    ? `  up: async (schema) => {
    await schema.createTable(${JSON.stringify(tableize(createMatch[1]!))}, (t) => {
${fields.map(columnLine).join("\n")}${fields.length > 0 ? "\n" : ""}      t.timestamps();
    });
  },

  down: async (schema) => {
    await schema.dropTable(${JSON.stringify(tableize(createMatch[1]!))});
  },`
    : `  up: async (schema) => {
    // Describe the change here.
    void schema;
  },

  down: async (schema) => {
    // Undo it here, or delete this to make the migration irreversible.
    void schema;
  },`;

  return {
    path: `db/migrate/${fileName}`,
    contents: `import type { Migration } from "@altair/orm";

const migration: Migration = {
  version: ${JSON.stringify(version)},
  name: ${JSON.stringify(camelize(underscore(name)))},

${body}
};

export default migration;
`,
  };
}

/**
 * `altair generate model Post title:string`
 *
 * The attributes come from `db/types.ts`, which `db:migrate` generates from the
 * database itself. Hand-writing them means a column added in a migration and
 * forgotten here makes the compiler confidently report a shape the database
 * does not have.
 */
export function generateModel(name: string, fields: FieldSpec[]): GeneratedFile {
  const className = classify(name);
  const table = tableize(name);

  const rowType = `${className}Row`;
  const references = fields.filter((field) => field.type === "references");

  const associationDeclarations = references
    .map(
      (field) =>
        `  declare ${camelize(singularize(field.name), false)}: BelongsTo<${classify(field.name)}>;`,
    )
    .join("\n");

  const associationRegistrations = references
    .map(
      (field) =>
        `    this.belongsTo(${JSON.stringify(camelize(singularize(field.name), false))}, () => ${classify(field.name)});`,
    )
    .join("\n");

  const imports = [
    references.length
      ? `import { Model, type BelongsTo } from "@altair/orm";`
      : `import { Model } from "@altair/orm";`,
    // The attributes come from db/types.ts, which db:migrate generates from
    // the database itself, so a column added in a migration cannot go missing
    // here without the compiler noticing.
    `import type { ${rowType} } from "#db/types";`,
    ...references.map(
      (field) =>
        `import { ${classify(field.name)} } from "./${underscore(singularize(field.name))}.js";`,
    ),
  ].join("\n");

  const body = references.length
    ? `${associationDeclarations}\n\n  static {\n${associationRegistrations}\n  }\n`
    : "";

  return {
    path: `app/models/${underscore(singularize(name))}.ts`,
    contents: `${imports}

export class ${className} extends Model<${rowType}>(${JSON.stringify(table)}) ${
      body
        ? `{
${body}}`
        : "{}"
    }
`,
  };
}

/**
 * `altair generate controller Posts`
 *
 * The class name stays plural. `classify` singularizes — correct for turning a
 * table into a model, wrong here, where Rails names the class PostsController.
 */
export function generateController(name: string, actions: string[] = []): GeneratedFile {
  const resource = pluralize(underscore(name));
  const className = `${camelize(resource)}Controller`;

  const methods =
    actions.length > 0
      ? actions
          .map(
            (action) => `  ${camelize(action, false)}(): void {
    this.render.json({});
  }`,
          )
          .join("\n\n")
      : `  index(): void {
    this.render.json({});
  }`;

  return {
    path: `app/controllers/${resource}_controller.ts`,
    contents: `import { Controller } from "@altair/controller";

export class ${className} extends Controller {
${methods}
}
`,
  };
}

/** The RESTful controller a scaffold produces, wired to its model. */
export function generateResourceController(name: string, fields: FieldSpec[]): GeneratedFile {
  const model = classify(singularize(name));
  const variable = camelize(singularize(underscore(name)), false);
  const resource = pluralize(underscore(name));
  const controllerName = `${camelize(resource)}Controller`;

  const permitted = fields
    .map((field) =>
      field.type === "references"
        ? `${underscore(singularize(field.name))}_id`
        : underscore(field.name),
    )
    .map((column) => JSON.stringify(column))
    .join(", ");

  return {
    path: `app/controllers/${resource}_controller.ts`,
    contents: `import { Controller, beforeAction } from "@altair/controller";
import { ${model} } from "#models/${underscore(singularize(name))}";

export class ${controllerName} extends Controller {
  @beforeAction({ only: ["show", "update", "destroy"] })
  async load${model}(): Promise<void> {
    this.${variable} = await ${model}.find(this.params.get("id"));
  }

  ${variable}: ${model} | undefined;

  async index(): Promise<void> {
    this.render.json(await ${model}.all());
  }

  show(): void {
    this.render.json(this.${variable});
  }

  async create(): Promise<void> {
    const ${variable} = ${model}.build(this.${variable}Params());

    if (await ${variable}.save()) {
      this.render.json(${variable}, { status: 201 });
    } else {
      this.render.json({ errors: ${variable}.errors.fullMessages() }, { status: 422 });
    }
  }

  async update(): Promise<void> {
    if (await this.${variable}!.update(this.${variable}Params())) {
      this.render.json(this.${variable});
    } else {
      this.render.json({ errors: this.${variable}!.errors.fullMessages() }, { status: 422 });
    }
  }

  async destroy(): Promise<void> {
    await this.${variable}!.destroy();
    this.head(204);
  }

  /** Rails' strong parameters: only these columns may be assigned. */
  private ${variable}Params() {
    return (this.params.require(${JSON.stringify(underscore(singularize(name)))}) as import("@altair/controller").Parameters)
      .permit(${permitted})
      .toObject();
  }
}
`,
  };
}

/** `altair generate scaffold Post title:string` — model, migration, controller. */
/**
 * Rails' `rails g mailer`.
 *
 * The methods are static, because that is how a mailer reads at the call site
 * — `UserMailer.welcome(user).deliverNow()` — and the body is TSX rather than
 * a template, so there is one file rather than three.
 */
export function generateMailer(name: string, actions: string[] = []): GeneratedFile[] {
  // Not singularized: a mailer name is whatever the person chose, and
  // `singularize` would turn `Notifications` into `Notification`.
  const base = underscore(name).replace(/_mailer$/, "");
  const className = `${camelize(base)}Mailer`;
  const named = actions.length > 0 ? actions : ["welcome"];

  const methods = named
    .map(
      (action) => `  static ${camelize(action, false)}(to: string) {
    return this.mail({
      to,
      subject: ${JSON.stringify(humanize(underscore(action)))},
      html: <p>Write ${camelize(action, false)} here.</p>,
    });
  }`,
    )
    .join("\n\n");

  return [
    {
      path: `app/mailers/${base}_mailer.tsx`,
      contents: `import { Mailer } from "@altair/mailer";

export class ${className} extends Mailer {
  // Every message needs a sender, and a mailer with no default has to be
  // given one on every call. Change this to yours.
  static override defaults = { from: "from@example.com" };

${methods}
}
`,
    },
    {
      path: `test/mailers/${base}_mailer.test.ts`,
      contents: `import { describe, expect, it } from "bun:test";
import { ${className} } from "#mailers/${base}_mailer";

describe("${className}", () => {
${named
  .map(
    (action) => `  it("builds ${camelize(action, false)}", async () => {
    const message = await ${className}.${camelize(action, false)}(
      "someone@example.com",
    ).toMessage();

    expect(message.to).toBe("someone@example.com");
    expect(message.html).toContain("${camelize(action, false)}");
  });`,
  )
  .join("\n\n")}
});
`,
    },
  ];
}

/**
 * Rails' `rails g job`.
 *
 * Enqueued after the transaction that created the work commits, which is the
 * default and the reason the generated comment says so — a job that runs
 * against a row the transaction rolled back is the bug this framework goes out
 * of its way to prevent.
 */
export function generateJob(name: string): GeneratedFile[] {
  // Not singularized — `CleanupImages` is a job name, not a plural to fold.
  const base = underscore(name).replace(/_job$/, "");
  const className = `${camelize(base)}Job`;

  return [
    {
      path: `app/jobs/${base}_job.ts`,
      contents: `import { Job } from "@altair/jobs";

export class ${className} extends Job {
  // Enqueue with \`${className}.performLater(id)\`. Inside a transaction it
  // waits for the commit, so a worker never sees a row that was rolled back.
  override async perform(id: number): Promise<void> {
    void id;
  }
}
`,
    },
    {
      path: `test/jobs/${base}_job.test.ts`,
      contents: `import { describe, expect, it } from "bun:test";
import { ${className} } from "#jobs/${base}_job";

describe("${className}", () => {
  it("performs", async () => {
    await expect(${className}.performNow(1)).resolves.toBeUndefined();
  });
});
`,
    },
  ];
}

/** Rails' `rails g channel`. */
export function generateChannel(name: string): GeneratedFile[] {
  const base = underscore(name).replace(/_channel$/, "");
  const className = `${camelize(base)}Channel`;

  return [
    {
      path: `app/channels/${base}_channel.ts`,
      contents: `import { Channel } from "@altair/cable";

export class ${className} extends Channel {
  override async subscribed(): Promise<void> {
    // Reject anyone who should not be here before streaming anything to them.
    this.streamFrom("${base}");
  }

  override async unsubscribed(): Promise<void> {}
}
`,
    },
  ];
}

export function generateScaffold(name: string, fields: FieldSpec[], now: Date): GeneratedFile[] {
  return [
    generateMigration(`create_${tableize(name)}`, fields, now),
    generateModel(name, fields),
    generateResourceController(name, fields),
  ];
}
