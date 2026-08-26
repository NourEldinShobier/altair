/**
 * Attachments.
 *
 * Mirrors activestorage/test/models/attached/one_test.rb and many_test.rb. The
 * case that carries its weight is two models with the same id: one table joins
 * every model in the application to its files, so the record's class has to be
 * part of every lookup.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Connection, Model, SchemaStatements, setConnection } from "@altair/orm";
import {
  Attachment,
  AttachedMany,
  AttachedOne,
  configureStorage,
  createStorageTables,
  DiskService,
  hasManyAttached,
  hasOneAttached,
  resetStorage,
  StorageBlob,
  storageService,
} from "../src/index.js";

interface UserRow {
  id: number;
  name: string;
}

class User extends Model<UserRow>("users") {
  declare avatar: AttachedOne;
  declare documents: AttachedMany;

  static {
    hasOneAttached(this, "avatar");
    hasManyAttached(this, "documents");
  }
}

/** A second model, to prove one table can serve both without collision. */
class Team extends Model<UserRow>("teams") {
  declare avatar: AttachedOne;

  static {
    hasOneAttached(this, "avatar");
  }
}

/** For the case where the files outlive the record on purpose. */
class Archive extends Model<UserRow>("archives") {
  declare avatar: AttachedOne;

  static {
    hasOneAttached(this, "avatar", { dependent: false });
  }
}

let root: string;
let connection: Connection;

const file = (name: string, text: string) => ({
  filename: name,
  data: new TextEncoder().encode(text),
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "altair-attach-"));
  configureStorage({ services: { disk: new DiskService({ root }) }, default: "disk" });

  connection = new Connection("sqlite://:memory:");
  setConnection(connection);

  for (const model of [StorageBlob, Attachment, User, Team, Archive]) {
    model.columnCache = undefined;
    model.columnTypeCache = undefined;
  }

  const schema = new SchemaStatements(connection);
  await createStorageTables(schema);
  await schema.createTable("users", (t) => t.string("name"));
  await schema.createTable("teams", (t) => t.string("name"));
  await schema.createTable("archives", (t) => t.string("name"));
});

afterEach(async () => {
  resetStorage();
  await rm(root, { recursive: true, force: true });
});

describe("one attachment", () => {
  it("starts with nothing attached", async () => {
    const user = await User.create({ name: "Ada" });

    expect(await user.avatar.attached()).toBe(false);
    expect(await user.avatar.blob()).toBeNull();
    expect(await user.avatar.url()).toBeNull();
  });

  it("attaches a file", async () => {
    const user = await User.create({ name: "Ada" });
    const blob = await user.avatar.attach(file("face.png", "pixels"));

    expect(blob.filename).toBe("face.png");
    expect(await user.avatar.attached()).toBe(true);
  });

  it("reads the bytes back", async () => {
    const user = await User.create({ name: "Ada" });
    await user.avatar.attach(file("face.png", "pixels"));

    expect(new TextDecoder().decode((await user.avatar.download())!)).toBe("pixels");
  });

  // Rails replaces rather than accumulates: `has_one_attached` means one.
  it("replaces what was there", async () => {
    const user = await User.create({ name: "Ada" });
    await user.avatar.attach(file("first.png", "one"));
    await user.avatar.attach(file("second.png", "two"));

    expect((await user.avatar.blob())!.filename).toBe("second.png");
    expect(await Attachment.count()).toBe(1);
    expect(await StorageBlob.count()).toBe(1);
  });

  // Replacing must take the old bytes with it, or a bucket fills with files no
  // row remembers.
  it("purges the bytes it replaced", async () => {
    const user = await User.create({ name: "Ada" });
    const first = await user.avatar.attach(file("first.png", "one"));
    const key = first.key as string;

    await user.avatar.attach(file("second.png", "two"));

    expect(await storageService("disk").exists(key)).toBe(false);
  });

  it("purges", async () => {
    const user = await User.create({ name: "Ada" });
    const blob = await user.avatar.attach(file("face.png", "pixels"));
    const key = blob.key as string;

    await user.avatar.purge();

    expect(await user.avatar.attached()).toBe(false);
    expect(await Attachment.count()).toBe(0);
    expect(await StorageBlob.count()).toBe(0);
    expect(await storageService("disk").exists(key)).toBe(false);
  });

  it("gives a url once something is attached", async () => {
    const user = await User.create({ name: "Ada" });
    await user.avatar.attach(file("face.png", "pixels"));

    expect(await user.avatar.url()).toStartWith("/storage/");
  });
});

