/**
 * Collecting bind values as a statement is built, ported from
 * `activerecord/test/cases/bind_parameter_test.rb` and the quoting cases in
 * `activerecord/test/cases/quoting_test.rb`.
 *
 * The numbering is what these tests are really about. PostgreSQL numbers its
 * placeholders and the others do not, so a fragment built alone and spliced in
 * second has to be renumbered — and getting that wrong does not fail, it binds
 * the right number of values in the wrong order and returns somebody else's
 * rows.
 */

import { describe, expect, it } from "bun:test";
import { Connection } from "../src/connection.js";
import {
  BindCollector,
  UnsafeOrder,
  boundSqlLiteralFor,
  buildBindAttribute,
  escapeBytea,
  quoteTableNameForAssignment,
  quotedBinary,
  quotedColumnsForIndex,
  quotedPrimaryKey,
  quotedTableName,
  quotedTime,
  sanitizeAsSqlComment,
  sanitizeSqlForOrder,
  typeCastedBinds,
  typeToSql,
  unescapeBytea,
  unquotedFalse,
  unquotedTrue,
} from "../src/binds.js";

const sqlite = new Connection("sqlite://:memory:");
const postgres = new Connection("postgres://localhost/x");
const mysql = new Connection("mysql://localhost/x");

describe("collecting binds", () => {
  it("leaves a placeholder and keeps the value", () => {
    const collector = new BindCollector(sqlite);
    collector.append("SELECT * FROM posts WHERE id = ").addBind(buildBindAttribute("id", 7));

    expect(collector.toSqlAndBinds()).toEqual({
      sql: "SELECT * FROM posts WHERE id = ?",
      binds: [7],
    });
  });

  /** The caller never writes a number, so it cannot write the wrong one. */
  it("numbers them for postgres", () => {
    const collector = new BindCollector(postgres);
    collector
      .append("WHERE a = ")
      .addBind(buildBindAttribute("a", 1))
      .append(" AND b = ")
      .addBind(buildBindAttribute("b", 2));

    expect(collector.sql).toBe("WHERE a = $1 AND b = $2");
  });

  it("does not number them elsewhere", () => {
    const collector = new BindCollector(mysql);
    collector.addBind(buildBindAttribute("a", 1)).addBind(buildBindAttribute("b", 2));

    expect(collector.sql).toBe("??");
  });

  it("adds several at once", () => {
    const collector = new BindCollector(postgres);
    collector
      .append("IN (")
      .addBinds([buildBindAttribute("a", 1), buildBindAttribute("b", 2)])
      .append(")");

    expect(collector.toSqlAndBinds()).toEqual({ sql: "IN ($1, $2)", binds: [1, 2] });
  });

  /**
   * With nothing collected first the numbering is right either way, so the
   * case that tells "counted from what came before" apart from "counted from
   * zero" needs a bind already in place.
   */
  it("numbers several from what came before them", () => {
    const collector = new BindCollector(postgres);
    collector
      .append("a = ")
      .addBind(buildBindAttribute("a", 1))
      .append(" AND b IN (")
      .addBinds([buildBindAttribute("b", 2), buildBindAttribute("c", 3)])
      .append(")");

    expect(collector.sql).toBe("a = $1 AND b IN ($2, $3)");
  });

  it("says whether it collected any", () => {
    const collector = new BindCollector(sqlite);

    expect(collector.hasBinds()).toBe(false);

    collector.addBind(buildBindAttribute("a", 1));

    expect(collector.hasBinds()).toBe(true);
  });

  it("hands back the binds with their names", () => {
    const collector = new BindCollector(sqlite);
    collector.addBind(buildBindAttribute("title", "hello"));

    expect(collector.getBinding()[0]?.name).toBe("title");
  });

  it("serializes a value on the way out", () => {
    const collector = new BindCollector(sqlite);
    collector.addBind(buildBindAttribute("at", new Date(0), (value) => (value as Date).getTime()));

    expect(collector.getBindValues()).toEqual([0]);
  });

  it("leaves a value alone when nothing serializes it", () => {
    expect(typeCastedBinds([buildBindAttribute("a", "hello")])).toEqual(["hello"]);
  });
});

