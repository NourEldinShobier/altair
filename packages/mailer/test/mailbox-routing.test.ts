/**
 * Routes declared on a class, ported from `ApplicationMailbox.routing` in
 * `actionmailbox/lib/action_mailbox/base.rb` and the routing cases in
 * `actionmailbox/test/unit/router_test.rb`.
 *
 * Rails puts this on a class because Ruby autoloads the file that declares it.
 * The reason to have it here is different and better: first match wins, so the
 * order routes are added in *is* the routing — and a shared `MailboxRouter`
 * that several modules push onto at import time is routed by whatever order
 * the bundler settled on. That is the same import-order hazard that made a
 * mail delivery method register itself on import and then depend on which
 * file was loaded first.
 *
 * Declaring on a class keeps a route beside the mailbox it names, and
 * `router()` reads them in declaration order every time.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Mailbox, MailboxRoutes, type InboundMessage } from "../src/mailbox.js";

const handled: string[] = [];

class RepliesMailbox extends Mailbox {
  async process(): Promise<void> {
    handled.push("replies");
  }
}

class SupportMailbox extends Mailbox {
  async process(): Promise<void> {
    handled.push("support");
  }
}

class CatchAllMailbox extends Mailbox {
  async process(): Promise<void> {
    handled.push("catch-all");
  }
}

class ApplicationMailbox extends MailboxRoutes {}

function inbound(to: string): InboundMessage {
  return { messageId: `m-${to}`, from: "someone@example.com", to: [to], subject: "hi" };
}

beforeEach(() => {
  handled.length = 0;
  ApplicationMailbox.resetRouting();
});

afterEach(() => {
  ApplicationMailbox.resetRouting();
});

describe("declaring routes on a class", () => {
  it("routes an address to the mailbox that claims it", async () => {
    ApplicationMailbox.routing("support@example.com", SupportMailbox);

    await ApplicationMailbox.router().receive(inbound("support@example.com"));

    expect(handled).toEqual(["support"]);
  });

  it("takes a pattern as well as an address", async () => {
    ApplicationMailbox.routing(/^reply\+/, RepliesMailbox);

    await ApplicationMailbox.router().receive(inbound("reply+42@example.com"));

    expect(handled).toEqual(["replies"]);
  });

  it("takes a predicate", async () => {
    ApplicationMailbox.routing((address) => address.endsWith(".test"), SupportMailbox);

    await ApplicationMailbox.router().receive(inbound("anyone@example.test"));

    expect(handled).toEqual(["support"]);
  });

  it("chains", () => {
    ApplicationMailbox.routing("a@example.com", SupportMailbox).routing(
      "b@example.com",
      RepliesMailbox,
    );

    expect(ApplicationMailbox.routingPatterns()).toEqual(["a@example.com", "b@example.com"]);
  });
});

describe("order", () => {
  /**
   * First match wins, which is the whole of the semantics — so the order is
   * the routing, and a router built from the class has to preserve it.
   */
  it("tries them in the order they were declared", async () => {
    ApplicationMailbox.routing(/@example\.com$/, CatchAllMailbox);
    ApplicationMailbox.routing("support@example.com", SupportMailbox);

    await ApplicationMailbox.router().receive(inbound("support@example.com"));

    expect(handled).toEqual(["catch-all"]);
  });

  it("puts the specific one first when it is declared first", async () => {
    ApplicationMailbox.routing("support@example.com", SupportMailbox);
    ApplicationMailbox.routing(/@example\.com$/, CatchAllMailbox);

    await ApplicationMailbox.router().receive(inbound("support@example.com"));

    expect(handled).toEqual(["support"]);
  });

  it("builds the same order every time", () => {
    ApplicationMailbox.routing("a@example.com", SupportMailbox);
    ApplicationMailbox.routing("b@example.com", RepliesMailbox);

    expect(ApplicationMailbox.router().routingPatterns()).toEqual(
      ApplicationMailbox.router().routingPatterns(),
    );
  });
});

describe("a subclass", () => {
  /**
   * Copy on write, the rule the callback chains and the model associations
   * follow. Without it a mailbox class declared for one test adds a route to
   * the application's, and the next test routes somewhere nobody asked for.
   */
  it("starts with its parent's routes", () => {
    ApplicationMailbox.routing("support@example.com", SupportMailbox);

    class Special extends ApplicationMailbox {}

    expect(Special.routingPatterns()).toEqual(["support@example.com"]);
  });

  it("does not add to its parent's", () => {
    ApplicationMailbox.routing("support@example.com", SupportMailbox);

    class Special extends ApplicationMailbox {}

    Special.routing("special@example.com", RepliesMailbox);

    expect(Special.routingPatterns()).toEqual(["support@example.com", "special@example.com"]);
    expect(ApplicationMailbox.routingPatterns()).toEqual(["support@example.com"]);
  });
});

describe("with no route for an address", () => {
  it("bounces rather than dropping it", async () => {
    ApplicationMailbox.routing("support@example.com", SupportMailbox);

    const result = await ApplicationMailbox.router().receive(inbound("nobody@example.com"));

    expect(result.status).toBe("bounced");
    expect(handled).toEqual([]);
  });

  it("bounces when nothing is routed at all", async () => {
    const result = await ApplicationMailbox.router().receive(inbound("anyone@example.com"));

    expect(result.status).toBe("bounced");
  });
});
