/**
 * One mailer's own delivery callbacks, ported from
 * `actionmailer/test/base_test.rb`.
 *
 * An interceptor is for a rule that holds across the application — rewriting
 * every recipient in staging. These are for one mailer's business, which is
 * why both exist and why the narrower one runs closer to the send.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Mailer, TestDelivery, type MessageFields } from "../src/index.js";

let delivery: TestDelivery;

beforeEach(() => {
  delivery = new TestDelivery();
  Mailer.delivery = delivery;
  Mailer.defaults = { from: "noreply@example.com" };
});

afterEach(() => {
  Mailer.defaults = {};
});

const built = (mailer: typeof Mailer) =>
  (mailer as unknown as { mail(options: object): { deliverNow(): Promise<MessageFields> } }).mail({
    to: ["someone@example.com"],
    subject: "Hello",
    text: "Hi",
  });

describe("running around a send", () => {
  it("runs a before hook", async () => {
    const seen: string[] = [];

    class Orders extends Mailer {
      static {
        this.beforeDeliver(() => void seen.push("before"));
      }
    }

    await built(Orders).deliverNow();

    expect(seen).toEqual(["before"]);
  });

  it("runs an after hook", async () => {
    const seen: string[] = [];

    class Orders extends Mailer {
      static {
        this.afterDeliver(() => void seen.push("after"));
      }
    }

    await built(Orders).deliverNow();

    expect(seen).toEqual(["after"]);
  });

  it("runs them in the right order around the send", async () => {
    const seen: string[] = [];

    class Orders extends Mailer {
      static {
        this.beforeDeliver(() => void seen.push("before"));
        this.afterDeliver(() => void seen.push("after"));
      }
    }

    Orders.delivery = {
      sendMail: async () => void seen.push("sent"),
    } as unknown as TestDelivery;

    await built(Orders).deliverNow();

    expect(seen).toEqual(["before", "sent", "after"]);
  });

  it("hands the hook the message that is going out", async () => {
    const subjects: string[] = [];

    class Orders extends Mailer {
      static {
        this.beforeDeliver((message) => void subjects.push(String(message.subject)));
      }
    }

    await built(Orders).deliverNow();

    expect(subjects).toEqual(["Hello"]);
  });

  it("lets a hook change the message before it goes", async () => {
    class Orders extends Mailer {
      static {
        this.beforeDeliver((message) => {
          message.subject = `[orders] ${String(message.subject)}`;
        });
      }
    }

    await built(Orders).deliverNow();

    expect(delivery.deliveries[0]?.subject).toBe("[orders] Hello");
  });
});

/**
 * A callback that records what went out should record only what actually went.
 */
describe("when the send fails", () => {
  it("does not run the after hook", async () => {
    const seen: string[] = [];

    class Broken extends Mailer {
      static {
        this.beforeDeliver(() => void seen.push("before"));
        this.afterDeliver(() => void seen.push("after"));
      }
    }

    Broken.delivery = {
      sendMail: async () => {
        throw new Error("the relay is down");
      },
    } as unknown as TestDelivery;

    await built(Broken)
      .deliverNow()
      .catch(() => undefined);

    expect(seen).toEqual(["before"]);
  });
});

describe("inheritance", () => {
  it("does not run a subclass's hook for its siblings", async () => {
    const seen: string[] = [];

    class Base extends Mailer {}
    class Left extends Base {}
    class Right extends Base {}

    Base.beforeDeliver(() => void seen.push("base"));
    Left.beforeDeliver(() => void seen.push("left"));

    await built(Right).deliverNow();

    expect(seen).toEqual(["base"]);
  });

  it("runs an inherited hook before the subclass's own", async () => {
    const seen: string[] = [];

    class Base extends Mailer {}
    class Child extends Base {}

    Base.beforeDeliver(() => void seen.push("base"));
    Child.beforeDeliver(() => void seen.push("child"));

    await built(Child).deliverNow();

    expect(seen).toEqual(["base", "child"]);
  });
});
