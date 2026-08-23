/**
 * Direct uploads.
 *
 * Mirrors activestorage/test/controllers/direct_uploads_controller_test.rb and
 * disk_controller_test.rb. The round trip is done for real — the endpoint is
 * asked for a URL, the bytes are PUT at that URL through `serveDisk`, and the
 * signed id is attached — because every interesting failure here is at a seam
 * between those three, and a test that stubs the seam tests nothing.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Connection, Model, SchemaStatements, setConnection } from "@altair/orm";
import {
  AttachedOne,
  checksumFor,
  configureStorage,
  createDirectUpload,
  createStorageTables,
  DIRECT_UPLOADS_PATH,
  DiskService,
  directUploads,
  hasOneAttached,
  InvalidDirectUpload,
  InvalidSignedId,
  resetStorage,
  serveDisk,
  StorageBlob,
  storageService,
} from "../src/index.js";

interface UserRow {
  id: number;
  name: string;
}

class User extends Model<UserRow>("users") {
  declare avatar: AttachedOne;
  static {
    hasOneAttached(this, "avatar");
  }
}

const SECRET = "a".repeat(32);
const payload = new TextEncoder().encode("the actual bytes of the file");
const digest = checksumFor(payload);

let root: string;
let disk: DiskService;

/** The endpoint, as a plain function of a request. */
const endpoint = directUploads();
const post = (blob: unknown) =>
  endpoint(
    new Request(`http://test${DIRECT_UPLOADS_PATH}`, {
      method: "POST",
      body: JSON.stringify({ blob }),
    }),
    () => new Response("fell through", { status: 404 }),
  );

const declared = {
  filename: "notes.txt",
  byte_size: payload.byteLength,
  checksum: digest,
  content_type: "text/plain",
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "altair-direct-"));
  disk = new DiskService({ root, secret: SECRET });
  configureStorage({ services: { disk }, default: "disk", secret: SECRET });

  const connection = new Connection("sqlite://:memory:");
  setConnection(connection);
  StorageBlob.columnCache = undefined;
  StorageBlob.columnTypeCache = undefined;

  const schema = new SchemaStatements(connection);
  await createStorageTables(schema);
  await schema.createTable("users", (t) => {
    t.string("name");
  });
});

afterEach(async () => {
  resetStorage();
  await rm(root, { recursive: true, force: true });
});

describe("asking for somewhere to upload", () => {
  it("records the blob before the bytes exist", async () => {
    const { blob } = await createDirectUpload(declared);

    expect(blob.id).toBeGreaterThan(0);
    expect(blob.filename).toBe("notes.txt");
    expect(blob.byte_size).toBe(payload.byteLength);
    // The row is there; the file is not, until the browser sends it.
    expect(await storageService("disk").exists(blob.key as string)).toBe(false);
  });

  it("answers with the fields Rails answers with", async () => {
    const { response } = await createDirectUpload(declared);

    expect(Object.keys(response).sort()).toEqual([
      "byte_size",
      "checksum",
      "content_type",
      "direct_upload",
      "filename",
      "id",
      "key",
      "metadata",
      "signed_id",
    ]);
    expect(response.direct_upload.url).toStartWith("/storage/");
    expect(response.direct_upload.headers["content-type"]).toBe("text/plain");
  });

  it("guesses the content type when the client does not say", async () => {
    const { blob } = await createDirectUpload({ ...declared, content_type: undefined });
    expect(blob.content_type).toBe("text/plain;charset=utf-8");
  });

  it("keeps metadata the client sent", async () => {
    const { response } = await createDirectUpload({ ...declared, metadata: { identified: true } });
    expect(response.metadata).toEqual({ identified: true });
  });
});

