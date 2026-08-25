/**
 * Typed attributes, ported from `ActiveModel::Attributes`.
 *
 *     class Search extends ActiveModel {
 *       static {
 *         this.attribute("query", "string")
 *         this.attribute("page", "integer", { default: 1 })
 *         this.attribute("unread", "boolean", { default: false })
 *       }
 *     }
 *
 *     Search.build({ page: "2", unread: "0" })   // page === 2, unread === false
 *
 * A form posts strings. Every value arriving from a browser is a string,
 * including the ones that mean a number and the ones that mean no — so a model
 * that does not cast is a model where `page > 1` compares a string to a number
 * and `if (unread)` is true for the string "0".
 *
 * That last one is the reason boolean casting is worth writing carefully
 * rather than reaching for `Boolean(value)`: an unchecked checkbox posts "0",
 * and `Boolean("0")` is true.
 */

export type AttributeType =
  | "string"
  | "integer"
  | "float"
  | "boolean"
  | "date"
  | "datetime"
  | "json";

export type Caster = (value: unknown) => unknown;

export interface AttributeOptions {
  /** Used when nothing was assigned. A function is called per record. */
  default?: unknown;
}

export interface AttributeDefinition {
  name: string;
  cast: Caster;
  options: AttributeOptions;
}

/**
 * The values Rails treats as false.
 *
 * An unchecked checkbox posts `"0"`, an unset select posts `""`, and both mean
 * no. Anything else that is present means yes, which is why this is a list of
 * falses rather than a list of trues.
 */
const FALSE = new Set(["", "0", "f", "false", "off", "no", "n"]);

export function castBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;

  return !FALSE.has(String(value).trim().toLowerCase());
}

function castNumber(value: unknown, whole: boolean): number | null {
  if (value === null || value === undefined || value === "") return null;

  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  if (Number.isNaN(parsed)) return null;

  return whole ? Math.trunc(parsed) : parsed;
}

function castDate(value: unknown, dateOnly: boolean): Date | null {
  if (value === null || value === undefined || value === "") return null;

  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return null;

  if (!dateOnly) return date;

  // A date with no time is the same date everywhere; keeping the time on it
  // makes a birthday shift a day for anyone east or west of the server.
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** The caster for a named type. */
export function casterFor(type: AttributeType | Caster): Caster {
  if (typeof type === "function") return type;

  switch (type) {
    case "string":
      return (value) => (value === null || value === undefined ? null : String(value));
    case "integer":
      return (value) => castNumber(value, true);
    case "float":
      return (value) => castNumber(value, false);
    case "boolean":
      return castBoolean;
    case "date":
      return (value) => castDate(value, true);
    case "datetime":
      return (value) => castDate(value, false);
    case "json":
      return (value) => {
        if (typeof value !== "string") return value;
        try {
          return JSON.parse(value) as unknown;
        } catch {
          // A malformed body is not a reason to fail the whole assignment; the
          // validation that cares can see it is null and say so in words.
          return null;
        }
      };
    default:
      return (value) => value;
  }
}

export function defineAttribute(
  name: string,
  type: AttributeType | Caster,
  options: AttributeOptions = {},
): AttributeDefinition {
  return { name, cast: casterFor(type), options };
}

/** The default for an attribute, calling it if it is a function. */
export function defaultFor(definition: AttributeDefinition): unknown {
  const value = definition.options.default;

  // Called per record rather than shared: a default of `[]` handed to every
  // record is one array that they all push into.
  return typeof value === "function" ? (value as () => unknown)() : value;
}
