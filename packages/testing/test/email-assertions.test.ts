/**
 * Assertions about queued mail, ported from
 * `actionmailer/test/test_helper_test.rb` — the `assert_enqueued_emails`,
 * `assert_enqueued_email_with`, `deliver_enqueued_emails` and `capture_emails`
 * cases.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Mailer, TestDelivery, registerObservers, type MessageFields } from "@altair/mailer";
import { AssertionFailed } from "@altair/support";
import {
  TestDeliveryQueue,
  assertCapturedEmails,
  assertEnqueuedEmailWith,
  assertEnqueuedEmails,
  assertNoEnqueuedEmails,
  captureEmails,
  deliverEnqueuedEmails,
} from "../src/email-assertions.js";

class Notifier extends Mailer {
  static override defaults = { from: "hello@example.com" };

  static welcome(to: string) {
    return this.mail({ to, subject: "Welcome" });
  }

  static receipt(to: string, total: string) {
    return this.mail({ to, subject: `Receipt for ${total}`, text: `You paid ${total}.` });
  }
}

let queue: TestDeliveryQueue;
let delivery: TestDelivery;

beforeEach(() => {
  queue = new TestDeliveryQueue();
  delivery = new TestDelivery();
  Mailer.queue = queue;
  Mailer.delivery = delivery;
});

afterEach(() => {
  Mailer.queue = undefined;
});

describe("assertEnqueuedEmails", () => {
  it("counts what a block queued", async () => {
    await assertEnqueuedEmails(2, async () => {
      await Notifier.welcome("a@example.com").deliverLater();
      await Notifier.welcome("b@example.com").deliverLater();
    });
  });

  it("fails with the count it actually saw", async () => {
    expect(
      assertEnqueuedEmails(2, async () => {
        await Notifier.welcome("a@example.com").deliverLater();
      }),
    ).rejects.toThrow("Expected 2 email(s) to be enqueued, got 1");
  });

  /** A test that sends in its setup has nothing to wrap. */
  it("counts everything queued so far when given no block", async () => {
    await Notifier.welcome("a@example.com").deliverLater();

    await assertEnqueuedEmails(1);
  });

  /** Only what the block queued: a fixture queued in setup is not the subject. */
  it("ignores what was queued before the block", async () => {
    await Notifier.welcome("before@example.com").deliverLater();

    await assertEnqueuedEmails(1, async () => {
      await Notifier.welcome("during@example.com").deliverLater();
    });
  });

  it("does not count mail sent directly", async () => {
    await assertNoEnqueuedEmails(async () => {
      await Notifier.welcome("a@example.com").deliverNow();
    });
  });

  it("says what to set up when there is no test queue", async () => {
    Mailer.queue = undefined;

    expect(assertEnqueuedEmails(0)).rejects.toThrow("TestDeliveryQueue");
  });
});

describe("assertEnqueuedEmailWith", () => {
  it("finds a message by its fields", async () => {
    await Notifier.welcome("a@example.com").deliverLater();
    await Notifier.receipt("b@example.com", "£4").deliverLater();

    const found = await assertEnqueuedEmailWith({ subject: "Receipt for £4" });

    expect(found.to).toBe("b@example.com");
  });

  it("requires every named field to match", async () => {
    await Notifier.welcome("a@example.com").deliverLater();

    expect(
      assertEnqueuedEmailWith({ to: "a@example.com", subject: "Something else" }),
    ).rejects.toThrow(AssertionFailed);
  });

  it("takes a predicate for anything a field comparison cannot say", async () => {
    await Notifier.receipt("b@example.com", "£4").deliverLater();

    const found = await assertEnqueuedEmailWith((message) =>
      (message.subject ?? "").startsWith("Receipt"),
    );

    expect(found.subject).toBe("Receipt for £4");
  });

  it("compares a list of recipients by value", async () => {
    await Notifier.mail({ to: ["a@example.com", "b@example.com"], subject: "Hi" }).deliverLater();

    await assertEnqueuedEmailWith({ to: ["a@example.com", "b@example.com"] });
  });

  it("lists what was there when nothing matched", async () => {
    await Notifier.welcome("a@example.com").deliverLater();

    expect(assertEnqueuedEmailWith({ subject: "Nope" })).rejects.toThrow("a@example.com");
  });

  it("scopes to the block when one is given", async () => {
    await Notifier.welcome("before@example.com").deliverLater();

    expect(
      assertEnqueuedEmailWith({ to: "before@example.com" }, async () => {
        await Notifier.welcome("during@example.com").deliverLater();
      }),
    ).rejects.toThrow(AssertionFailed);
  });
});

