/**
 * Inbound mail.
 *
 * Mirrors actionmailbox/test/unit/ and the ingress controllers. Two behaviours
 * carry their weight: a provider retries anything it does not like, so a
 * message must not be processed twice; and an endpoint that anyone can post to
 * is an application that can be told anything by anybody.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import {
  addressOf,
  inboundIngress,
  Mailbox,
  MailboxRouter,
  matchesPattern,
  MemoryInboundLog,
  parseInbound,
  type InboundMessage,
} from "../src/mailbox.js";

const handled: string[] = [];

class SupportMailbox extends Mailbox {
  async process(): Promise<void> {
    handled.push(`support:${this.message.subject}`);
  }
}

class RepliesMailbox extends Mailbox {
  async process(): Promise<void> {
    handled.push(`reply:${this.recipient}`);
  }
}

class RefusingMailbox extends Mailbox {
  override async accepts(): Promise<boolean> {
    return false;
  }
  async process(): Promise<void> {
    handled.push("refusing");
  }
}

class BrokenMailbox extends Mailbox {
  async process(): Promise<void> {
    throw new Error("the database was down");
  }
}

const message = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  messageId: "msg-1",
  from: "someone@example.com",
  to: ["support@example.com"],
  subject: "Help",
  text: "It is broken",
  ...over,
});

beforeEach(() => {
  handled.length = 0;
});

describe("addresses", () => {
  it("come out of an angled form", () => {
    expect(addressOf("Ada Lovelace <ada@example.com>")).toBe("ada@example.com");
  });

  it("are left alone when bare", () => {
    expect(addressOf("ada@example.com")).toBe("ada@example.com");
  });

  it("are compared without case", () => {
    expect(addressOf("Ada@Example.COM")).toBe("ada@example.com");
  });
});

describe("patterns", () => {
  it("match an exact address", () => {
    expect(matchesPattern("support@example.com", "support@example.com")).toBe(true);
    expect(matchesPattern("support@example.com", "sales@example.com")).toBe(false);
  });

  it("ignore case", () => {
    expect(matchesPattern("Support@Example.com", "support@example.com")).toBe(true);
  });

  it("match an expression", () => {
    expect(matchesPattern(/^reply\+/, "reply+123@example.com")).toBe(true);
    expect(matchesPattern(/^reply\+/, "support@example.com")).toBe(false);
  });

  it("match whatever a function says", () => {
    expect(matchesPattern((address) => address.endsWith("@example.com"), "x@example.com")).toBe(
      true,
    );
  });
});

describe("routing", () => {
  const router = () =>
    new MailboxRouter()
      .route(/^reply\+/, RepliesMailbox)
      .route("support@example.com", SupportMailbox);

  it("finds the mailbox for an address", () => {
    expect(router().mailboxFor("support@example.com")).toBe(SupportMailbox);
    expect(router().mailboxFor("reply+42@example.com")).toBe(RepliesMailbox);
  });

  it("finds nothing for an address nobody claims", () => {
    expect(router().mailboxFor("nobody@example.com")).toBeUndefined();
  });

  // First match wins, as in Rails, so the order routes are declared in is the
  // order they are tried.
  it("takes the first route that matches", () => {
    const ordered = new MailboxRouter()
      .route(/@example\.com$/, SupportMailbox)
      .route("support@example.com", RepliesMailbox);

    expect(ordered.mailboxFor("support@example.com")).toBe(SupportMailbox);
  });

  it("delivers to the mailbox that claimed it", async () => {
    const result = await router().receive(message());

    expect(result.status).toBe("delivered");
    expect(result.mailbox).toBe("SupportMailbox");
    expect(handled).toEqual(["support:Help"]);
  });

  // A message addressed to a person and copied to a mailbox is still for the
  // mailbox.
  it("considers every recipient", async () => {
    await router().receive(message({ to: ["ada@example.com"], cc: ["support@example.com"] }));
    expect(handled).toEqual(["support:Help"]);
  });

  it("tells the mailbox which address it was routed on", async () => {
    await router().receive(message({ to: ["reply+42@example.com"] }));
    expect(handled).toEqual(["reply:reply+42@example.com"]);
  });

  it("bounces a message nobody claims", async () => {
    const result = await router().receive(message({ to: ["nobody@example.com"] }));

    expect(result.status).toBe("bounced");
    expect(handled).toEqual([]);
  });

  // A message has one destination. Handing it to whichever route matched next
  // would deliver it somewhere nobody wrote down, so declining bounces.
  it("bounces when the mailbox that claimed it declines", async () => {
    const refusing = new MailboxRouter()
      .route("support@example.com", RefusingMailbox)
      .route(/@example\.com$/, SupportMailbox);

    const result = await refusing.receive(message());

    expect(result.status).toBe("bounced");
    expect(result.reason).toContain("RefusingMailbox");
    expect(handled).toEqual([]);
  });

  // A mailbox that threw may work on the next attempt, and telling the sender
  // their message was rejected when the fault was ours is the wrong answer.
  it("marks a mailbox that threw as failed rather than bounced", async () => {
    const broken = new MailboxRouter().route("support@example.com", BrokenMailbox);
    const result = await broken.receive(message());

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("the database was down");
  });
});

// A provider retries anything it does not like the look of, and an
// application that files a duplicate ticket for every retry is worse than one
// that misses mail.
describe("redelivery", () => {
  it("processes a message once", async () => {
    const router = new MailboxRouter().route("support@example.com", SupportMailbox);

    await router.receive(message());
    await router.receive(message());

    expect(handled).toEqual(["support:Help"]);
  });

  it("says the second time was already done", async () => {
    const router = new MailboxRouter().route("support@example.com", SupportMailbox);

    await router.receive(message());
    const second = await router.receive(message());

    expect(second.status).toBe("delivered");
    expect(second.reason).toBe("already processed");
  });

  it("processes a different message", async () => {
    const router = new MailboxRouter().route("support@example.com", SupportMailbox);

    await router.receive(message({ messageId: "one" }));
    await router.receive(message({ messageId: "two", subject: "Another" }));

    expect(handled).toEqual(["support:Help", "support:Another"]);
  });

  // A failure is not recorded, so the provider's retry is a real second
  // attempt rather than a no-op.
  it("lets a failed message be tried again", async () => {
    const attempts: string[] = [];

    class FlakyMailbox extends Mailbox {
      async process(): Promise<void> {
        attempts.push("try");
        if (attempts.length === 1) throw new Error("not yet");
      }
    }

    const router = new MailboxRouter().route("support@example.com", FlakyMailbox);

    expect((await router.receive(message())).status).toBe("failed");
    expect((await router.receive(message())).status).toBe("delivered");
    expect(attempts).toHaveLength(2);
  });

  it("remembers through whatever log it is given", async () => {
    const log = new MemoryInboundLog();
    const router = new MailboxRouter({ log }).route("support@example.com", SupportMailbox);

    await router.receive(message());
    expect(log.entries.has("msg-1")).toBe(true);
  });
});

describe("reading a provider's payload", () => {
  it("takes the common shape", () => {
    const parsed = parseInbound({
      messageId: "abc",
      from: "a@b.com",
      to: "support@example.com",
      subject: "Hi",
      text: "body",
    });

    expect(parsed.messageId).toBe("abc");
    expect(parsed.to).toEqual(["support@example.com"]);
  });

  it("takes a list of recipients", () => {
    expect(parseInbound({ to: ["a@b.com", "c@d.com"] }).to).toHaveLength(2);
  });

  it("reads the hyphenated header name too", () => {
    expect(parseInbound({ "message-id": "xyz" }).messageId).toBe("xyz");
  });

  // Without an id there is nothing to recognise a retry by, so one is made up
  // rather than every delivery colliding under the empty string.
  it("invents an id when the provider sends none", () => {
    const first = parseInbound({ from: "a@b.com" });
    const second = parseInbound({ from: "a@b.com" });

    expect(first.messageId).not.toBe(second.messageId);
  });
});

describe("the ingress endpoint", () => {
  const next = async () => new Response("app", { status: 418 });

  const SECRET = "ingress-secret";

  /**
   * Sends the secret unless a case is about not sending it.
   *
   * An ingress needs one now, so every case that is about something else has
   * to get past the door first.
   */
  const post = (
    body: unknown,
    init: RequestInit = {},
    options: { path?: string; secret?: string } = {},
  ) =>
    inboundIngress(new MailboxRouter().route("support@example.com", SupportMailbox), {
      secret: SECRET,
      ...options,
    })(
      new Request("https://example.com/altair/inbound", {
        method: "POST",
        body: JSON.stringify(body),
        ...init,
        // Sent by default, so a case about routing is not also a case about
        // authentication. A case that is about the door overrides it.
        headers: { authorization: `Bearer ${SECRET}`, ...(init.headers as object) },
      }),
      next,
    );

  it("accepts a message", async () => {
    const response = await post({ messageId: "a", to: "support@example.com", subject: "Hi" });

    expect(response.status).toBe(200);
    expect(handled).toEqual(["support:Hi"]);
  });

  it("passes anything else along", async () => {
    const response = await inboundIngress(new MailboxRouter(), { secret: SECRET })(
      new Request("https://example.com/posts"),
      next,
    );

    expect(response.status).toBe(418);
  });

  it("refuses a method that is not POST", async () => {
    const response = await inboundIngress(new MailboxRouter(), { secret: SECRET })(
      new Request("https://example.com/altair/inbound"),
      next,
    );

    expect(response.status).toBe(405);
  });

  // A provider decides whether to retry from the status, so a failure has to
  // read as one.
  it("answers 500 when a mailbox failed, so the provider tries again", async () => {
    const response = await inboundIngress(
      new MailboxRouter().route("support@example.com", BrokenMailbox),
      { secret: SECRET },
    )(
      new Request("https://example.com/altair/inbound", {
        method: "POST",
        body: JSON.stringify({ messageId: "a", to: "support@example.com" }),
        headers: { authorization: `Bearer ${SECRET}` },
      }),
      next,
    );

    expect(response.status).toBe(500);
  });

  it("answers 200 for a bounce, since retrying will not help", async () => {
    const response = await post({ messageId: "a", to: "nobody@example.com" });

    expect(response.status).toBe(200);
    expect(((await response.json()) as { status: string }).status).toBe("bounced");
  });

  it("refuses a body it cannot read", async () => {
    const response = await inboundIngress(new MailboxRouter(), { secret: SECRET })(
      new Request("https://example.com/altair/inbound", {
        method: "POST",
        body: "not json",
        headers: { authorization: `Bearer ${SECRET}` },
      }),
      next,
    );

    expect(response.status).toBe(400);
  });

  /**
   * An inbound address is printed on websites and in email headers, so the URL
   * behind it is found. Without a secret, a support ticket, a password reset
   * reply or an invoice can be forged by a stranger.
   *
   * Refused at construction rather than at the first request: an endpoint that
   * is open is open from the moment it is mounted, and a boot that fails is
   * seen by whoever mounted it.
   */
  it("cannot be built without a secret", () => {
    expect(() => inboundIngress(new MailboxRouter(), { secret: "" })).toThrow(/needs a secret/);
    expect(() => inboundIngress(new MailboxRouter(), undefined as never)).toThrow();
  });

  it("says what the secret is for", () => {
    expect(() => inboundIngress(new MailboxRouter(), { secret: "" })).toThrow(
      /anyone who finds the URL/,
    );
  });

  // Without a secret the endpoint accepts mail from anyone who finds the URL.
  it("refuses a request with the wrong secret", async () => {
    const response = await post(
      { messageId: "a", to: "support@example.com" },
      { headers: { authorization: "Bearer wrong" } },
      { secret: "right" },
    );

    expect(response.status).toBe(401);
    expect(handled).toEqual([]);
  });

  it("accepts one with the right secret", async () => {
    const response = await post(
      { messageId: "a", to: "support@example.com", subject: "Hi" },
      { headers: { authorization: "Bearer right" } },
      { secret: "right" },
    );

    expect(response.status).toBe(200);
  });

  it("refuses a request with no secret at all", async () => {
    const response = await post(
      { messageId: "a", to: "support@example.com" },
      {},
      {
        secret: "right",
      },
    );

    expect(response.status).toBe(401);
  });
});