describe("splicing one statement into another", () => {
  /**
   * The operation the collector exists for. Pasting the text unchanged binds
   * the right number of values in the wrong order.
   */
  it("renumbers the spliced placeholders on postgres", () => {
    const outer = new BindCollector(postgres);
    outer.append("WHERE a = ").addBind(buildBindAttribute("a", 1));

    const inner = new BindCollector(postgres);
    inner.append("AND b = ").addBind(buildBindAttribute("b", 2));

    outer.merge(inner);

    expect(outer.sql).toBe("WHERE a = $1 AND b = $2");
  });

  it("carries the values in the right order", () => {
    const outer = new BindCollector(postgres);
    outer.append("a = ").addBind(buildBindAttribute("a", "first"));

    const inner = new BindCollector(postgres);
    inner.append("b = ").addBind(buildBindAttribute("b", "second"));

    outer.merge(inner);

    expect(outer.getBindValues()).toEqual(["first", "second"]);
  });

  /**
   * Rewriting lowest-first would turn $1 into $3 and then the pass for $3
   * would turn it into $5.
   */
  it("does not renumber a placeholder twice", () => {
    // One bind outside, two inside. Rewriting lowest-first turns $1 into $2 —
    // which the pass for $2 then turns into $3, so both inner placeholders end
    // up as $3 and the second value is never read. An offset of two happens to
    // come out right either way, which is why this uses one.
    const outer = new BindCollector(postgres);
    outer.addBind(buildBindAttribute("a", 1));

    const inner = new BindCollector(postgres);
    inner
      .append("(")
      .addBind(buildBindAttribute("b", 2))
      .append(",")
      .addBind(buildBindAttribute("c", 3))
      .append(")");

    outer.merge(inner);

    expect(outer.sql).toContain("($2,$3)");
  });

  it("leaves the text alone where placeholders are not numbered", () => {
    const outer = new BindCollector(mysql);
    outer.append("a = ").addBind(buildBindAttribute("a", 1));

    const inner = new BindCollector(mysql);
    inner.append("b = ").addBind(buildBindAttribute("b", 2));

    outer.merge(inner);

    expect(outer.sql).toBe("a = ? b = ?");
    expect(outer.getBindValues()).toEqual([1, 2]);
  });

  it("merges into an empty collector without a leading joiner", () => {
    const outer = new BindCollector(postgres);
    const inner = new BindCollector(postgres);
    inner.append("SELECT 1");

    outer.merge(inner);

    expect(outer.sql).toBe("SELECT 1");
  });
});

describe("a literal that carries its own values", () => {
  it("keeps the sql and names the binds", () => {
    const literal = boundSqlLiteralFor("lag(views) OVER (ORDER BY id) > ?", [10]);

    expect(literal.sql).toContain("lag(views)");
    expect(literal.binds).toHaveLength(1);
    expect(literal.binds[0]?.value).toBe(10);
  });

  it("takes none", () => {
    expect(boundSqlLiteralFor("NOW()", []).binds).toEqual([]);
  });
});

describe("quoting names", () => {
  it("quotes a table", () => {
    expect(quotedTableName(sqlite, "posts")).toBe('"posts"');
    expect(quotedTableName(mysql, "posts")).toBe("`posts`");
  });

  it("quotes each part of a qualified name separately", () => {
    expect(quotedTableName(postgres, "public.posts")).toBe('"public"."posts"');
  });

  it("quotes a primary key", () => {
    expect(quotedPrimaryKey(sqlite, "id")).toBe('"id"');
  });

  /** `UPDATE posts SET posts.title` is a syntax error on MySQL. */
  it("leaves the table off an assignment on mysql", () => {
    expect(quoteTableNameForAssignment(mysql, "posts", "title")).toBe("`title`");
  });

  it("keeps it elsewhere", () => {
    expect(quoteTableNameForAssignment(postgres, "posts", "title")).toBe('"posts"."title"');
  });

  it("quotes index columns", () => {
    expect(quotedColumnsForIndex(sqlite, ["title", "body"])).toEqual(['"title"', '"body"']);
  });

  it("keeps an ordering where one was given", () => {
    expect(quotedColumnsForIndex(sqlite, ["title"], { title: "DESC" })).toEqual(['"title" DESC']);
  });
});

