/**
 * `explainPretty`, ported from `ExplainPrettyPrinter#pp` in
 * `activerecord/lib/active_record/connection_adapters/postgresql/explain_pretty_printer.rb`
 * and its MySQL sibling, matched against the sample output in each file's
 * comment.
 *
 * `explain()` hands back rows and is right to: what each adapter reports
 * differs enough that flattening it to a string would lose the detail somebody
 * ran it for. But rows are not what a person reads.
 *
 * A PostgreSQL plan is lines of indentation that only mean anything in order,
 * and `[{ "QUERY PLAN": "..." }, …]` in a console destroys the one property
 * that made it readable. A MySQL plan is ten columns wide and scrolls off.
 * Reading the plan is the entire reason to run explain, and an output nobody
 * can read is one nobody checks.
 */

import { describe, expect, it } from "bun:test";
import { explainPretty } from "../src/query_analysis.js";

describe("a plan in one column, as PostgreSQL reports it", () => {
  const plan = [
    { "QUERY PLAN": "Nested Loop Left Join  (cost=0.00..37.24 rows=8 width=0)" },
    { "QUERY PLAN": "  Join Filter: (posts.user_id = users.id)" },
    { "QUERY PLAN": "  ->  Seq Scan on posts  (cost=0.00..28.88 rows=8 width=4)" },
  ];

  it("keeps the indentation, which is the only thing carrying the tree", () => {
    const lines = explainPretty(plan).split("\n");

    expect(lines[2]).toBe(" Nested Loop Left Join  (cost=0.00..37.24 rows=8 width=0)");
    expect(lines[3]).toBe("   Join Filter: (posts.user_id = users.id)");
  });

  it("centres the header over a rule as wide as the widest line", () => {
    const lines = explainPretty(plan).split("\n");
    const widest = Math.max(...plan.map((row) => row["QUERY PLAN"].length)) + 2;

    expect(lines[1]).toBe("-".repeat(widest));
    expect(lines[0]?.trim()).toBe("QUERY PLAN");
    // Centred, not left-aligned. Asserted on the leading spaces, because
    // trimming the line is exactly what stops a test noticing the difference.
    expect(lines[0]).toBe(
      `${" ".repeat(Math.floor((widest - "QUERY PLAN".length) / 2))}QUERY PLAN`,
    );
  });

  it("counts the rows the way psql does", () => {
    expect(explainPretty(plan)).toContain("(3 rows)");
  });

  it("says row, not rows, for one", () => {
    expect(explainPretty([{ "QUERY PLAN": "Seq Scan on posts" }])).toContain("(1 row)");
  });

  it("draws no box around text that is already laid out", () => {
    expect(explainPretty(plan)).not.toContain("+--");
  });
});

describe("a plan in columns, as MySQL reports it", () => {
  const plan = [
    { id: 1, select_type: "SIMPLE", table: "users", type: "const", rows: 1, Extra: null },
    { id: 1, select_type: "SIMPLE", table: "posts", type: "ALL", rows: 12, Extra: "Using where" },
  ];

  it("draws the border the shell draws", () => {
    const lines = explainPretty(plan).split("\n");

    expect(lines[0]).toMatch(/^\+(-+\+)+$/);
    expect(lines[0]).toBe(lines[2]);
  });

  it("names the columns in the order they arrived", () => {
    expect(explainPretty(plan).split("\n")[1]).toContain("id | select_type | table");
  });

  it("pads every cell to its column, so the border lines up", () => {
    const lines = explainPretty(plan).split("\n");
    const widths = new Set(lines.slice(0, 6).map((line) => line.length));

    expect(widths.size).toBe(1);
  });

  /** A null is a value the plan is making a statement about, not an absence. */
  it("writes NULL rather than nothing", () => {
    expect(explainPretty(plan)).toContain("NULL");
  });

  /** Numbers right, text left — the alignment a shell uses to make a column scannable. */
  it("right-aligns a column that holds only numbers", () => {
    const line = explainPretty(plan).split("\n")[4] as string;

    // Padded to the header width, which is what lines the digits up.
    expect(line).toContain("|   12 |");
    expect(explainPretty(plan).split("\n")[3]).toContain("|    1 |");
  });

  it("left-aligns a column that holds any text", () => {
    expect(explainPretty(plan)).toContain("| SIMPLE      |");
  });

  /**
   * One text value is enough. A column of mostly numbers with a `Using index`
   * in it reads as text, and right-aligning the numbers under a left-aligned
   * word is the worst of both.
   */
  it("left-aligns a column that mixes numbers and text", () => {
    // Two columns, because one column is the PostgreSQL shape and takes the
    // other path entirely.
    const mixed = [
      { id: 1, key_len: 4 },
      { id: 2, key_len: "unknown" },
    ];
    const lines = explainPretty(mixed).split("\n");

    expect(lines[3]).toContain("| 4       |");
    expect(lines[4]).toContain("| unknown |");
  });

  it("counts the rows and the time when it was given one", () => {
    expect(explainPretty(plan, 0.004)).toContain("2 rows in set (0.00 sec)");
  });

  it("leaves the time out when it was not", () => {
    expect(explainPretty(plan)).toContain("2 rows in set");
    expect(explainPretty(plan)).not.toContain("sec");
  });
});

describe("nothing to print", () => {
  it("prints nothing", () => {
    expect(explainPretty([])).toBe("");
  });
});
