/**
 * What is reported when a handler catches something, ported from the
 * `rescue_from_callback.action_controller` cases in
 * `actionpack/test/controller/rescue_test.rb`.
 *
 * A rescued exception is the one kind nothing else reports: it never reached
 * the error reporter, the response was fine, and the log says the request
 * succeeded.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { notifications } from "../src/notifications.js";
import { RescueHandlers, rescueFromCallback, rescueWithHandler } from "../src/rescuable.js";

afterEach(() => {
  notifications.reset();
});

function collected(): { names: string[]; messages: string[] } {
  const names: string[] = [];
  const messages: string[] = [];

  notifications.subscribe("rescue_from_callback.altair", (event) => {
    names.push(String(event.payload["exception"]));
    messages.push(String(event.payload["message"]));
  });

  return { names, messages };
}

class NotFound extends Error {
  constructor() {
    super("no such record");
    this.name = "NotFound";
  }
}

describe("reporting a rescue", () => {
  /**
   * An application that has started raising on every request looks healthy
   * otherwise, and the rescue written for a rare case quietly becomes the
   * normal path.
   */
  it("says what was caught", () => {
    const seen = collected();
    rescueFromCallback(new NotFound());

    expect(seen.names).toEqual(["NotFound"]);
    expect(seen.messages).toEqual(["no such record"]);
  });

  it("describes something that is not an error", () => {
    const seen = collected();
    rescueFromCallback("boom");

    expect(seen.names).toEqual(["string"]);
    expect(seen.messages).toEqual(["boom"]);
  });

  it("is published rather than logged, so nothing is written by default", () => {
    expect(() => rescueFromCallback(new NotFound())).not.toThrow();
  });
});

describe("running a handler", () => {
  it("reports the exception it handled", async () => {
    const seen = collected();
    const handlers = new RescueHandlers<string>();
    handlers.add("NotFound", () => "handled");

    expect(await rescueWithHandler(handlers, new NotFound())).toBe("handled");
    expect(seen.names).toEqual(["NotFound"]);
  });

  /**
   * Nothing handled it, so it is not a rescue: reported here, an unhandled
   * error would be counted twice — once as rescued and once by whatever
   * finally catches it.
   */
  it("reports nothing when no handler matched", async () => {
    const seen = collected();
    const handlers = new RescueHandlers<string>();

    await expect(rescueWithHandler(handlers, new NotFound())).rejects.toThrow("no such record");
    expect(seen.names).toEqual([]);
  });

  it("reports once per rescue", async () => {
    const seen = collected();
    const handlers = new RescueHandlers<string>();
    handlers.add("NotFound", () => "handled");

    await rescueWithHandler(handlers, new NotFound());
    await rescueWithHandler(handlers, new NotFound());

    expect(seen.names).toHaveLength(2);
  });
});
