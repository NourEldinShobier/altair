/**
 * Cleaning a `style` attribute, ported from
 * `Rails::HTML::SafeListSanitizer#sanitize_css` and Loofah's CSS scrubber.
 *
 * `sanitize.ts` strips `<style>` elements outright and drops the `style`
 * attribute, which is safe and sometimes too blunt: a rich text editor that
 * lets people set a colour or an alignment produces inline styles, and
 * throwing them all away means the formatting somebody applied silently does
 * not survive being saved.
 *
 * Keeping them means keeping only what cannot do anything. Three things a
 * style attribute can carry that are not styling:
 *
 *   - **A URL that executes.** `background: url(javascript:...)` still runs in
 *     browsers people use, and `url(data:text/html,...)` is worse.
 *   - **A legacy expression.** `width: expression(alert(1))` and `behavior:
 *     url(x.htc)` are Internet Explorer's own scripting hooks. Long dead,
 *     still worth refusing, and free to refuse.
 *   - **A full-page overlay.** `position: fixed; top: 0; width: 100vw` over a
 *     page is how a comment becomes a clickjacking frame — not script
 *     execution, and just as effective.
 *
 * So this is a list of properties that are allowed, not a list of ones that
 * are not: a deny list is a list somebody has to keep up with, and the thing
 * it misses is the thing that gets used.
 */

/**
 * Properties that only describe appearance.
 *
 * Positioning, sizing beyond a font, and anything that loads a resource are
 * left out — not because each is an exploit, but because the ones that are
 * cannot be told apart from the ones that are not without knowing the page
 * they will land in.
 */
export const DEFAULT_ALLOWED_STYLES: ReadonlySet<string> = new Set([
  "color",
  "background-color",
  "font",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "font-variant",
  "letter-spacing",
  "line-height",
  "text-align",
  "text-decoration",
  "text-indent",
  "text-transform",
  "vertical-align",
  "white-space",
  "word-break",
  "word-wrap",
  "list-style-type",
  "border",
  "border-color",
  "border-style",
  "border-width",
  "border-radius",
  "margin",
  "margin-top",
  "margin-bottom",
  "margin-left",
  "margin-right",
  "padding",
  "padding-top",
  "padding-bottom",
  "padding-left",
  "padding-right",
]);

/**
 * What a value may not contain, whatever property it is on.
 *
 * Checked on the value as well as the property, because an allowed property
 * can still carry one of these: `border: 1px solid; background: url(...)` is
 * one declaration to a careless splitter and two to a browser.
 */
const DANGEROUS_VALUE = /url\s*\(|expression\s*\(|javascript\s*:|behavior\s*:|@import|\\/i;

export interface SanitizeCssOptions {
  /** Properties to keep. Anything else is dropped. */
  allowedStyles?: ReadonlySet<string>;
}

/**
 * A `style` attribute with everything that is not styling taken out. Rails'
 * `sanitize_css`.
 *
 * Declarations are dropped rather than the whole attribute, so one bad
 * property does not lose the colour somebody chose — and the result is empty
 * rather than absent when nothing survives, which a caller can test.
 */
export function sanitizeCss(style: string, options: SanitizeCssOptions = {}): string {
  const allowed = options.allowedStyles ?? DEFAULT_ALLOWED_STYLES;
  const kept: string[] = [];

  for (const declaration of style.split(";")) {
    const at = declaration.indexOf(":");

    if (at === -1) continue;

    const property = declaration.slice(0, at).trim().toLowerCase();
    const value = declaration.slice(at + 1).trim();

    if (property === "" || value === "") continue;
    if (!allowed.has(property)) continue;

    // A backslash is in the dangerous set because CSS lets an escape spell a
    // character: `\75 rl(...)` is `url(...)` to a browser and is not `url` to
    // any check looking for the word.
    if (DANGEROUS_VALUE.test(value)) continue;

    // A closing brace would end the rule this attribute becomes when a style
    // element is built from it, letting a value open a selector of its own.
    if (value.includes("}") || value.includes("{")) continue;

    kept.push(`${property}: ${value}`);
  }

  return kept.join("; ");
}

/**
 * Whether a value would be refused, for a caller that wants to say why.
 *
 * A form that silently drops half of what somebody typed is a form they will
 * fight; one that says which declaration was refused is one they can correct.
 */
export function isDangerousStyleValue(value: string): boolean {
  return DANGEROUS_VALUE.test(value) || value.includes("{") || value.includes("}");
}

/** Whether a property is one this will keep. */
export function isAllowedStyleProperty(
  property: string,
  allowed: ReadonlySet<string> = DEFAULT_ALLOWED_STYLES,
): boolean {
  return allowed.has(property.trim().toLowerCase());
}
