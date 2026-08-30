/**
 * Rich text as something you can transform, ported from `ActionText::Fragment`
 * and its conversion modules.
 *
 *     Fragment.fromHtml(body).replace("action-text-attachment", canonicalize).toHtml()
 *
 * A rich text body goes through several shapes on its way between the editor
 * and the page, and the reason for a type rather than string functions is that
 * each conversion has to be composable: canonicalize, then minify, then render.
 * Done as separate string passes, each one re-parses what the last produced,
 * and a regular expression that was correct on the original stops being
 * correct on the output of the one before it.
 *
 * Rails uses Nokogiri. There is no DOM here, so the operations are expressed
 * over the tag forms Action Text actually emits — which is narrower than a
 * parser and enough for the transformations Action Text performs, all of which
 * are on its own `<action-text-attachment>` and `<figure>` tags. Anything
 * needing real CSS selectors over arbitrary markup wants a parser, and this
 * says so rather than pretending.
 */

/** The tag Action Text stores an attachment as. */
export const ATTACHMENT_SELECTOR = "action-text-attachment";

/** The tag the Trix editor uses for the same thing. */
export const TRIX_ATTACHMENT_SELECTOR = "figure";

export class Fragment {
  constructor(readonly source: string) {}

  /** A fragment from HTML, or the fragment itself if it already is one. */
  static wrap(value: Fragment | string): Fragment {
    return value instanceof Fragment ? value : Fragment.fromHtml(value);
  }

  /** Rails' `Fragment.from_html`. */
  static fromHtml(html: string): Fragment {
    return new Fragment(String(html ?? "").trim());
  }

  /** Every node matching a tag name, as its full markup. Rails' `find_all`. */
  findAll(tag: string): string[] {
    return [...this.source.matchAll(nodePattern(tag))].map((match) => match[0]);
  }

  /**
   * A new fragment with each matching node replaced.
   *
   * A new one rather than a mutation, because the conversions compose and a
   * pipeline that edited in place would leave the caller unable to keep the
   * original — which Action Text needs, since the stored body and the rendered
   * body are different things and both are wanted.
   */
  replace(tag: string, replacement: (node: string) => string): Fragment {
    return new Fragment(this.source.replace(nodePattern(tag), (node) => replacement(node)));
  }

  /** A new fragment with each matching node removed. */
  remove(tag: string): Fragment {
    return this.replace(tag, () => "");
  }

  /** Rails' `update`: hand the source to a block and take what comes back. */
  update(change: (source: string) => string): Fragment {
    return new Fragment(change(this.source));
  }

  /** The markup. Rails' `to_html`. */
  toHtml(): string {
    return this.source;
  }

  toString(): string {
    return this.toHtml();
  }

  /** The text a search index or a plain-text email wants. Rails' `to_plain_text`. */
  toPlainText(): string {
    return nodeToPlainText(this.source);
  }

  /** Rails' `to_markdown`. */
  toMarkdown(): string {
    return nodeToMarkdown(this.source);
  }

  /** Every attachment node in the fragment. */
  attachmentNodes(): string[] {
    return this.findAll(ATTACHMENT_SELECTOR);
  }

  /** Every gallery — a figure wrapping more than one attachment. */
  attachmentGalleryNodes(): string[] {
    return this.findAll("div").filter((node) => attributeOf(node, "class")?.includes("gallery"));
  }
}

/**
 * Matches a whole element by tag name, self-closing or paired.
 *
 * Deliberately non-greedy on the body, so two attachments in a row are two
 * matches rather than one that swallows everything between the first opening
 * tag and the last closing one — the bug every hand-written tag regex has.
 */
function nodePattern(tag: string): RegExp {
  return new RegExp(`<${tag}\\b[^>]*(?:/>|>[\\s\\S]*?</${tag}>)`, "g");
}

/** One attribute's value off a node's markup. */
export function attributeOf(node: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(node)?.[1];
}

/** Rails' `HtmlConversion.fragment_for_html`. */
export function fragmentForHtml(html: string): Fragment {
  return Fragment.fromHtml(html);
}

/** Rails' `HtmlConversion.node_to_html`. */
export function nodeToHtml(node: Fragment | string): string {
  return Fragment.wrap(node).toHtml();
}

/** Blocks that should read as separate lines once the tags are gone. */
const BLOCK_TAGS = ["p", "div", "li", "br", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "tr"];

/**
 * The plain text of a body. Rails' `PlainTextConversion.node_to_plain_text`.
 *
 * Block tags become newlines before anything is stripped. Stripping first
 * would run the last word of one paragraph into the first word of the next,
 * which is what makes a search index match phrases that were never written and
 * a plain-text email unreadable.
 */