describe("many attachments", () => {
  it("starts empty", async () => {
    const user = await User.create({ name: "Ada" });

    expect(await user.documents.blobs()).toEqual([]);
    expect(await user.documents.count()).toBe(0);
  });

  it("keeps everything attached", async () => {
    const user = await User.create({ name: "Ada" });

    await user.documents.attach(file("a.txt", "one"));
    await user.documents.attach(file("b.txt", "two"));

    expect((await user.documents.blobs()).map((blob) => blob.filename)).toEqual(["a.txt", "b.txt"]);
  });

  it("attaches several at once", async () => {
    const user = await User.create({ name: "Ada" });
    const blobs = await user.documents.attach(file("a.txt", "one"), file("b.txt", "two"));

    expect(blobs).toHaveLength(2);
    expect(await user.documents.count()).toBe(2);
  });

  it("returns them in the order they were attached", async () => {
    const user = await User.create({ name: "Ada" });
    for (const name of ["c.txt", "a.txt", "b.txt"]) await user.documents.attach(file(name, name));

    expect((await user.documents.blobs()).map((blob) => blob.filename)).toEqual([
      "c.txt",
      "a.txt",
      "b.txt",
    ]);
  });

  it("gives a url for each", async () => {
    const user = await User.create({ name: "Ada" });
    await user.documents.attach(file("a.txt", "one"), file("b.txt", "two"));

    const urls = await user.documents.urls();
    expect(urls).toHaveLength(2);
    expect(urls.every((url) => url.startsWith("/storage/"))).toBe(true);
  });

  it("purges all of them", async () => {
    const user = await User.create({ name: "Ada" });
    const blobs = await user.documents.attach(file("a.txt", "one"), file("b.txt", "two"));

    await user.documents.purge();

    expect(await user.documents.count()).toBe(0);
    expect(await StorageBlob.count()).toBe(0);
    for (const blob of blobs) {
      expect(await storageService("disk").exists(blob.key as string)).toBe(false);
    }
  });
});

describe("keeping records apart", () => {
  it("keeps one record's files from another's", async () => {
    const ada = await User.create({ name: "Ada" });
    const alan = await User.create({ name: "Alan" });

    await ada.avatar.attach(file("ada.png", "a"));
    await alan.avatar.attach(file("alan.png", "b"));

    expect((await ada.avatar.blob())!.filename).toBe("ada.png");
    expect((await alan.avatar.blob())!.filename).toBe("alan.png");
  });

  // One table joins every model in the application, so two records with the
  // same id in different tables are the case that breaks a lookup keyed on id
  // alone — and for two tables counting from 1, that is the first record of
  // each.
  it("keeps two models with the same id apart", async () => {
    const user = await User.create({ name: "Ada" });
    const team = await Team.create({ name: "Analytical" });

    expect(user.id).toBe(team.id);

    await user.avatar.attach(file("user.png", "u"));
    await team.avatar.attach(file("team.png", "t"));

    expect((await user.avatar.blob())!.filename).toBe("user.png");
    expect((await team.avatar.blob())!.filename).toBe("team.png");
  });

  // Two attachments on the same record are told apart by name.
  it("keeps two attachment names on one record apart", async () => {
    const user = await User.create({ name: "Ada" });

    await user.avatar.attach(file("face.png", "one"));
    await user.documents.attach(file("cv.pdf", "two"));

    expect((await user.avatar.blob())!.filename).toBe("face.png");
    expect((await user.documents.blobs()).map((blob) => blob.filename)).toEqual(["cv.pdf"]);
  });

  it("purges only the name it was asked for", async () => {
    const user = await User.create({ name: "Ada" });
    await user.avatar.attach(file("face.png", "one"));
    await user.documents.attach(file("cv.pdf", "two"));

    await user.avatar.purge();

    expect(await user.avatar.attached()).toBe(false);
    expect(await user.documents.count()).toBe(1);
  });
});