describe("quoting values", () => {
  it("spells a boolean the way each adapter takes it", () => {
    expect(unquotedTrue(sqlite)).toBe(1);
    expect(unquotedFalse(sqlite)).toBe(0);
    expect(unquotedTrue(postgres)).toBe(true);
    expect(unquotedFalse(mysql)).toBe(false);
  });

  it("writes a time the way each adapter takes it", () => {
    const at = new Date("2026-06-15T12:00:00.000Z");

    expect(quotedTime(postgres, at)).toBe("2026-06-15T12:00:00.000Z");
    expect(quotedTime(mysql, at)).toBe("2026-06-15 12:00:00.000");
  });

  /**
   * The hex form survives a value containing a quote, a backslash or a null
   * byte — all three of which an uploaded file contains within its first few
   * bytes.
   */
  it("writes binary as hex", () => {
    const bytes = new Uint8Array([0, 39, 92, 255]);

    expect(quotedBinary(postgres, bytes)).toBe("'\\x00275cff'");
    expect(quotedBinary(mysql, bytes)).toBe("X'00275cff'");
  });

  it("round-trips bytes", () => {
    const bytes = new Uint8Array([0, 39, 92, 255]);

    expect(Array.from(unescapeBytea(escapeBytea(bytes)))).toEqual([0, 39, 92, 255]);
  });

  it("reads bytes written without the prefix", () => {
    expect(Array.from(unescapeBytea("00ff"))).toEqual([0, 255]);
  });
});

describe("what goes in a comment", () => {
  /**
   * A closing comment marker ends the comment and everything after it runs. A
   * comment carrying a controller and action is a comment carrying whatever
   * was in the URL.
   */
  it("removes anything that would end the comment", () => {
    expect(sanitizeAsSqlComment("posts#show */ DROP TABLE posts; /*")).not.toContain("*/");
  });

  it("removes an opening marker too", () => {
    expect(sanitizeAsSqlComment("a /* b")).not.toContain("/*");
  });

  it("flattens newlines", () => {
    expect(sanitizeAsSqlComment("one\ntwo")).toBe("one two");
  });

  it("leaves ordinary text alone", () => {
    expect(sanitizeAsSqlComment("controller:posts,action:show")).toBe(
      "controller:posts,action:show",
    );
  });
});

describe("an order fragment", () => {
  it("accepts a column", () => {
    expect(sanitizeSqlForOrder("title")).toBe("title");
  });

  it("accepts a direction", () => {
    expect(sanitizeSqlForOrder("title DESC")).toBe("title DESC");
    expect(sanitizeSqlForOrder("title asc")).toBe("title asc");
  });

  it("accepts a qualified column", () => {
    expect(sanitizeSqlForOrder("posts.title DESC")).toBe("posts.title DESC");
  });

  it("accepts a nulls clause", () => {
    expect(sanitizeSqlForOrder("title DESC NULLS LAST")).toBe("title DESC NULLS LAST");
  });

  /**
   * ORDER BY cannot take a bind — a placeholder is a value and this position
   * needs an identifier — so it has to be validated instead.
   */
  it("refuses anything else", () => {
    expect(() => sanitizeSqlForOrder("title; DROP TABLE posts")).toThrow(UnsafeOrder);
    expect(() => sanitizeSqlForOrder("(SELECT 1)")).toThrow(UnsafeOrder);
    expect(() => sanitizeSqlForOrder("title, body")).toThrow(UnsafeOrder);
  });

  it("says why", () => {
    expect(() => sanitizeSqlForOrder("evil()")).toThrow("bind parameter");
  });
});

describe("spelling a type", () => {
  it("takes a bare type", () => {
    expect(typeToSql(postgres, "integer")).toBe("INTEGER");
  });

  it("takes a limit", () => {
    expect(typeToSql(postgres, "varchar", { limit: 255 })).toBe("VARCHAR(255)");
  });

  it("takes a precision and scale", () => {
    expect(typeToSql(postgres, "decimal", { precision: 10, scale: 2 })).toBe("DECIMAL(10,2)");
  });

  it("takes a precision alone", () => {
    expect(typeToSql(postgres, "decimal", { precision: 10 })).toBe("DECIMAL(10)");
  });

  /** SQLite accepts a varchar length and ignores it, which reads as a constraint. */
  it("does not pretend sqlite enforces a varchar length", () => {
    expect(typeToSql(sqlite, "varchar")).toBe("TEXT");
  });
});
