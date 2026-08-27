/**
 * Turning a job's arguments into something a queue can hold, ported from
 * `ActiveJob::Serializers`.
 *
 * A queue stores JSON. A `Date` through `JSON.stringify` and back is a string,
 * and a job that took a date yesterday takes a string today — so
 * `date.getTime()` throws inside a worker, hours after the code that enqueued
 * it looked fine.
 *
 *     addSerializer({ key: "Money", ... })
 *
 * Rails serializes dates, times, durations, symbols and ranges for the same
 * reason, and lets an application add its own.
 */

/** How one kind of value survives the round trip. */
export interface ArgumentSerializer<T = unknown> {
  /** What marks a payload as this kind. Must be unique. */
  key: string;
  serializes(value: unknown): boolean;
  serialize(value: T): unknown;
  deserialize(payload: unknown): T;
}

/** The marker that says a payload is not a plain object. */
const MARKER = "_altair_type";

const serializers: ArgumentSerializer[] = [
  {
    key: "Date",
    serializes: (value) => value instanceof Date,
    serialize: (value) => (value as Date).toISOString(),
    deserialize: (payload) => new Date(payload as string),
  },
  {
    key: "BigInt",
    serializes: (value) => typeof value === "bigint",
    // As a string: a bigint is a bigint because a number could not hold it,
    // and JSON has only numbers.
    serialize: (value) => (value as bigint).toString(),
    deserialize: (payload) => BigInt(payload as string),
  },
  {
    key: "Set",
    serializes: (value) => value instanceof Set,
    serialize: (value) => [...(value as Set<unknown>)].map((one) => serializeArgument(one)),
    deserialize: (payload) =>
      new Set((payload as unknown[]).map((one) => deserializeArgument(one))),
  },
  {
    key: "Map",
    serializes: (value) => value instanceof Map,
    serialize: (value) =>
      [...(value as Map<unknown, unknown>)].map(([key, one]) => [
        serializeArgument(key),
        serializeArgument(one),
      ]),
    deserialize: (payload) =>
      new Map(
        (payload as [unknown, unknown][]).map(([key, one]) => [
          deserializeArgument(key),
          deserializeArgument(one),
        ]),
      ),
  },
];

/**
 * Adds a serializer, or replaces the one with the same key.
 *
 * Replacing rather than appending, so registering twice — which a module
 * reloaded in development does — leaves one rather than two, and the second
 * does not shadow the first for reasons of ordering.
 */
export function addSerializer(serializer: ArgumentSerializer): void {
  const at = serializers.findIndex((one) => one.key === serializer.key);

  if (at === -1) serializers.push(serializer);
  else serializers[at] = serializer;
}

/** Every serializer, in the order they are tried. */
export function argumentSerializers(): readonly ArgumentSerializer[] {
  return serializers;
}

/**
 * A value as the queue will hold it.
 *
 * Arrays and plain objects are walked, so a date inside one survives — which
 * is where a hand-written version usually stops and where the bug lives.
 */
export function serializeArgument(value: unknown): unknown {
  for (const serializer of serializers) {
    if (serializer.serializes(value)) {
      return { [MARKER]: serializer.key, value: serializer.serialize(value) };
    }
  }

  if (Array.isArray(value)) return value.map((one) => serializeArgument(one));

  if (
    value !== null &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(value as object).map(([key, one]) => [key, serializeArgument(one)]),
    );
  }

  return value;
}

/** The value back again. */
export function deserializeArgument(payload: unknown): unknown {
  if (Array.isArray(payload)) return payload.map((one) => deserializeArgument(one));

  if (payload !== null && typeof payload === "object") {
    const marked = (payload as Record<string, unknown>)[MARKER];

    if (typeof marked === "string") {
      const serializer = serializers.find((one) => one.key === marked);

      // An unknown marker means the payload was written by a version that had
      // a serializer this one does not. Handing back the wrapper is worse than
      // saying so: the job would run with an object where it expected a value.
      if (!serializer) {
        throw new Error(
          `No serializer for "${marked}". A job was enqueued by a version that had one this process does not.`,
        );
      }

      return serializer.deserialize((payload as Record<string, unknown>).value);
    }

    if (Object.getPrototypeOf(payload) === Object.prototype) {
      return Object.fromEntries(
        Object.entries(payload as object).map(([key, one]) => [key, deserializeArgument(one)]),
      );
    }
  }

  return payload;
}

export function serializeArguments(args: readonly unknown[]): unknown[] {
  return args.map((one) => serializeArgument(one));
}

export function deserializeArguments(payload: readonly unknown[]): unknown[] {
  return payload.map((one) => deserializeArgument(one));
}
