/**
 * Fixtures and factories, ported from `ActiveRecord::FixtureSet`.
 *
 * Rails fixtures are YAML files loaded once, before the per-test transaction
 * opens, and referenced by name: `posts(:welcome)`. The naming and the loading
 * order are kept; the YAML is not, because a TypeScript object is already the
 * thing YAML was standing in for, and it type-checks against the row types the
 * schema dump generates.
 */

import type { Row } from "@altair/orm";

/** Any model class. Kept structural so this package does not import Model. */
export type ModelClass = abstract new (...args: never[]) => object;

/** A record of the model, with the framework's own members hidden from view. */
export type Attributes<M extends ModelClass> = Partial<InstanceType<M>>;

/** The statics a factory calls. Model satisfies this; the cast lives here only. */
interface Persistence<M extends ModelClass> {
  readonly table: string;
  build(values?: object): InstanceType<M>;
  create(values?: object): Promise<InstanceType<M>>;
  instantiate(row: Row): InstanceType<M>;
}

/** A record's stored columns. Spreading the instance would not reach them. */
function attributesOf(record: object): Row {
  return (record as { attributes(): Row }).attributes();
}

function persistence<M extends ModelClass>(model: M): Persistence<M> {
  return model as unknown as Persistence<M>;
}

/**
 * A record template with a counter, for tests that need many of something and
 * care about only one field of it.
 *
 * Rails has no equivalent — this is FactoryBot's idea, and it is here because
 * fixtures alone push tests toward sharing one global record set, which is the
 * thing people dislike about fixtures.
 */
export class Factory<M extends ModelClass> {
  readonly model: M;

  #defaults: (sequence: number) => Attributes<M>;
  #sequence = 0;

  constructor(model: M, defaults: (sequence: number) => Attributes<M>) {
    this.model = model;
    this.#defaults = defaults;
  }

  /** The next set of attributes, without touching the database. */
  attributes(overrides: Attributes<M> = {}): Attributes<M> {
    this.#sequence += 1;
    return { ...this.#defaults(this.#sequence), ...overrides };
  }

  /** An unsaved record. */
  build(overrides: Attributes<M> = {}): InstanceType<M> {
    return persistence(this.model).build(this.attributes(overrides));
  }

  /** A saved record. Throws if it fails validation, as `create!` does. */
  async create(overrides: Attributes<M> = {}): Promise<InstanceType<M>> {
    return await persistence(this.model).create(this.attributes(overrides));
  }

  /** `count` saved records, each with its own sequence number. */
  async createList(count: number, overrides: Attributes<M> = {}): Promise<InstanceType<M>[]> {
    const records: InstanceType<M>[] = [];
    for (let index = 0; index < count; index += 1) {
      records.push(await this.create(overrides));
    }
    return records;
  }

  /** Restarts the counter, so a test asserting on generated values can. */
  reset(): void {
    this.#sequence = 0;
  }

  get sequence(): number {
    return this.#sequence;
  }
}

export function defineFactory<M extends ModelClass>(
  model: M,
  defaults: (sequence: number) => Attributes<M>,
): Factory<M> {
  return new Factory(model, defaults);
}

/** Raised when a test asks for a fixture that was never defined. */
export class FixtureNotFound extends Error {
  constructor(name: string, known: string[]) {
    super(
      known.length > 0
        ? `No fixture named "${name}". Defined: ${known.join(", ")}.`
        : `No fixture named "${name}". None are defined.`,
    );
    this.name = "FixtureNotFound";
  }
}

/**
 * A named set of records, loaded once and referred to by name.
 *
 * Load before the per-test transaction opens — in `beforeAll`, not
 * `beforeEach` — so every test starts from the same rows and its own writes
 * roll back off them. That is exactly Rails' ordering, and getting it wrong is
 * the usual reason a fixture-based suite is slow.
 */
export class Fixtures<M extends ModelClass, N extends string> {
  readonly model: M;

  #records: Record<N, Attributes<M>>;
  #rows = new Map<N, Row>();

  constructor(model: M, records: Record<N, Attributes<M>>) {
    this.model = model;
    this.#records = records;
  }

  /** Inserts every record. Call once, outside the test transaction. */
  async load(): Promise<void> {
    this.#rows.clear();

    for (const name of Object.keys(this.#records) as N[]) {
      const record = await persistence(this.model).create(this.#records[name]);
      this.#rows.set(name, attributesOf(record));
    }
  }

  /**
   * The record a name refers to. Rails' `posts(:welcome)`.
   *
   * A fresh instance each call, built from the attributes as loaded. Handing
   * back one shared instance would let a test that mutated it leak into the
   * next one, which the transaction rollback would not undo — the rollback
   * covers the database, not objects held in memory.
   */
  get(name: N): InstanceType<M> {
    const row = this.#rows.get(name);
    if (!row) {
      if (this.#rows.size === 0 && name in this.#records) {
        throw new Error(`Fixtures for "${persistence(this.model).table}" have not been loaded.`);
      }
      throw new FixtureNotFound(name, Object.keys(this.#records));
    }

    return persistence(this.model).instantiate({ ...row });
  }

  /** The primary key a fixture was given, for building associations. */
  id(name: N): unknown {
    return attributesOf(this.get(name)).id;
  }

  get names(): N[] {
    return Object.keys(this.#records) as N[];
  }
}

export function defineFixtures<M extends ModelClass, const N extends string>(
  model: M,
  records: Record<N, Attributes<M>>,
): Fixtures<M, N> {
  return new Fixtures(model, records);
}
