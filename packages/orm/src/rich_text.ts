/**
 * Rich text, ported from `ActionText`.
 *
 * Rails keeps a record's formatted body in its own table rather than a column,
 * for two reasons worth repeating: a body is usually large and would be loaded
 * with every query that touches the record, and it is polymorphic, so one
 * table serves every model that has one.
 *
 *     class Post extends Model<PostRow>("posts") {
 *       declare content: RichTextField
 *       static { hasRichText(this, "content") }
 *     }
 *
 * What is stored is what was submitted. What is rendered is sanitized, every
 * time — storing sanitized HTML means a policy that tightens later does
 * nothing for what is already in the database.
 */

import { Model } from "./model.js";
import type { SchemaStatements } from "./schema.js";

export interface RichTextRow {
  id: number;
  name: string;
  body: string | null;
  record_type: string;
  record_id: number;
  created_at: string;
  updated_at: string;
}

export class RichText extends Model<RichTextRow>("action_text_rich_texts") {}

/** How a rich text body is rendered. Supplied so the ORM need not import a view. */
export type Sanitizer = (html: string) => Promise<string>;

let sanitizer: Sanitizer | undefined;

/**
 * Sets what renders a body.
 *
 * Registered rather than imported: the ORM has no business depending on the
 * view layer, and an application that renders its own way should be able to.
 */
export function configureRichText(options: { sanitizer: Sanitizer }): void {
  sanitizer = options.sanitizer;
}

export function resetRichText(): void {
  sanitizer = undefined;
}

/** The record a rich text hangs off. Structural, so any model qualifies. */
interface RichTextRecord {
  id: unknown;
  constructor: { name: string };
}

/** One record's rich text, under one name. */
export class RichTextField {
  constructor(
    private readonly record: RichTextRecord,
    readonly name: string,
  ) {}

  private get scope(): { name: string; record_type: string; record_id: number } {
    return {
      name: this.name,
      record_type: this.record.constructor.name,
      record_id: this.record.id as number,
    };
  }

  /** The stored body, exactly as it was submitted. */
  async body(): Promise<string | null> {
    const stored = await RichText.findBy(this.scope);
    return (stored?.body as string | null) ?? null;
  }

  async isPresent(): Promise<boolean> {
    const body = await this.body();
    return body !== null && body.trim() !== "";
  }

  /** Replaces the body. What arrives is stored as it arrived. */
  async update(body: string | null): Promise<RichText> {
    const existing = await RichText.findBy(this.scope);

    if (existing) {
      await existing.update({ body });
      return existing;
    }

    return await RichText.create({ ...this.scope, body });
  }

  /**
   * The body, sanitized, ready to render.
   *
   * Sanitized on the way out rather than on the way in: a policy that tightens
   * next month should protect what was stored last month, and it cannot if the
   * only copy has already been through the old one.
   */
  async toHtml(): Promise<string> {
    const body = await this.body();
    if (body === null) return "";

    if (!sanitizer) {
      throw new Error(
        "Rich text has no sanitizer. Call configureRichText({ sanitizer }) with one — rendering a stored body unsanitized is how a stored cross-site scripting bug works.",
      );
    }

    return await sanitizer(body);
  }

  /** Deletes the body. */
  async destroy(): Promise<void> {
    const existing = await RichText.findBy(this.scope);
    if (existing) await existing.destroy();
  }
}

type ModelClass = abstract new (...args: never[]) => object;

/** The name has to be a property the model declares, as an association does. */
type FieldName<M extends ModelClass> = keyof InstanceType<M> & string;

/**
 * Rails' `has_rich_text :content`.
 *
 *     class Post extends Model<PostRow>("posts") {
 *       declare content: RichTextField
 *       static { hasRichText(this, "content") }
 *     }
 */
export function hasRichText<M extends ModelClass>(model: M, name: FieldName<M>): void {
  // A getter on the prototype rather than a field: a field would be an own
  // property on every instance, which the Proxy a model is wrapped in would
  // find before it looked for an attribute.
  Object.defineProperty(model.prototype, name, {
    configurable: true,
    get(this: RichTextRecord) {
      return new RichTextField(this, name);
    },
  });
}

/** Creates the table rich text bodies live in. */
export async function createRichTextTable(schema: SchemaStatements): Promise<void> {
  await schema.createTable("action_text_rich_texts", (t) => {
    t.string("name", { null: false });
    t.text("body");
    t.string("record_type", { null: false });
    t.bigint("record_id", { null: false });
    t.timestamps();
    // One body per record per name, which is what makes findBy the right
    // lookup and stops a second one being created by a race.
    t.index(["record_type", "record_id", "name"], { unique: true });
  });
}