describe("the attachment record", () => {
  it("points at its blob", async () => {
    const user = await User.create({ name: "Ada" });
    await user.avatar.attach(file("face.png", "pixels"));

    const attachment = (await Attachment.all())[0]!;

    expect(attachment.name).toBe("avatar");
    expect(attachment.record_type).toBe("User");
    expect(attachment.record_id).toBe(user.id);
    expect((await attachment.blob()).filename).toBe("face.png");
  });
});

/**
 * What happens to the files when the record goes.
 *
 * Nothing did. Destroying a user left the attachment row, the blob row, and
 * the bytes — so a deleted person's avatar stayed downloadable by anyone
 * holding the key, and the bill for storing it went on arriving. Rails purges
 * on destroy and has since Active Storage shipped.
 */
describe("destroying the record", () => {
  it("takes the attachment, the blob, and the bytes with it", async () => {
    const user = await User.create({ name: "Ada" });
    await user.avatar.attach(file("avatar.png", "pixels"));

    const blob = (await user.avatar.blob()) as StorageBlob;
    const key = blob.key as string;

    await user.destroy();

    expect(await Attachment.count()).toBe(0);
    expect(await StorageBlob.count()).toBe(0);
    expect(await storageService().exists(key)).toBe(false);
  });

  it("takes all of them when there are many", async () => {
    const user = await User.create({ name: "Ada" });
    await user.documents.attach(file("a.txt", "one"), file("b.txt", "two"));

    const keys = (await user.documents.blobs()).map((blob) => blob.key as string);
    expect(keys).toHaveLength(2);

    await user.destroy();

    expect(await StorageBlob.count()).toBe(0);
    for (const key of keys) expect(await storageService().exists(key)).toBe(false);
  });

  it("leaves another record's files alone", async () => {
    const ada = await User.create({ name: "Ada" });
    const grace = await User.create({ name: "Grace" });

    await ada.avatar.attach(file("ada.png", "one"));
    await grace.avatar.attach(file("grace.png", "two"));

    await ada.destroy();

    expect(await grace.avatar.attached()).toBe(true);
    expect(await StorageBlob.count()).toBe(1);
  });

  // Several records sharing a blob, or files something outside the
  // application owns.
  it("keeps them when the declaration says to", async () => {
    const archive = await Archive.create({ name: "Old" });
    await archive.avatar.attach(file("keep.txt", "kept"));

    const key = ((await archive.avatar.blob()) as StorageBlob).key as string;

    await archive.destroy();

    expect(await StorageBlob.count()).toBe(1);
    expect(await storageService().exists(key)).toBe(true);
  });

  /**
   * Deleting the bytes is the one step no rollback can undo, so it waits for
   * the commit. Purging on `after_destroy` instead would delete the files of
   * a record that is still there.
   */
  it("does not touch them when the transaction rolls back", async () => {
    const user = await User.create({ name: "Ada" });
    await user.avatar.attach(file("avatar.png", "pixels"));
    const key = ((await user.avatar.blob()) as StorageBlob).key as string;

    await User.transaction(async () => {
      await user.destroy();
      throw new Error("changed my mind");
    }).catch(() => undefined);

    expect(await storageService().exists(key)).toBe(true);
    expect(await StorageBlob.count()).toBe(1);
  });
});
