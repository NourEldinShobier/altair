/**
 * Mailer suite.
 *
 * Mirrors actionmailer/test/ — building messages, defaults, delivery methods
 * and the test delivery collector.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Mailer, type DeliveryQueue } from "../src/mailer.js";
import {
  LogDelivery,
  TestDelivery,
  UnconfiguredDelivery,
  formatAddress,
  formatAddresses,
  type MessageFields,
} from "../src/message.js";

let delivery: TestDelivery;

class UserMailer extends Mailer {
  static override defaults = { from: "noreply@example.com" };

  static welcome(user: { email: string; name: string }) {
    return this.mail({
      to: user.email,
      subject: "Welcome aboard",
      html: (
        <div>
          <h1>Hello {user.name}</h1>
        </div>
      ),
    });
  }

  static receipt(email: string, total: number) {
    return this.mail({
      to: email,
      subject: "Your receipt",
      text: `You paid ${total}`,
    });
  }
}

beforeEach(() => {
  delivery = new TestDelivery();
  Mailer.delivery = delivery;
  UserMailer.delivery = delivery;
  Mailer.queue = undefined;
  UserMailer.queue = undefined;
});

describe("addresses", () => {
  it("passes a plain address through", () => {
    expect(formatAddress("a@b.c")).toBe("a@b.c");
  });

  it("formats a named address", () => {
    expect(formatAddress({ name: "Ada", address: "ada@example.com" })).toBe(
      "Ada <ada@example.com>",
    );
  });

  // A name containing a comma would otherwise split the header into two
  // recipients, which is how mail gets sent to the wrong person.
  it("quotes a name that would break the header", () => {
    expect(formatAddress({ name: "Lovelace, Ada", address: "a@b.c" })).toBe(
      '"Lovelace, Ada" <a@b.c>',
    );
    expect(formatAddress({ name: 'Ada "The First"', address: "a@b.c" })).toContain('\\"');
  });

  it("joins several addresses", () => {
    expect(formatAddresses(["a@b.c", { name: "Ada", address: "d@e.f" }])).toBe(
      "a@b.c, Ada <d@e.f>",
    );
    expect(formatAddresses(undefined)).toBe("");
  });
});

describe("building messages", () => {
  it("renders TSX to HTML", async () => {
    const message = await UserMailer.welcome({ email: "ada@example.com", name: "Ada" }).toMessage();

    expect(message.html).toBe("<div><h1>Hello Ada</h1></div>");
    expect(message.subject).toBe("Welcome aboard");
    expect(message.to).toBe("ada@example.com");
  });

  it("escapes rendered content", async () => {
    const message = await UserMailer.welcome({
      email: "a@b.c",
      name: "<script>alert(1)</script>",
    }).toMessage();

    expect(message.html).not.toContain("<script>");
    expect(message.html).toContain("&lt;script&gt;");
  });

  it("takes a plain string body", async () => {
    const message = await UserMailer.receipt("a@b.c", 10).toMessage();

    expect(message.text).toBe("You paid 10");
    expect(message.html).toBeUndefined();
  });

  it("applies the mailer's defaults", async () => {
    const message = await UserMailer.receipt("a@b.c", 1).toMessage();
    expect(message.from).toBe("noreply@example.com");
  });

  it("lets a message override a default", async () => {
    class Override extends Mailer {
      static override defaults = { from: "default@example.com" };
      static hello() {
        return this.mail({ to: "a@b.c", from: "specific@example.com", subject: "Hi" });
      }
    }

    expect((await Override.hello().toMessage()).from).toBe("specific@example.com");
  });

  it("merges default headers with the message's", async () => {
    class Tagged extends Mailer {
      static override defaults = { from: "a@b.c", headers: { "X-App": "altair" } };
      static hello() {
        return this.mail({ to: "d@e.f", subject: "Hi", headers: { "X-Kind": "greeting" } });
      }
    }

    expect((await Tagged.hello().toMessage()).headers).toEqual({
      "X-App": "altair",
      "X-Kind": "greeting",
    });
  });

  it("refuses a message with no from address", async () => {
    class Anonymous extends Mailer {
      static hello() {
        return this.mail({ to: "a@b.c", subject: "Hi" });
      }
    }

    await expect(Anonymous.hello().toMessage()).rejects.toThrow("has no from address");
  });

  it("refuses a message with no recipient", async () => {
    class Nowhere extends Mailer {
      static override defaults = { from: "a@b.c" };
      static hello() {
        return this.mail({ to: [], subject: "Hi" });
      }
    }

    await expect(Nowhere.hello().toMessage()).rejects.toThrow("has no recipient");
  });
});

describe("delivering", () => {
  it("hands the message to the delivery method", async () => {
    await UserMailer.welcome({ email: "ada@example.com", name: "Ada" }).deliverNow();

    expect(delivery.deliveries).toHaveLength(1);
    expect(delivery.last?.subject).toBe("Welcome aboard");
  });

  it("returns the delivered message", async () => {
    const message = await UserMailer.receipt("a@b.c", 5).deliverNow();
    expect(message.text).toBe("You paid 5");
  });

  it("collects several deliveries", async () => {
    await UserMailer.receipt("a@b.c", 1).deliverNow();
    await UserMailer.receipt("d@e.f", 2).deliverNow();

    expect(delivery.deliveries.map((m) => m.to)).toEqual(["a@b.c", "d@e.f"]);
    delivery.clear();
    expect(delivery.deliveries).toHaveLength(0);
  });

  // Silently dropping mail is the failure nobody notices until a customer
  // asks where their receipt went.
  it("refuses to deliver with no delivery method configured", async () => {
    class Unset extends Mailer {
      static override delivery = new UnconfiguredDelivery();
      static override defaults = { from: "a@b.c" };
      static hello() {
        return this.mail({ to: "d@e.f", subject: "Hi" });
      }
    }

    await expect(Unset.hello().deliverNow()).rejects.toThrow("No delivery method configured");
  });

  it("writes to a log delivery", async () => {
    const lines: string[] = [];

    class Logged extends Mailer {
      static override delivery = new LogDelivery((line) => lines.push(line));
      static override defaults = { from: "a@b.c" };
      static hello() {
        return this.mail({ to: "d@e.f", subject: "Hi", text: "body" });
      }
    }

    await Logged.hello().deliverNow();

    expect(lines[0]).toContain("To: d@e.f");
    expect(lines[0]).toContain("Subject: Hi");
    expect(lines[0]).toContain("body");
  });

  // Anything exposing sendMail works: Nodemailer, an SES client, or a stub.
  it("works with any transport exposing sendMail", async () => {
    const sent: MessageFields[] = [];

    class Custom extends Mailer {
      static override delivery = {
        sendMail: async (message: MessageFields) => void sent.push(message),
      };
      static override defaults = { from: "a@b.c" };
      static hello() {
        return this.mail({ to: "d@e.f", subject: "Hi" });
      }
    }

    await Custom.hello().deliverNow();
    expect(sent).toHaveLength(1);
  });
});

describe("deliverLater", () => {
  it("puts the rendered message on the queue", async () => {
    const queued: MessageFields[] = [];
    const queue: DeliveryQueue = { enqueue: async (message) => void queued.push(message) };

    UserMailer.queue = queue;
    await UserMailer.welcome({ email: "ada@example.com", name: "Ada" }).deliverLater();

    expect(queued).toHaveLength(1);
    // The body is already rendered, which is the difference from Rails.
    expect(queued[0]!.html).toBe("<div><h1>Hello Ada</h1></div>");
    expect(delivery.deliveries).toHaveLength(0);
  });

  it("refuses without a queue", async () => {
    await expect(UserMailer.receipt("a@b.c", 1).deliverLater()).rejects.toThrow(
      "No delivery queue configured",
    );
  });

  it("validates the message before queuing it", async () => {
    class Anonymous extends Mailer {
      static override queue = { enqueue: async () => undefined };
      static hello() {
        return this.mail({ to: "a@b.c", subject: "Hi" });
      }
    }

    await expect(Anonymous.hello().deliverLater()).rejects.toThrow("has no from address");
  });
});
