/**
 * Reading a raw email off the wire, ported from
 * `actionmailbox/test/unit/inbound_email/message_id_test.rb` and the relayer
 * cases in `actionmailbox/test/unit/relayer_test.rb`.
 *
 * The router took a parsed shape, which is what Mailgun and SendGrid post. It
 * is not what everything posts: Postmark's raw mode, an SMTP server piping to
 * a command, and anything relaying through exim hand over the RFC 822 source,
 * and without a parser those could not be received at all.
 */

import { describe, expect, it } from "bun:test";
import { addressIn, addressesIn, fromSource, relay } from "../src/inbound_source.js";

const SIMPLE = [
  "Message-ID: <abc123@mail.test>",
  "From: Alice <alice@example.test>",
  "To: support@app.test",
  "Subject: Help please",
  "Date: Thu, 01 Jan 2026 12:00:00 +0000",
  "",
  "My order has not arrived.",
].join("\r\n");

describe("addresses", () => {
  it("takes the address out of a display name", () => {
    expect(addressIn("Alice <alice@example.test>")).toBe("alice@example.test");
  });

  it("leaves a bare address alone", () => {
    expect(addressIn("alice@example.test")).toBe("alice@example.test");
  });

  it("splits a recipient list", () => {
    expect(addressesIn("a@b.test, c@d.test")).toEqual(["a@b.test", "c@d.test"]);
  });

  /** Ordinary, and splitting naively drops half of everybody called that. */
  it("does not split a display name containing a comma", () => {
    expect(addressesIn('"Smith, J" <j@b.test>, other@b.test')).toEqual([
      "j@b.test",
      "other@b.test",
    ]);
  });

  it("gives nothing for nothing", () => {
    expect(addressesIn(undefined)).toEqual([]);
    expect(addressesIn("")).toEqual([]);
  });
});

describe("fromSource", () => {
  it("reads the headers", () => {
    const message = fromSource(SIMPLE);

    expect(message.from).toBe("alice@example.test");
    expect(message.to).toEqual(["support@app.test"]);
    expect(message.subject).toBe("Help please");
  });

  /** Without a stable id a provider's retry is processed twice. */
  it("takes the message id, without its brackets", () => {
    expect(fromSource(SIMPLE).messageId).toBe("abc123@mail.test");
  });

  it("reads the body", () => {
    expect(fromSource(SIMPLE).text).toBe("My order has not arrived.");
  });

  it("reads the date", () => {
    expect(fromSource(SIMPLE).receivedAt?.getUTCFullYear()).toBe(2026);
  });

  it("keeps the headers it was given", () => {
    expect(fromSource(SIMPLE).headers?.Subject).toBe("Help please");
  });

  it("reads bytes as readily as a string", () => {
    expect(fromSource(new TextEncoder().encode(SIMPLE)).subject).toBe("Help please");
  });

  it("survives a message with no headers it knows", () => {
    const message = fromSource("\r\nJust a body.");

    expect(message.text).toBe("Just a body.");
    expect(message.subject).toBe("");
  });

  /** A stray blank line in the header block turns the rest into a body. */
  it("ends the headers at the first blank line", () => {
    const message = fromSource("Subject: One\r\n\r\nSubject: Not a header\r\n");

    expect(message.subject).toBe("One");
    expect(message.text).toContain("Subject: Not a header");
  });

  /** Missing this splits a long subject in two and loses the tail. */
  it("joins a header folded onto the next line", () => {
    const message = fromSource("Subject: a very long\r\n  subject line\r\n\r\nbody");

    expect(message.subject).toBe("a very long subject line");
  });

  /** Preferring a later one is how a spoofed header ends up believed. */
  it("keeps the first of a repeated header", () => {
    const message = fromSource("From: real@b.test\r\nFrom: spoof@evil.test\r\n\r\nbody");

    expect(message.from).toBe("real@b.test");
  });

  it("reads a cc list", () => {
    const message = fromSource("To: a@b.test\r\nCc: c@d.test, e@f.test\r\n\r\nbody");

    expect(message.cc).toEqual(["c@d.test", "e@f.test"]);
  });

  it("leaves cc off when there is none", () => {
    expect(fromSource(SIMPLE).cc).toBeUndefined();
  });
});

describe("encodings", () => {
  it("decodes base64", () => {
    const source = [
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("Hello there").toString("base64"),
    ].join("\r\n");

    expect(fromSource(source).text).toBe("Hello there");
  });

  it("decodes quoted-printable", () => {
    const source = ["Content-Transfer-Encoding: quoted-printable", "", "caf=C3=A9"].join("\r\n");

    expect(fromSource(source).text).toBe("café");
  });

  /** A trailing `=` is a wrap, not a character; left in it splits words. */
  it("joins a quoted-printable soft line break", () => {
    const source = ["Content-Transfer-Encoding: quoted-printable", "", "one=", "two"].join("\r\n");

    expect(fromSource(source).text).toBe("onetwo");
  });

  it("leaves plain text alone", () => {
    expect(fromSource("\r\nplain").text).toBe("plain");
  });

  it("falls back when the charset is one nobody has heard of", () => {
    const source = [
      "Content-Type: text/plain; charset=x-invented",
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("Hello").toString("base64"),
    ].join("\r\n");

    expect(fromSource(source).text).toBe("Hello");
  });
});

