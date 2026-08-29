/**
 * Requiring and permitting in one call, ported from
 * `actionpack/test/controller/parameters/expect_test.rb` (Rails 8).
 *
 * The shape check is why this exists rather than being sugar for
 * `require(...).permit(...)`. A form posts `post[title]=x` and the parameter is
 * an object; a request built by hand posts `post[]=x` and it is an array.
 * `require("post").permit("title")` was happy with either, so a controller that
 * expected one object could be handed a list of them and pass it to `update` —
 * a way of writing attributes the form never offered.
 */

import { describe, expect as check, it } from "bun:test";
import { ParameterMissing, Parameters } from "../src/parameters.js";

const params = (raw: Record<string, unknown>) => new Parameters(raw);

describe("a scalar", () => {
  it("comes back as itself", () => {
    check(params({ id: "7" }).expect("id")).toBe("7");
  });

  it("is required", () => {
    check(() => params({}).expect("id")).toThrow(ParameterMissing);
  });

  it("is missing rather than empty", () => {
    check(() => params({ id: "" }).expect("id")).toThrow(ParameterMissing);
  });

  /**
   * The attack this closes. `params.expect("id")` on `?id[]=1&id[]=2` used to
   * hand back an array, and everything downstream treated it as one value.
   */
  it("refuses an array pretending to be one", () => {
    check(() => params({ id: ["1", "2"] }).expect("id")).toThrow(ParameterMissing);
  });

  it("refuses an object pretending to be one", () => {
    check(() => params({ id: { a: 1 } }).expect("id")).toThrow(ParameterMissing);
  });
});

describe("an object with named keys", () => {
  it("comes back permitted", () => {
    const post = params({ post: { title: "A", body: "B" } }).expect({
      post: ["title", "body"],
    }) as Parameters;

    check(post.toObject()).toEqual({ title: "A", body: "B" });
  });

  it("drops what was not asked for", () => {
    const post = params({ post: { title: "A", admin: true } }).expect({
      post: ["title"],
    }) as Parameters;

    check(post.toObject()).toEqual({ title: "A" });
  });

  it("is required", () => {
    check(() => params({}).expect({ post: ["title"] })).toThrow(ParameterMissing);
  });

  /**
   * The one that matters. An array here is a request that was not built by the
   * form, and handing it to `update` writes attributes the form never offered.
   */
  it("refuses an array where an object was asked for", () => {
    check(() => params({ post: [{ title: "A" }] }).expect({ post: ["title"] })).toThrow(
      ParameterMissing,
    );
  });

  it("refuses a scalar where an object was asked for", () => {
    check(() => params({ post: "A" }).expect({ post: ["title"] })).toThrow(ParameterMissing);
  });
});

describe("an array of scalars", () => {
  it("comes back as an array", () => {
    check(params({ emails: ["a@b.com", "c@d.com"] }).expect({ emails: [] })).toEqual([
      "a@b.com",
      "c@d.com",
    ]);
  });

  it("drops an object hiding among the scalars", () => {
    check(params({ emails: ["a@b.com", { evil: true }] }).expect({ emails: [] })).toEqual([
      "a@b.com",
    ]);
  });

  it("refuses a scalar where an array was asked for", () => {
    check(() => params({ emails: "a@b.com" }).expect({ emails: [] })).toThrow(ParameterMissing);
  });
});

describe("an array of objects", () => {
  it("permits each of them", () => {
    const friends = params({
      friends: [
        { name: "André", admin: true },
        { name: "Kewe", admin: true },
      ],
    }).expect({ friends: [["name"]] }) as Parameters[];

    check(friends.map((one) => one.toObject())).toEqual([{ name: "André" }, { name: "Kewe" }]);
  });

  it("refuses a bare object where a list was asked for", () => {
    check(() => params({ friends: { name: "A" } }).expect({ friends: [["name"]] })).toThrow(
      ParameterMissing,
    );
  });

  it("permits nested keys inside each", () => {
    const friends = params({
      friends: [{ name: "A", family: { name: "B", secret: "x" } }],
    }).expect({ friends: [["name", { family: ["name"] }]] }) as Parameters[];

    check(friends[0]!.toObject()).toEqual({ name: "A", family: { name: "B" } });
  });
});

/**
 * Permitting a whole hash means every key in it is safe to mass-assign, which
 * is true for a settings blob and false for almost everything else.
 */
describe("a whole object", () => {
  it("comes back permitted entire", () => {
    const settings = params({ settings: { theme: "dark", density: "tight" } }).expect({
      settings: {},
    }) as Parameters;

    check(settings.toObject()).toEqual({ theme: "dark", density: "tight" });
  });

  it("still refuses an array", () => {
    check(() => params({ settings: [1, 2] }).expect({ settings: {} })).toThrow(ParameterMissing);
  });
});

describe("several at once", () => {
  it("comes back in the order they were asked for", () => {
    const [name, emails] = params({ name: "Martin", emails: ["a@b.com"] }).expect("name", {
      emails: [],
    }) as [string, string[]];

    check(name).toBe("Martin");
    check(emails).toEqual(["a@b.com"]);
  });

  it("throws on the first one that is missing", () => {
    check(() => params({ name: "Martin" }).expect("name", "id")).toThrow(ParameterMissing);
  });

  /**
   * Two keys in one filter would come back as one value, and there would be no
   * way to say which. Refused rather than guessed.
   */
  it("refuses two keys in one filter", () => {
    check(() =>
      params({ a: { x: 1 }, b: { y: 2 } }).expect({ a: ["x"], b: ["y"] } as never),
    ).toThrow(/one key/);
  });
});

describe("what expect gives that require and permit did not", () => {
  it("require and permit still accept the array", () => {
    // Kept as the contrast: this is the older pair behaving as it always has,
    // and the reason `expect` was added rather than the pair being changed.
    const post = params({ post: [{ title: "A" }] }).require("post");

    check(Array.isArray(post)).toBe(true);
  });
});
