/**
 * Asking a model what it has attached, ported from
 * `activestorage/test/models/reflection_test.rb`.
 *
 * The same question association reflection answers, for the same reason: a
 * serializer deciding what to include, a form generator writing a file field,
 * an admin page listing what a record carries.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Model } from "@altair/orm";
import {
  attachmentNames,
  hasManyAttached,
  hasOneAttached,
  reflectOnAllAttachments,
  reflectOnAttachment,
  resetAttachmentReflections,
  type AttachedMany,
  type AttachedOne,
} from "../src/attachment.js";

beforeEach(() => {
  resetAttachmentReflections();
});

function userClass() {
  class User extends Model<{ id: number }>("users") {
    declare avatar: AttachedOne;
    declare images: AttachedMany;
  }
  return User;
}

describe("listing them", () => {
  it("gives every attachment", () => {
    const User = userClass();
    hasOneAttached(User, "avatar");
    hasManyAttached(User, "images");

    expect(reflectOnAllAttachments(User)).toHaveLength(2);
  });

  it("gives their names in declaration order", () => {
    const User = userClass();
    hasOneAttached(User, "avatar");
    hasManyAttached(User, "images");

    expect(attachmentNames(User)).toEqual(["avatar", "images"]);
  });

  it("gives nothing for a model with none", () => {
    class Tag extends Model<{ id: number }>("tags") {}

    expect(reflectOnAllAttachments(Tag)).toEqual([]);
    expect(attachmentNames(Tag)).toEqual([]);
  });
});

describe("asking about one", () => {
  it("reports whether it holds one file or many", () => {
    const User = userClass();
    hasOneAttached(User, "avatar");
    hasManyAttached(User, "images");

    expect(reflectOnAttachment(User, "avatar")?.kind).toBe("hasOneAttached");
    expect(reflectOnAttachment(User, "images")?.kind).toBe("hasManyAttached");
  });

  /** What happens to the bytes on destroy is the part worth being able to ask. */
  it("reports the default dependent behaviour", () => {
    const User = userClass();
    hasOneAttached(User, "avatar");

    expect(reflectOnAttachment(User, "avatar")?.dependent).toBe("purge");
  });

  it("reports an explicit dependent behaviour", () => {
    const User = userClass();
    hasOneAttached(User, "avatar", { dependent: "purgeLater" });

    expect(reflectOnAttachment(User, "avatar")?.dependent).toBe("purgeLater");
  });

  it("reports when nothing is purged", () => {
    const User = userClass();
    hasOneAttached(User, "avatar", { dependent: false });

    expect(reflectOnAttachment(User, "avatar")?.dependent).toBe(false);
  });

  it("names the declared variants", () => {
    const User = userClass();
    hasOneAttached(User, "avatar", {
      variants: { thumb: { resize: [100, 100] }, large: { resize: [800, 800] } },
    });

    expect(reflectOnAttachment(User, "avatar")?.variants).toEqual(["thumb", "large"]);
  });

  it("names none when there are none", () => {
    const User = userClass();
    hasOneAttached(User, "avatar");

    expect(reflectOnAttachment(User, "avatar")?.variants).toEqual([]);
  });

  /** Undefined rather than thrown: a caller asking is prepared for no. */
  it("gives undefined for one that was never declared", () => {
    const User = userClass();
    hasOneAttached(User, "avatar");

    expect(reflectOnAttachment(User, "banner")).toBeUndefined();
  });
});
