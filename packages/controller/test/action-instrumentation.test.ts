/**
 * What an action reports about itself, ported from
 * `actionpack/test/controller/log_subscriber_test.rb`.
 *
 * Altair had a complete instrumentation module and nothing published to it, so
 * an application got no request log at all. These are about the joint — and
 * about the one part of it that is a security property rather than a
 * convenience: parameters are filtered before they are published, not by
 * whoever subscribes.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ParameterFilter, notifier, resetNotifier } from "@altair/support";
import { Controller } from "../src/controller.js";
import type { ProcessActionPayload } from "../src/instrumentation.js";

class PostsController extends Controller {
  index(): Response {
    return this.render.json({ ok: true });
  }

  boom(): Response {
    throw new Error("the query died");
  }

  created(): Response {
    return this.render.json({ ok: true }, { status: 201 });
  }

  async slow(): Promise<Response> {
    await new Promise((resolve) => setTimeout(resolve, 2));

    return this.render.json({ ok: true });
  }
}

/** The filter the class ships with, so a test can put it back rather than invent one. */
const SHIPPED = PostsController.parameterFilter;

interface Seen {
  name: string;
  payload: ProcessActionPayload;
  duration: number;
}

function listening(): Seen[] {
  const seen: Seen[] = [];

  notifier().subscribe("start_processing.altair", (event) =>
    seen.push({
      name: event.name,
      payload: event.payload as unknown as ProcessActionPayload,
      duration: event.duration,
    }),
  );
  notifier().subscribe("process_action.altair", (event) =>
    seen.push({
      name: event.name,
      payload: event.payload as unknown as ProcessActionPayload,
      duration: event.duration,
    }),
  );

  return seen;
}

function controllerFor(url: string, body: Record<string, unknown> = {}): PostsController {
  return new PostsController({
    request: new Request(url, { method: "GET" }),
    params: body,
    routeParams: {},
  });
}

beforeEach(() => {
  PostsController.parameterFilter = SHIPPED;
});

afterEach(() => {
  resetNotifier();
});

describe("what an action publishes", () => {
  it("says it started and says it finished", async () => {
    const seen = listening();

    await controllerFor("https://example.com/posts").processAction("index");

    expect(seen.map((one) => one.name)).toEqual([
      "start_processing.altair",
      "process_action.altair",
    ]);
  });

  it("names the controller, the action and the request", async () => {
    const seen = listening();

    await controllerFor("https://example.com/posts").processAction("index");

    expect(seen[1]?.payload.controller).toBe("PostsController");
    expect(seen[1]?.payload.action).toBe("index");
    expect(seen[1]?.payload.method).toBe("GET");
    expect(seen[1]?.payload.path).toBe("/posts");
  });

  it("carries the status the response ended with", async () => {
    const seen = listening();

    await controllerFor("https://example.com/posts").processAction("created");

    expect(seen[1]?.payload.status).toBe(201);
  });

  /** A duration of nothing is what a log shows when the timing was not carried. */
  it("times the action", async () => {
    const seen = listening();

    await controllerFor("https://example.com/posts").processAction("slow");

    expect(seen[1]?.duration).toBeGreaterThan(0);
  });

  it("times from the start of the action, not from the end", async () => {
    const seen = listening();

    await controllerFor("https://example.com/posts").processAction("slow");

    // The start event is the marker, so it carries no duration of its own.
    expect(seen[0]?.duration).toBe(0);
  });
});

describe("an action that raised", () => {
  /**
   * The one whose timing matters most. An event that simply does not fire
   * leaves a gap in the log at the moment something went wrong.
   */
  it("still publishes, and records what went wrong", async () => {
    const seen = listening();

    await expect(controllerFor("https://example.com/posts").processAction("boom")).rejects.toThrow(
      "the query died",
    );

    expect(seen).toHaveLength(2);
    expect(seen[1]?.payload.exception).toEqual(["Error", "the query died"]);
  });

  /** The caller sees the error, not a swallowed one. */
  it("still raises", async () => {
    listening();

    await expect(controllerFor("https://example.com/posts").processAction("boom")).rejects.toThrow(
      "the query died",
    );
  });
});

describe("the parameters it carries", () => {
  it("carries what the action saw", async () => {
    const seen = listening();

    await controllerFor("https://example.com/posts?page=2", { title: "Hello" }).processAction(
      "index",
    );

    expect(seen[1]?.payload.params).toMatchObject({ page: "2", title: "Hello" });
  });

  /**
   * Filtered here rather than by whoever subscribes: a subscriber is
   * application code, and a password that reaches one has already left the
   * framework. Without any configuration, too — the shipped list is the one
   * that matters most, because it is the one nobody had to think about.
   */
  it("redacts a password by default", async () => {
    const seen = listening();

    await controllerFor("https://example.com/posts", { password: "hunter2" }).processAction(
      "index",
    );

    expect(seen[1]?.payload.params).toMatchObject({ password: "[FILTERED]" });
  });

  it("redacts a secret before anybody sees it", async () => {
    const seen = listening();

    await controllerFor("https://example.com/posts", {
      title: "Hello",
      password: "hunter2",
    }).processAction("index");

    expect(seen[1]?.payload.params).toMatchObject({ title: "Hello", password: "[FILTERED]" });
  });

  it("redacts one in the query string too, in the path it reports", async () => {
    const seen = listening();

    await controllerFor("https://example.com/posts?token=abc123&page=2").processAction("index");

    expect(seen[1]?.payload.path).toBe("/posts?token=[FILTERED]&page=2");
  });

  /** So an application can add a name of its own. */
  it("uses the filter the controller was given", async () => {
    PostsController.parameterFilter = new ParameterFilter(["title"]);

    const seen = listening();

    await controllerFor("https://example.com/posts", { title: "Hello" }).processAction("index");

    expect(seen[1]?.payload.params).toMatchObject({ title: "[FILTERED]" });
  });
});

describe("with nobody listening", () => {
  /** Publishing is what changed; behaviour is not. */
  it("returns the response as before", async () => {
    const response = await controllerFor("https://example.com/posts").processAction("index");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});
