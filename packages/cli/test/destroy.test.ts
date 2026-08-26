/**
 * `altair destroy`, the other half of `altair generate`.
 *
 * Mirrors what railties/test/generators covers for `rails destroy`: the point
 * is that it removes exactly what the generator wrote, including the files a
 * generator gained after the destroy command was written.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generate } from "../src/commands.js";
import { destroy } from "../src/destroy.js";

let root: string;

/** Runs a generator for real, so there is something to remove. */
const generated = async (kind: string, name: string, fields: string[] = []) => {
  const files = generate(kind, name, fields);

  for (const file of files) {
    const path = join(root, file.path);
    mkdirSync(dirname(path), { recursive: true });
    await Bun.write(path, file.contents);
  }

  return files.map((file) => file.path);
};

const exists = (path: string) => Bun.file(join(root, path)).exists();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "altair-destroy-"));
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Left for the OS to sweep.
  }
});

describe("undoing a generator", () => {
  it("removes the model and its migration", async () => {
    const written = await generated("model", "Widget", ["title:string"]);

    for (const path of written) expect(await exists(path)).toBe(true);

    await destroy("model", "Widget", ["title:string"], root);

    for (const path of written) expect(await exists(path)).toBe(false);
  });

  /**
   * The version is the time the generator ran, so asking it again produces a
   * different file name than the one on disk. Matching on what follows the
   * version is the only way to find it.
   */
  it("finds the migration even though its version has moved on", async () => {
    const written = await generated("model", "Widget");
    const generatedPath = written.find((path) => path.startsWith("db/migrate/")) as string;

    // Renamed to the version it would have had yesterday. Without this the
    // case proves nothing: both calls land in the same second, so the name the
    // generator produces the second time is the name already on disk, and a
    // destroy that ignored the version entirely would still pass.
    const onDisk = generatedPath.replace(/\/\d+_/, "/20260101000001_");

    await Bun.write(join(root, onDisk), await Bun.file(join(root, generatedPath)).text());
    rmSync(join(root, generatedPath));

    const removals = await destroy("model", "Widget", [], root);

    expect(await exists(onDisk)).toBe(false);
    expect(removals.some((removal) => removal.path === onDisk && removal.removed)).toBe(true);
  });

  // The generator gained a preview today. A destroy keeping its own list of
  // what a mailer writes would have missed it.
  it("removes everything the generator writes now, not what it wrote once", async () => {
    const written = await generated("mailer", "Notifier", ["welcome"]);

    expect(written).toContain("test/mailers/previews/notifier_mailer_preview.ts");

    await destroy("mailer", "Notifier", ["welcome"], root);

    for (const path of written) expect(await exists(path)).toBe(false);
  });

  it("removes a scaffold whole", async () => {
    const written = await generated("scaffold", "Post", ["title:string"]);

    await destroy("scaffold", "Post", ["title:string"], root);

    for (const path of written) expect(await exists(path)).toBe(false);
  });

  /**
   * Reported rather than removed in silence. A file that was not there almost
   * always means the name being typed is not the name it was generated under,
   * and a command that says "done" leaves somebody looking for files that are
   * still where they were.
   */
  it("says which files were not there", async () => {
    const removals = await destroy("model", "Ghost", [], root);

    expect(removals.every((removal) => !removal.removed)).toBe(true);
    expect(removals.length).toBeGreaterThan(0);
  });

  it("leaves another model alone", async () => {
    const widget = await generated("model", "Widget");
    await generated("model", "Gadget");

    await destroy("model", "Gadget", [], root);

    for (const path of widget) expect(await exists(path)).toBe(true);
  });
});
