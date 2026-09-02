/**
 * What `url_for` accepts, ported from
 * `actionpack/test/controller/routing_test.rb` and
 * `actionpack/test/controller/url_for_test.rb` — the polymorphic-argument
 * cases.
 *
 * Every mistake here is a route name that does not exist, so every case asserts
 * the name and the arguments rather than a rendered path.
 */

import { describe, expect, it } from "bun:test";
import {
  type HelperTable,
  NilLocation,
  callHelper,
  handleClass,
  handleClassCall,
  handleList,
  handleModel,
  handleModelCall,
  handleString,
  handleStringCall,
  helperMethodBuilder,
  polymorphicHelperFor,
} from "../src/polymorphic_arguments.js";

// Real classes, because that is what a caller passes and what `isClass`
// distinguishes an unsaved record from.
class Post {}
class Comment {}

const post = { constructor: { name: "Post" }, id: 1, persisted: true };
const comment = { constructor: { name: "Comment" }, id: 2, persisted: true };
const draft = { constructor: { name: "Post" }, persisted: false };

const named = {
  modelName: { routeKey: "people", singularRouteKey: "person" },
  id: 7,
  persisted: true,
};

const url = helperMethodBuilder(undefined, "url");
const path = helperMethodBuilder(undefined, "path");

describe("how a helper name is built", () => {
  it("takes the action in front and the kind behind", () => {
    expect(handleString(helperMethodBuilder("edit", "path"), "post").method).toBe("editPostPath");
    expect(handleString(url, "posts").method).toBe("postsUrl");
  });

  /**
   * `new` is the one action that is singular while naming a collection —
   * `new_post_path` creates *a* post.
   */
  it("names the singular for new and the plural otherwise", () => {
    expect(handleClass(helperMethodBuilder("new", "path"), Post).method).toBe("newPostPath");
    expect(handleClass(path, Post).method).toBe("postsPath");
    // Only `new`: `edit` acts on a record, so it is the record that makes the
    // name singular, not the action.
    expect(handleClass(helperMethodBuilder("edit", "path"), Post).method).toBe("editPostsPath");
  });
});

describe("a name given directly", () => {
  it("carries no arguments", () => {
    expect(handleString(path, "posts")).toEqual({ method: "postsPath", args: [] });
  });

  it("can be called against a helper table", () => {
    const table: HelperTable = { postsPath: () => "/posts" };

    expect(handleStringCall(table, path, "posts")).toBe("/posts");
  });
});

describe("a class", () => {
  /** A class is every record of its kind, not one of them. */
  it("names the collection and carries nothing", () => {
    expect(handleClass(path, Post)).toEqual({ method: "postsPath", args: [] });
  });

  it("uses a declared route key rather than the class name", () => {
    class Person {
      static modelName = { routeKey: "people", singularRouteKey: "person" };
    }

    expect(handleClass(path, Person).method).toBe("peoplePath");
    expect(handleClass(helperMethodBuilder("new", "path"), Person).method).toBe("newPersonPath");
  });

  it("can be called against a helper table", () => {
    const table: HelperTable = { postsPath: () => "/posts" };

    expect(handleClassCall(table, path, Post)).toBe("/posts");
  });
});

describe("a record", () => {
  /**
   * Read from the record rather than from a flag the caller passes, which is
   * what stops a form's create and update paths drifting apart.
   */
  it("goes to its own path when saved", () => {
    expect(handleModel(path, post)).toEqual({ method: "postPath", args: ["1"] });
  });

  it("goes to the collection when unsaved, carrying nothing", () => {
    expect(handleModel(path, draft)).toEqual({ method: "postsPath", args: [] });
  });

  it("uses a declared route key", () => {
    expect(handleModel(path, named)).toEqual({ method: "personPath", args: ["7"] });
  });

  it("names the singular for new, saved or not", () => {
    const forNew = helperMethodBuilder("new", "path");

    expect(handleModel(forNew, draft).method).toBe("newPostPath");
  });

  it("can be called against a helper table", () => {
    const table: HelperTable = { postPath: (id) => `/posts/${String(id)}` };

    expect(handleModelCall(table, path, post)).toBe("/posts/1");
  });
});

