/**
 * The assertions a framework owes the people testing applications built on it,
 * ported from `activesupport/test/test_case_test.rb` and the per-component
 * ones beside it.
 *
 * Each case checks two things: that it passes when it should, and that its
 * failure message says something a person can act on. A green assertion that
 * fails with "expected 4 to be 5" has done half its job.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Connection, Model, SchemaStatements, setConnection } from "@altair/orm";
import {
  AssertionFailed,
  assertChanges,
  assertDifference,
  assertEmails,
  assertNoChanges,
  assertNoDifference,
  assertNoEmails,
  assertNoQueries,
  assertNoQueriesMatch,
  assertNothingRaised,
  assertQueriesCount,
  assertQueriesMatch,
  assertRedirectedTo,
  assertResponse,
} from "../src/assertions.js";

interface PostRow {
  id: number;
  title: string;
}

class Post extends Model<PostRow>("posts") {}

let connection: Connection;

beforeEach(async () => {
  connection = new Connection("sqlite://:memory:");
  setConnection(connection);

  Post.resetColumnInformation();

  await new SchemaStatements(connection).createTable("posts", (t) => t.string("title"));
});

afterEach(async () => {
  await connection.close();
});

/** What an assertion said when it failed. */
const failureFrom = async (body: () => unknown): Promise<string> => {
  try {
    await body();
  } catch (error) {
    if (error instanceof AssertionFailed) return error.message;
    throw error;
  }

  throw new Error("Expected the assertion to fail, and it did not.");
};

describe("a difference", () => {
  it("passes when the count moved by what was expected", async () => {
    await assertDifference(
      () => Post.count(),
      1,
      async () => {
        await Post.create({ title: "A" });
      },
    );
  });

  it("passes when nothing moved and nothing was meant to", async () => {
    await assertNoDifference(
      () => Post.count(),
      async () => {},
    );
  });

  /**
   * "Expected 4 to be 5" is a different message from this one, and only this
   * one says which way it went — staying still is a different bug from moving
   * twice.
   */
  it("says where it started and where it ended", async () => {
    const message = await failureFrom(() =>
      assertDifference(
        () => Post.count(),
        1,
        async () => {},
        "the post count",
      ),
    );

    expect(message).toContain("the post count");
    expect(message).toContain("from 0 to 0");
    expect(message).toContain("change by 1");
  });

  it("catches a change that went too far", async () => {
    const message = await failureFrom(() =>
      assertDifference(
        () => Post.count(),
        1,
        async () => {
          await Post.create({ title: "A" });
          await Post.create({ title: "B" });
        },
      ),
    );

    expect(message).toContain("a change of 2");
  });

  it("hands back whatever the block returned", async () => {
    const post = await assertDifference(
      () => Post.count(),
      1,
      () => Post.create({ title: "A" }),
    );

    expect(post.title).toBe("A");
  });
});

describe("a change that is not a number", () => {
  it("passes when the value moved", async () => {
    const post = await Post.create({ title: "draft" });

    await assertChanges(
      () => post.title,
      async () => {
        post.title = "live";
        await post.save();
      },
    );
  });

  it("checks where it started and where it ended when told", async () => {
    const post = await Post.create({ title: "draft" });

    await assertChanges(
      () => post.title,
      async () => {
        post.title = "live";
      },
      { from: "draft", to: "live" },
    );
  });

  it("says so when it did not move", async () => {
    const post = await Post.create({ title: "draft" });

    expect(
      await failureFrom(() =>
        assertChanges(
          () => post.title,
          async () => {},
        ),
      ),
    ).toContain("stayed");
  });

  it("says so when it became something else", async () => {
    const post = await Post.create({ title: "draft" });

    const message = await failureFrom(() =>
      assertChanges(
        () => post.title,
        async () => {
          post.title = "archived";
        },
        { to: "live" },
      ),
    );

    expect(message).toContain('became "archived"');
  });

  it("has the opposite too", async () => {
    const post = await Post.create({ title: "draft" });

    await assertNoChanges(
      () => post.title,
      async () => {},
    );

    expect(
      await failureFrom(() =>
        assertNoChanges(
          () => post.title,
          async () => {
            post.title = "live";
          },
        ),
      ),
    ).toContain("went from");
  });
});

