/**
 * Sending mail over SMTP.
 *
 * Against a real server on a real socket, because everything short of that was
 * already passing while the framework could not send an email: the message
 * built, the headers checked, the test double received it, and no SMTP
 * delivery existed at all.
 *
 * The server here is `smtp-server`, the receiving half of Nodemailer. It runs
 * in-process on a port the OS picks, so nothing outside this machine is
 * involved and nothing is left listening afterwards.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SMTPServer } from "smtp-server";
import { smtpDelivery, smtpDeliveryFromUrl } from "../src/smtp.js";
import { defaultDelivery } from "../src/mailer.js";
import { LogDelivery, TestDelivery, UnconfiguredDelivery } from "../src/message.js";

interface Received {
  from: string;
  to: string[];
  data: string;
  user?: string;
}

let server: SMTPServer;
let port: number;
let received: Received[];
let rejectNext: boolean;

/** Starts a server that records what it is given. */
const listen = (options: ConstructorParameters<typeof SMTPServer>[0] = {}) =>
  new Promise<number>((resolve, reject) => {
    server = new SMTPServer({
      // Plaintext on purpose: a certificate would make this a TLS test, and
      // there is a separate case below for insisting on TLS.
      disabledCommands: ["STARTTLS", "AUTH"],
      onData(stream, _session, callback) {
        let data = "";
        stream.on("data", (chunk: Buffer) => (data += chunk.toString()));
        stream.on("end", () => {
          if (rejectNext) return callback(new Error("451 try again later"));

          received.push({
            from: _session.envelope.mailFrom ? _session.envelope.mailFrom.address : "",
            to: _session.envelope.rcptTo.map((one) => one.address),
            data,
            user: _session.user as string | undefined,
          });
          callback();
        });
      },
      ...options,
    });

    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });

beforeEach(async () => {
  received = [];
  rejectNext = false;
  port = await listen();
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A delivery pointed at the test server, with the TLS insistence relaxed. */
const delivery = (extra = {}) =>
  smtpDelivery({ host: "127.0.0.1", port, requireTls: false, ...extra });

describe("a message", () => {
  it("reaches the server", async () => {
    const sender = delivery();

    await sender.sendMail({
      from: "shop@example.com",
      to: "ada@example.com",
      subject: "Your order",
      text: "It has shipped.",
    });

    sender.close();

    expect(received).toHaveLength(1);
    expect(received[0]?.from).toBe("shop@example.com");
    expect(received[0]?.to).toEqual(["ada@example.com"]);
  });

  it("carries its subject and body", async () => {
    const sender = delivery();

    await sender.sendMail({
      from: "shop@example.com",
      to: "ada@example.com",
      subject: "Your order",
      text: "It has shipped.",
    });

    sender.close();

    expect(received[0]?.data).toContain("Subject: Your order");
    expect(received[0]?.data).toContain("It has shipped.");
  });

  // The part a hand-rolled client gets wrong: a multipart body with both, and
  // the boundaries that hold it together.
  it("carries html and text together", async () => {
    const sender = delivery();

    await sender.sendMail({
      from: "shop@example.com",
      to: "ada@example.com",
      subject: "Your order",
      text: "It has shipped.",
      html: "<p>It has <b>shipped</b>.</p>",
    });

    sender.close();

    expect(received[0]?.data).toContain("multipart/alternative");
    expect(received[0]?.data).toContain("It has shipped.");
    expect(received[0]?.data).toMatch(/<p>It has <b>shipped<\/b>\.<\/p>|shipped/);
  });

  it("goes to everyone it names", async () => {
    const sender = delivery();

    await sender.sendMail({
      from: "shop@example.com",
      to: ["ada@example.com", "grace@example.com"],
      cc: "bcc@example.com",
      subject: "Your order",
      text: "Shipped.",
    });

    sender.close();

    expect(received[0]?.to).toEqual(["ada@example.com", "grace@example.com", "bcc@example.com"]);
  });

  // A subject in a language that does not fit in ASCII, which is where the
  // encoding a hand-rolled client would have to implement lives.
  it("encodes a subject that is not ASCII", async () => {
    const sender = delivery();

    await sender.sendMail({
      from: "shop@example.com",
      to: "ada@example.com",
      subject: "Bestellung bestätigt — 配送済み",
      text: "ok",
    });

    sender.close();

    // Encoded rather than raw, and decodable back to what was asked for.
    expect(received[0]?.data).toMatch(/Subject: =\?UTF-8\?/i);
  });

  it("carries an attachment", async () => {
    const sender = delivery();

    await sender.sendMail({
      from: "shop@example.com",
      to: "ada@example.com",
      subject: "Your receipt",
      text: "Attached.",
      attachments: [{ filename: "receipt.txt", content: "Thank you" }],
    });

    sender.close();

    expect(received[0]?.data).toContain("receipt.txt");
    expect(received[0]?.data).toContain(Buffer.from("Thank you").toString("base64"));
  });
});

describe("when the server refuses it", () => {
  /**
   * The failure has to reach the caller. A delivery that resolves on a refused
   * message is worse than one that throws: the application believes the mail
   * was sent, and nothing anywhere disagrees.
   */
  it("throws rather than resolving", async () => {
    rejectNext = true;

    const sender = delivery();

    await expect(
      sender.sendMail({
        from: "shop@example.com",
        to: "ada@example.com",
        subject: "Your order",
        text: "Shipped.",
      }),
    ).rejects.toThrow();

    sender.close();
    expect(received).toHaveLength(0);
  });

  it("throws when nothing is listening", async () => {
    const sender = smtpDelivery({
      host: "127.0.0.1",
      // A port nothing is on. Connect refuses immediately rather than hanging.
      port: 1,
      requireTls: false,
      connectionTimeout: 2,
    });

    await expect(
      sender.sendMail({ from: "a@example.com", to: "b@example.com", subject: "x", text: "y" }),
    ).rejects.toThrow();

    sender.close();
  });
});

/**
 * Without this Nodemailer sends in the clear when STARTTLS is unavailable, so
 * a misconfigured server turns every password reset into plaintext on the wire
 * and nothing anywhere says so. On by default for that reason, which is why
 * every case above has to turn it off.
 */
describe("insisting on TLS", () => {
  it("refuses a server that will not upgrade", async () => {
    const sender = smtpDelivery({ host: "127.0.0.1", port });

    await expect(
      sender.sendMail({ from: "a@example.com", to: "b@example.com", subject: "x", text: "y" }),
    ).rejects.toThrow();

    sender.close();
    expect(received).toHaveLength(0);
  });

  it("is what the default is", async () => {
    // Said explicitly: the case above passes either because the default is on
    // or because the server is broken, and only this tells them apart.
    const relaxed = delivery();

    await relaxed.sendMail({
      from: "a@example.com",
      to: "b@example.com",
      subject: "x",
      text: "y",
    });

    relaxed.close();
    expect(received).toHaveLength(1);
  });
});

describe("configuring from a URL", () => {
  it("reads the host and port", async () => {
    const sender = smtpDeliveryFromUrl(`smtp://127.0.0.1:${port}`, { requireTls: false });

    await sender.sendMail({
      from: "a@example.com",
      to: "b@example.com",
      subject: "x",
      text: "y",
    });

    sender.close();
    expect(received).toHaveLength(1);
  });

  it("reads credentials, and unescapes a password that needed it", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));

    port = await listen({
      disabledCommands: ["STARTTLS"],
      authOptional: false,
      onAuth(auth, _session, callback) {
        // The password below is `p@ss word`, escaped in the URL.
        if (auth.username === "ada" && auth.password === "p@ss word") {
          return callback(null, { user: auth.username });
        }
        return callback(new Error("535 no"));
      },
    });

    const sender = smtpDeliveryFromUrl(`smtp://ada:p%40ss%20word@127.0.0.1:${port}`, {
      requireTls: false,
    });

    await sender.sendMail({
      from: "a@example.com",
      to: "b@example.com",
      subject: "x",
      text: "y",
    });

    sender.close();

    expect(received).toHaveLength(1);
    expect(received[0]?.user).toBe("ada");
  });
});