describe("multipart", () => {
  const multipart = [
    "From: a@b.test",
    "To: c@d.test",
    "Subject: Both",
    'Content-Type: multipart/alternative; boundary="xyz"',
    "",
    "--xyz",
    "Content-Type: text/plain",
    "",
    "The plain one.",
    "--xyz",
    "Content-Type: text/html",
    "",
    "<p>The html one.</p>",
    "--xyz--",
    "",
  ].join("\r\n");

  it("finds the plain part", () => {
    expect(fromSource(multipart).text).toBe("The plain one.");
  });

  it("finds the html part", () => {
    expect(fromSource(multipart).html).toBe("<p>The html one.</p>");
  });

  it("still reads the outer headers", () => {
    expect(fromSource(multipart).subject).toBe("Both");
  });

  it("decodes a part with its own encoding", () => {
    const source = [
      'Content-Type: multipart/alternative; boundary="xyz"',
      "",
      "--xyz",
      "Content-Type: text/plain",
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("Encoded part").toString("base64"),
      "--xyz--",
    ].join("\r\n");

    expect(fromSource(source).text).toBe("Encoded part");
  });
});

describe("relay", () => {
  /** The headers of a captured request, or an empty set if nothing was sent. */
  function headersOf(init: RequestInit | undefined): Record<string, string> {
    return (init?.headers as Record<string, string> | undefined) ?? {};
  }

  function answering(status: number): typeof globalThis.fetch {
    return (async () => new Response(null, { status })) as unknown as typeof globalThis.fetch;
  }

  it("reports a delivery", async () => {
    const result = await relay(SIMPLE, { url: "https://app.test/ingress", fetch: answering(204) });

    expect(result.delivered).toBe(true);
    expect(result.retryable).toBe(false);
  });

  /**
   * The three-way answer is the point: an SMTP server needs to know whether to
   * bin the message, bounce it, or hold it and try again.
   */
  it("says a server error is worth retrying", async () => {
    const result = await relay(SIMPLE, { url: "https://app.test/ingress", fetch: answering(500) });

    expect(result.delivered).toBe(false);
    expect(result.retryable).toBe(true);
  });

  /** Retrying either is a message that never stops arriving. */
  it("says a refusal is not", async () => {
    for (const status of [404, 422]) {
      const result = await relay(SIMPLE, {
        url: "https://app.test/ingress",
        fetch: answering(status),
      });

      expect(result.retryable).toBe(false);
      expect(result.delivered).toBe(false);
    }
  });

  it("says bad credentials are worth retrying, since they may be fixed", async () => {
    const result = await relay(SIMPLE, { url: "https://app.test/ingress", fetch: answering(401) });

    expect(result.retryable).toBe(true);
  });

  it("explains what happened", async () => {
    const result = await relay(SIMPLE, { url: "https://app.test/ingress", fetch: answering(404) });

    expect(result.message).toContain("no ingress");
  });

  it("sends the source as rfc822", async () => {
    let seen: RequestInit | undefined;

    await relay(SIMPLE, {
      url: "https://app.test/ingress",
      fetch: (async (_url: string, init: RequestInit) => {
        seen = init;

        return new Response(null, { status: 204 });
      }) as unknown as typeof globalThis.fetch,
    });

    expect(headersOf(seen)["content-type"]).toBe("message/rfc822");
    expect(seen?.body).toBe(SIMPLE);
  });

  it("sends credentials when it has them", async () => {
    let seen: RequestInit | undefined;

    await relay(SIMPLE, {
      url: "https://app.test/ingress",
      password: "secret",
      fetch: (async (_url: string, init: RequestInit) => {
        seen = init;

        return new Response(null, { status: 204 });
      }) as unknown as typeof globalThis.fetch,
    });

    const authorization = headersOf(seen).authorization ?? "";

    expect(Buffer.from(authorization.replace("Basic ", ""), "base64").toString()).toBe(
      "actionmailbox:secret",
    );
  });

  it("sends none when it has none", async () => {
    let seen: RequestInit | undefined;

    await relay(SIMPLE, {
      url: "https://app.test/ingress",
      fetch: (async (_url: string, init: RequestInit) => {
        seen = init;

        return new Response(null, { status: 204 });
      }) as unknown as typeof globalThis.fetch,
    });

    expect(headersOf(seen).authorization).toBeUndefined();
  });
});
