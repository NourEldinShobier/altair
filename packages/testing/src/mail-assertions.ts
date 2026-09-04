/**
 * Assertions about what an email contains, ported from
 * `ActionMailer::TestHelper` and the part assertions in
 * `actionmailer/test/base_test.rb`.
 *
 * Written against parts rather than fields because that is the level a mistake
 * happens at: a mailer that stopped rendering its HTML template still sends,
 * still has a subject, and still passes every assertion about the text body.
 */

import { AssertionFailed } from "@altair/support";
import { bodyParts, messagePart, messageParts, type MessageFields } from "@altair/mailer";

/** Asserts the message has a part of this content type, and gives it back. */
export function assertPart(message: MessageFields, contentType: string) {
  const part = messagePart(message, contentType);

  if (!part) {
    const present = messageParts(message).map((one) => one.contentType);

    throw new AssertionFailed(
      `Expected a ${contentType} part, got: ${present.join(", ") || "none"}`,
    );
  }

  return part;
}

/** The other way round. Rails' `assert_no_part`. */
export function assertNoPart(message: MessageFields, contentType: string): void {
  if (messagePart(message, contentType)) {
    throw new AssertionFailed(`Expected no ${contentType} part, but there was one`);
  }
}

/**
 * Asserts a part contains something.
 *
 * The content type is required rather than searching every part, because a
 * phrase appearing in the text body and missing from the HTML one is exactly
 * the bug this is for — and a search across both would pass.
 */
export function assertPartContains(
  message: MessageFields,
  contentType: string,
  expected: string | RegExp,
): void {
  const part = assertPart(message, contentType);
  const found =
    typeof expected === "string" ? part.body.includes(expected) : expected.test(part.body);

  if (!found) {
    throw new AssertionFailed(`Expected the ${contentType} part to contain ${String(expected)}`);
  }
}

/** Asserts every body part contains it, whichever the client picks. */
export function assertEveryBodyContains(message: MessageFields, expected: string | RegExp): void {
  const parts = bodyParts(message);

  if (parts.length === 0) throw new AssertionFailed("The message has no body parts");

  for (const part of parts) {
    const found =
      typeof expected === "string" ? part.body.includes(expected) : expected.test(part.body);

    if (!found) {
      throw new AssertionFailed(
        `Expected every body part to contain ${String(expected)}; the ${part.contentType} part does not`,
      );
    }
  }
}

/** Asserts an attachment by filename, and gives it back. */
export function assertAttachment(message: MessageFields, filename: string) {
  const part = messageParts(message).find((one) => one.filename === filename);

  if (!part) {
    const present = messageParts(message)
      .map((one) => one.filename)
      .filter(Boolean);

    throw new AssertionFailed(
      `Expected an attachment named ${filename}, got: ${present.join(", ") || "none"}`,
    );
  }

  return part;
}

/** Rails' `assert_no_attachment`. */
export function assertNoAttachment(message: MessageFields, filename: string): void {
  if (messageParts(message).some((one) => one.filename === filename)) {
    throw new AssertionFailed(`Expected no attachment named ${filename}, but there was one`);
  }
}
