/**
 * Absolute asset URLs, and the pieces `assetPath` builds one from.
 *
 * Rails ships both `image_path` and `image_url` and the difference is not
 * cosmetic: a path is relative to the origin serving the page, and a URL
 * carries the host. Anything read outside a browsing context needs the second
 * — an email client fetching an image, a crawler reading an Open Graph tag, a
 * feed reader following an enclosure. A relative path in any of those resolves
 * against the wrong origin, or against nothing at all.
 */

import {
  assetPath,
  audioPath,
  fontPath,
  imagePath,
  javascriptPath,
  stylesheetPath,
  videoPath,
} from "./assets.js";

/**
 * The host absolute asset URLs are built against.
 *
 * Separate from the asset host, which may be a CDN that only serves assets and
 * is already applied by `assetPath`. This is the application's own origin, and
 * it is what a URL falls back to when no asset host is set.
 */
let defaultHost: string | undefined;

export function setDefaultUrlHost(host: string | undefined): void {
  defaultHost = host;
}

export function computeAssetHost(): string | undefined {
  return defaultHost;
}

/**
 * The extension a source is missing, given the kind of asset it is.
 *
 * `stylesheet_link_tag "application"` is the shape everyone writes, and the
 * browser will not guess. A source that already has an extension, or a query
 * string implying one, is left alone.
 */
export function computeAssetExtname(source: string, extension?: string): string {
  if (!extension) return "";
  if (/\.[^./?#]+(\?|#|$)/.test(source)) return "";

  return extension.startsWith(".") ? extension : `.${extension}`;
}

/**
 * A path made absolute against the host.
 *
 * A source that is already absolute — because it names another origin, or
 * because an asset host was configured — is returned untouched. Prefixing it
 * again would produce `https://cdn.example.comhttps://…`, which is the bug
 * this check exists for.
 */
export function computeAssetPath(path: string, host = defaultHost): string {
  if (/^(https?:)?\/\//.test(path) || path.startsWith("data:")) return path;
  if (!host) return path;

  return `${host.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

/** An asset's absolute URL. Rails' `asset_url`. */
export function assetUrl(source: string, folder = "", host?: string): string {
  return computeAssetPath(assetPath(source, folder), host);
}

/** Rails' `image_url`. */
export function imageUrl(source: string, host?: string): string {
  return computeAssetPath(imagePath(source), host);
}

/** Rails' `video_url`. */
export function videoUrl(source: string, host?: string): string {
  return computeAssetPath(videoPath(source), host);
}

/** Rails' `audio_url`. */
export function audioUrl(source: string, host?: string): string {
  return computeAssetPath(audioPath(source), host);
}

/** Rails' `font_url`. */
export function fontUrl(source: string, host?: string): string {
  return computeAssetPath(fontPath(source), host);
}

/** Rails' `javascript_url`. */
export function javascriptUrl(source: string, host?: string): string {
  return computeAssetPath(javascriptPath(source), host);
}

/** Rails' `stylesheet_url`. */
export function stylesheetUrl(source: string, host?: string): string {
  return computeAssetPath(stylesheetPath(source), host);
}