describe("what it refuses", () => {
  it("refuses a file with no name", async () => {
    await expect(createDirectUpload({ ...declared, filename: "" })).rejects.toThrow(
      InvalidDirectUpload,
    );
  });

  // Without a digest the size is the only thing bounding what turns up, and a
  // signed URL with no digest is a signed URL for arbitrary content.
  it("refuses a file with no checksum", async () => {
    await expect(createDirectUpload({ ...declared, checksum: "" })).rejects.toThrow(
      InvalidDirectUpload,
    );
  });

  it("refuses a negative or fractional size", async () => {
    await expect(createDirectUpload({ ...declared, byte_size: -1 })).rejects.toThrow(
      InvalidDirectUpload,
    );
    await expect(createDirectUpload({ ...declared, byte_size: 1.5 })).rejects.toThrow(
      InvalidDirectUpload,
    );
  });

  it("enforces a ceiling when it is given one", async () => {
    await expect(createDirectUpload(declared, { maxByteSize: 4 })).rejects.toThrow(
      /the limit is 4/,
    );
  });

  it("leaves no blob behind when it refuses", async () => {
    await createDirectUpload({ ...declared, filename: "" }).catch(() => undefined);
    expect(await StorageBlob.count()).toBe(0);
  });
});

describe("the endpoint", () => {
  it("answers a well-formed request", async () => {
    const response = await post(declared);

    expect(response.status).toBe(200);
    expect(((await response.json()) as { signed_id: string }).signed_id).toBeTruthy();
  });

  it("answers 422 for parameters it cannot act on", async () => {
    const response = await post({ ...declared, checksum: "" });

    expect(response.status).toBe(422);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining("checksum"),
    });
  });

  it("answers 422 for a body that is not the shape asked for", async () => {
    const response = await endpoint(
      new Request(`http://test${DIRECT_UPLOADS_PATH}`, { method: "POST", body: "not json" }),
      () => new Response("fell through", { status: 404 }),
    );

    expect(response.status).toBe(422);
  });

  it("passes anything else along", async () => {
    const response = await endpoint(
      new Request("http://test/posts", { method: "POST" }),
      () => new Response("fell through", { status: 404 }),
    );

    expect(await response.text()).toBe("fell through");
  });

  // An endpoint that mints signed upload URLs for anyone who asks is a way to
  // pay for someone else's file hosting.
  it("can be closed to requests that are not allowed to upload", async () => {
    const guarded = directUploads({ authorize: () => false });
    const response = await guarded(
      new Request(`http://test${DIRECT_UPLOADS_PATH}`, {
        method: "POST",
        body: JSON.stringify({ blob: declared }),
      }),
      () => new Response("fell through"),
    );

    expect(response.status).toBe(403);
    expect(await StorageBlob.count()).toBe(0);
  });
});

describe("uploading to the url it gave", () => {
  const handler = () => serveDisk(disk);
  const put = (url: string, body: Uint8Array | string) =>
    handler()(
      new Request(`http://test${url}`, { method: "PUT", body }),
      () => new Response("fell through", { status: 404 }),
    );

  it("stores the bytes", async () => {
    const { blob, response } = await createDirectUpload(declared);
    const uploaded = await put(response.direct_upload.url, payload);

    expect(uploaded.status).toBe(204);
    expect(await blob.download()).toEqual(payload);
  });

  // The size and digest were signed when the upload was authorised, so bytes
  // that do not match them are not the bytes the URL was issued for.
  it("refuses bytes of a different length", async () => {
    const { response } = await createDirectUpload(declared);
    const uploaded = await put(response.direct_upload.url, "short");

    expect(uploaded.status).toBe(422);
  });

  it("refuses bytes with the wrong digest", async () => {
    const { response } = await createDirectUpload(declared);
    const tampered = new Uint8Array(payload);
    tampered[0] = 0;

    expect((await put(response.direct_upload.url, tampered)).status).toBe(422);
  });

  it("refuses a token it did not sign", async () => {
    expect((await put("/storage/made-up-token", payload)).status).toBe(404);
  });

  // A link that lets someone read a file must not let them replace it.
  it("refuses to upload through a download token", async () => {
    const { blob } = await createDirectUpload(declared);
    const readUrl = new URL(await blob.url(), "http://test");

    expect((await put(readUrl.pathname, payload)).status).toBe(404);
  });

  it("refuses to download through an upload token", async () => {
    const { response } = await createDirectUpload(declared);
    await put(response.direct_upload.url, payload);

    const read = await handler()(
      new Request(`http://test${response.direct_upload.url}`),
      () => new Response("fell through", { status: 404 }),
    );

    expect(read.status).toBe(404);
  });

  it("stops honouring the url once it has expired", async () => {
    const { response } = await createDirectUpload(declared, { expiresIn: -1 });
    expect((await put(response.direct_upload.url, payload)).status).toBe(404);
  });
});

