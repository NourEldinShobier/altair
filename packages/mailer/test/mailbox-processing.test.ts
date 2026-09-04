/**
 * The hooks around handling an inbound message, ported from
 * `actionmailbox/test/unit/mailbox_test.rb`.
 *
 * The reason they are hooks rather than lines at the top of `process`: the
 * things that belong on both sides of a failure — a transaction, a timer, the
 * account a message belongs to — have to still happen when `process` throws.
 */

import { describe, expect, it } from "bun:test";
import { Mailbox, MailboxRouter, type InboundMessage } from "../src/mailbox.js";

const arriving = (overrides: Partial<InboundMessage> = {}): InboundMessage => ({
  messageId: `m-${Math.random()}`,
  from: "someone@example.com",
  to: ["support@example.com"],
  subject: "Help",
  text: "It is broken",
  ...overrides,
});

/** Records the order things ran in, which is the whole assertion here. */
const trace: string[] = [];

class Support extends Mailbox {
  async process(): Promise<void> {
    trace.push("process");
  }
}

Support.beforeProcessing(() => void trace.push("before"));
Support.afterProcessing(() => void trace.push("after"));
Support.aroundProcessing(async (_mailbox, body) => {
  trace.push("around in");
  await body();
  trace.push("around out");
});

describe("the hooks around processing", () => {
  it("runs them outside in", async () => {
    trace.length = 0;
    await new Support(arriving()).performProcessing();

    expect(trace).toEqual(["around in", "before", "process", "after", "around out"]);
  });

  it("does not run a subclass's hooks for its siblings", async () => {
    class Base extends Mailbox {
      async process(): Promise<void> {}
    }
    class Left extends Base {
      override async process(): Promise<void> {}
    }
    class Right extends Base {
      override async process(): Promise<void> {}
    }

    const seen: string[] = [];
    Base.beforeProcessing(() => void seen.push("base"));
    Left.beforeProcessing(() => void seen.push("left"));

    await new Right(arriving()).performProcessing();

    expect(seen).toEqual(["base"]);
  });

  it("runs an inherited hook before the subclass's own", async () => {
    class Base extends Mailbox {
      async process(): Promise<void> {}
    }
    class Child extends Base {
      override async process(): Promise<void> {}
    }

    const seen: string[] = [];
    Base.beforeProcessing(() => void seen.push("base"));
    Child.beforeProcessing(() => void seen.push("child"));

    await new Child(arriving()).performProcessing();

    expect(seen).toEqual(["base", "child"]);
  });

  /**
   * The reason `aroundProcessing` exists at all. A transaction that only
   * commits and never rolls back is not a transaction.
   */
  it("lets an around hook see a failure", async () => {
    class Broken extends Mailbox {
      async process(): Promise<void> {
        throw new Error("the ticket service is down");
      }
    }

    let sawFailure = false;
    Broken.aroundProcessing(async (_mailbox, body) => {
      try {
        await body();
      } catch {
        sawFailure = true;
        throw new Error("the ticket service is down");
      }
    });

    await expect(new Broken(arriving()).performProcessing()).rejects.toThrow("is down");
    expect(sawFailure).toBe(true);
  });

  it("skips the after hooks when process throws", async () => {
    class Broken extends Mailbox {
      async process(): Promise<void> {
        throw new Error("nope");
      }
    }

    let ran = false;
    Broken.afterProcessing(() => void (ran = true));

    await new Broken(arriving()).performProcessing().catch(() => undefined);

    expect(ran).toBe(false);
  });
});

describe("refusing a message where it stands", () => {
  class Strict extends Mailbox {
    async process(): Promise<void> {
      this.bounceNowWith({ to: [this.message.from], subject: "Not here", text: "Wrong address" });

      trace.push("kept going");
    }
  }

  it("stops the rest of process", async () => {
    trace.length = 0;
    await new Strict(arriving()).performProcessing();

    expect(trace).not.toContain("kept going");
  });

  it("hands back the reply rather than sending it", async () => {
    const result = await new Strict(arriving()).performProcessing();

    expect(result.status).toBe("bounced");
    expect(result.bounce?.subject).toBe("Not here");
  });

  it("skips the after hooks", async () => {
    class Refusing extends Mailbox {
      async process(): Promise<void> {
        this.bounceNowWith({ to: ["a@b.com"], subject: "no", text: "no" });
      }
    }

    let ran = false;
    Refusing.afterProcessing(() => void (ran = true));

    await new Refusing(arriving()).performProcessing();

    expect(ran).toBe(false);
  });

  it("says the message is no longer pending", async () => {
    const mailbox = new Strict(arriving());

    expect(mailbox.finishedProcessing()).toBe(false);
    await mailbox.performProcessing();
    expect(mailbox.finishedProcessing()).toBe(true);
  });
});

/**
 * The hooks are only worth having if the router runs them, which is exactly
 * the "declared but never consulted" shape this codebase keeps finding.
 */
describe("the router", () => {
  it("goes through performProcessing rather than straight to process", async () => {
    const seen: string[] = [];

    class Routed extends Mailbox {
      async process(): Promise<void> {
        seen.push("process");
      }
    }
    Routed.beforeProcessing(() => void seen.push("before"));

    const router = new MailboxRouter().route("support@example.com", Routed);
    const result = await router.receive(arriving());

    expect(result.status).toBe("delivered");
    expect(seen).toEqual(["before", "process"]);
  });

  it("reports a bounce from inside process as a bounce, not a delivery", async () => {
    class Refusing extends Mailbox {
      async process(): Promise<void> {
        this.bounceNowWith({ to: ["a@b.com"], subject: "no", text: "no" });
      }
    }

    const router = new MailboxRouter().route("support@example.com", Refusing);

    expect((await router.receive(arriving())).status).toBe("bounced");
  });
});
