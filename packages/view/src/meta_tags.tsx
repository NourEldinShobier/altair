/**
 * The tags a layout puts in its head, ported from
 * `ActionView::Helpers::AssetTagHelper` and `CsrfHelper`.
 *
 * Each is small, and each is the sort of thing that gets hand-written slightly
 * wrong once per application — a feed link the reader cannot discover, a CSRF
 * meta tag the JavaScript looks for under a different name, a script tag that
 * breaks on a closing brace in the data it carries.
 */

import { escapeHtml as escape, RawHtml, type Node } from "./render.js";
import { jsonEscape } from "./escaping.js";

/**
 * A feed link browsers and readers discover the feed by. Rails'
 * `auto_discovery_link_tag`.
 *
 * The type matters more than it looks: a reader looks for
 * `application/atom+xml` or `application/rss+xml` specifically, so a link
 * served as `text/xml` is a feed nobody finds.
 */
export function autoDiscoveryLinkTag(
  type: "rss" | "atom" | "json" = "rss",
  href = "",
  options: { title?: string; rel?: string } = {},
): Node {
  const contentType = {
    rss: "application/rss+xml",
    atom: "application/atom+xml",
    json: "application/feed+json",
  }[type];

  const title = options.title ?? type.toUpperCase();

  return new RawHtml(
    `<link rel="${escape(options.rel ?? "alternate")}" type="${contentType}" ` +
      `title="${escape(title)}" href="${escape(href)}" />`,
  );
}

export interface PictureSource {
  srcset: string;
  type?: string;
  media?: string;
}

/**
 * A `<picture>` with alternative sources. Rails' `picture_tag`.
 *
 * What it is for is serving AVIF or WebP to browsers that take them and a JPEG
 * to those that do not, without JavaScript and without guessing from the user
 * agent. The browser picks the first source it understands, so the order is
 * the preference — and the `<img>` is the fallback, not a decoration: a
 * `<picture>` with no `<img>` inside renders nothing at all.
 */
export function pictureTag(
  sources: readonly PictureSource[],
  img: { src: string; alt: string; class?: string; loading?: "lazy" | "eager" },
): Node {
  const rendered = sources
    .map((source) => {
      const type = source.type ? ` type="${escape(source.type)}"` : "";
      const media = source.media ? ` media="${escape(source.media)}"` : "";

      return `<source srcset="${escape(source.srcset)}"${type}${media} />`;
    })
    .join("");

  const attributes = [
    ` src="${escape(img.src)}"`,
    ` alt="${escape(img.alt)}"`,
    img.class ? ` class="${escape(img.class)}"` : "",
    img.loading ? ` loading="${escape(img.loading)}"` : "",
  ].join("");

  return new RawHtml(`<picture>${rendered}<img${attributes} /></picture>`);
}

/**
 * A submit button that is an image. Rails' `image_submit_tag`.
 *
 * The alt text is required rather than optional, because this is a control:
 * without it a screen reader announces a button with no name, and the form
 * cannot be submitted by anybody who cannot see the picture.
 */
export function imageSubmitTag(
  src: string,
  alt: string,
  options: { name?: string; class?: string; disabled?: boolean } = {},
): Node {
  const attributes = [
    ` type="image"`,
    ` src="${escape(src)}"`,
    ` alt="${escape(alt)}"`,
    options.name ? ` name="${escape(options.name)}"` : "",
    options.class ? ` class="${escape(options.class)}"` : "",
    options.disabled ? " disabled" : "",
  ].join("");

  return new RawHtml(`<input${attributes} />`);
}

/**
 * An inline script. Rails' `javascript_tag`.
 *
 * The body is not escaped as HTML — it is script, and escaping it would break
 * every `<` in a comparison. What it does instead is refuse a body containing
 * `</script`, because that ends the element wherever it appears, including
 * inside a string literal, and everything after it is parsed as markup. A
 * caller with data to embed should use `javascriptCdataSection` or pass it as
 * JSON, both of which handle it properly.
 */
export function javascriptTag(
  body: string,
  options: { nonce?: string; type?: string; defer?: boolean } = {},
): Node {
  if (/<\/script/i.test(body)) {
    throw new Error(
      "A script body cannot contain </script — it ends the tag wherever it appears. " +
        "Embed the value as JSON instead.",
    );
  }

  const attributes = [
    options.type ? ` type="${escape(options.type)}"` : "",
    options.nonce ? ` nonce="${escape(options.nonce)}"` : "",
    options.defer ? " defer" : "",
  ].join("");

  return new RawHtml(`<script${attributes}>\n//<![CDATA[\n${body}\n//]]>\n</script>`);
}

