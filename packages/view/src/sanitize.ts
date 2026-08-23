/**
 * HTML sanitizing, ported from `rails-html-sanitizer`.
 *
 * This is the one place in the framework where being clever is a security
 * bug. Sanitizing with regular expressions is a well-known way to be wrong:
 * `<img src=x onerror=alert(1)>`, `<svg/onload=...>`, a tag split across an
 * attribute value — every one of them beats a pattern, because the thing that
 * decides what an element is is a parser, not a match.
 *
 * Bun ships one. `HTMLRewriter` is Cloudflare's lol-html, the same parser that
 * rewrites HTML at their edge, so the question "what is an element and what
 * are its attributes" is answered by something that already agrees with a
 * browser. What is left here is the policy: which elements, which attributes,
 * and which URL schemes.
 *
 * The list is an allowlist. A denylist of dangerous things is a list of the
 * attacks that were known when it was written.
 */

/** Elements that carry formatting a document needs and nothing executable. */
export const DEFAULT_ALLOWED_TAGS: ReadonlySet<string> = new Set([
  "a",
  "abbr",
  "acronym",
  "address",
  "b",
  "big",
  "blockquote",
  "br",
  "caption",
  "cite",
  "code",
  "dd",
  "del",
  "dfn",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "ins",
  "kbd",
  "li",
  "mark",
  "ol",
  "p",
  "pre",
  "q",
  "s",
  "samp",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "time",
  "tr",
  "tt",
  "u",
  "ul",
  "var",
]);

/** Attributes allowed on any element, and the extra ones some elements get. */
export const DEFAULT_ALLOWED_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  "*": ["class", "dir", "lang", "title"],
  a: ["href", "rel", "target", "name"],
  img: ["src", "alt", "width", "height", "loading"],
  td: ["colspan", "rowspan"],
  th: ["colspan", "rowspan", "scope"],
  ol: ["start", "type"],
  time: ["datetime"],
  blockquote: ["cite"],
  q: ["cite"],
  del: ["cite", "datetime"],
  ins: ["cite", "datetime"],
};

/** Schemes a link may use. Anything else, including `javascript:`, is dropped. */
export const DEFAULT_ALLOWED_SCHEMES: ReadonlySet<string> = new Set([
  "http",
  "https",
  "mailto",
  "tel",
  "ftp",
]);

/**
 * Elements removed with everything inside them.
 *
 * The rest of a disallowed element's content is kept as text, because a `<foo>`
 * wrapper around a paragraph should not delete the paragraph. These are
 * different: the content of a script *is* the attack, and the content of a
 * style can reach outside the document it was pasted into.
 */
const STRIP_CONTENT = new Set([
  "script",
  "style",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "template",
  "noscript",
  "svg",
  "math",
  "form",
  "input",
  "button",
  "select",
  "textarea",
  "option",
  "base",
  "link",
  "meta",
  "title",
]);

export interface SanitizeOptions {
  allowedTags?: ReadonlySet<string>;
  allowedAttributes?: Readonly<Record<string, readonly string[]>>;
  allowedSchemes?: ReadonlySet<string>;
  /** Adds `rel="noopener noreferrer"` to a link that opens elsewhere. */
  addNoopener?: boolean;
}

/**
 * Whether a URL is one a link may point at.
 *
 * The scheme is read after stripping the whitespace and control characters a
 * browser ignores — `java\tscript:` is `javascript:` to a browser, and a check
 * that does not know that is not a check. A URL with no scheme is relative and
 * is allowed.
 */
export function isAllowedUrl(value: string, schemes: ReadonlySet<string>): boolean {
  // Control characters and whitespace are dropped by a browser before it
  // reads the scheme, so a check that does not drop them too is checking a
  // different string than the browser will. Matching them is the point.
  // oxlint-disable-next-line no-control-regex
  const cleaned = value.replaceAll(/[\u0000-\u0020\u007f-\u00a0]/gu, "").toLowerCase();

  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(cleaned);
  if (!scheme) return true;

  return schemes.has(scheme[1]!);
}

/**
 * Removes everything not on the allowlist.
 *
 * Asynchronous because the parser is: it streams, which is also why a document
 * far too large to hold twice does not have to be.
 */
export async function sanitize(html: string, options: SanitizeOptions = {}): Promise<string> {
  const allowedTags = options.allowedTags ?? DEFAULT_ALLOWED_TAGS;
  const allowedAttributes = options.allowedAttributes ?? DEFAULT_ALLOWED_ATTRIBUTES;
  const schemes = options.allowedSchemes ?? DEFAULT_ALLOWED_SCHEMES;
  const universal = allowedAttributes["*"] ?? [];

  const rewriter = new HTMLRewriter()
    .on("*", {
      element(element) {
        const tag = element.tagName.toLowerCase();

        if (!allowedTags.has(tag)) {
          // The content of a script is the attack; the content of an unknown
          // wrapper is someone's paragraph.
          if (STRIP_CONTENT.has(tag)) element.remove();
          else element.removeAndKeepContent();
          return;
        }

        const allowed = new Set([...universal, ...(allowedAttributes[tag] ?? [])]);

        for (const [name, value] of element.attributes) {
          const attribute = name.toLowerCase();

          // Every event handler is an `on*` attribute, so this covers the ones
          // that do not exist yet as well as the ones that do.
          if (!allowed.has(attribute)) {
            element.removeAttribute(name);
            continue;
          }

          if (
            (attribute === "href" || attribute === "src" || attribute === "cite") &&
            !isAllowedUrl(value, schemes)
          ) {
            element.removeAttribute(name);
          }
        }

        if (options.addNoopener && tag === "a" && element.getAttribute("target")) {
          // A page opened with `target` can reach back through `window.opener`
          // unless it is told it cannot.
          element.setAttribute("rel", "noopener noreferrer");
        }
      },
    })
    .onDocument({
      // On the document rather than on `*`: a handler registered for elements
      // only sees the comments inside one, and a comment before the first tag
      // is not inside anything. That is where `<!--<script>...</script>-->`
      // survived, which is the sort of thing a parser is used to avoid and a
      // selector then hands back.
      comments(comment) {
        comment.remove();
      },
    })
    .on("script, style", {
      // Belt and braces: `remove()` above drops these, and stripping the text
      // means a parser disagreement cannot leave the body behind.
      text(text) {
        text.remove();
      },
    });

  return await rewriter.transform(new Response(html)).text();
}

/** Everything stripped: the text of a document, with none of its markup. */
export async function sanitizeToText(html: string): Promise<string> {
  return await sanitize(html, { allowedTags: new Set(), allowedAttributes: {} });
}