describe("deliverEnqueuedEmails", () => {
  it("sends what the block queued", async () => {
    await deliverEnqueuedEmails(async () => {
      await Notifier.welcome("a@example.com").deliverLater();
    });

    expect(delivery.deliveries).toHaveLength(1);
    expect(delivery.deliveries[0]?.to).toBe("a@example.com");
  });

  it("empties the queue", async () => {
    await deliverEnqueuedEmails(async () => {
      await Notifier.welcome("a@example.com").deliverLater();
    });

    expect(queue.enqueued).toHaveLength(0);
  });

  it("sends what was queued before it too", async () => {
    await Notifier.welcome("a@example.com").deliverLater();

    await deliverEnqueuedEmails();

    expect(delivery.deliveries).toHaveLength(1);
  });

  /** A welcome mail that queues a follow-up would otherwise sit unsent. */
  it("sends mail queued by delivering mail", async () => {
    const stop = registerObservers(async (message: MessageFields) => {
      if (message.subject === "Welcome") {
        await Notifier.mail({ to: message.to, subject: "Follow-up" }).deliverLater();
      }
    });

    try {
      const sent = await deliverEnqueuedEmails(async () => {
        await Notifier.welcome("a@example.com").deliverLater();
      });

      expect(sent.map((one) => one.subject)).toEqual(["Welcome", "Follow-up"]);
    } finally {
      stop();
    }
  });

  /** Observers say what went out, and nothing went out until the queue drained. */
  it("runs observers when the message actually leaves", async () => {
    const observed: string[] = [];
    const stop = registerObservers((message: MessageFields) => {
      observed.push(String(message.to));
    });

    try {
      await Notifier.welcome("a@example.com").deliverLater();

      expect(observed).toEqual([]);

      await deliverEnqueuedEmails();

      expect(observed).toEqual(["a@example.com"]);
    } finally {
      stop();
    }
  });
});

describe("captureEmails", () => {
  /**
   * The reason this exists. A test written against `deliveries` goes green
   * while asserting nothing the moment the code under test moves to
   * `deliverLater` — the mail is still sent, the test just stops seeing it.
   */
  it("sees mail sent directly", async () => {
    const captured = await captureEmails(async () => {
      await Notifier.welcome("a@example.com").deliverNow();
    });

    expect(captured.map((one) => one.subject)).toEqual(["Welcome"]);
  });

  it("sees mail sent through the queue", async () => {
    const captured = await captureEmails(async () => {
      await Notifier.welcome("a@example.com").deliverLater();
    });

    expect(captured.map((one) => one.subject)).toEqual(["Welcome"]);
  });

  it("sees both in one block", async () => {
    const captured = await captureEmails(async () => {
      await Notifier.welcome("a@example.com").deliverNow();
      await Notifier.receipt("b@example.com", "£4").deliverLater();
    });

    expect(captured.map((one) => one.subject)).toEqual(["Welcome", "Receipt for £4"]);
  });

  it("ignores mail sent before the block", async () => {
    await Notifier.welcome("before@example.com").deliverNow();

    const captured = await captureEmails(async () => {
      await Notifier.welcome("during@example.com").deliverNow();
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.to).toBe("during@example.com");
  });

  it("says what to set up when mail is not being collected", async () => {
    Mailer.delivery = { sendMail: async () => undefined };

    expect(captureEmails(async () => undefined)).rejects.toThrow("TestDelivery");
  });
});

describe("assertCapturedEmails", () => {
  it("counts what was sent by either route", async () => {
    const captured = await assertCapturedEmails(2, async () => {
      await Notifier.welcome("a@example.com").deliverNow();
      await Notifier.welcome("b@example.com").deliverLater();
    });

    expect(captured).toHaveLength(2);
  });

  it("fails with what it saw", async () => {
    expect(
      assertCapturedEmails(2, async () => {
        await Notifier.welcome("a@example.com").deliverNow();
      }),
    ).rejects.toThrow("Expected 2 email(s) to be sent, got 1");
  });
});
