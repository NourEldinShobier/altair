/**
 * Storage mounted on a real application.
 *
 * `serveDisk` had tests, and every one of them called it directly. Nothing
 * ever put it on an application, so `blob.url()` handed back a path that
 * nothing answered — which is a 404 an application only finds out about by
 * clicking one of its own links.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "@altair/core";
import { Connection, SchemaStatements, setConnection } from "@altair/orm";
import {
  configureStorage,
  createBlob,
  createStorageTables,
  DiskService,
  resetStorage,
  S3Service,
  StorageBlob,
  storageProvider,
} from "../src/index.js";

let root: string;
let connection: Connection;

const application = async (options: Parameters<typeof storageProvider>[0] = {}) => {
  const app = createApplication({
    routes: () => undefined,
    providers: [storageProvider(options)],
    secretKeyBase: "x".repeat(64),
    database: { url: "sqlite://:memory:" },
  });

  await app.boot();

  // Booting connects the application's own database. The blobs in these cases
  // live in the one the suite set up, so it goes back afterwards.
  setConnection(connection);

  return app;
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "altair-provider-"));
  configureStorage({
    services: { disk: new DiskService({ root, secret: "a".repeat(32) }) },
    default: "disk",
    // Signs the blob ids a direct upload hands back. Without it the endpoint
    // refuses rather than minting an unsigned id, which would let a form
    // attach any file in the table.
    secret: "b".repeat(32),
  });

  connection = new Connection("sqlite://:memory:");
  setConnection(connection);
  StorageBlob.columnCache = undefined;
  StorageBlob.columnTypeCache = undefined;

  await createStorageTables(new SchemaStatements(connection));
});

afterEach(async () => {
  resetStorage();
  await rm(root, { recursive: true, force: true });
});

describe("a disk service on an application", () => {
  it("answers the URL a blob hands out", async () => {
    const app = await application();
    const blob = await createBlob({
      filename: "hello.txt",
      data: new TextEncoder().encode("the bytes"),
    });

    const response = await app.handler()(new Request(`https://app.example${await blob.url()}`));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("the bytes");
  });

  it("sends the filename it was asked for", async () => {
    const app = await application();
    const blob = await createBlob({
      filename: "report.pdf",
      data: new TextEncoder().encode("%PDF-1.4"),
    });

    const response = await app.handler()(new Request(`https://app.example${await blob.url()}`));

    expect(response.headers.get("content-disposition")).toContain("report.pdf");
  });

  // The signature is the only thing between a key and the file behind it.
  it("refuses a URL that has been edited", async () => {
    const app = await application();
    const blob = await createBlob({
      filename: "secret.txt",
      data: new TextEncoder().encode("private"),
    });

    const url = await blob.url();
    const tampered = url.replace(/\/storage\/./, "/storage/A");

    // Both ends asserted: a 404 for the tampered URL means nothing unless the
    // untampered one is a 200, since an unmounted service 404s either way.
    expect((await app.handler()(new Request(`https://app.example${url}`))).status).toBe(200);
    expect((await app.handler()(new Request(`https://app.example${tampered}`))).status).not.toBe(
      200,
    );
  });

  it("leaves everything else to the application", async () => {
    const app = await application();

    expect((await app.handler()(new Request("https://app.example/nothing"))).status).toBe(404);
  });
});

describe("a bucket", () => {
  it("mounts nothing, because it answers its own URLs", async () => {
    configureStorage({
      services: { s3: new S3Service({ bucket: "files", region: "us-east-1" }) },
      default: "s3",
    });

    const app = await application();

    expect(app.middleware.names).not.toContain("storage");
  });
});

/**
 * The endpoint that hands a browser a signed URL to PUT a file to.
 *
 * Written and tested and mounted nowhere, so a direct upload could not start.
 * It stays opt-in rather than joining the default, and it takes an `authorize`
 * because there is no safe default: an endpoint that mints signed upload URLs
 * for anyone who asks is a way to pay for someone else's file hosting.
 */
describe("direct uploads", () => {
  const upload = (app: { handler(): (request: Request) => Promise<Response> }) =>
    app.handler()(
      new Request("https://app.example/rails/active_storage/direct_uploads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          blob: { filename: "a.txt", byte_size: 9, content_type: "text/plain", checksum: "x" },
        }),
      }),
    );

  it("is not there unless the application asks for it", async () => {
    expect((await upload(await application())).status).toBe(404);
  });

  it("answers with somewhere to put the file", async () => {
    const app = await application({ directUploads: { authorize: () => true } });
    const response = await upload(app);

    expect(response.status).toBe(200);

    const body = (await response.json()) as { direct_upload: { url: string } };
    expect(body.direct_upload.url).toContain("/storage/");
  });

  // The whole reason `authorize` has no default.
  it("refuses when the application says no", async () => {
    const app = await application({ directUploads: { authorize: () => false } });

    expect((await upload(app)).status).toBe(403);
  });
});
