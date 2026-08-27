/**
 * Changing or stopping a message on its way out.
 *
 * Mirrors actionmailer/test/base_test.rb's interceptor and observer cases.
 *
 * The reason this exists rather than a wrapper around each mailer: what people
 * need it for is a rule that must hold for *every* message an application
 * sends, and one mailer that forgot to opt in is the one that emails a real
 * customer from staging.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Mailer, type DeliveryQueue } from "../src/mailer.js";
import {
  TestDelivery,
  interceptDelivery,
  observeDelivery,
  resetDeliveryHooks,
  registerInterceptor,
  registerObserver,
  registerObservers,
  unregisterObserver,
  emailAddressWithName,
  type MessageFields,
} from "../src/message.js";

let delivery: TestDelivery;
let queued: MessageFields[];

class UserMailer extends Mailer {
  static override defaults = { from: "noreply@example.com" };

  static welcome(to: string) {
    return this.mail({ to, subject: "Welcome", text: "hello" });
  }
}

beforeEach(() => {
  delivery = new TestDelivery();
  queued = [];

  Mailer.delivery = delivery;
  Mailer.queue = {
    enqueue: async (message: MessageFields) => {
      queued.push(message);
      return message;
    },
  } as DeliveryQueue;

  resetDeliveryHooks();
});

afterEach(() => {
  resetDeliveryHooks();
});

describe("an interceptor", () => {
  // The canonical one, and the reason to have this at all.
  it("can rewrite every recipient", async () => {
    interceptDelivery((message) => {
      message.to = "staging@example.com";
    });

    await UserMailer.welcome("real.customer@example.com").deliverNow();

    expect(delivery.deliveries[0]?.to).toBe("staging@example.com");
  });

  it("sees the message after it was rendered", async () => {
    let seen: string | undefined;
    interceptDelivery((message) => {
      seen = message.text as string;
    });

    await UserMailer.welcome("a@b.c").deliverNow();

    expect(seen).toBe("hello");
  });

  it("runs in the order they were registered", async () => {
    const order: string[] = [];
    interceptDelivery(() => void order.push("first"));
    interceptDelivery(() => void order.push("second"));

    await UserMailer.welcome("a@b.c").deliverNow();

    expect(order).toEqual(["first", "second"]);
  });

  // So a rule that rewrites a recipient and a rule that reads one agree about
  // which recipient they mean.
  it("sees what the one before it did", async () => {
    interceptDelivery((message) => {
      message.to = "rewritten@example.com";
    });

    let seen: unknown;
    interceptDelivery((message) => {
      seen = message.to;
    });

    await UserMailer.welcome("a@b.c").deliverNow();

    expect(seen).toBe("rewritten@example.com");
  });

  it("stops the message when it returns false", async () => {
    interceptDelivery(() => false);

    await UserMailer.welcome("a@b.c").deliverNow();

    expect(delivery.deliveries).toHaveLength(0);
  });

  it("may answer asynchronously", async () => {
    interceptDelivery(async (message) => {
      message.subject = await Promise.resolve("rewritten");
    });

    await UserMailer.welcome("a@b.c").deliverNow();

    expect(delivery.deliveries[0]?.subject).toBe("rewritten");
  });

  it("can be removed again", async () => {
    const stop = interceptDelivery(() => false);
    stop();

    await UserMailer.welcome("a@b.c").deliverNow();

    expect(delivery.deliveries).toHaveLength(1);
  });
});

/**
 * The path that would otherwise be missed. `deliverLater` hands the message to
 * a queue the application supplies, and what sends it later is code the
 * framework does not own — so the rules run before it is stored rather than
 * when it is sent.
 */
describe("a message that is queued rather than sent", () => {
  it("goes through the interceptors too", async () => {
    interceptDelivery((message) => {
      message.to = "staging@example.com";
    });

    await UserMailer.welcome("real.customer@example.com").deliverLater();

    expect(queued[0]?.to).toBe("staging@example.com");
  });

  it("is not queued at all when one stops it", async () => {
    interceptDelivery(() => false);

    await UserMailer.welcome("a@b.c").deliverLater();

    expect(queued).toHaveLength(0);
  });
});

describe("an observer", () => {
  it("is told what went", async () => {
    const seen: string[] = [];
    observeDelivery((message) => void seen.push(String(message.to)));

    await UserMailer.welcome("a@b.c").deliverNow();

    expect(seen).toEqual(["a@b.c"]);
  });

  it("sees what the interceptors did", async () => {
    interceptDelivery((message) => {
      message.to = "rewritten@example.com";
    });

    let seen: unknown;
    observeDelivery((message) => void (seen = message.to));

    await UserMailer.welcome("a@b.c").deliverNow();

    expect(seen).toBe("rewritten@example.com");
  });

  it("is not told about a message that was stopped", async () => {
    interceptDelivery(() => false);

    let told = false;
    observeDelivery(() => void (told = true));

    await UserMailer.welcome("a@b.c").deliverNow();

    expect(told).toBe(false);
  });

  // The message has already been handed over; there is nothing left to undo.
  it("does not fail the delivery by throwing", async () => {
    observeDelivery(() => {
      throw new Error("the metrics endpoint is down");
    });

    expect(UserMailer.welcome("a@b.c").deliverNow()).resolves.toBeDefined();
    expect(delivery.deliveries).toHaveLength(1);
  });
});

/**
 * The Rails spellings for the same two hooks, and the address formatter beside
 * them.
 *
 * `interceptDelivery` and `observeDelivery` say what they do; these are what
 * somebody arriving from Rails looks for, and a framework keeping its
 * conventions should answer to both.
 */
describe("registering by Rails' names", () => {
  it("registers an interceptor", async () => {
    registerInterceptor((message) => {
      message.to = "staging@example.com";
    });

    await UserMailer.welcome("real@example.com").deliverNow();

    expect(delivery.deliveries[0]?.to).toBe("staging@example.com");
  });

  it("registers several at once, and takes them all back together", async () => {
    const seen: string[] = [];
    const remove = registerObservers(
      () => void seen.push("one"),
      () => void seen.push("two"),
    );

    await UserMailer.welcome("a@b.com").deliverNow();
    expect(seen).toEqual(["one", "two"]);

    remove();
    await UserMailer.welcome("a@b.com").deliverNow();

    expect(seen).toEqual(["one", "two"]);
  });

  it("unregisters one by reference", async () => {
    const seen: string[] = [];
    const observer = () => void seen.push("ran");

    registerObserver(observer);
    unregisterObserver(observer);

    await UserMailer.welcome("a@b.com").deliverNow();

    expect(seen).toEqual([]);
  });
});

describe("an address with a name on it", () => {
  it("quotes the name", () => {
    expect(emailAddressWithName("ada@example.com", "Ada Lovelace")).toBe(
      '"Ada Lovelace" <ada@example.com>',
    );
  });

  /**
   * A name containing a quote would end the quoted string and turn the rest
   * into a second address — a header injection wearing a person's name.
   */
  it("cannot be broken by a quote or a line break in the name", () => {
    expect(emailAddressWithName("a@b.com", 'Ada" <eve@evil.example>, "')).not.toContain('" <eve');
    expect(emailAddressWithName("a@b.com", "Ada\r\nBcc: eve@evil.example")).not.toContain("\n");
  });
});
