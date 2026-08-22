/**
 * The console, ported from `rails console`.
 *
 * A REPL with the application already booted, so a question about the data is
 * a line rather than a script. Bun has no `node:repl`, which was checked
 * rather than assumed, so this is built on `readline` and an async function
 * constructor — which turns out to be the right shape anyway, because it makes
 * `await` work at the prompt without ceremony.
 */

import { createInterface } from "node:readline/promises";

/** Names the console makes available at the prompt: models, helpers, the app. */
export type ConsoleContext = Record<string, unknown>;

const AsyncFunction = Object.getPrototypeOf(async function () {
  /* the constructor is the point */
}).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<unknown>;

/**
 * Whether a line can be run, or is still waiting for a closing bracket.
 *
 * Enough to let a multi-line paste work. Brackets inside strings are not
 * counted, because `"("` is not an open paren.
 */
export function isComplete(source: string): boolean {
  let depth = 0;
  let quote: string | undefined;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;

    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = undefined;
      continue;
    }

    if (character === '"' || character === "'" || character === "`") quote = character;
    else if (character === "(" || character === "[" || character === "{") depth += 1;
    else if (character === ")" || character === "]" || character === "}") depth -= 1;
  }

  return depth <= 0 && quote === undefined;
}

/**
 * A declaration the console should remember, if the line is one.
 *
 * ponytail: single declarations only — `const post = await Post.find(1)`. A
 * destructuring or multi-name declaration evaluates and is not kept. Rewriting
 * arbitrary declarations means parsing JavaScript, which is a lot to carry for
 * a prompt.
 */
export function declaredName(source: string): { name: string; expression: string } | undefined {
  const match = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([\s\S]+?);?\s*$/.exec(source);
  if (!match) return undefined;

  return { name: match[1]!, expression: match[2]! };
}

/**
 * Runs one line against the context.
 *
 * An expression is evaluated and its value returned; anything else runs as
 * statements. A declaration is stored back into the context, so the next line
 * can use it — which is the difference between a console and a calculator.
 */
export async function evaluateInput(
  source: string,
  context: ConsoleContext,
): Promise<{ value: unknown; assigned?: string }> {
  const declaration = declaredName(source);

  if (declaration) {
    const value = await run(declaration.expression, context, true);
    context[declaration.name] = value;
    return { value, assigned: declaration.name };
  }

  try {
    return { value: await run(source, context, true) };
  } catch (error) {
    // A statement is a syntax error when wrapped as an expression. Anything
    // else is the line's own error and belongs to the caller.
    if (!(error instanceof SyntaxError)) throw error;
    return { value: await run(source, context, false) };
  }
}

async function run(
  source: string,
  context: ConsoleContext,
  asExpression: boolean,
): Promise<unknown> {
  const names = Object.keys(context);
  const body = asExpression ? `return (${source});` : source;
  const compiled = new AsyncFunction(...names, `"use strict";\n${body}`);

  return await compiled(...names.map((name) => context[name]));
}

/**
 * Anything that can describe itself as a row.
 *
 * Structural rather than an import of Model: the console has no business
 * depending on the ORM, and anything that answers `attributes()` is worth
 * printing the same way.
 */
function isRecordLike(value: unknown): value is { attributes(): Record<string, unknown> } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { attributes?: unknown }).attributes === "function"
  );
}

/**
 * Renders a record the way Rails does: its class and its columns.
 *
 * Inspecting a model otherwise prints every method and internal symbol on it,
 * which buries the two fields the question was about.
 */
function formatRecord(record: { attributes(): Record<string, unknown> }): string {
  const name = record.constructor?.name ?? "Record";

  try {
    const fields = Object.entries(record.attributes())
      .map(([key, value]) => `${key}: ${formatValue(value)}`)
      .join(", ");

    return `#<${name} ${fields}>`;
  } catch {
    return `#<${name}>`;
  }
}

/** Renders a value the way a prompt should: readable, and never a crash. */
export function formatValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);

  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }

  if (isRecordLike(value)) return formatRecord(value);

  // A list of records is what a query returns, and is worth the same treatment.
  if (Array.isArray(value) && value.some(isRecordLike)) {
    return `[${value.map((item) => formatValue(item)).join(", ")}]`;
  }

  try {
    return Bun.inspect(value);
  } catch {
    // An object with a throwing getter should not take the prompt down.
    return String(value);
  }
}

export interface ConsoleIO {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

export interface ConsoleOptions {
  prompt?: string;
  banner?: string;
  io?: ConsoleIO;
}

/**
 * Reads lines and evaluates them until the input ends.
 *
 * The loop is separated from what it evaluates so the interesting half is
 * testable without a terminal.
 */
export async function startConsole(
  context: ConsoleContext,
  options: ConsoleOptions = {},
): Promise<void> {
  const io = options.io ?? { input: process.stdin, output: process.stdout };
  const reader = createInterface({ input: io.input, output: io.output, terminal: false });

  const prompt = options.prompt ?? "altair> ";
  const write = (text: string) => io.output.write(`${text}\n`);

  if (options.banner) write(options.banner);

  // Iterated rather than questioned one at a time: readline throws instead of
  // rejecting once the input ends, and piped input arrives buffered — a loop
  // that asks for the next line can close before it has read what is already
  // waiting.
  let pending = "";
  io.output.write(prompt);

  for await (const line of reader) {
    pending = pending
      ? `${pending}
${line}`
      : line;

    if (pending.trim() === "") {
      pending = "";
      io.output.write(prompt);
      continue;
    }

    if (pending.trim() === ".exit" || pending.trim() === "exit") break;

    if (!isComplete(pending)) {
      io.output.write("...     ");
      continue;
    }

    const source = pending;
    pending = "";

    try {
      const { value, assigned } = await evaluateInput(source, context);
      if (assigned) write(`${assigned} = ${formatValue(value)}`);
      else if (value !== undefined) write(`=> ${formatValue(value)}`);
    } catch (error) {
      // An error at the prompt is an answer, not a reason to stop.
      write(formatValue(error));
    }

    io.output.write(prompt);
  }

  reader.close();
}