describe("nothing raised", () => {
  it("passes and hands the value back", async () => {
    expect(await assertNothingRaised(() => 42)).toBe(42);
  });

  // Names the error rather than letting it propagate as though the test itself
  // broke.
  it("names what was raised", async () => {
    const message = await failureFrom(() =>
      assertNothingRaised(() => {
        throw new Error("the database is gone");
      }),
    );

    expect(message).toContain("the database is gone");
  });
});

/**
 * What catches an N+1 before it reaches production: the page still renders, so
 * nothing else notices it took forty queries to do it.
 */
describe("counting queries", () => {
  it("counts what a block ran", async () => {
    await assertQueriesCount(1, () => Post.create({ title: "A" }));
  });

  it("passes when nothing touched the database", async () => {
    await assertNoQueries(async () => 1 + 1);
  });

  it("prints the queries when the count is wrong", async () => {
    const message = await failureFrom(() => assertNoQueries(() => Post.create({ title: "A" })));

    expect(message).toContain("Expected 0 queries, got 1");
    expect(message.toLowerCase()).toContain("insert");
  });

  it("finds a query that looks a certain way", async () => {
    await assertQueriesMatch(/INSERT/i, () => Post.create({ title: "A" }));
  });

  it("says what did run when none matched", async () => {
    const message = await failureFrom(() =>
      assertQueriesMatch(/DELETE/i, () => Post.create({ title: "A" })),
    );

    expect(message).toContain("none of the 1 run did");
  });

  it("checks that something did not happen", async () => {
    await assertNoQueriesMatch(/DELETE/i, () => Post.create({ title: "A" }));

    expect(
      await failureFrom(() => assertNoQueriesMatch(/INSERT/i, () => Post.create({ title: "A" }))),
    ).toContain("but 1 did");
  });
});

describe("a response", () => {
  it("recognises each family", () => {
    assertResponse(new Response("", { status: 201 }), "success");
    assertResponse(new Response("", { status: 302 }), "redirect");
    assertResponse(new Response("", { status: 404 }), "missing");
    assertResponse(new Response("", { status: 503 }), "error");
    assertResponse(new Response("", { status: 422 }), 422);
  });

  it("says what it got instead", async () => {
    expect(
      await failureFrom(() => assertResponse(new Response("", { status: 500 }), "success")),
    ).toContain("but it was 500");
  });

  /**
   * Compared by path when given one, because a test should not have to know
   * the host it was served from.
   */
  it("checks where a redirect went", () => {
    const response = new Response(null, {
      status: 302,
      headers: { location: "https://app.example/posts/1" },
    });

    assertRedirectedTo(response, "/posts/1");
    assertRedirectedTo(response, /posts/);
  });

  it("says where it actually went", async () => {
    const response = new Response(null, {
      status: 302,
      headers: { location: "/sessions/new" },
    });

    expect(await failureFrom(() => assertRedirectedTo(response, "/posts"))).toContain(
      "it went to /sessions/new",
    );
  });

  it("says when there was no redirect at all", async () => {
    expect(
      await failureFrom(() => assertRedirectedTo(new Response("", { status: 200 }), "/posts")),
    ).toContain("no location");
  });
});

describe("emails", () => {
  it("counts what a block sent", async () => {
    const deliveries: unknown[] = [];

    await assertEmails(deliveries, 1, async () => {
      deliveries.push({ to: "a@b.com" });
    });

    await assertNoEmails(deliveries, async () => {});
  });

  it("says how many were sent instead", async () => {
    const deliveries: unknown[] = [];

    expect(
      await failureFrom(() =>
        assertEmails(deliveries, 1, async () => {
          deliveries.push({}, {});
        }),
      ),
    ).toContain("the number of emails");
  });
});
