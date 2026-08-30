/**
 * Reassembling the parts a multi-part select posts, ported from
 * `ActiveRecord::AttributeAssignment#assign_multiparameter_attributes`.
 *
 *     { "published_on(1i)": "2026", "published_on(2i)": "3", "published_on(3i)": "9" }
 *     // becomes { published_on: Date(2026-03-09) }
 *
 * Three selects cannot post one value, so Rails has each post its own part and
 * puts them back together on the way in. Without this the parameters arrive as
 * three strings with parentheses in their names, and nothing downstream knows
 * what to do with them.
 *
 * The suffix letter is the type: `i` for integer, `f` for float, `s` for
 * string. It is on the wire because the browser cannot know it, and dropping
 * it would leave the reassembler guessing that "09" is a number and "0912" a
 * phone extension.
 */

/** One posted part, taken apart. */
interface Part {
  attribute: string;
  position: number;
  cast: "i" | "f" | "s";
  value: string;
}

const PART = /^(.+)\((\d+)([ifs])\)$/;

/** Whether a parameter name is one part of a multi-part value. */
export function isMultiparameterKey(key: string): boolean {
  return PART.test(key);
}

/** The attribute a part belongs to, or undefined if it is not a part. */
export function multiparameterAttribute(key: string): string | undefined {
  return PART.exec(key)?.[1];
}

function parse(key: string, value: unknown): Part | undefined {
  const match = PART.exec(key);
  if (!match) return undefined;

  return {
    attribute: match[1] as string,
    position: Number(match[2]),
    cast: match[3] as "i" | "f" | "s",
    value: value === null || value === undefined ? "" : String(value),
  };
}

function castPart(part: Part): number | string | null {
  if (part.value === "") return null;
  if (part.cast === "s") return part.value;

  const parsed =
    part.cast === "i" ? Number.parseInt(part.value, 10) : Number.parseFloat(part.value);

  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Builds a Date out of positions 1 to 6.
 *
 * Positions are Rails' order: year, month, day, hour, minute, second. Missing
 * trailing parts default rather than failing, because a `date_select` posts
 * three of the six and a `datetime_select` five — a builder that insisted on
 * all six would reject the common case.
 *
 * Any part left blank makes the whole value null. That is Rails' behaviour and
 * the right one: a date with the year chosen and the month not is not a date,
 * and guessing January would record a fact nobody entered.
 */
function buildDate(parts: Part[]): Date | null {
  const byPosition = new Map(parts.map((part) => [part.position, castPart(part)]));
  const year = byPosition.get(1);

  if (year === null || year === undefined) return null;

  // A blank in any position that was posted at all sinks the whole value.
  for (const value of byPosition.values()) {
    if (value === null) return null;
  }

  const month = Number(byPosition.get(2) ?? 1);
  const day = Number(byPosition.get(3) ?? 1);
  const hour = Number(byPosition.get(4) ?? 0);
  const minute = Number(byPosition.get(5) ?? 0);
  const second = Number(byPosition.get(6) ?? 0);

  const built = new Date(Date.UTC(Number(year), month - 1, day, hour, minute, second));

  if (Number.isNaN(built.getTime())) return null;

  // Date.UTC rolls over rather than refusing: 31 February silently becomes
  // 3 March, and 25 o'clock becomes one in the morning of the next day. A
  // caller that accepted either would record a date the person never picked,
  // so the parts are compared against what came back.
  const rolled =
    built.getUTCFullYear() !== Number(year) ||
    built.getUTCMonth() !== month - 1 ||
    built.getUTCDate() !== day ||
    built.getUTCHours() !== hour ||
    built.getUTCMinutes() !== minute ||
    built.getUTCSeconds() !== second;

  return rolled ? null : built;
}

export interface MultiparameterResult {
  /** The parameters with the parts replaced by assembled values. */
  attributes: Record<string, unknown>;
  /** Attributes whose parts could not be assembled, and why. */
  errors: Record<string, string>;
}

/**
 * Reassembles every multi-part value in a set of parameters.
 *
 * Parameters that are not parts pass through untouched, so this can run over a
 * whole params object rather than being pointed at the fields that need it —
 * which matters because the form, not the controller, decides which fields are
 * multi-part.
 *
 * A set of parts that cannot make a date is reported rather than thrown. Rails
 * raises a MultiparameterAssignmentErrors, but a form is user input: 31
 * February is a mistake to show on the field, not a 500.
 */
export function assignMultiparameterAttributes(
  params: Record<string, unknown>,
): MultiparameterResult {
  const attributes: Record<string, unknown> = {};
  const grouped = new Map<string, Part[]>();

  for (const [key, value] of Object.entries(params)) {
    const part = parse(key, value);

    if (!part) {
      attributes[key] = value;
      continue;
    }

    const existing = grouped.get(part.attribute) ?? [];
    existing.push(part);
    grouped.set(part.attribute, existing);
  }

  const errors: Record<string, string> = {};

  for (const [attribute, parts] of grouped) {
    const sorted = [...parts].sort((a, b) => a.position - b.position);

    // Only positions 1 to 6 mean a date. Anything else is a value split for a
    // reason this does not know about, and is handed back as its parts rather
    // than guessed at.
    if (sorted.every((part) => part.position >= 1 && part.position <= 6)) {
      const built = buildDate(sorted);

      // A complete set that still produced nothing is a date that does not
      // exist — 31 February, or 25 o'clock — and worth saying so about.
      if (built === null && sorted.every((part) => part.value !== "")) {
        errors[attribute] = `${attribute} is not a valid date`;
      }

      attributes[attribute] = built;
      continue;
    }

    for (const part of sorted) {
      attributes[`${attribute}(${part.position}${part.cast})`] = part.value;
    }
  }

  return { attributes, errors };
}
