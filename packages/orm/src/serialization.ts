/**
 * Turning a record into something transportable, ported from
 * `ActiveModel::Serialization` and `ActiveModel::Serializers::JSON`.
 *
 * `serializableHash` next door decides *which* attributes. This decides what
 * happens to them on the way out — nested records, a root key, the JSON and
 * XML forms — and keeps those decisions in one place so an API and a job
 * payload of the same record do not quietly disagree about the shape.
 */

import { serializableHash, type SerializationOptions } from "./active_model.js";

export interface JsonOptions extends SerializationOptions {
  /**
   * Associations to include, and optionally their own options.
   *
   *     asJson(post, { include: { comments: { only: ["body"] } } })
   *
   * Nested rather than flattened, because a comment's `id` and a post's `id`
   * are different things and a flat merge silently picks one.
   */
  include?: readonly string[] | Record<string, SerializationOptions>;
  /** Wrap the result under the model's name. Rails' `include_root_in_json`. */
  root?: boolean | string;
}

/** Whether serialization wraps results in a root key by default. */
let includeRootInJson = false;

export function setIncludeRootInJson(value: boolean): void {
  includeRootInJson = value;
}

export function includeRoot(): boolean {
  return includeRootInJson;
}

/**
 * What a record must offer to be serialized.
 *
 * `attributes()` is typed loosely on purpose: a model returns its own row
 * interface, which is a narrower type than an index signature and would
 * otherwise refuse to satisfy this — for no benefit, since every value is
 * about to be treated as unknown anyway.
 */
interface Serializable {
  attributes(): object;
  constructor: { name: string };
}

/**
 * One attribute as it should appear in output. Rails'
 * `read_attribute_for_serialization`.
 *
 * A seam rather than a direct read, so a model can present a value differently
 * to an API than it stores it — a state held as an integer rendered as its
 * name, a decimal rendered as a string so a client's float does not round it.
 */
export function readAttributeForSerialization(record: object, name: string): unknown {
  const value = (record as Record<string, unknown>)[name];

  return typeof value === "function" ? (value as () => unknown).call(record) : value;
}

/**
 * A record as plain data. Rails' `as_json`.
 *
 * Recursive through `include`, and the recursion is why this exists rather
 * than a spread: a nested record needs its own `only` and `except` applied,
 * and a plain object copy would carry its internals along.
 */
export function asJson(record: Serializable, options: JsonOptions = {}): Record<string, unknown> {
  const hash = serializableHash(record, record.attributes() as Record<string, unknown>, options);

  for (const [name, nested] of Object.entries(normalizeInclude(options.include))) {
    const value = readAttributeForSerialization(record, name);
    hash[name] = serializeNested(value, nested);
  }

  const root = options.root ?? includeRootInJson;
  if (!root) return hash;

  const key = typeof root === "string" ? root : underscoreName(record.constructor.name);

  return { [key]: hash };
}

/** The same, as a JSON string. Rails' `to_json`. */
export function toJson(record: Serializable, options: JsonOptions = {}): string {
  return JSON.stringify(asJson(record, options));
}

/**
 * A record as XML. Rails' `to_xml`.
 *
 * Still here because a good deal of the world speaks it — payment gateways,
 * shipping carriers, government filings — and the alternative is every caller
 * writing its own escaping, which is where the injection is.
 */
export function toXml(record: Serializable, options: JsonOptions = {}): string {
  const name = underscoreName(record.constructor.name).replace(/_/g, "-");
  const hash = asJson(record, { ...options, root: false });

  const body = Object.entries(hash)
    .map(([key, value]) => xmlElement(key.replace(/_/g, "-"), value))
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>\n<${name}>${body}</${name}>`;
}

function xmlElement(name: string, value: unknown): string {
  if (value === null || value === undefined) return `<${name} nil="true"/>`;

  if (Array.isArray(value)) {
    return `<${name} type="array">${value.map((one) => xmlElement("item", one)).join("")}</${name}>`;
  }

  if (value instanceof Date) return `<${name} type="datetime">${value.toISOString()}</${name}>`;

  if (typeof value === "object") {
    const inner = Object.entries(value as Record<string, unknown>)
      .map(([key, one]) => xmlElement(key.replace(/_/g, "-"), one))
      .join("");

    return `<${name}>${inner}</${name}>`;
  }

  const type = typeof value === "number" ? ' type="integer"' : "";

  return `<${name}${type}>${escapeXml(String(value))}</${name}>`;
}

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (one) => XML_ESCAPES[one] as string);
}

function normalizeInclude(include: JsonOptions["include"]): Record<string, SerializationOptions> {
  if (!include) return {};
  if (Array.isArray(include)) return Object.fromEntries(include.map((name) => [name, {}]));

  return include as Record<string, SerializationOptions>;
}

function serializeNested(value: unknown, options: SerializationOptions): unknown {
  if (value === null || value === undefined) return null;

  if (Array.isArray(value)) {
    return value.map((one) => asJson(one as Serializable, options));
  }

  return asJson(value as Serializable, options);
}

function underscoreName(name: string): string {
  return name
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .replace(/::/g, "_")
    .toLowerCase();
}
