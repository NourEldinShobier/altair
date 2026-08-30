/**
 * Inbound-email test helpers, ported from
 * `actionmailbox/test/unit/inbound_email_test.rb` and the routing tests.
 */

import { describe, expect, it } from "bun:test";
import { Mailbox, MailboxRouter } from "../src/mailbox.js";
import {
  createInboundEmailFromMail,
  createInboundEmailFromSource,
  receiveInboundEmailFromMail,
  receiveInboundEmailFromSource,
  recipientsAddresses,
  xForwardedToAddresses,
  xOriginalToAddresses,
} from "../src/mailbox_testing.js";

const SOURCE = [
  "Message-ID: <abc@example.com>",
  "From: Ada Lovelace <ada@example.com>",
  "To: support@example.com, second@example.com",
  "Cc: watcher@example.com",
  "Subject: Broken widget",
  "",
  "It stopped working.",
].join("\n");

describe("createInboundEmailFromMail", () => {
  it("fills in what the test did not say", () => {
    const mail = createInboundEmailFromMail({ subject: "Hi" });

    expect(mail.messageId).toBeTruthy();
    expect(mail.from).toBeTruthy();
    expect(mail.to).toHaveLength(1);
  });

  it("keeps what the test did say", () => {
    const mail = createInboundEmailFromMail({ from: "me@example.com", to: ["you@example.com"] });

    expect(mail.from).toBe("me@example.com");
    expect(mail.to).toEqual(["you@example.com"]);
  });
});

describe("createInboundEmailFromSource", () => {
  it("reads the message id", () => {
    expect(createInboundEmailFromSource(SOURCE).messageId).toBe("<abc@example.com>");
  });

  it("reads the subject", () => {
    expect(createInboundEmailFromSource(SOURCE).subject).toBe("Broken widget");
  });

  /** The display name is not the address, and routing needs the address. */
  it("strips the display name off the sender", () => {
    expect(createInboundEmailFromSource(SOURCE).from).toBe("ada@example.com");
  });

  it("splits several recipients", () => {
    expect(createInboundEmailFromSource(SOURCE).to).toEqual([
      "support@example.com",
      "second@example.com",
    ]);
  });

  it("reads the cc list", () => {
    expect(createInboundEmailFromSource(SOURCE).cc).toEqual(["watcher@example.com"]);
  });

  it("keeps the body", () => {
    expect(createInboundEmailFromSource(SOURCE).text).toBe("It stopped working.");
  });

  it("copes with a source that has no body", () => {
    expect(createInboundEmailFromSource("To: a@example.com").to).toEqual(["a@example.com"]);
  });

  it("handles CRLF line endings", () => {
    const crlf = SOURCE.replaceAll("\n", "\r\n");

    expect(createInboundEmailFromSource(crlf).subject).toBe("Broken widget");
  });
});

describe("the forwarding headers", () => {
  function forwarded(headers: Record<string, string>) {
    return createInboundEmailFromMail({ to: ["catchall@example.com"], headers });
  }

  it("reads x-forwarded-to", () => {
    expect(xForwardedToAddresses(forwarded({ "x-forwarded-to": "support@example.com" }))).toEqual([
      "support@example.com",
    ]);
  });

  it("reads x-original-to", () => {
    expect(xOriginalToAddresses(forwarded({ "x-original-to": "sales@example.com" }))).toEqual([
      "sales@example.com",
    ]);
  });

  it("gives nothing when the header is absent", () => {
    expect(xForwardedToAddresses(createInboundEmailFromMail())).toEqual([]);
  });

  it("splits several", () => {
    const message = forwarded({ "x-forwarded-to": "a@example.com, b@example.com" });

    expect(xForwardedToAddresses(message)).toEqual(["a@example.com", "b@example.com"]);
  });
});

describe("recipientsAddresses", () => {
  /**
   * The forwarded address comes first because it is the specific one: `to` on
   * a forwarded message is the catch-all, and routing on that sends everything
   * to one mailbox.
   */
  it("puts the forwarded address before the envelope one", () => {
    const message = createInboundEmailFromMail({
      to: ["catchall@example.com"],
      headers: { "x-forwarded-to": "support@example.com" },
    });

    expect(recipientsAddresses(message)[0]).toBe("support@example.com");
  });

  it("includes the cc list", () => {
    expect(recipientsAddresses(createInboundEmailFromSource(SOURCE))).toContain(
      "watcher@example.com",
    );
  });

  it("lower-cases them", () => {
    const message = createInboundEmailFromMail({ to: ["Support@Example.com"] });

    expect(recipientsAddresses(message)).toEqual(["support@example.com"]);
  });

  it("does not repeat an address that appears twice", () => {
    const message = createInboundEmailFromMail({
      to: ["a@example.com"],
      cc: ["a@example.com"],
    });

    expect(recipientsAddresses(message)).toEqual(["a@example.com"]);
  });
});

describe("receiving", () => {
  class SupportMailbox extends Mailbox {
    static received: string[] = [];

    override async process(): Promise<void> {
      SupportMailbox.received.push(this.message.subject);
    }
  }

  it("routes a message built from parts", async () => {
    SupportMailbox.received = [];
    const router = new MailboxRouter().route("support@example.com", SupportMailbox);

    await receiveInboundEmailFromMail(router, {
      to: ["support@example.com"],
      subject: "Help",
    });

    expect(SupportMailbox.received).toEqual(["Help"]);
  });

  it("routes a message built from source", async () => {
    SupportMailbox.received = [];
    const router = new MailboxRouter().route("support@example.com", SupportMailbox);

    const result = await receiveInboundEmailFromSource(router, SOURCE);

    expect(result.status).toBe("delivered");
    expect(SupportMailbox.received).toEqual(["Broken widget"]);
  });
});
