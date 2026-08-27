/**
 * What a mailbox does with mail it cannot process, ported from
 * `actionmailbox/test/unit/mailbox_test.rb`.
 *
 * Three answers, because they mean different things to whoever sent it:
 * bounced is "we understood and the answer is no", failed is "we broke, try
 * again", delivered is done. Silence is the fourth and the worst — the sender
 * believes their reply landed.
 */

import { describe, expect, it } from "bun:test";
import {
  bccAddresses,
  bounceWith,
  ccAddresses,
  delivered,
  fromAddress,
  looksAutomated,
  permanentFailure,
  recipientsOf,
  replyToAddress,
  senderOf,
  toAddresses,
  transientFailure,
} from "../src/bounce.js";

const inbound = (fields: Partial<Parameters<typeof bounceWith>[0]> = {}) =>
  ({
    from: "ada@example.com",
    to: "support@example.com",
    subject: "Help",
    text: "hello",
    ...fields,
  }) as Parameters<typeof bounceWith>[0];

describe("the three answers", () => {
  it("says delivered", () => {
    expect(delivered().status).toBe("delivered");
  });

  it("says failed, with a reason", () => {
    expect(transientFailure("the queue is down")).toEqual({
      status: "failed",
      reason: "the queue is down",
    });

    expect(permanentFailure("nothing to do").status).toBe("failed");
  });

  it("builds a bounce back to the sender", () => {
    const result = bounceWith(inbound(), { subject: "Undeliverable", text: "No such thread." });

    expect(result.status).toBe("bounced");
    expect(result.bounce?.to).toBe("ada@example.com");
    expect(result.bounce?.subject).toBe("Undeliverable");
  });
});

/**
 * The one address a bounce may ever go to is the sender. Replying to anything
 * the message named — a `To`, a `Reply-To` — is how a mailbox becomes a way to
 * send mail to strangers.
 */
describe("who a bounce goes to", () => {
  it("is the sender, not the reply-to", () => {
    const result = bounceWith(inbound({ replyTo: "somebody-else@example.com" }), {
      subject: "No",
      text: "no",
    });

    expect(result.bounce?.to).toBe("ada@example.com");
  });

  it("is nobody when there was no sender", () => {
    const result = bounceWith(inbound({ from: undefined }), { subject: "No", text: "no" });

    expect(result.status).toBe("failed");
    expect(result.bounce).toBeUndefined();
  });
});

/**
 * Bouncing an automatic message is how two mail servers spend a weekend
 * talking to each other. `Auto-Submitted` is the header that exists to stop
 * exactly this.
 */
describe("mail that should never be bounced", () => {
  it("recognises an automatic message", () => {
    expect(looksAutomated(inbound({ headers: { "auto-submitted": "auto-replied" } }))).toBe(true);
    expect(looksAutomated(inbound({ headers: { "Auto-Submitted": "auto-generated" } }))).toBe(true);
  });

  it("does not mistake one that says it is not automatic", () => {
    expect(looksAutomated(inbound({ headers: { "auto-submitted": "no" } }))).toBe(false);
    expect(looksAutomated(inbound())).toBe(false);
  });

  it("recognises a mailing list and a bulk message", () => {
    expect(looksAutomated(inbound({ headers: { "list-id": "<list.example.com>" } }))).toBe(true);
    expect(looksAutomated(inbound({ headers: { precedence: "bulk" } }))).toBe(true);
  });

  // The null sender is what a bounce itself uses, and bouncing a bounce is the
  // loop all of this exists to stop.
  it("recognises a bounce", () => {
    expect(looksAutomated(inbound({ from: "<>" }))).toBe(true);
  });

  it("refuses to bounce to any of them", () => {
    const result = bounceWith(inbound({ headers: { "auto-submitted": "auto-replied" } }), {
      subject: "No",
      text: "no",
    });

    expect(result.status).toBe("failed");
    expect(senderOf(inbound({ headers: { "list-id": "x" } }))).toBeNull();
  });
});

describe("reading the addresses", () => {
  const message = inbound({
    to: ["a@example.com", "b@example.com"],
    cc: "c@example.com",
    bcc: { name: "D", address: "d@example.com" },
    replyTo: "reply@example.com",
  });

  it("takes each header apart", () => {
    expect(toAddresses(message)).toEqual(["a@example.com", "b@example.com"]);
    expect(ccAddresses(message)).toEqual(["c@example.com"]);
    expect(bccAddresses(message)).toEqual(["d@example.com"]);
    expect(fromAddress(message)).toBe("ada@example.com");
    expect(replyToAddress(message)).toBe("reply@example.com");
  });

  it("gathers every recipient across them, once each", () => {
    expect(recipientsOf(message)).toEqual([
      "a@example.com",
      "b@example.com",
      "c@example.com",
      "d@example.com",
    ]);
  });

  it("does not count the same address twice", () => {
    expect(recipientsOf(inbound({ to: "a@example.com", cc: "A@example.com" }))).toEqual([
      "a@example.com",
    ]);
  });
});
