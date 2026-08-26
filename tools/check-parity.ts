/**
 * Checks the numbers in PARITY.md against the suite that produced them.
 *
 * The file is the project's public claim about how far along it is, which
 * makes a wrong number there worse than a wrong number anywhere else. It has
 * drifted repeatedly — a package gains tests, the row keeps yesterday's
 * figure, and nobody notices because nothing reads it.
 *
 *     bun run tools/check-parity.ts        # report
 *     bun run tools/check-parity.ts --fix  # rewrite the rows
 *
 * Run from `verify.sh`, so the claim cannot go stale without the gate saying
 * so.
 */

// A module, so top-level await is allowed.
export {};

const PACKAGES = [
  "support",
  "orm",
  "controller",
  "cli",
  "router",
  "cable",
  "storage",
  "view",
  "jobs",
  "testing",
  "core",
  "mailer",
];

/** Runs one package's suite and reads the count off the summary. */
async function countFor(name: string): Promise<number> {
  const result = Bun.spawnSync(["bun", "test", `packages/${name}`], {
    stdout: "pipe",
    stderr: "pipe",
  });

  // Bun writes its summary to stderr.
  const output = `${result.stderr.toString()}${result.stdout.toString()}`;
  const match = /^\s*(\d+)\s+pass/m.exec(output);

  if (!match) throw new Error(`Could not read a test count for ${name}.`);

  // A red suite has no count worth writing down. Without this a single flaky
  // failure came back as "says 3,303, actually 3,302" — which reads as a stale
  // number and sends you to `--fix`, quietly recording the smaller figure as
  // the truth. It cost two wrong diagnoses before anyone looked at the exit
  // code.
  const failed = /^\s*(\d+)\s+fail/m.exec(output);

  if (result.exitCode !== 0 || (failed && Number(failed[1]) > 0)) {
    const names = [...output.matchAll(/^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/gm)].map(
      (line) => `    ${line[1]}`,
    );

    throw new Error(
      `packages/${name} is not green, so its test count means nothing:\n${names.join("\n")}`,
    );
  }

  return Number(match[1]);
}

const counts = new Map<string, number>();
for (const name of PACKAGES) counts.set(name, await countFor(name));

const total = [...counts.values()].reduce((sum, count) => sum + count, 0);

const path = "PARITY.md";
let source = await Bun.file(path).text();

interface Problem {
  what: string;
  claimed: string;
  actual: string;
}

const problems: Problem[] = [];

for (const [name, count] of counts) {
  const row = new RegExp(`^\\| \`@altair/${name}\`(\\s*)\\| (\\d+)(\\s*)\\|`, "m");
  const found = row.exec(source);

  if (!found) {
    problems.push({ what: `@altair/${name}`, claimed: "no row", actual: String(count) });
    continue;
  }

  if (found[2] !== String(count)) {
    problems.push({ what: `@altair/${name}`, claimed: found[2] as string, actual: String(count) });
  }

  // The column is padded, so the replacement keeps the table aligned.
  const width = (found[2] as string).length + (found[3] as string).length;
  const padded = String(count).padEnd(width, " ");
  source = source.replace(row, `| \`@altair/${name}\`$1| ${padded}|`);
}

const totalRow = /\| \*\*Total\*\* \| \*\*([\d,]+)\*\*(\s*)\| ([\d,]+)\s*\|\s*([\d.]+)% \|/;
const foundTotal = totalRow.exec(source);

if (!foundTotal) {
  problems.push({ what: "total", claimed: "no row", actual: String(total) });
} else {
  const claimed = (foundTotal[1] as string).replace(/,/g, "");
  if (claimed !== String(total)) {
    problems.push({ what: "total", claimed: foundTotal[1] as string, actual: String(total) });
  }

  const rails = Number((foundTotal[3] as string).replace(/,/g, ""));
  const share = ((total / rails) * 100).toFixed(1);

  source = source.replace(
    totalRow,
    `| **Total** | **${total.toLocaleString("en-US")}**$2| ${foundTotal[3]}    | ${share}% |`,
  );

  // The same figure written out in the closing paragraph. It said 8% while the
  // table said 12.3%, because only the table was ever checked — and the
  // sentence is the part somebody reads.
  const prose = /depth: ([\d.]+)% of Rails' test count, not ([\d.]+)% of Rails\./;
  const foundProse = prose.exec(source);

  if (!foundProse) {
    problems.push({ what: "the closing sentence", claimed: "not found", actual: `${share}%` });
  } else if (foundProse[1] !== share) {
    problems.push({
      what: "the closing sentence",
      claimed: `${foundProse[1]}%`,
      actual: `${share}%`,
    });
    source = source.replace(
      prose,
      `depth: ${share}% of Rails' test count, not ${share}% of Rails.`,
    );
  }
}

if (Bun.argv.includes("--fix")) {
  await Bun.write(path, source);
  console.log(`Rewrote ${problems.length} row(s) in ${path}.`);
} else if (problems.length > 0) {
  console.error(`${path} does not match the suite:\n`);
  for (const problem of problems) {
    console.error(
      `  ${problem.what.padEnd(20)} says ${problem.claimed}, actually ${problem.actual}`,
    );
  }
  console.error(`\nRun \`bun run tools/check-parity.ts --fix\` to correct it.`);
  process.exit(1);
} else {
  console.log(`${path} matches the suite: ${total.toLocaleString("en-US")} tests.`);
}
