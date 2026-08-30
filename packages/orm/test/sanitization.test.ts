/**
 * Sanitization, ported from `activerecord/test/cases/sanitize_test.rb` and the
 * raw-SQL guard in `activerecord/test/cases/relation/where_test.rb`.
 */

import { describe, expect, it } from "bun:test";
import { Connection } from "../src/connection.js";
import {
  disallowRawSql,
  quoteColumnName,
  quoteDefaultExpression,
  quoteString,
  quoteTableName,
  quotedDate,
  quotedFalse,
  quotedTrue,
  sanitizeSqlArray,
  sanitizeSqlForAssignment,
  sanitizeSqlForConditions,
  sanitizeSqlLike,
  unquoteIdentifier,
} from "../src/sanitization.js";

/** No statement is run here; only the adapter's dialect is being asked. */
const sqlite = new Connection("sqlite://:memory:");
const postgres = new Connection("postgres://localhost/x", {} as never);
const mysql = new Connection("mysql://localhost/x", {} as never);

describe("sanitizeSqlLike", () => {
  /** The bug that reads like a ranking problem: a trailing % matches all. */
  it("escapes a percent", () => {
    expect(sanitizeSqlLike("50%")).toBe("50\\%");
  });

  /** Worse than %, because it still returns a plausible-looking subset. */
  it("escapes an underscore", () => {
    expect(sanitizeSqlLike("a_b")).toBe("a\\_b");
  });

  /**
   * The escape character first, or a literal backslash becomes an escape for
   * whatever follows it.
   */
  it("escapes the escape character itself", () => {
    expect(sanitizeSqlLike("a\\b")).toBe("a\\\\b");
  });

  it("escapes a backslash that precedes a wildcard", () => {
    expect(sanitizeSqlLike("\\%")).toBe("\\\\\\%");
  });

  it("leaves ordinary text alone", () => {
    expect(sanitizeSqlLike("hello")).toBe("hello");
  });

  it("takes a different escape character", () => {
    expect(sanitizeSqlLike("50%", "!")).toBe("50!%");
  });

  it("copes with an empty pattern", () => {
    expect(sanitizeSqlLike("")).toBe("");
  });
});

describe("sanitizeSqlArray", () => {
  it("keeps the template and hands back the values", () => {
    expect(sanitizeSqlArray(["name = ? AND age > ?", "Ada", 36])).toEqual({
      sql: "name = ? AND age > ?",
      bindings: ["Ada", 36],
    });
  });

  /** The point: a value carrying a quote never becomes syntax. */
  it("does not interpolate the values", () => {
    const { sql, bindings } = sanitizeSqlArray(["name = ?", "'; DROP TABLE posts; --"]);

    expect(sql).toBe("name = ?");
    expect(bindings).toEqual(["'; DROP TABLE posts; --"]);
  });

  it("counts a mismatch as an error", () => {
    expect(() => sanitizeSqlArray(["name = ? AND age > ?", "Ada"])).toThrow(/1 for 2/);
  });

  /** A question mark inside a literal is text, not a placeholder. */
  it("ignores a question mark inside a string literal", () => {
    expect(() => sanitizeSqlArray(["name = ? AND note = 'what?'", "Ada"])).not.toThrow();
  });

  it("takes named placeholders", () => {
    expect(sanitizeSqlArray(["name = :name AND age > :age", { name: "Ada", age: 36 }])).toEqual({
      sql: "name = ? AND age > ?",
      bindings: ["Ada", 36],
    });
  });

  it("binds a repeated name once per appearance", () => {
    expect(sanitizeSqlArray(["a = :x OR b = :x", { x: 1 }])).toEqual({
      sql: "a = ? OR b = ?",
      bindings: [1, 1],
    });
  });

  it("throws when a named value is missing", () => {
    expect(() => sanitizeSqlArray(["name = :name", {}])).toThrow(/:name/);
  });
});

describe("sanitizeSqlForConditions", () => {
  it("passes a bare string through", () => {
    expect(sanitizeSqlForConditions("published = 1")).toEqual({
      sql: "published = 1",
      bindings: [],
    });
  });

  it("treats an array as a template", () => {
    expect(sanitizeSqlForConditions(["id = ?", 7])).toEqual({ sql: "id = ?", bindings: [7] });
  });
});

