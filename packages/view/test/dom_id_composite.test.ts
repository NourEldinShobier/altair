/**
 * A DOM id built from the whole key, ported from `record_key_for_dom_id` in
 * `actionview/lib/action_view/record_identifier.rb`.
 *
 * Rails takes `to_key` — every column that names one row — checks that all of
 * it is present, and joins it with `_`. This took the `id` column, so on a
 * model that declares `queryConstraints` two tenants' row 5 were both
 * `shop_5`. That is the collision `dom_id` exists to prevent: a Turbo Stream
 * update addressed to one lands on whichever the page rendered.
 *
 * Found by the type-aware lint, which flagged `String(id)` as a value that
 * would stringify as `[object Object]` — right about the coercion and, once
 * followed, about something worse: an array id stringifies as `1,5`, and a
 * comma in an id is legal HTML that reads as two selectors in CSS. The
 * element would be unreachable by the thing the id exists for.
 */

import { describe, expect, it } from "bun:test";
import { domId, domTarget } from "../src/dom.js";

/** A model whose rows are named by a tenant column and an id. */
class Shop {
  static queryConstraintsList = () => ["account_id", "id"];

  constructor(
    readonly account_id: unknown,
    readonly id: unknown,
  ) {}
}

/** An ordinary model, which is every model that does not say otherwise. */
class Post {
  constructor(readonly id: unknown) {}
}

describe("a model with an ordinary key", () => {
  it("is the name and the id", () => {
    expect(domId(new Post(1))).toBe("post_1");
  });

  it("takes a prefix", () => {
    expect(domId(new Post(1), "edit")).toBe("edit_post_1");
  });

  it("is new when there is no id", () => {
    expect(domId(new Post(undefined))).toBe("new_post");
    expect(domId(new Post(null))).toBe("new_post");
    expect(domId(new Post(""))).toBe("new_post");
  });

  it("is new with a prefix too", () => {
    expect(domId(new Post(undefined), "edit")).toBe("edit_new_post");
  });
});

describe("a model keyed by more than one column", () => {
  /** The regression: this used to be `shop_5` for every account. */
  it("names every column of the key", () => {
    expect(domId(new Shop(1, 5))).toBe("shop_1_5");
  });

  it("tells two accounts' rows apart", () => {
    expect(domId(new Shop(1, 5))).not.toBe(domId(new Shop(2, 5)));
  });

  /** Joined with `_`, not the comma an array stringifies to. */
  it("does not put a comma in an id", () => {
    expect(domId(new Shop(1, 5))).not.toContain(",");
  });

  it("takes a prefix", () => {
    expect(domId(new Shop(1, 5), "edit")).toBe("edit_shop_1_5");
  });

  /**
   * Rails' `key.all?`. A half-known key names nothing, so the record is new
   * rather than given an id that cannot be looked up.
   */
  it("is new when any part of the key is missing", () => {
    expect(domId(new Shop(1, undefined))).toBe("new_shop");
    expect(domId(new Shop(undefined, 5))).toBe("new_shop");
    expect(domId(new Shop(null, null))).toBe("new_shop");
  });
});

describe("a stream target", () => {
  it("names the same element the id does", () => {
    expect(domTarget(new Shop(1, 5))).toBe(domId(new Shop(1, 5)));
  });
});

describe("something that is not a model", () => {
  it("still works from a plain object", () => {
    expect(domId({ id: 7 })).toBe("object_7");
  });

  it("is new when a plain object has no id", () => {
    expect(domId({})).toBe("new_object");
  });
});
