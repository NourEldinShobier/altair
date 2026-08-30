/**
 * Rules that run only when a message is previewed, ported from
 * `actionmailer/test/base_test.rb` (the preview interceptor cases) and
 * `actionmailer/test/inline_preview_interceptor_test.rb`.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { attachInline } from "../src/attachments.js";
import { Mailer } from "../src/mailer.js";
import type { MessageFields } from "../src/message.js";
import { emailExists, previewName, previewNames, renderPreview } from "../src/preview.js";
import {
  inlineCidImages,
  inlinePreviewInterceptor,
  informPreviewInterceptors,
  previewInterceptors,
  registerPreviewInterceptor,
  registerPreviewInterceptors,
  resetPreviewInterceptors,
  unregisterPreviewInterceptor,
  unregisterPreviewInterceptors,
  type PreviewInterceptor,
} from "../src/preview_interceptors.js";

afterEach(() => {
  resetPreviewInterceptors();
});

const logo = attachInline("logo.png", new Uint8Array([1, 2, 3]), {
  cid: "logo",
  contentType: "image/png",
});

function withLogo(html: string): MessageFields {
  return {
    to: "a@example.com",
    subject: "Hi",
    html,
    attachments: [logo],
  };
}

describe("inlining cid images", () => {
  /**
   * A browser has no idea what `cid:` means, so without this the preview shows
   * a broken image and the person checking cannot tell that from a real one.
   */
  it("turns a cid source into a data url", () => {
    const message = inlineCidImages(withLogo('<img src="cid:logo">'));

    expect(message.html).toBe('<img src="data:image/png;base64,AQID">');
  });

  it("handles single quotes, which a template is as likely to write", () => {
    const message = inlineCidImages(withLogo("<img src='cid:logo'>"));

    expect(message.html).toBe("<img src='data:image/png;base64,AQID'>");
  });

  it("rewrites every reference, not just the first", () => {
    const message = inlineCidImages(withLogo('<img src="cid:logo"><img src="cid:logo">'));

    expect(message.html).toBe(
      '<img src="data:image/png;base64,AQID"><img src="data:image/png;base64,AQID">',
    );
  });

  /** A broken image in the preview should mean a broken image in the mail. */
  it("leaves a reference with no matching attachment alone", () => {
    const message = inlineCidImages(withLogo('<img src="cid:missing">'));

    expect(message.html).toBe('<img src="cid:missing">');
  });

  it("leaves an ordinary source alone", () => {
    const message = inlineCidImages(withLogo('<img src="https://example.com/logo.png">'));

    expect(message.html).toBe('<img src="https://example.com/logo.png">');
  });

  it("does nothing to a message with no html", () => {
    const message: MessageFields = { to: "a@example.com", subject: "Hi", text: "cid:logo" };

    expect(inlineCidImages(message)).toEqual(message);
  });

  it("does nothing to a message with no attachments", () => {
    const message: MessageFields = {
      to: "a@example.com",
      subject: "Hi",
      html: '<img src="cid:x">',
    };

    expect(inlineCidImages(message).html).toBe('<img src="cid:x">');
  });

  /**
   * A new object, so previewing twice starts from the same markup both times
   * and a caller holding a reference still has the message as it was built.
   */
  it("does not change the message it was given", () => {
    const original = withLogo('<img src="cid:logo">');

    inlineCidImages(original);

    expect(original.html).toBe('<img src="cid:logo">');
  });
});

describe("the registered list", () => {
  it("starts with the inline one", () => {
    expect(previewInterceptors()).toEqual([inlinePreviewInterceptor]);
  });

  it("takes another", () => {
    const extra: PreviewInterceptor = { previewingEmail: () => undefined };

    registerPreviewInterceptor(extra);

    expect(previewInterceptors()).toContain(extra);
  });

  /** An initializer that runs twice under a reload would otherwise double up. */
  it("ignores a repeat registration", () => {
    const extra: PreviewInterceptor = { previewingEmail: () => undefined };

    registerPreviewInterceptor(extra);
    registerPreviewInterceptor(extra);

    expect(previewInterceptors().filter((one) => one === extra)).toHaveLength(1);
  });

  it("takes several at once", () => {
    const one: PreviewInterceptor = { previewingEmail: () => undefined };
    const two: PreviewInterceptor = { previewingEmail: () => undefined };

    registerPreviewInterceptors(one, two);

    expect(previewInterceptors()).toContain(one);
    expect(previewInterceptors()).toContain(two);
  });

  /** Rails documents removing the default one, so it has to be removable. */
  it("gives up the default when asked", () => {
    unregisterPreviewInterceptor(inlinePreviewInterceptor);

    expect(previewInterceptors()).toEqual([]);
  });

  it("removes several at once", () => {
    const one: PreviewInterceptor = { previewingEmail: () => undefined };

    registerPreviewInterceptor(one);
    unregisterPreviewInterceptors(one, inlinePreviewInterceptor);

    expect(previewInterceptors()).toEqual([]);
  });

  it("ignores removing something that was never there", () => {
    unregisterPreviewInterceptor({ previewingEmail: () => undefined });

    expect(previewInterceptors()).toEqual([inlinePreviewInterceptor]);
  });
});

