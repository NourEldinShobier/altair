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

const application = async () => {
  const app = createApplication({
    routes: () => undefined,
    providers: [storageProvider()],
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