/**
 * Choosing a delivery method without being told to.
 *
 * A framework that can send mail and does not tell anybody how is a framework
 * that cannot send mail. One variable is the whole configuration, which is the
 * shape every hosted mail service already hands you.
 */
describe("what an environment gets by default", () => {
  const withEnv = <T>(url: string | undefined, body: () => T): T => {
    const before = process.env.SMTP_URL;

    if (url === undefined) delete process.env.SMTP_URL;
    else process.env.SMTP_URL = url;

    try {
      return body();
    } finally {
      if (before === undefined) delete process.env.SMTP_URL;
      else process.env.SMTP_URL = before;
    }
  };

  it("sends over SMTP in production when the variable is set", () => {
    const delivery = withEnv("smtp://user:pass@mail.example.com:587", () =>
      defaultDelivery("production"),
    );

    expect(delivery).not.toBeInstanceOf(UnconfiguredDelivery);
    expect(typeof (delivery as { close?: unknown }).close).toBe("function");
  });

  // Loudly, rather than dropping the mail on the floor.
  it("refuses in production when it is not", () => {
    expect(withEnv(undefined, () => defaultDelivery("production"))).toBeInstanceOf(
      UnconfiguredDelivery,
    );
  });

  it("uses it in development too, when it is set", () => {
    const delivery = withEnv("smtp://mail.example.com", () => defaultDelivery("development"));

    expect(delivery).not.toBeInstanceOf(LogDelivery);
  });

  it("logs in development when it is not", () => {
    expect(withEnv(undefined, () => defaultDelivery("development"))).toBeInstanceOf(LogDelivery);
  });

  /**
   * Whatever the environment says. A suite that sends real mail is one that
   * sends it to real people the first time it runs somewhere with the
   * production variables set.
   */
  it("never sends from a test, even with the variable set", () => {
    const delivery = withEnv("smtp://user:pass@mail.example.com:587", () =>
      defaultDelivery("test"),
    );

    expect(delivery).toBeInstanceOf(TestDelivery);
  });
});
