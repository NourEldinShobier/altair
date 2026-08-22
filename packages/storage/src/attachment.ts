/**
 * Attachments, ported from `ActiveStorage::Attached`.
 *
 * One table joins every model in the application to its files, keyed by the
 * record's class, its id, and the name the attachment was declared under. That
 * is what lets `hasOneAttached("avatar")` and `hasManyAttached("images")` live
 * on the same table without either knowing the other exists.
 */

import { Model } from "@altair/orm";
import { createBlob, StorageBlob, type UploadedFile } from "./blob.js";
import type { UrlOptions } from "./service.js";

export interface AttachmentRow {
  id: number;
  name: string;
  record_type: string;
  record_id: number;
  blob_id: number;
  created_at: string;
}

export class Attachment extends Model<AttachmentRow>("active_storage_attachments") {
  async blob(): Promise<StorageBlob> {
    return await StorageBlob.find(this.blob_id);
  }
}

/** The record an attachment hangs off. Structural, so any model qualifies. */
interface AttachedRecord {
  id: unknown;
  constructor: { name: string };
}

function scopeFor(record: AttachedRecord, name: string) {
  return {
    name,
    record_type: record.constructor.name,
    record_id: record.id,
  };
}

/** Shared by the one and many cases. */
abstract class Attached {
  constructor(
    protected readonly record: AttachedRecord,
    readonly name: string,
  ) {}

  protected get scope(): Record<string, unknown> {
    return scopeFor(this.record, this.name);
  }

  /** Whether anything is attached. Rails' `attached?`. */
  async attached(): Promise<boolean> {
    return await Attachment.where(this.scope).exists();
  }

  protected async attachOne(file: UploadedFile): Promise<Attachment> {
    const blob = await createBlob(file);

    return await Attachment.create({
      ...(this.scope as { name: string; record_type: string; record_id: number }),
      blob_id: blob.id,
    });
  }

  /** Deletes the attachments and the bytes behind them. Rails' `purge`. */
  async purge(): Promise<void> {
    const attachments = await Attachment.where(this.scope);

    for (const attachment of attachments) {
      // The blob goes first: an attachment row pointing at bytes that are gone
      // is worse than bytes with no row, because only the first breaks a page.
      const blob = await StorageBlob.find(attachment.blob_id).catch(() => null);
      if (blob) await blob.purge();

      await attachment.destroy();
    }
  }
}

/** Rails' `has_one_attached`. */
export class AttachedOne extends Attached {
  /** Replaces whatever was attached. */
  async attach(file: UploadedFile): Promise<StorageBlob> {
    await this.purge();
    const attachment = await this.attachOne(file);
    return await attachment.blob();
  }

  async blob(): Promise<StorageBlob | null> {
    const attachment = await Attachment.where(this.scope).order("id", "desc").first();
    return attachment ? await attachment.blob() : null;
  }

  async url(options: UrlOptions = {}): Promise<string | null> {
    const blob = await this.blob();
    return blob ? await blob.url(options) : null;
  }

  async download(): Promise<Uint8Array | null> {
    const blob = await this.blob();
    return blob ? await blob.download() : null;
  }
}

/** Rails' `has_many_attached`. */
export class AttachedMany extends Attached {
  /** Adds files, keeping what was already there. */
  async attach(...files: UploadedFile[]): Promise<StorageBlob[]> {
    const blobs: StorageBlob[] = [];

    for (const file of files) {
      const attachment = await this.attachOne(file);
      blobs.push(await attachment.blob());
    }

    return blobs;
  }

  async blobs(): Promise<StorageBlob[]> {
    const attachments = await Attachment.where(this.scope).order("id");
    const ids = attachments.map((attachment) => attachment.blob_id);
    if (ids.length === 0) return [];

    // One query for every blob, not one per attachment.
    const found = await StorageBlob.where({ id: ids });
    const byId = new Map(found.map((blob) => [String(blob.id), blob]));

    // Ordered by when they were attached, which is the order they were listed.
    return ids.map((id) => byId.get(String(id))).filter((blob): blob is StorageBlob => !!blob);
  }

  async count(): Promise<number> {
    return await Attachment.where(this.scope).count();
  }

  async urls(options: UrlOptions = {}): Promise<string[]> {
    const blobs = await this.blobs();
    return await Promise.all(blobs.map((blob) => blob.url(options)));
  }
}

/** Any model class, for declaring an attachment on it. */
type ModelClass = abstract new (...args: never[]) => object;

/** The name an attachment is declared under has to be a declared property. */
type AttachmentName<M extends ModelClass> = keyof InstanceType<M> & string;

function defineAttached<M extends ModelClass>(
  model: M,
  name: AttachmentName<M>,
  build: (record: AttachedRecord, name: string) => Attached,
): void {
  // A getter on the prototype rather than a field: a field would be an own
  // property on every instance, and the Proxy a model is wrapped in resolves
  // attributes only for names the object does not already have.
  Object.defineProperty(model.prototype, name, {
    configurable: true,
    get(this: AttachedRecord) {
      return build(this, name);
    },
  });
}

/**
 * Rails' `has_one_attached :avatar`.
 *
 *     class User extends Model<UserRow>("users") {
 *       declare avatar: AttachedOne
 *       static { hasOneAttached(this, "avatar") }
 *     }
 */
export function hasOneAttached<M extends ModelClass>(model: M, name: AttachmentName<M>): void {
  defineAttached(model, name, (record, attachmentName) => new AttachedOne(record, attachmentName));
}

/** Rails' `has_many_attached :images`. */
export function hasManyAttached<M extends ModelClass>(model: M, name: AttachmentName<M>): void {
  defineAttached(model, name, (record, attachmentName) => new AttachedMany(record, attachmentName));
}