describe("sanitizeSqlForAssignment", () => {
  it("quotes the columns and binds the values", () => {
    expect(sanitizeSqlForAssignment(sqlite, { title: "Hi", views: 3 })).toEqual({
      sql: '"title" = ?, "views" = ?',
      bindings: ["Hi", 3],
    });
  });

  it("quotes for the adapter", () => {
    expect(sanitizeSqlForAssignment(mysql, { title: "Hi" }).sql).toBe("`title` = ?");
  });
});

describe("disallowRawSql", () => {
  it("allows a bare column", () => {
    expect(() => disallowRawSql(["created_at"])).not.toThrow();
  });

  it("allows a direction", () => {
    expect(() => disallowRawSql(["created_at desc", "id ASC"])).not.toThrow();
  });

  it("allows a table qualifier", () => {
    expect(() => disallowRawSql(["posts.created_at desc"])).not.toThrow();
  });

  it("allows a nulls placement", () => {
    expect(() => disallowRawSql(["created_at desc nulls last"])).not.toThrow();
  });

  /** The classic hole: a sort parameter lands where no binding can go. */
  it("rejects a subquery", () => {
    expect(() => disallowRawSql(["(SELECT 1)"])).toThrow(/Dangerous query method/);
  });

  it("rejects a function call", () => {
    expect(() => disallowRawSql(["length(title)"])).toThrow();
  });

  it("rejects a second statement", () => {
    expect(() => disallowRawSql(["id; DROP TABLE posts"])).toThrow();
  });

  it("names what it rejected", () => {
    expect(() => disallowRawSql(["(SELECT 1)"])).toThrow(/\(SELECT 1\)/);
  });

  it("accepts an empty list", () => {
    expect(() => disallowRawSql([])).not.toThrow();
  });
});

describe("quoting identifiers", () => {
  it("quotes a column", () => {
    expect(quoteColumnName(sqlite, "title")).toBe('"title"');
  });

  /** Quoting a qualified name whole invents a table with a dot in its name. */
  it("quotes each half of a qualified table name", () => {
    expect(quoteTableName(postgres, "public.posts")).toBe('"public"."posts"');
  });

  it("quotes an unqualified table name plainly", () => {
    expect(quoteTableName(postgres, "posts")).toBe('"posts"');
  });

  it("uses backticks on MySQL", () => {
    expect(quoteTableName(mysql, "posts")).toBe("`posts`");
  });

  it("reads a quoted identifier back", () => {
    expect(unquoteIdentifier('"posts"')).toBe("posts");
    expect(unquoteIdentifier("`posts`")).toBe("posts");
    expect(unquoteIdentifier("posts")).toBe("posts");
  });

  it("collapses a doubled quote when reading back", () => {
    expect(unquoteIdentifier('"od""d"')).toBe('od"d');
  });
});

describe("quoting values", () => {
  it("doubles a quote in a string literal", () => {
    expect(quoteString("O'Hara")).toBe("'O''Hara'");
  });

  it("spells the booleans each adapter's way", () => {
    expect(quotedTrue(postgres)).toBe("TRUE");
    expect(quotedFalse(postgres)).toBe("FALSE");
    expect(quotedTrue(sqlite)).toBe("1");
    expect(quotedFalse(sqlite)).toBe("0");
  });

  it("gives MySQL a space-separated date", () => {
    expect(quotedDate(mysql, new Date("2026-01-02T03:04:05.678Z"))).toBe("2026-01-02 03:04:05.678");
  });

  it("gives the others ISO", () => {
    expect(quotedDate(postgres, new Date("2026-01-02T03:04:05.678Z"))).toBe(
      "2026-01-02T03:04:05.678Z",
    );
  });
});

describe("quoteDefaultExpression", () => {
  /** DEFAULT 'now()' stores seven characters; DEFAULT now() stores the time. */
  it("passes a function call through unquoted", () => {
    expect(quoteDefaultExpression(postgres, "now()")).toBe("now()");
  });

  it("quotes a plain value", () => {
    expect(quoteDefaultExpression(postgres, "draft")).toBe("'draft'");
  });

  it("does not quote a number", () => {
    expect(quoteDefaultExpression(postgres, 0)).toBe("0");
  });

  it("spells a boolean for the adapter", () => {
    expect(quoteDefaultExpression(postgres, true)).toBe("TRUE");
    expect(quoteDefaultExpression(sqlite, false)).toBe("0");
  });

  it("gives NULL for nothing", () => {
    expect(quoteDefaultExpression(postgres, null)).toBe("NULL");
  });

  it("escapes a quote in a default", () => {
    expect(quoteDefaultExpression(postgres, "O'Hara")).toBe("'O''Hara'");
  });
});