export function nodeToPlainText(html: string): string {
  const withBreaks = BLOCK_TAGS.reduce(
    (text, tag) => text.replace(new RegExp(`</?${tag}\\b[^>]*>`, "gi"), "\n"),
    html,
  );

  return withBreaks
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n\n")
    .trim();
}

/** Rails' `MarkdownConversion.node_to_markdown`. */
export function nodeToMarkdown(html: string): string {
  const converted = html
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**")
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, "_$2_")
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
    .replace(
      /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
      (_all, level: string, text: string) => `\n${"#".repeat(Number(level))} ${text}\n`,
    )
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1")
    .replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, "\n> $1\n");

  return nodeToPlainText(converted);
}

/**
 * The stored form of a body. Rails' `fragment_by_canonicalizing_content`.
 *
 * Canonical means: attachments as `<action-text-attachment>`, no galleries.
 * The stored body is the one shape everything else is derived from, and
 * keeping the editor's own markup out of it is what stops a change to the
 * editor from becoming a data migration.
 */
export function fragmentByCanonicalizingContent(html: string): Fragment {
  return fragmentByCanonicalizingAttachmentGalleries(
    fragmentByCanonicalizingAttachments(html).toHtml(),
  );
}

/**
 * Turns the editor's attachment markup into Action Text's own. Rails'
 * `fragment_by_canonicalizing_attachments`.
 *
 * Trix writes `<figure data-trix-attachment="{...}">`. What is kept is the
 * sgid — the rest is presentation the renderer decides again each time, so
 * storing it would freeze today's rendering into every old record.
 */
export function fragmentByCanonicalizingAttachments(html: string): Fragment {
  return Fragment.fromHtml(html).replace(TRIX_ATTACHMENT_SELECTOR, (node) => {
    const sgid = attributeOf(node, "data-trix-attachment-sgid") ?? sgidFromJson(node);
    if (!sgid) return node;

    const caption = attributeOf(node, "data-trix-caption");

    return `<${ATTACHMENT_SELECTOR} sgid="${sgid}"${caption ? ` caption="${caption}"` : ""}></${ATTACHMENT_SELECTOR}>`;
  });
}

/** Rails' `fragment_by_converting_trix_attachments`, the other direction. */
export function fragmentByConvertingTrixAttachments(html: string): Fragment {
  return Fragment.fromHtml(html).replace(ATTACHMENT_SELECTOR, (node) => {
    const sgid = attributeOf(node, "sgid");
    if (!sgid) return node;

    return `<${TRIX_ATTACHMENT_SELECTOR} data-trix-attachment-sgid="${sgid}"></${TRIX_ATTACHMENT_SELECTOR}>`;
  });
}

/** Rails' `fragment_by_canonicalizing_attachment_galleries`. */
export function fragmentByCanonicalizingAttachmentGalleries(html: string): Fragment {
  return Fragment.fromHtml(html).update((source) =>
    source.replace(/<div class="[^"]*attachment-gallery[^"]*"[^>]*>([\s\S]*?)<\/div>/g, "$1"),
  );
}

/** Rails' `fragment_by_replacing_attachment_gallery_nodes`. */
export function fragmentByReplacingAttachmentGalleryNodes(
  html: string,
  replacement: (inner: string) => string,
): Fragment {
  return Fragment.fromHtml(html).update((source) =>
    source.replace(
      /<div class="[^"]*attachment-gallery[^"]*"[^>]*>([\s\S]*?)<\/div>/g,
      (_all, inner: string) => replacement(inner),
    ),
  );
}

/**
 * Strips an attachment down to what is worth storing. Rails'
 * `fragment_by_minifying_attachments`.
 *
 * Everything but the sgid goes, for the same reason canonicalizing drops the
 * presentation: the renderer decides how an attachment looks each time it
 * renders, so a stored copy of last year's markup is a body that renders
 * differently from a new one for no reason anybody can see.
 */
export function fragmentByMinifyingAttachments(html: string): Fragment {
  return Fragment.fromHtml(html).replace(ATTACHMENT_SELECTOR, (node) => {
    const sgid = attributeOf(node, "sgid");

    return sgid ? `<${ATTACHMENT_SELECTOR} sgid="${sgid}"></${ATTACHMENT_SELECTOR}>` : node;
  });
}

/** The sgid inside a Trix attachment's JSON blob, if that is where it is. */
function sgidFromJson(node: string): string | undefined {
  const json = attributeOf(node, "data-trix-attachment");
  if (!json) return undefined;

  try {
    const parsed = JSON.parse(json.replaceAll("&quot;", '"')) as { sgid?: string };

    return parsed.sgid;
  } catch {
    return undefined;
  }
}
