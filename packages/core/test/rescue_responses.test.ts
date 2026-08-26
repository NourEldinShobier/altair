/**
 * Which status an exception answers with.
 *
 * Ported from the behaviour of `config.action_dispatch.rescue_responses`.
 * Everything used to be a 500, which is wrong in two directions at once: a
 * crawler walking ids paged whoever was on call, and a browser could not tell
 * "the thing you asked for is gone" from "this application is broken".
 */

import { describe, expect, it } from "bun:test";
import { errors, type ErrorContext } from "@altair/support";
import { RecordNotFound, StaleObjectError } from "@altair/orm";
import { InvalidAuthenticityToken } from "@altair/controller";
import { createApplication } from "../src/index.js";
import { statusForError } from "../src/rescue_responses.js";

const application = (options: Record<string, unknown> = {}) =>
  createApplication({
    secretKeyBase: "x".repeat(64),
    database: { url: "sqlite://:memory:" },
    showDetailedErrors: false,
    routes: () => undefined,
    ...options,
  });

/** Sends a request the application will fail on, and reports what came back. */
const answerFor = async (error: unknown, options: Record<string, unknown> = {}) => {
  const app = application(options);
  app.middleware.use("boom", async () => {
    throw error;
  });

  return await app.handler()(new Request("https://app.example/anything"));
};

describe("the status an error means", () => {
  it("is 404 for something that is not there", () => {
    expect(statusForError(new RecordNotFound("Could not find Widget with id = 9"))).toBe(404);
  });

  // Rails answers 422 here, not 403: the request was understood and refused,
  // and a browser that retries after refreshing the token should be told so.
  it("is 422 for a token that does not verify", () => {
    expect(statusForError(new InvalidAuthenticityToken())).toBe(422);
  });

  it("is 409 when somebody else changed it first", () => {
    expect(statusForError(new StaleObjectError("Widget", 1))).toBe(409);
  });

  /**
   * The default is 500 on purpose. An exception nobody has classified is a bug
   * until somebody says otherwise, and reporting a bug as a 404 is how it
   * stops being noticed.
   */
  it("is 500 for anything nobody has classified", () => {
    expect(statusForError(new Error("something went wrong"))).toBe(500);
    expect(statusForError("not even an error")).toBe(500);
  });

  it("takes the application's own mappings first", () => {
    expect(statusForError(new Error("nope"), { Error: 418 })).toBe(418);
  });
});

describe("what the application answers", () => {
  it("answers 404 rather than 500 for a missing record", async () => {
    expect((await answerFor(new RecordNotFound("Could not find Widget with id = 9"))).status).toBe(
      404,
    );
  });

  it("says what is wrong when the client can act on it", async () => {
    const response = await answerFor(new RecordNotFound("Could not find Widget with id = 9"));

    expect(await response.text()).toContain("Could not find Widget");
  });

  /**
   * A 500's message is where the stack traces and the connection strings are,
   * and this is the production path — `showDetailedErrors` is off.
   */
  it("says nothing of its own when it is a fault", async () => {
    const response = await answerFor(new Error("SQL: password=hunter2"));

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("hunter2");
  });

  it("takes a mapping from the application", async () => {
    const response = await answerFor(new Error("pay up"), { rescueResponses: { Error: 402 } });

    expect(response.status).toBe(402);
  });
});

/**
 * Every one of these used to reach the error reporter as an unhandled server
 * error, which is what pages somebody at 3am for a crawler walking ids.
 */
describe("what reaches the error reporter", () => {
  const captureFor = async (error: unknown): Promise<ErrorContext> => {
    const seen: ErrorContext[] = [];
    const subscription = errors.subscribe((_error, context) => void seen.push(context));

    try {
      await answerFor(error);
    } finally {
      subscription.unsubscribe();
    }

    return seen[0] as ErrorContext;
  };

  it("reports a missing record as handled, not as a fault", async () => {
    const context = await captureFor(new RecordNotFound("Could not find Widget with id = 9"));

    expect(context.handled).toBe(true);
    expect(context.severity).toBe("info");
    expect(context.context.status).toBe(404);
  });

  // Still loud, because this one is the framework's problem.
  it("reports anything unclassified as an unhandled error", async () => {
    const context = await captureFor(new Error("something went wrong"));

    expect(context.handled).toBe(false);
    expect(context.severity).toBe("error");
    expect(context.context.status).toBe(500);
  });
});

/**
 * The catch used to sit inside the middleware stack, under every middleware.
 * Anything one of them threw went straight past it — no report, no status, and
 * whatever the runtime does with a rejected promise.
 */
describe("an error thrown by a middleware", () => {
  it("is answered rather than escaping", async () => {
    const app = application();
    app.middleware.unshift("boom", async () => {
      throw new RecordNotFound("Could not find Widget with id = 9");
    });

    const response = await app.handler()(new Request("https://app.example/anything"));

    expect(response.status).toBe(404);
  });

  it("reaches the error reporter like any other", async () => {
    const app = application();
    app.middleware.unshift("boom", async () => {
      throw new Error("the session store is down");
    });

    const seen: unknown[] = [];
    const subscription = errors.subscribe((error) => void seen.push(error));

    try {
      expect((await app.handler()(new Request("https://app.example/anything"))).status).toBe(500);
    } finally {
      subscription.unsubscribe();
    }

    expect(seen).toHaveLength(1);
  });
});