describe("a list", () => {
  /** `admin_post_path(post)` takes one argument, not two. */
  it("treats a bare name as a namespace, contributing no argument", () => {
    expect(handleList(path, ["admin", post])).toEqual({ method: "adminPostPath", args: ["1"] });
  });

  it("names every parent in the singular and carries each id", () => {
    expect(handleList(path, [post, comment])).toEqual({
      method: "postCommentPath",
      args: ["1", "2"],
    });
  });

  /**
   * The last item decides the shape: a class at the end is the collection under
   * its parent, which is where a new comment on a post is posted.
   */
  it("ends at the collection for a class", () => {
    expect(handleList(path, [post, Comment])).toEqual({ method: "postCommentsPath", args: ["1"] });
  });

  it("ends at the collection for an unsaved record", () => {
    expect(
      handleList(path, [post, { constructor: { name: "Comment" }, persisted: false }]),
    ).toEqual({ method: "postCommentsPath", args: ["1"] });
  });

  /** `[Post, comment]` cannot mean a particular post, so there is no id to add. */
  it("names a class in the middle in the singular, carrying nothing", () => {
    expect(handleList(path, [Post, comment])).toEqual({ method: "postCommentPath", args: ["2"] });
  });

  it("takes a namespace, a parent and a class together", () => {
    expect(handleList(path, ["admin", post, Comment])).toEqual({
      method: "adminPostCommentsPath",
      args: ["1"],
    });
  });

  it("carries the action through", () => {
    expect(handleList(helperMethodBuilder("edit", "path"), ["admin", post]).method).toBe(
      "editAdminPostPath",
    );
    expect(handleList(helperMethodBuilder("new", "path"), [post, Comment]).method).toBe(
      "newPostCommentPath",
    );
  });

  it("takes a single item", () => {
    expect(handleList(path, [post])).toEqual({ method: "postPath", args: ["1"] });
  });

  /**
   * `url_for([nil])` would otherwise build `_path`, a helper nobody has,
   * reported far from where the nil came from.
   */
  it("drops blanks, and refuses a list that is only blanks", () => {
    expect(handleList(path, [null, post]).method).toBe("postPath");
    expect(() => handleList(path, [])).toThrow(NilLocation);
    expect(() => handleList(path, [null, undefined])).toThrow("Can't build URI");
  });
});

describe("whatever url_for was given", () => {
  it("dispatches on the shape", () => {
    expect(polymorphicHelperFor(post, { type: "path" }).method).toBe("postPath");
    expect(polymorphicHelperFor(Post, { type: "path" }).method).toBe("postsPath");
    expect(polymorphicHelperFor("posts", { type: "path" }).method).toBe("postsPath");
    expect(polymorphicHelperFor(["admin", post], { type: "path" }).method).toBe("adminPostPath");
  });

  it("builds a url by default", () => {
    expect(polymorphicHelperFor(post).method).toBe("postUrl");
  });

  it("refuses nothing at all", () => {
    expect(() => polymorphicHelperFor(null)).toThrow(NilLocation);
    expect(() => polymorphicHelperFor(undefined)).toThrow(NilLocation);
  });

  /**
   * A class is a function; checking for a missing id instead would make an
   * unsaved record look like a class — which names the same route, so the
   * mistake would only appear when an id was expected.
   */
  it("tells a class from an unsaved record", () => {
    class Article {}

    expect(polymorphicHelperFor(Article, { type: "path" }).method).toBe("articlesPath");
    expect(polymorphicHelperFor(new Article(), { type: "path" }).method).toBe("articlesPath");
    expect(handleList(path, [Article, comment]).args).toEqual(["2"]);
  });
});

describe("running it against the route table", () => {
  /** Where a missing route is reported, naming the helper that is missing. */
  it("names the helper it could not find", () => {
    expect(() => callHelper({}, { method: "adminPostPath", args: [] })).toThrow("adminPostPath");
  });

  it("passes the arguments through", () => {
    const table: HelperTable = {
      postCommentPath: (...args) => `/posts/${String(args[0])}/comments/${String(args[1])}`,
    };

    expect(callHelper(table, handleList(path, [post, comment]))).toBe("/posts/1/comments/2");
  });

  /** Options go last, after the ids, which is where a helper expects them. */
  it("appends options when there are any", () => {
    const table: HelperTable = { postPath: (...args) => JSON.stringify(args) };

    expect(callHelper(table, handleModel(path, post), { page: 2 })).toBe('["1",{"page":2}]');
    expect(callHelper(table, handleModel(path, post))).toBe('["1"]');
  });
});
