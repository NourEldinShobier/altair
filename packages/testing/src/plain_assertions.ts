/**
 * The small assertions Rails adds to every test case.
 *
 * Each exists because the version people write inline reports badly. A bare
 * `expect(x).toBe(false)` that fails says "expected false, got true", which
 * names neither what was being asked nor what it was asked about.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AssertionFailed } from "@altair/support";

/** Asserts the value is falsy. Rails' `assert_not`. */
export function assertNot(value: unknown, message?: string): void {
  if (value) {
    throw new AssertionFailed(message ?? `Expected ${String(value)} to be falsy`);
  }
}

/**
 * Asserts the block throws, and hands the error back.
 *
 * The handing back is the point, and the reason to prefer this over a bare
 * expect-to-throw: the assertions that matter are usually about the error —
 * its message, its code, which record it names — and catching it yourself to
 * check those means writing the did-it-actually-throw guard by hand every time.
 */
export async function assertRaises<E extends Error = Error>(
  body: () => unknown,
  expected?: (new (...args: never[]) => E) | RegExp,
): Promise<E> {
  let raised: unknown;
  let threw = false;

  try {
    await body();
  } catch (error) {
    threw = true;
    raised = error;
  }

  if (!threw) throw new AssertionFailed("Expected the block to throw, and it did not");

  if (expected instanceof RegExp) {
    const message = raised instanceof Error ? raised.message : String(raised);

    if (!expected.test(message)) {
      throw new AssertionFailed(`Expected the error message to match ${expected}, got: ${message}`);
    }
  } else if (expected && !(raised instanceof expected)) {
    throw new AssertionFailed(
      `Expected a ${expected.name}, got ${(raised as { constructor?: { name?: string } })?.constructor?.name ?? String(raised)}`,
    );
  }

  return raised as E;
}

/** Where `fileFixture` looks, relative to the working directory. */
let fixturePath = join("test", "fixtures", "files");

export function setFileFixturePath(path: string): void {
  fixturePath = path;
}

/**
 * A file from the fixtures directory. Rails' `file_fixture`.
 *
 * For the tests that need a real file rather than a made-up buffer — an upload,
 * a parser, an importer. Reading it through one helper means the path appears
 * once, so moving the directory is one edit rather than a search.
 */
export async function fileFixture(name: string): Promise<Buffer> {
  return await readFile(join(fixturePath, name));
}

/** The same, as text. */
export async function fileFixtureText(name: string): Promise<string> {
  return await readFile(join(fixturePath, name), "utf8");
}

/**
 * Asserts the response body contains this. Rails' `assert_in_body`.
 *
 * The body is consumed from a clone, so the caller can still read it — a
 * `Response` body reads once, and an assertion that quietly emptied it would
 * make the next line in the test fail for an unrelated-looking reason.
 */
export async function assertInBody(response: Response, expected: string | RegExp): Promise<void> {
  const body = await response.clone().text();
  const found = typeof expected === "string" ? body.includes(expected) : expected.test(body);

  if (!found) {
    throw new AssertionFailed(`Expected the body to contain ${String(expected)}`);
  }
}

/** The other way round. Rails' `assert_not_in_body`. */
export async function assertNotInBody(
  response: Response,
  expected: string | RegExp,
): Promise<void> {
  const body = await response.clone().text();
  const found = typeof expected === "string" ? body.includes(expected) : expected.test(body);

  if (found) {
    throw new AssertionFailed(`Expected the body not to contain ${String(expected)}`);
  }
}
