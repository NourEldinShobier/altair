/**
 * Mailer previews, ported from `ActionMailer::Preview`.
 *
 * Rails serves these at `/rails/mailers`, and they are the only practical way
 * to work on a message: sending yourself a copy for every change is slow, and
 * a test asserting the subject tells you nothing about whether it reads well.
 *
 *     export const previews = definePreviews({
 *       "welcome email": () => UserMailer.welcome(sampleUser),
 *     })
 *
 *     app.middleware.use("previews", servePreviews(previews))
 *
 * A preview builds a real message with sample data and renders it. It never
 * delivers, which is the point — and this refuses to be mounted in production
 * for the same reason Rails does.
 */

import type { MailMessage } from "./mailer.js";
import { underscore } from "@altair/support";
import { informPreviewInterceptors } from "./preview_interceptors.js";
import type { MessageFields } from "./message.js";
import { formatAddresses } from "./message.js";

/** A named preview: something that builds a message from sample data. */
export type Preview = () => MailMessage | Promise<MailMessage>;

export type PreviewSet = Record<string, Preview>;

export function definePreviews(previews: PreviewSet): PreviewSet {
  return previews;
}

/** Turns a preview's name into something safe in a URL. */
export function previewSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
}

/** Finds a preview by its slug, since that is what a URL carries. */
export function findPreview(previews: PreviewSet, slug: string): [string, Preview] | undefined {
  for (const [name, preview] of Object.entries(previews)) {
    if (previewSlug(name) === slug) return [name, preview];
  }
  return undefined;
}

/**
 * Builds a preview's message without delivering it.
 *
 * The preview interceptors run here and the delivery interceptors do not: a
 * rule that rewrites every recipient in staging has nothing to say about a
 * page nobody receives, and a rule that makes an embedded image visible in a
 * browser must not follow the message out to a mail client that understood the
 * original perfectly well.
 */
export async function renderPreview(preview: Preview): Promise<MessageFields> {
  return await informPreviewInterceptors(await (await preview()).toMessage());
}

/** The previews a set offers, by name. Rails' `emails`. */
export function previewNames(previews: PreviewSet): string[] {
  return Object.keys(previews).sort();
}

/**
 * Whether a set has a given preview. Rails' `email_exists?`.
 *
 * By name rather than by slug, which is the question a link check asks —
 * `findPreview` answers the URL's question and this one answers the code's.
 */
export function emailExists(previews: PreviewSet, name: string): boolean {
  return Object.hasOwn(previews, name);
}

/**
 * A preview's name without the suffix people give the file. Rails'
 * `preview_name`.
 *
 * `UserMailerPreview` and `UserMailer` name the same thing, and a set written
 * either way should produce the same URL rather than two that differ by seven
 * characters nobody meant to type.
 */
export function previewName(name: string): string {
  // Underscored before slugging, so `UserMailer` becomes `user-mailer` rather
  // than `usermailer` — Rails' `underscore` does the same split, and a URL
  // that runs the words together is one nobody can read back.
  return previewSlug(underscore(name.replace(/Preview$/, "")));
}

function escape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** The list of previews. */
export function previewIndex(previews: PreviewSet, prefix: string): string {
  const items = Object.keys(previews)
    .map((name) => `<li><a href="${prefix}/${previewSlug(name)}">${escape(name)}</a></li>`)
    .join("");

  return page(
    "Mailer previews",
    Object.keys(previews).length > 0
      ? `<ul>${items}</ul>`
      : "<p>No previews defined. Export some with definePreviews().</p>",
  );
}

/** One preview, with its headers and a way to see either body. */
export function previewPage(
  name: string,
  message: MessageFields,
  prefix: string,
  format: "html" | "text",
): string {
  const rows: [string, string][] = [
    ["From", formatAddresses(message.from)],
    ["To", formatAddresses(message.to)],
    ["Subject", message.subject ?? ""],
  ];

  if (message.cc) rows.push(["Cc", formatAddresses(message.cc)]);
  if (message.replyTo) rows.push(["Reply to", formatAddresses(message.replyTo)]);

  const attachments = message.attachments ?? [];
  if (attachments.length > 0) {
    rows.push(["Attachments", attachments.map((one) => one.filename).join(", ")]);
  }

  const headers = rows
    .map(([label, value]) => `<tr><th align="left">${label}</th><td>${escape(value)}</td></tr>`)
    .join("");

  const slug = previewSlug(name);
  const tabs =
    `<a href="${prefix}/${slug}?format=html">HTML</a> · ` +
    `<a href="${prefix}/${slug}?format=text">Text</a>`;

  // The HTML body goes in an iframe: a message's own styles have no business
  // reaching the page showing it, and a preview that restyles itself is not
  // showing you what will arrive.
  const body =
    format === "text"
      ? `<pre>${escape(message.text ?? "(no text body)")}</pre>`
      : `<iframe srcdoc="${escape(message.html ?? "<p>(no HTML body)</p>")}" style="width:100%;height:60vh;border:1px solid #ddd"></iframe>`;

  return page(
    name,
    `<p><a href="${prefix}">← All previews</a></p>
     <table>${headers}</table>
     <p>${tabs}</p>
     ${body}`,
  );
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escape(title)}</title>
<style>body{font:14px system-ui;margin:2rem;max-width:60rem}th{padding-right:1rem;vertical-align:top}</style>
</head><body><h1>${escape(title)}</h1>${body}</body></html>`;
}

export interface PreviewOptions {
  /** Where the previews are mounted. */
  prefix?: string;
  /**
   * Whether to serve them at all.
   *
   * Off in production by default: a preview builds a message from sample data
   * and shows it to whoever asks, which in an application with real customer
   * names in its samples is a disclosure rather than a convenience.
   */
  enabled?: boolean;
}

/** What a middleware is handed to continue the chain. */
type Next = (request: Request) => Promise<Response>;

/** Serves the previews. Rails mounts the same thing at `/rails/mailers`. */
export function servePreviews(previews: PreviewSet, options: PreviewOptions = {}) {
  const prefix = options.prefix ?? "/altair/mailers";
  const enabled = options.enabled ?? process.env.NODE_ENV !== "production";

  return async (request: Request, next: Next): Promise<Response> => {
    const url = new URL(request.url);
    if (!enabled || !url.pathname.startsWith(prefix)) return await next(request);

    const rest = url.pathname.slice(prefix.length).replace(/^\//, "");
    if (rest === "") {
      return html(previewIndex(previews, prefix));
    }

    const found = findPreview(previews, rest);
    if (!found) return new Response("No such preview", { status: 404 });

    const [name, preview] = found;
    const format = url.searchParams.get("format") === "text" ? "text" : "html";

    try {
      const message = await renderPreview(preview);
      return html(previewPage(name, message, prefix, format));
    } catch (error) {
      // A preview that throws is the thing being worked on; showing the error
      // beats a blank page or a stack trace in a terminal somewhere else.
      return html(
        page(name, `<h2>This preview raised</h2><pre>${escape(String(error))}</pre>`),
        500,
      );
    }
  };
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}
