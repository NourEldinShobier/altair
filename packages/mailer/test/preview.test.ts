/**
 * Attachments and mailer previews.
 *
 * Mirrors actionmailer/test/base_test.rb's attachment cases and
 * mailers/previews. A preview shows sample data to whoever asks for it, so
 * where it is served and where it is not is part of the feature.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mailer } from "../src/mailer.js";
import { TestDelivery } from "../src/message.js";
import {
  attachData,
  attachFile,
  attachInline,
  attachmentsSize,
  AttachmentsTooLarge,
  checkAttachments,
  cidUrl,
  contentTypeFor,
  generateCid,
} from "../src/attachments.js";
import {
  definePreviews,
  findPreview,
  previewIndex,
  previewPage,
  previewSlug,
  renderPreview,
  servePreviews,
} from "../src/preview.js";

class UserMailer extends Mailer {
  static override defaults = { from: "hello@example.com" };

  static welcome(name: string) {
    return this.mail({
      to: `${name}@example.com`,
      subject: `Welcome, ${name}`,
      text: `Hello ${name}`,
      html: `<p>Hello ${name}</p>`,
    });
  }

  static broken() {
    return this.mail({ to: "", subject: "Nope" });
  }
}

beforeEach(() => {
  Mailer.delivery = new TestDelivery();
  UserMailer.delivery = new TestDelivery();
});

describe("content types", () => {
  it("come from the filename", () => {
    expect(contentTypeFor("invoice.pdf")).toBe("application/pdf");
    expect(contentTypeFor("logo.png")).toBe("image/png");
  });

  it("fall back for something unrecognised", () => {
    expect(contentTypeFor("thing.unknownext")).toBe("application/octet-stream");
  });
});

describe("attaching", () => {
  it("takes bytes already in hand", () => {
    const attachment = attachData("notes.txt", "hello");

    expect(attachment.filename).toBe("notes.txt");
    expect(attachment.content).toBe("hello");
    expect(attachment.contentType).toStartWith("text/plain");
  });

  it("takes a content type that was given", () => {
    expect(attachData("data", "{}", "application/json").contentType).toBe("application/json");
  });

  // A message put on a queue is delivered by another process, where the path
  // may mean nothing — so the bytes are read now.
  it("reads a file's bytes rather than its path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "altair-attach-"));

    try {
      await Bun.write(join(directory, "invoice.txt"), "amount due");
      const attachment = await attachFile(join(directory, "invoice.txt"));

      expect(attachment.filename).toBe("invoice.txt");
      expect(new TextDecoder().decode(attachment.content as Uint8Array)).toBe("amount due");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("takes a name of its own", async () => {
    const directory = await mkdtemp(join(tmpdir(), "altair-attach-"));

    try {
      await Bun.write(join(directory, "tmp-123.pdf"), "x");
      const attachment = await attachFile(join(directory, "tmp-123.pdf"), { as: "invoice.pdf" });

      expect(attachment.filename).toBe("invoice.pdf");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("says when there is no such file", async () => {
    await expect(attachFile("/nowhere/at/all.txt")).rejects.toThrow("No file to attach");
  });
});

// Most clients refuse to fetch a hosted image without the reader asking, so
// an inline attachment is the difference between a message that looks right
// on arrival and one that looks broken.
describe("inline attachments", () => {
  it("carry a content id the body can point at", () => {
    const logo = attachInline("logo.png", new Uint8Array([1, 2, 3]));

    expect(logo.contentDisposition).toBe("inline");
    expect(cidUrl(logo)).toBe(`cid:${logo.cid}`);
  });

  it("take a content id that was given", () => {
    expect(attachInline("logo.png", "x", { cid: "logo@app" }).cid).toBe("logo@app");
  });

  it("generate ids that do not collide", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateCid("logo.png")));
    expect(ids.size).toBe(100);
  });

  it("generate an id that is valid in a header", () => {
    expect(generateCid("my logo (1).png")).toMatch(/^[\w.-]+@altair$/);
  });
});

describe("size limits", () => {
  it("measure strings and bytes alike", () => {
    expect(attachmentsSize([attachData("a.txt", "hello")])).toBe(5);
    expect(attachmentsSize([attachData("a.bin", new Uint8Array(10))])).toBe(10);
  });

  // A provider refuses the message rather than truncating it, so refusing
  // before it is queued beats finding out after.
  it("refuse what a provider would refuse", () => {
    const huge = attachData("big.bin", new Uint8Array(30 * 1024 * 1024));

    expect(() => checkAttachments([huge])).toThrow(AttachmentsTooLarge);
    expect(() => checkAttachments([huge])).toThrow("over the 25MB limit");
  });

  it("accept what fits", () => {
    expect(() => checkAttachments([attachData("small.txt", "hello")])).not.toThrow();
  });
});

describe("preview names", () => {
  it("become something safe in a url", () => {
    expect(previewSlug("welcome email")).toBe("welcome-email");
    expect(previewSlug("Password Reset!")).toBe("password-reset");
  });

  it("are found by their slug", () => {
    const previews = definePreviews({ "welcome email": () => UserMailer.welcome("ada") });

    expect(findPreview(previews, "welcome-email")?.[0]).toBe("welcome email");
    expect(findPreview(previews, "nope")).toBeUndefined();
  });
});

describe("rendering a preview", () => {
  const previews = definePreviews({ "welcome email": () => UserMailer.welcome("ada") });

  it("builds the message", async () => {
    const message = await renderPreview(previews["welcome email"]!);

    expect(message.subject).toBe("Welcome, ada");
    expect(message.html).toContain("Hello ada");
  });

  // A preview is for looking at, not for sending.
  it("delivers nothing", async () => {
    await renderPreview(previews["welcome email"]!);
    expect((UserMailer.delivery as TestDelivery).deliveries).toHaveLength(0);
  });

  it("lists the previews", () => {
    const html = previewIndex(previews, "/altair/mailers");

    expect(html).toContain('href="/altair/mailers/welcome-email"');
    expect(html).toContain("welcome email");
  });

  it("says when there are none", () => {
    expect(previewIndex({}, "/altair/mailers")).toContain("No previews defined");
  });

  it("shows the headers", async () => {
    const message = await renderPreview(previews["welcome email"]!);
    const html = previewPage("welcome email", message, "/altair/mailers", "html");

    expect(html).toContain("hello@example.com");
    expect(html).toContain("ada@example.com");
    expect(html).toContain("Welcome, ada");
  });

  // A message's own styles have no business reaching the page showing it.
  it("shows the html body in a frame of its own", async () => {
    const message = await renderPreview(previews["welcome email"]!);
    expect(previewPage("welcome email", message, "/altair/mailers", "html")).toContain("<iframe");
  });

  it("shows the text body when asked", async () => {
    const message = await renderPreview(previews["welcome email"]!);
    const html = previewPage("welcome email", message, "/altair/mailers", "text");

    expect(html).toContain("<pre>Hello ada</pre>");
  });

  it("names the attachments", async () => {
    const message = await renderPreview(previews["welcome email"]!);
    message.attachments = [attachData("invoice.pdf", "x")];

    expect(previewPage("welcome email", message, "/altair/mailers", "html")).toContain(
      "invoice.pdf",
    );
  });
});

describe("serving previews", () => {
  const previews = definePreviews({
    "welcome email": () => UserMailer.welcome("ada"),
    "broken one": () => UserMailer.broken(),
  });

  const next = async () => new Response("app", { status: 418 });
  const get = (path: string) =>
    servePreviews(previews, { enabled: true })(new Request(`https://example.com${path}`), next);

  it("lists them at the root", async () => {
    const response = await get("/altair/mailers");

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("welcome-email");
  });

  it("shows one", async () => {
    expect(await (await get("/altair/mailers/welcome-email")).text()).toContain("Welcome, ada");
  });

  it("shows the text body when asked", async () => {
    const html = await (await get("/altair/mailers/welcome-email?format=text")).text();
    expect(html).toContain("<pre>Hello ada</pre>");
  });

  it("passes anything else along", async () => {
    expect((await get("/posts")).status).toBe(418);
  });

  it("answers 404 for a preview that does not exist", async () => {
    expect((await get("/altair/mailers/nope")).status).toBe(404);
  });

  // The preview is the thing being worked on, so showing the error beats a
  // blank page and a stack trace in a terminal somewhere else.
  it("shows what a broken preview raised", async () => {
    const response = await get("/altair/mailers/broken-one");

    expect(response.status).toBe(500);
    expect(await response.text()).toContain("no recipient");
  });

  // Sample data is still data, and a preview shows it to whoever asks.
  it("is not served in production", async () => {
    const response = await servePreviews(previews, { enabled: false })(
      new Request("https://example.com/altair/mailers"),
      next,
    );

    expect(response.status).toBe(418);
  });

  it("mounts where it is told to", async () => {
    const response = await servePreviews(previews, { enabled: true, prefix: "/dev/mail" })(
      new Request("https://example.com/dev/mail"),
      next,
    );

    expect(response.status).toBe(200);
  });
});