describe("signed ids", () => {
  it("name the blob they were made from", async () => {
    const { blob } = await createDirectUpload(declared);
    const found = await StorageBlob.findSigned(blob.signedId());

    expect(found?.id).toBe(blob.id);
  });

  // A signed id is authenticated, not secret: the id is readable in it, and
  // that is fine. What a form cannot do is name a blob the server never signed
  // for it, which is the whole reason a raw primary key will not do.
  it("cannot be re-signed for another blob", async () => {
    const { blob } = await createDirectUpload(declared);
    const other = await createDirectUpload({ ...declared, filename: "other.txt" });

    const [body, signature] = blob.signedId().split("--") as [string, string];
    const swapped = Buffer.from(
      JSON.stringify({
        value: { id: other.blob.id },
        purpose: "altair.storage.blob",
      }),
    ).toString("base64url");

    expect(Buffer.from(body, "base64url").toString()).toContain(String(blob.id));
    expect(await StorageBlob.findSigned(`${swapped}--${signature}`)).toBeNull();
  });

  it("refuse an id nobody signed", async () => {
    expect(await StorageBlob.findSigned("1--nonsense")).toBeNull();
  });

  it("refuse a tampered id", async () => {
    const { blob } = await createDirectUpload(declared);
    const signed = blob.signedId();

    expect(await StorageBlob.findSigned(`x${signed}`)).toBeNull();
  });

  it("expire when told to", async () => {
    const { blob } = await createDirectUpload(declared);
    expect(await StorageBlob.findSigned(blob.signedId({ expiresIn: -1 }))).toBeNull();
  });
});

describe("attaching what was uploaded", () => {
  it("attaches by signed id", async () => {
    const user = await User.create({ name: "ada" });
    const { blob, response } = await createDirectUpload(declared);
    await serveDisk(disk)(
      new Request(`http://test${response.direct_upload.url}`, { method: "PUT", body: payload }),
      () => new Response("fell through"),
    );

    await user.avatar.attach(response.signed_id);

    expect((await user.avatar.blob())?.id).toBe(blob.id);
    expect(await user.avatar.download()).toEqual(payload);
  });

  it("attaches a blob it is handed directly", async () => {
    const user = await User.create({ name: "ada" });
    const { blob } = await createDirectUpload(declared);

    await user.avatar.attach(blob);
    expect((await user.avatar.blob())?.id).toBe(blob.id);
  });

  it("refuses an id it did not sign", async () => {
    const user = await User.create({ name: "ada" });

    await expect(user.avatar.attach("not-a-signed-id")).rejects.toThrow(InvalidSignedId);
  });

  // Resolving before purging: a bad id should leave the record with the file
  // it already had, not with nothing.
  it("keeps the existing attachment when the new id is bad", async () => {
    const user = await User.create({ name: "ada" });
    await user.avatar.attach({ filename: "old.txt", data: payload, contentType: "text/plain" });

    await user.avatar.attach("not-a-signed-id").catch(() => undefined);

    expect((await user.avatar.blob())?.filename).toBe("old.txt");
  });
});
