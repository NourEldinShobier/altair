/**
 * Packing an actual record, ported from `ActiveRecord::MessagePack`'s
 * `Extensions.write_record` / `read_record`.
 *
 * `record_pack.ts` knows the shape of a payload — one entry per record,
 * references instead of copies, associations carried by name. It deliberately
 * knows nothing about `Model`, which is what makes it testable without a
 * database. This is the half that does: how to get a record's columns out of
 * it, and how to build one back.
 *
 * Two things here are not obvious.
 *
 * **What goes in the payload is the database form, not the in-memory one.** A
 * cache is another datastore. Packing the plaintext of an encrypted column
 * would put it in Redis, or on a disk, or in whatever else is holding the
 * cache — and the column is encrypted precisely because those are not places
 * it belongs. So the values go through the same encryption the insert would
 * use, and come back through the same casting a row does.
 *
 * **A class is looked up in a list the caller gives, never by name alone.** A
 * payload says which class to build, and a payload is data: reading a class
 * name out of one and instantiating whatever it names is how a cache becomes a
 * way to construct arbitrary objects. The allowlist is the whole of the
 * defence, and it costs one argument.
 */

import { cacheKey } from "./associations.js";
import type { RecordReader, RecordWriter } from "./record_pack.js";

/** What this needs a record to be, without naming `Model` and its generics. */
export interface PackableRecord {
  constructor: { name: string };
  attributes(): Record<string, unknown>;
  isNewRecord: boolean;
  loadedAssociations(): string[];
}

/** What this needs a model class to be. */
export interface PackableModel {
  name: string;
  new (values: Record<string, unknown>, persisted?: boolean): PackableRecord;
  encryptFor(attribute: string, value: unknown): unknown;
  castRow(row: Record<string, unknown>, options?: { encrypted?: boolean }): Record<string, unknown>;
}

export class UnknownPackedClass extends Error {
  constructor(name: string, known: readonly string[]) {
    super(
      `This payload names ${JSON.stringify(name)} and that class was not offered to the loader. ` +
        `Known: ${known.join(", ") || "none"}. A payload is data, and building whatever class it ` +
        `names is how a cache becomes a way to construct arbitrary objects — so the list is ` +
        `given, not discovered.`,
    );
    this.name = "UnknownPackedClass";
  }
}

/**
 * Reads a record for packing.
 *
 * A loaded association is carried when it is a record or a list of them.
 * Anything else — a relation that has not been run, most often — is skipped,
 * because turning one into records is asynchronous and this is not. Skipping
 * is the safe direction: the association is simply not in the payload, and the
 * loaded record fetches it the first time it is asked, exactly as an unpacked
 * record with no cached association always would.
 */
export function modelRecordReader(): RecordReader<PackableRecord> {
  return {
    className: (record) => record.constructor.name,
    isNew: (record) => record.isNewRecord,
    attributes: (record) => {
      const klass = record.constructor as unknown as PackableModel;

      return Object.fromEntries(
        Object.entries(record.attributes()).map(([name, value]) => [
          name,
          klass.encryptFor(name, value),
        ]),
      );
    },
    loadedAssociations: (record) => {
      const entries: [string, PackableRecord | PackableRecord[] | null][] = [];

      for (const name of record.loadedAssociations()) {
        const target = (record as unknown as Record<string, unknown>)[cacheKey(name)];
        const packable = packableTarget(target);

        // Skipped rather than guessed at when it is neither. The association
        // is then simply absent from the payload, and the loaded record
        // fetches it the first time it is asked — which is what any unpacked
        // record with nothing cached does anyway.
        if (packable !== undefined) entries.push([name, packable]);
      }

      return entries;
    },
  };
}

/**
 * Builds records back, from a list of classes the caller vouches for.
 *
 * The row goes through `castRow`, which is what decrypts and casts it — the
 * same path a row from the database takes, so a packed record and a queried
 * one differ in where they came from and nowhere else.
 */
export function modelRecordWriter(classes: Iterable<PackableModel>): RecordWriter<PackableRecord> {
  const known = new Map<string, PackableModel>();

  for (const klass of classes) known.set(klass.name, klass);

  return {
    build: (className, attributes, isNew) => {
      const klass = known.get(className);

      if (klass === undefined) throw new UnknownPackedClass(className, [...known.keys()]);

      return new klass(klass.castRow(attributes), !isNew);
    },
    setAssociation: (record, name, target) => {
      // Straight into the association cache, which is where a preload puts one
      // too. Going through the accessor would fetch what is already here.
      (record as unknown as Record<string, unknown>)[cacheKey(name)] = target;
    },
  };
}

/**
 * A cached association as something the payload can hold, or nothing.
 *
 * `null` is a real answer — a `belongsTo` that was loaded and found nothing —
 * and has to survive the round trip, or the loaded record would go looking for
 * it again and find nothing again, once per read.
 */
function packableTarget(target: unknown): PackableRecord | PackableRecord[] | null | undefined {
  if (target === null) return null;
  if (Array.isArray(target))
    return target.every(isRecord) ? (target as PackableRecord[]) : undefined;

  return isRecord(target) ? target : undefined;
}

/** Structural, because the record classes are built by a factory rather than shared. */
function isRecord(value: unknown): value is PackableRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PackableRecord).attributes === "function" &&
    typeof (value as PackableRecord).loadedAssociations === "function"
  );
}