describe("running the list", () => {
  it("runs them in order", async () => {
    const order: string[] = [];

    unregisterPreviewInterceptor(inlinePreviewInterceptor);
    registerPreviewInterceptors(
      { previewingEmail: () => void order.push("one") },
      { previewingEmail: () => void order.push("two") },
    );

    await informPreviewInterceptors({ to: "a@example.com", subject: "Hi" });

    expect(order).toEqual(["one", "two"]);
  });

  it("passes each one what the last returned", async () => {
    unregisterPreviewInterceptor(inlinePreviewInterceptor);
    registerPreviewInterceptors(
      { previewingEmail: (message) => ({ ...message, subject: `${message.subject}!` }) },
      { previewingEmail: (message) => ({ ...message, subject: `${message.subject}?` }) },
    );

    const result = await informPreviewInterceptors({ to: "a@example.com", subject: "Hi" });

    expect(result.subject).toBe("Hi!?");
  });

  /** A rule that only adds a header should not have to rebuild the message. */
  it("keeps the message when one returns nothing", async () => {
    unregisterPreviewInterceptor(inlinePreviewInterceptor);
    registerPreviewInterceptor({
      previewingEmail: (message) => {
        message.subject = "changed in place";
      },
    });

    const result = await informPreviewInterceptors({ to: "a@example.com", subject: "Hi" });

    expect(result.subject).toBe("changed in place");
  });

  it("waits for an async one", async () => {
    unregisterPreviewInterceptor(inlinePreviewInterceptor);
    registerPreviewInterceptor({
      previewingEmail: async (message) => {
        await Promise.resolve();

        return { ...message, subject: "later" };
      },
    });

    const result = await informPreviewInterceptors({ to: "a@example.com", subject: "Hi" });

    expect(result.subject).toBe("later");
  });
});

describe("rendering a preview", () => {
  class Notifier extends Mailer {
    static override defaults = { from: "hello@example.com" };

    static welcome() {
      return this.mail({
        to: "a@example.com",
        subject: "Welcome",
        html: '<img src="cid:logo">',
        attachments: [logo],
      });
    }
  }

  it("runs the preview interceptors", async () => {
    const message = await renderPreview(() => Notifier.welcome());

    expect(message.html).toBe('<img src="data:image/png;base64,AQID">');
  });

  /**
   * The separation this whole file is for: what the preview shows and what a
   * mail client receives are allowed to differ, and the message that goes out
   * keeps the cid reference that its client understands.
   */
  it("leaves the delivered message alone", async () => {
    await renderPreview(() => Notifier.welcome());

    const delivered = await Notifier.welcome().toMessage();

    expect(delivered.html).toBe('<img src="cid:logo">');
  });
});

describe("naming previews", () => {
  it("lists what a set offers, sorted", () => {
    expect(
      previewNames({ welcome: () => undefined as never, receipt: () => undefined as never }),
    ).toEqual(["receipt", "welcome"]);
  });

  it("says whether one is there", () => {
    const previews = { welcome: () => undefined as never };

    expect(emailExists(previews, "welcome")).toBe(true);
    expect(emailExists(previews, "goodbye")).toBe(false);
  });

  /** Inherited properties are not previews; only the set's own count. */
  it("does not count something off the prototype", () => {
    expect(emailExists({ welcome: () => undefined as never }, "toString")).toBe(false);
  });

  /** UserMailerPreview and UserMailer name the same thing. */
  it("drops the suffix people put on the file", () => {
    expect(previewName("UserMailerPreview")).toBe("user-mailer");
    expect(previewName("UserMailer")).toBe("user-mailer");
  });
});
