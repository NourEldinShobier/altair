/**
 * `defineModelCallbacks`, ported from `ActiveModel::Callbacks` and the
 * `define_model_callbacks` cases in
 * `activemodel/test/cases/callbacks_test.rb`.
 *
 * Declaring a lifecycle event is two things: the chain the class runs, and the
 * decorators a caller writes to put something on it. They were both here and
 * neither call knew about the other — `defineCallbacks` gives a class a chain
 * with nothing to put on it, and `callbackDecorators` gives decorators for a
 * chain that may not exist. Doing them separately is how the two come to
 * disagree about a name, which fails as a callback that silently never runs.
 */

import { describe, expect, it } from "bun:test";
import { CallbackAbort, defineModelCallbacks, runCallbacks } from "../src/index.js";

describe("declaring an event", () => {
  it("gives a class a chain and the decorators for it", async () => {
    const { beforeCreate, afterCreate } = defineModelCallbacks("create");
    const seen: string[] = [];

    class Signup {
      @beforeCreate
      first(): void {
        seen.push("before");
      }

      @afterCreate
      last(): void {
        seen.push("after");
      }

      async create(): Promise<void> {
        await runCallbacks(this, "create", () => {
          seen.push("body");
        });
      }
    }

    await new Signup().create();

    expect(seen).toEqual(["before", "body", "after"]);
  });

  it("declares several at once", async () => {
    const seen: string[] = [];

    class Post {
      async run(event: string): Promise<void> {
        await runCallbacks(this, event, () => {
          seen.push(event);
        });
      }
    }

    const hooks = defineModelCallbacks(["publish", "archive"]);

    expect(Object.keys(hooks).sort()).toEqual([
      "afterArchive",
      "afterPublish",
      "aroundArchive",
      "aroundPublish",
      "beforeArchive",
      "beforePublish",
    ]);

    await new Post().run("publish");
    await new Post().run("archive");

    expect(seen).toEqual(["publish", "archive"]);
  });

  /** `create` gives `beforeCreate`, and the chain keeps the name it was given. */
  it("camel-cases the decorator and leaves the chain alone", async () => {
    const hooks = defineModelCallbacks("send_email");

    expect(Object.keys(hooks)).toContain("beforeSend_email");
  });
});

describe("only", () => {
  it("makes just the kinds asked for", () => {
    const hooks = defineModelCallbacks("create", { only: ["before", "after"] });

    expect(Object.keys(hooks).sort()).toEqual(["afterCreate", "beforeCreate"]);
  });

  /**
   * An event with no `around` is one a caller cannot wrap, which is worth
   * being able to say: `around` is the kind that can swallow the block.
   */
  it("leaves out around when it was not asked for", () => {
    expect(Object.keys(defineModelCallbacks("create", { only: ["before"] }))).toEqual([
      "beforeCreate",
    ]);
  });
});

describe("running one", () => {
  it("wraps the body with around", async () => {
    const seen: string[] = [];
    const { aroundSave } = defineModelCallbacks("save");

    class Record_ {
      /**
       * `(target, block)`, the same arguments a function filter gets, so a
       * method and a lambda declaring the same parameters behave alike.
       */
      @aroundSave
      async trace(_self: Record_, block: () => Promise<void>): Promise<void> {
        seen.push("in");
        await block();
        seen.push("out");
      }

      async save(): Promise<void> {
        await runCallbacks(this, "save", () => {
          seen.push("body");
        });
      }
    }

    await new Record_().save();

    expect(seen).toEqual(["in", "body", "out"]);
  });

  /** A before callback that aborts halts the chain, which is what halting is for. */
  it("halts when a before callback aborts", async () => {
    let ran = false;
    const { beforeSave } = defineModelCallbacks("save");

    class Guarded {
      @beforeSave
      refuse(): void {
        throw new CallbackAbort();
      }

      async save(): Promise<unknown> {
        return await runCallbacks(this, "save", () => {
          ran = true;
        });
      }
    }

    expect(await new Guarded().save()).toBe(false);
    expect(ran).toBe(false);
  });

  it("runs with no callbacks on it at all", async () => {
    class Bare {}

    defineModelCallbacks("save");

    expect(await runCallbacks(new Bare(), "save", () => "done")).toBe("done");
  });
});
