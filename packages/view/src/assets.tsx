/**
 * Asset and link helpers, ported from `ActionView::Helpers::AssetTagHelper`
 * and `UrlHelper`.
 *
 * The Vite integration handles a built application's own scripts and styles;
 * these are for everything else — an image, a favicon, a mail link, a link
 * that knows whether it points at the page you are on.
 */

import { escapeHtml as escape, RawHtml, type Node } from "./render.js";
import { usePath } from "./context.js";
import { tagOptions, type TagAttributes } from "./tags.js";

/** Where assets are served from, when they are not served from here. */
let assetHost: string | undefined;

export function setAssetHost(host: string | undefined): void {
  assetHost = host;
}

/**
 * The path an asset is served at.
 *
 * An absolute URL is left exactly as it is: something already pointing at
 * another origin is not ours to prefix.
 */
export function assetPath(source: string, folder = ""): string {
  if (/^(https?:)?\/\//.test(source) || source.startsWith("data:")) return source;

  const path = source.startsWith("/") ? source : `/${folder}${folder ? "/" : ""}${source}`;

  return assetHost ? `${assetHost.replace(/\/$/, "")}${path}` : path;
}

export const imagePath = (source: string): string => assetPath(source, "images");
export const videoPath = (source: string): string => assetPath(source, "videos");
export const audioPath = (source: string): string => assetPath(source, "audios");
export const fontPath = (source: string): string => assetPath(source, "fonts");
export const javascriptPath = (source: string): string => assetPath(source, "javascripts");
export const stylesheetPath = (source: string): string => assetPath(source, "stylesheets");

export interface ImageProps extends TagAttributes {
  src: string;
  alt?: string;
  size?: string;
}

/**
 * An `<img>`. Rails' `image_tag`.
 *
 * `size: "16x16"` becomes width and height, which is Rails' shorthand and
 * worth keeping: giving both stops the page moving as images arrive.
 */
export function ImageTag(props: ImageProps): Node {
  const { src, size, ...rest } = props;
  const [width, height] = size ? size.split("x") : [];

  return new RawHtml(
    `<img${tagOptions({
      src: imagePath(src),
      width: width ?? undefined,
      height: height ?? width ?? undefined,
      ...rest,
    })}>`,
  );
}

export function VideoTag(props: TagAttributes & { src: string }): Node {
  const { src, ...rest } = props;

  return new RawHtml(`<video${tagOptions({ src: videoPath(src), ...rest })}></video>`);
}

export function AudioTag(props: TagAttributes & { src: string }): Node {
  const { src, ...rest } = props;

  return new RawHtml(`<audio${tagOptions({ src: audioPath(src), ...rest })}></audio>`);
}

export function FaviconLinkTag(props: { href?: string; type?: string; rel?: string } = {}): Node {
  return new RawHtml(
    `<link${tagOptions({
      rel: props.rel ?? "icon",
      type: props.type ?? "image/x-icon",
      href: imagePath(props.href ?? "favicon.ico"),
    })}>`,
  );
}

/**
 * A `<link rel=preload>`. Rails' `preload_link_tag`.
 *
 * `as` is required by the browser rather than optional: without it the hint is
 * ignored, so the tag is written and nothing happens.
 */
export function PreloadLinkTag(props: {
  href: string;
  as: string;
  type?: string;
  crossorigin?: string;
}): Node {
  return new RawHtml(
    `<link${tagOptions({ rel: "preload", ...props, href: assetPath(props.href) })}>`,
  );
}

export function StylesheetLinkTag(props: TagAttributes & { href: string }): Node {
  const { href, ...rest } = props;

  return new RawHtml(
    `<link${tagOptions({ rel: "stylesheet", href: stylesheetPath(href), ...rest })}>`,
  );
}

export function JavascriptIncludeTag(props: TagAttributes & { src: string }): Node {
  const { src, ...rest } = props;

  return new RawHtml(`<script${tagOptions({ src: javascriptPath(src), ...rest })}></script>`);
}

/** Whether a path is the one being rendered. Rails' `current_page?`. */
export function isCurrentPage(path: string): boolean {
  const here = usePath();
  if (here === undefined) return false;

  // Compared without a trailing slash, because `/posts` and `/posts/` are the
  // same page and only one of them is in the link.
  const trim = (one: string) => (one.length > 1 ? one.replace(/\/$/, "") : one);

  return trim(here) === trim(path);
}

export interface ConditionalLinkProps extends TagAttributes {
  href: string;
  text: string;
}

/** A link that is only a link when a condition holds. Rails' `link_to_if`. */
export function LinkToIf(props: ConditionalLinkProps & { condition: boolean }): Node {
  const { condition, href, text, ...rest } = props;

  if (!condition) return new RawHtml(escape(text));

  return new RawHtml(`<a${tagOptions({ href, ...rest })}>${escape(text)}</a>`);
}

export function LinkToUnless(props: ConditionalLinkProps & { condition: boolean }): Node {
  const { condition, ...rest } = props;

  return LinkToIf({ ...rest, condition: !condition });
}

/**
 * A link everywhere except the page it points at. Rails'
 * `link_to_unless_current`.
 *
 * What a navigation bar wants: the current section as plain words rather than
 * a link to where you already are.
 */
export function LinkToUnlessCurrent(props: ConditionalLinkProps): Node {
  return LinkToUnless({ ...props, condition: isCurrentPage(props.href) });
}

/**
 * A `mailto:` link. Rails' `mail_to`.
 *
 * The address is encoded into the href as well as escaped into the text: a
 * `?` or a `&` in it would otherwise start a header the sender never wrote.
 */
export function MailTo(
  props: TagAttributes & { address: string; text?: string; subject?: string; body?: string },
): Node {
  const { address, text, subject, body, ...rest } = props;

  const query = new URLSearchParams(
    Object.entries({ subject, body }).filter(([, value]) => value !== undefined) as [
      string,
      string,
    ][],
  ).toString();

  const href = `mailto:${encodeURIComponent(address)}${query ? `?${query}` : ""}`;

  return new RawHtml(`<a${tagOptions({ href, ...rest })}>${escape(text ?? address)}</a>`);
}

export function PhoneTo(props: TagAttributes & { number: string; text?: string }): Node {
  const { number, text, ...rest } = props;

  return new RawHtml(
    `<a${tagOptions({ href: `tel:${number.replace(/[^+\d]/g, "")}`, ...rest })}>${escape(
      text ?? number,
    )}</a>`,
  );
}

export function SmsTo(
  props: TagAttributes & { number: string; text?: string; body?: string },
): Node {
  const { number, text, body, ...rest } = props;
  const query = body ? `?&body=${encodeURIComponent(body)}` : "";

  return new RawHtml(
    `<a${tagOptions({ href: `sms:${number.replace(/[^+\d]/g, "")}${query}`, ...rest })}>${escape(
      text ?? number,
    )}</a>`,
  );
}