/**
 * A value embedded in a script, safely. Rails' `javascript_cdata_section`.
 *
 * Serialized as JSON and then escaped for the script context, which is the
 * combination that survives both — JSON alone leaves `</script>` intact, and
 * HTML escaping alone corrupts the JSON.
 */
export function javascriptCdataSection(value: unknown): Node {
  return new RawHtml(`//<![CDATA[\n${jsonEscape(JSON.stringify(value))}\n//]]>`);
}

/**
 * Escapes a string for inclusion in a JavaScript string literal. Rails'
 * `escape_javascript`.
 *
 * Three of these look decorative and are not.
 *
 * `</` is the one that matters. A browser looks for `</script` in the raw
 * bytes of a script block without parsing the JavaScript around it, so a value
 * holding it ends the tag from inside a string literal and everything after it
 * is markup. `javascriptTag` refuses such a body outright; this is the other
 * half, for a value going into a script somebody else wrote.
 *
 * `$` is literal in a JavaScript string and not in a template one, so a value
 * written into a backtick string carries `${\u2026}` into an expression its author
 * never wrote.
 *
 * U+2028 and U+2029 are legal inside a JSON string and both terminate a
 * JavaScript line, so a value carrying one is a syntax error in the script
 * that embeds it.
 */
const JS_ESCAPES: Record<string, string> = {
  "\\": "\\\\",
  "</": "<\\/",
  // Before the single characters, so a CRLF becomes one newline rather than
  // two. Rails orders it the same way for the same reason.
  "\r\n": "\\n",
  "\r": "\\n",
  "\n": "\\n",
  '"': '\\"',
  "'": "\\'",
  "`": "\\`",
  $: "\\$",
  "\u2028": "&#x2028;",
  "\u2029": "&#x2029;",
};

export function escapeJavascript(value: string): string {
  return value.replace(/\\|<\/|\r\n|[\r\n"'`$\u2028\u2029]/g, (one) => JS_ESCAPES[one] as string);
}

/**
 * The CSRF token, where JavaScript can find it. Rails' `csrf_meta_tags`.
 *
 * Two tags rather than one, and the parameter name matters: a script that
 * submits a form has to know what to call the field, and hard-coding
 * `authenticity_token` in the JavaScript is how a renamed parameter breaks
 * every asynchronous form at once.
 */
export function csrfMetaTags(token: string | undefined, parameter = "authenticity_token"): Node {
  if (!token) return new RawHtml("");

  return new RawHtml(
    `<meta name="csrf-param" content="${escape(parameter)}" />\n` +
      `<meta name="csrf-token" content="${escape(token)}" />`,
  );
}

/**
 * The nonce, where an inline script can read it. Rails' `csp_meta_tag`.
 *
 * A framework on the page needs the nonce to add a script element the policy
 * will accept, and it cannot read the response header.
 */
export function cspMetaTag(nonce: string | undefined): Node {
  return nonce
    ? new RawHtml(`<meta name="csp-nonce" content="${escape(nonce)}" />`)
    : new RawHtml("");
}

/**
 * Where the cable is, for the client script. Rails'
 * `action_cable_meta_tag`.
 *
 * The browser client has to be told the URL and cannot work it out: the cable
 * may be on another host, behind another scheme, or under a path the page's
 * own URL says nothing about. Hard-coding it into the script instead means an
 * application whose staging and production builds differ by one string, which
 * is the kind of difference that is discovered in production.
 *
 * A relative path is left as it is rather than made absolute here. The client
 * resolves it against the page, which is what makes one build work behind any
 * host — and an absolute URL baked in at render time is the very thing this
 * exists to avoid.
 */
export function actionCableMetaTag(url = "/cable"): Node {
  return new RawHtml(`<meta name="action-cable-url" content="${escape(url)}" />`);
}

/**
 * A hidden field that makes a browser post UTF-8. Rails' `utf8_enforcer_tag`.
 *
 * Internet Explorer decided a form's encoding from its content, so a form of
 * pure ASCII was submitted as the page's legacy encoding and any non-ASCII the
 * user typed arrived mangled. A snowman in a hidden field forced the issue.
 * Kept because a form generated by Rails still carries it and something has to
 * explain why — not because that browser still matters.
 */
export function utf8EnforcerTag(): Node {
  return new RawHtml(`<input name="utf8" type="hidden" value="&#x2713;" autocomplete="off" />`);
}

/**
 * A machine-readable time. Rails' `time_tag`.
 *
 * The datetime attribute is the point: the text is for a person and can say
 * "three days ago", while the attribute stays exact for anything parsing the
 * page.
 */
export function timeTag(value: Date, text?: string, options: { class?: string } = {}): Node {
  const attributes = options.class ? ` class="${escape(options.class)}"` : "";

  return new RawHtml(
    `<time datetime="${value.toISOString()}"${attributes}>${escape(text ?? value.toISOString())}</time>`,
  );
}
