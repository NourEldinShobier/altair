/**
 * Callback decorators.
 *
 * There is no Rails counterpart to port here — Rails declares callbacks with a
 * macro that takes a symbol. These tests cover the behaviour that replaces it,
 * and assert it registers exactly what setCallback would.
 */

import { describe, expect, it } from "bun:test";
import { Callbacks, callbacksFor } from "../src/callbacks.js";
import { after, around, before, callbackDecorators } from "../src/callback-decorators.js";

const { before: beforeSave, after: afterSave } = callbackDecorators("save");

describe("decorators", () => {
  it("registers a decorated method on the chain", async () => {
    class Post extends Callbacks {
      history: string[] = [];
      static {
        this.defineCallbacks("save");
      }

      @before("save")
      normalizeTitle(): void {
        this.history.push("normalized");
      }
    }

    const post = new Post();
    await post.runCallbacks("save", () => null);

    expect(post.history).toEqual(["normalized"]);
  });

  it("registers before a chain is ever run", () => {
    class Post extends Callbacks {
      static {
        this.defineCallbacks("save");
      }

      @before("save")
      normalizeTitle(): void {}
    }

    // No instance has been constructed; the chain is already populated.
    expect(callbacksFor(Post, "save")).toHaveLength(1);
  });

  it("keeps declaration order", async () => {
    class Post extends Callbacks {
      history: string[] = [];
      static {
        this.defineCallbacks("save");
      }

      @before("save")
      first(): void {
        this.history.push("first");
      }

      @before("save")
      second(): void {
        this.history.push("second");
      }

      @after("save")
      third(): void {
        this.history.push("third");
      }

      @after("save")
      fourth(): void {
        this.history.push("fourth");
      }
    }

    const post = new Post();
    await post.runCallbacks("save", () => null);

    // before in order, after reversed — the same rule as the macro form.
    expect(post.history).toEqual(["first", "second", "fourth", "third"]);
  });

  it("supports conditions", async () => {
    class Post extends Callbacks {
      history: string[] = [];
      published = false;
      static {
        this.defineCallbacks("save");
      }

      isPublished(): boolean {
        return this.published;
      }

      @before("save", { if: "isPublished" })
      stamp(): void {
        this.history.push("stamped");
      }
    }

    const draft = new Post();
    await draft.runCallbacks("save", () => null);
    expect(draft.history).toEqual([]);

    const live = new Post();
    live.published = true;
    await live.runCallbacks("save", () => null);
    expect(live.history).toEqual(["stamped"]);
  });

  it("wraps the block with an around decorator", async () => {
    class Post extends Callbacks {
      history: string[] = [];
      static {
        this.defineCallbacks("save");
      }

      @around("save")
      async logged(_target: Post, block: () => Promise<unknown>): Promise<void> {
        this.history.push("in");
        await block();
        this.history.push("out");
      }
    }

    const post = new Post();
    await post.runCallbacks("save", () => {
      post.history.push("body");
    });

    expect(post.history).toEqual(["in", "body", "out"]);
  });

  it("works with the named sugar form, bare and with options", async () => {
    class Post extends Callbacks {
      history: string[] = [];
      published = true;
      static {
        this.defineCallbacks("save");
      }

      isPublished(): boolean {
        return this.published;
      }

      @beforeSave
      normalize(): void {
        this.history.push("normalized");
      }

      @afterSave({ if: "isPublished" })
      notify(): void {
        this.history.push("notified");
      }
    }

    const post = new Post();
    await post.runCallbacks("save", () => null);

    expect(post.history).toEqual(["normalized", "notified"]);
  });

  it("inherits decorated callbacks and lets a subclass add more", async () => {
    class Post extends Callbacks {
      history: string[] = [];
      static {
        this.defineCallbacks("save");
      }

      @beforeSave
      fromParent(): void {
        this.history.push("parent");
      }
    }

    class Article extends Post {
      @beforeSave
      fromChild(): void {
        this.history.push("child");
      }
    }

    const article = new Article();
    await article.runCallbacks("save", () => null);
    expect(article.history).toEqual(["parent", "child"]);

    // The parent is untouched by the subclass's decorator.
    const post = new Post();
    await post.runCallbacks("save", () => null);
    expect(post.history).toEqual(["parent"]);
  });

  it("can be skipped like any other callback", async () => {
    class Post extends Callbacks {
      history: string[] = [];
      static {
        this.defineCallbacks("save");
      }

      @beforeSave
      normalize(): void {
        this.history.push("normalized");
      }
    }

    Post.skipCallback("save", "before", "normalize");

    const post = new Post();
    await post.runCallbacks("save", () => null);
    expect(post.history).toEqual([]);
  });

  it("mixes with callbacks registered the explicit way", async () => {
    class Post extends Callbacks {
      history: string[] = [];
      static {
        this.defineCallbacks("save");
      }

      @beforeSave
      decorated(): void {
        this.history.push("decorated");
      }
    }

    Post.setCallback("save", "before", function (this: Post) {
      this.history.push("explicit");
    });

    const post = new Post();
    await post.runCallbacks("save", () => null);
    expect(post.history).toEqual(["decorated", "explicit"]);
  });
});
