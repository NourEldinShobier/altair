/**
 * Putting a record in a cache and getting it back without a query, ported from
 * `ActiveRecord::MessagePack`.
 *
 * Caching a record is not the same as caching its attributes. What an
 * application wants back is the object — with its class, its persisted state,
 * and the associations that were already loaded — so that the cached copy
 * behaves like the one that was cached rather than like a hash that looks a
 * bit like it.
 *
 * Three things make that work, and each is a bug if it is left out:
 *
 * - **Every record is stored once and referred to by number.** A post holds
 *   its author, and the author holds their posts including that one. Encoding
 *   that naively does not produce a big payload; it does not terminate. The
 *   reference table is also what stops fifty comments on one post carrying
 *   fifty copies of the post.
 * - **Only loaded associations travel.** Walking an unloaded one would issue
 *   the query at dump time — so writing to the cache would run exactly the
 *   queries the cache exists to avoid, on every write.
 * - **Whether the record was persisted travels with it.** Without it, a cached
 *   unsaved record loads as a persisted one and its next `save` is an UPDATE
 *   against a row that does not exist: no error, no row, no record.
 *
 * The class is named rather than captured, because a payload outlives the
 * process that wrote it. The version is stamped for the same reason — an old
 * payload is refused rather than misread — and an association that no longer
 * exists is skipped rather than raised on, because the cache outlives the code
 * too and a deploy that removed one should not make every cached record
 * unloadable.
 */

/** The stamp on a payload. Anything else is refused rather than guessed at. */
export const RECORD_PACK_VERSION = 1;

/** One record in the flat table: its class, its columns, whether it is saved. */
export type RecordEntry = [
  className: string,
  attributes: Record<string, unknown>,
  isNew: boolean,
  ...associations: unknown[],
];

/** A reference into the entry table, or a list of them. */
export type RecordRef = number | number[] | null;

export interface PackedRecords {
  version: number;
  top: RecordRef;
  entries: RecordEntry[];
}

/** What packing needs to know about a record. */
export interface RecordReader<R> {
  className(record: R): string;
  attributes(record: R): Record<string, unknown>;
  isNew(record: R): boolean;
  /** Only the associations already in memory. Rails' `association_cached?`. */
  loadedAssociations(record: R): [name: string, target: R | R[] | null][];
}

/** What unpacking needs to be able to do. */
export interface RecordWriter<R> {
  build(className: string, attributes: Record<string, unknown>, isNew: boolean): R;
  /** Throws for an association the class no longer has; that is not fatal. */
  setAssociation(record: R, name: string, target: R | R[] | null): void;
}

export class UnknownPackVersion extends Error {
  constructor(version: unknown) {
    super(
      `This payload is version ${String(version)} and this code reads version ` +
        `${String(RECORD_PACK_VERSION)}. Refusing it rather than reading it as though the ` +
        `fields still meant the same thing — a cache outlives the deploy that filled it.`,
    );
    this.name = "UnknownPackVersion";
  }
}

/**
 * Turns one record into an entry and returns its reference. Rails'
 * `encode_record`.
 *
 * The identity map is the whole of it: a record already seen gives back the
 * number it was given, so a cycle closes instead of recursing.
 */
export function encodeRecord<R extends object>(
  record: R,
  reader: RecordReader<R>,
  entries: RecordEntry[],
  refs: Map<R, number>,
): number {
  const seen = refs.get(record);

  if (seen !== undefined) return seen;

  const ref = entries.length;

  // Registered *before* the associations are walked, so a record that reaches
  // itself finds the number rather than starting again.
  refs.set(record, ref);
  const entry = writeRecord(record, reader);
  entries.push(entry);

  for (const [name, target] of reader.loadedAssociations(record)) {
    entry.push(name, encodeTarget(target, reader, entries, refs));
  }

  return ref;
}

/** The entry for one record, before its associations are appended. Rails' `build_entry`. */
export function writeRecord<R>(record: R, reader: RecordReader<R>): RecordEntry {
  return [reader.className(record), reader.attributes(record), reader.isNew(record)];
}

/** One record out of an entry. Rails' `read_record`. */
export function readRecord<R>(entry: RecordEntry, writer: RecordWriter<R>): R {
  const [className, attributes, isNew] = entry;

  return writer.build(className, attributes, isNew);
}

/** A record, or a list of them, as a cacheable payload. */
export function dumpRecords<R extends object>(
  input: R | readonly R[] | null,
  reader: RecordReader<R>,
): PackedRecords {
  const entries: RecordEntry[] = [];
  const refs = new Map<R, number>();

  return {
    version: RECORD_PACK_VERSION,
    top: encodeTarget(input, reader, entries, refs),
    entries,
  };
}

/**
 * The records a payload holds.
 *
 * Every entry is built before any association is resolved, because an
 * association points at a record that may come later in the table — and a
 * cycle means one of them always does.
 */
export function loadRecords<R extends object>(
  packed: PackedRecords,
  writer: RecordWriter<R>,
): R | R[] | null {
  if (packed.version !== RECORD_PACK_VERSION) throw new UnknownPackVersion(packed.version);

  const records = packed.entries.map((entry) => readRecord(entry, writer));

  for (const [index, entry] of packed.entries.entries()) {
    const record = records[index] as R;

    // Entry is [class, attributes, isNew, name, ref, name, ref, …].
    for (let at = 3; at < entry.length; at += 2) {
      try {
        writer.setAssociation(record, entry[at] as string, decodeTarget(entry[at + 1], records));
      } catch {
        // The association is gone from the class. A cache outlives the code
        // that filled it, and a deploy that removed one association should not
        // make every record written before it unloadable.
      }
    }
  }

  return decodeTarget(packed.top, records);
}

function encodeTarget<R extends object>(
  target: R | readonly R[] | null | undefined,
  reader: RecordReader<R>,
  entries: RecordEntry[],
  refs: Map<R, number>,
): RecordRef {
  if (target === null || target === undefined) return null;

  if (Array.isArray(target)) {
    return (target as readonly R[]).map((one) => encodeRecord(one, reader, entries, refs));
  }

  return encodeRecord(target as R, reader, entries, refs);
}

function decodeTarget<R>(ref: unknown, records: readonly R[]): R | R[] | null {
  if (ref === null || ref === undefined) return null;

  if (Array.isArray(ref)) return (ref as number[]).map((one) => records[one] as R);

  return (records[ref as number] ?? null) as R | null;
}
