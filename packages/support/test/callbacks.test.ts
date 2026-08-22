/**
 * Callback chain parity suite.
 *
 * Mirrors activesupport/test/callbacks_test.rb. Rails' callback tests are code
 * rather than fixture data, so each case here is ported by hand and names the
 * Rails test it corresponds to.
 */

import { describe, expect, it } from "bun:test";
import {
  Callbacks,
  CallbackAbort,
  type Filter,
  abortCallback,
  callbacksFor,
  defineCallbacks,
  resetCallbacks,
  runCallbacks,
  setCallback,
  skipCallback,
} from "../src/callbacks.js";

/** Each test gets a fresh class so chains never leak between cases. */
function personClass() {
  class Person extends Callbacks {
    history: string[] = [];
    saved = false;

    static {
      this.defineCallbacks("save");
    }

    async save(): Promise<unknown> {
      return this.runCallbacks("save", () => {
        this.saved = true;
        return "saved";
      });
    }
  }
  return Person;
}

describe("ordering", () => {
  // Rails: test_save_person / basic before and after
  it("runs before callbacks in declaration order", async () => {
    const Person = personClass();
    Person.setCallback("save", "before", function (this: InstanceType<typeof Person>) {
      this.history.push("before-1");
    });
    Person.setCallback("save", "before", function (this: InstanceType<typeof Person>) {
      this.history.push("before-2");
    });

    const person = new Person();
    await person.save();

    expect(person.history).toEqual(["before-1", "before-2"]);
    expect(person.saved).toBe(true);
  });

  // Rails: test_after_save_runs_in_the_reverse_order
  it("runs after callbacks in reverse declaration order", async () => {
    const Person = personClass();
    Person.setCallback("save", "after", function (this: InstanceType<typeof Person>) {
      this.history.push("after-1");
    });
    Person.setCallback("save", "after", function (this: InstanceType<typeof Person>) {
      this.history.push("after-2");
    });

    const person = new Person();
    await person.save();

    expect(person.history).toEqual(["after-2", "after-1"]);
  });

  // Rails: test_save_around
  it("wraps the block with around callbacks", async () => {
    const Person = personClass();
    Person.setCallback(
      "save",
      "around",
      async function (this: InstanceType<typeof Person>, _t, block) {
        this.history.push("around-1-before");
        await block();
        this.history.push("around-1-after");
      },
    );
    Person.setCallback(
      "save",
      "around",
      async function (this: InstanceType<typeof Person>, _t, block) {
        this.history.push("around-2-before");
        await block();
        this.history.push("around-2-after");
      },
    );

    const person = new Person();
    await person.save();

    expect(person.history).toEqual([
      "around-1-before",
      "around-2-before",
      "around-2-after",
      "around-1-after",
    ]);
  });

  // Rails: test_save_around — before, around and after interleave correctly
  it("interleaves before, around and after", async () => {
    const Person = personClass();
    const push = (label: string) =>
      function (this: InstanceType<typeof Person>) {
        this.history.push(label);
      };

    Person.setCallback("save", "before", push("before"));
    Person.setCallback(
      "save",
      "around",
      async function (this: InstanceType<typeof Person>, _t, block) {
        this.history.push("around-in");
        await block();
        this.history.push("around-out");
      },
    );
    Person.setCallback("save", "after", push("after"));

    const person = new Person();
    await person.save();

    expect(person.history).toEqual(["before", "around-in", "after", "around-out"]);
  });

  // Rails: test_double_save
  it("runs the chain again on a second call", async () => {
    const Person = personClass();
    Person.setCallback("save", "before", function (this: InstanceType<typeof Person>) {
      this.history.push("before");
    });

    const person = new Person();
    await person.save();
    await person.save();

    expect(person.history).toEqual(["before", "before"]);
  });
});

describe("return values", () => {
  // Rails: test_block_result_is_returned
  it("returns the block's value", async () => {
    const Person = personClass();
    Person.setCallback("save", "before", () => {});

    expect(await new Person().save()).toBe("saved");
  });

  // Rails: run_callbacks with no block
  it("returns true when there is no block", async () => {
    const Person = personClass();
    Person.setCallback("save", "before", () => {});

    expect(await new Person().runCallbacks("save")).toBe(true);
  });

  // Rails: an empty chain still yields
  it("runs the block when no callbacks are registered", async () => {
    const Person = personClass();
    const person = new Person();

    expect(await person.save()).toBe("saved");
    expect(person.saved).toBe(true);
  });
});

describe("termination", () => {
  // Rails: test_block_never_called_if_abort_is_thrown
  it("does not call the block when a before callback aborts", async () => {
    const Person = personClass();
    Person.setCallback("save", "before", () => abortCallback());

    const person = new Person();
    const result = await person.save();

    expect(result).toBe(false);
    expect(person.saved).toBe(false);
  });

  // Rails: test_termination_skips_following_before_and_around_callbacks
  it("skips later before and around callbacks after a halt", async () => {
    const Person = personClass();
    Person.setCallback("save", "before", function (this: InstanceType<typeof Person>) {
      this.history.push("first");
      abortCallback();
    });
    Person.setCallback("save", "before", function (this: InstanceType<typeof Person>) {
      this.history.push("second");
    });
    Person.setCallback(
      "save",
      "around",
      async function (this: InstanceType<typeof Person>, _t, block) {
        this.history.push("around");
        await block();
      },
    );

    const person = new Person();
    await person.save();

    expect(person.history).toEqual(["first"]);
  });

  // Rails: after callbacks still run on halt unless configured otherwise
  it("still runs after callbacks by default when halted", async () => {
    const Person = personClass();
    Person.setCallback("save", "before", () => abortCallback());
    Person.setCallback("save", "after", function (this: InstanceType<typeof Person>) {
      this.history.push("after");
    });

    const person = new Person();
    await person.save();

    expect(person.history).toEqual(["after"]);
  });

  // Rails: test_termination_skips_after_callbacks
  it("skips after callbacks when skipAfterCallbacksIfTerminated is set", async () => {
    class Record extends Callbacks {
      history: string[] = [];
      static {
        this.defineCallbacks("save", { skipAfterCallbacksIfTerminated: true });
      }
    }
    Record.setCallback("save", "before", () => abortCallback());
    Record.setCallback("save", "after", function (this: Record) {
      this.history.push("after");
    });

    const record = new Record();
    await record.runCallbacks("save", () => "value");

    expect(record.history).toEqual([]);
  });

  // Rails: test_returning_false_does_not_halt_callback
  it("does not halt when a callback returns false", async () => {
    const Person = personClass();
    Person.setCallback("save", "before", () => false);

    const person = new Person();

    expect(await person.save()).toBe("saved");
    expect(person.saved).toBe(true);
  });

  // Rails: test_default_termination — a custom terminator decides what halts
  it("honours a custom terminator", async () => {
    class Validated extends Callbacks {
      history: string[] = [];
      static {
        this.defineCallbacks<Validated>("validate", {
          // Rails' documented example: halt when a callback returns false.
          terminator: async (_target, run) => (await run()) === false,
        });
      }
    }
    Validated.setCallback("validate", "before", function (this: Validated) {
      this.history.push("first");
      return false;
    });
    Validated.setCallback("validate", "before", function (this: Validated) {
      this.history.push("second");
    });

    const record = new Validated();
    const result = await record.runCallbacks("validate", () => "ran");

    expect(result).toBe(false);
    expect(record.history).toEqual(["first"]);
  });

  // An error that is not an abort is a real error and must not be swallowed.
  it("propagates ordinary errors", async () => {
    const Person = personClass();
    Person.setCallback("save", "before", () => {
      throw new Error("boom");
    });

    await expect(new Person().save()).rejects.toThrow("boom");
  });

  // Rails: an around callback that never yields stops the chain
  it("does not run the block when an around callback never yields", async () => {
    const Person = personClass();
    Person.setCallback("save", "around", function (this: InstanceType<typeof Person>) {
      this.history.push("around");
    });

    const person = new Person();
    await person.save();

    expect(person.history).toEqual(["around"]);
    expect(person.saved).toBe(false);
  });
});

describe("conditionals", () => {
  // Rails: test_save_conditional_person
  it("runs a callback only when :if holds", async () => {
    const Person = personClass();
    Person.setCallback(
      "save",
      "before",
      function (this: InstanceType<typeof Person>) {
        this.history.push("ran");
      },
      { if: () => false },
    );

    const person = new Person();
    await person.save();

    expect(person.history).toEqual([]);
  });

  // Rails: test_save_conditional_person — :unless is the inverse
  it("skips a callback when :unless holds", async () => {
    const Person = personClass();
    Person.setCallback(
      "save",
      "before",
      function (this: InstanceType<typeof Person>) {
        this.history.push("ran");
      },
      { unless: () => true },
    );

    const person = new Person();
    await person.save();

    expect(person.history).toEqual([]);
    expect(person.saved).toBe(true);
  });

  // Rails: conditions may be method names on the target
  it("accepts a method name as a condition", async () => {
    class Post extends Callbacks {
      history: string[] = [];
      published = false;
      isPublished(): boolean {
        return this.published;
      }
      static {
        this.defineCallbacks("save");
      }
    }
    Post.setCallback(
      "save",
      "before",
      function (this: Post) {
        this.history.push("ran");
      },
      { if: "isPublished" },
    );

    const draft = new Post();
    await draft.runCallbacks("save", () => null);
    expect(draft.history).toEqual([]);

    const live = new Post();
    live.published = true;
    await live.runCallbacks("save", () => null);
    expect(live.history).toEqual(["ran"]);
  });

  // Rails: multiple conditions must all pass
  it("requires every condition in an array to hold", async () => {
    const Person = personClass();
    Person.setCallback(
      "save",
      "before",
      function (this: InstanceType<typeof Person>) {
        this.history.push("ran");
      },
      { if: [() => true, () => false] },
    );

    const person = new Person();
    await person.save();

    expect(person.history).toEqual([]);
  });
});

describe("registration", () => {
  // Rails: callbacks may be declared as method names
  it("accepts a method name as the callback", async () => {
    class Person extends Callbacks {
      history: string[] = [];
      normalize(): void {
        this.history.push("normalized");
      }
      static {
        this.defineCallbacks("save");
      }
    }
    Person.setCallback("save", "before", "normalize");

    const person = new Person();
    await person.runCallbacks("save", () => null);

    expect(person.history).toEqual(["normalized"]);
  });

  // Rails: test_excludes_duplicates_in_separate_calls
  it("does not register the same filter twice", async () => {
    const Person = personClass();
    const filter = function (this: InstanceType<typeof Person>) {
      this.history.push("ran");
    };
    Person.setCallback("save", "before", filter);
    Person.setCallback("save", "before", filter);

    const person = new Person();
    await person.save();

    expect(person.history).toEqual(["ran"]);
  });

  // Rails: prepend: true puts the callback first
  it("prepends when asked", async () => {
    const Person = personClass();
    Person.setCallback("save", "before", function (this: InstanceType<typeof Person>) {
      this.history.push("second");
    });
    Person.setCallback(
      "save",
      "before",
      function (this: InstanceType<typeof Person>) {
        this.history.push("first");
      },
      { prepend: true },
    );

    const person = new Person();
    await person.save();

    expect(person.history).toEqual(["first", "second"]);
  });

  // Rails: test_skip_person
  it("skips a registered callback", async () => {
    class Person extends Callbacks {
      history: string[] = [];
      normalize(): void {
        this.history.push("normalized");
      }
      static {
        this.defineCallbacks("save");
      }
    }
    Person.setCallback("save", "before", "normalize");
    Person.skipCallback("save", "before", "normalize");

    const person = new Person();
    await person.runCallbacks("save", () => null);

    expect(person.history).toEqual([]);
  });

  // Rails: skip_callback raises when the callback is not there.
  //
  // Reaching this at run time now takes a deliberate cast, because the type
  // rejects a name that is not a method — see the compile-time test below.
  it("throws when skipping a callback that was never set", () => {
    const Person = personClass();
    const missing = "missing" as unknown as Filter<InstanceType<typeof Person>>;
    expect(() => Person.skipCallback("save", "before", missing)).toThrow(
      "No before callback missing defined for save",
    );
  });

  // Rails: skip_callback(raise: false) is silent
  it("stays quiet when raise is false", () => {
    const Person = personClass();
    const missing = "missing" as unknown as Filter<InstanceType<typeof Person>>;
    expect(() => Person.skipCallback("save", "before", missing, { raise: false })).not.toThrow();
  });

  // Altair-specific: Rails takes a symbol and finds out at run time. We do not.
  it("rejects a method name that does not exist, at compile time", () => {
    class Post extends Callbacks {
      static {
        this.defineCallbacks("save");
      }
      normalizeTitle(): void {}
    }

    // @ts-expect-error "normalizeTitel" is a typo and is not a method on Post
    Post.setCallback("save", "before", "normalizeTitel");

    // @ts-expect-error "nope" is not a method, so it cannot be a condition
    Post.setCallback("save", "before", "normalizeTitle", { if: "nope" });

    // The correctly spelled name is accepted.
    Post.setCallback("save", "before", "normalizeTitle");
    expect(callbacksFor(Post, "save").length).toBeGreaterThan(0);
  });

  // Rails: test_reset_callbacks
  it("resets a chain", async () => {
    const Person = personClass();
    Person.setCallback("save", "before", function (this: InstanceType<typeof Person>) {
      this.history.push("ran");
    });
    Person.resetCallbacks("save");

    const person = new Person();
    await person.save();

    expect(person.history).toEqual([]);
    expect(callbacksFor(Person, "save")).toHaveLength(0);
  });
});

describe("inheritance", () => {
  // Rails: callbacks defined on a parent run for subclass instances
  it("inherits callbacks from the parent class", async () => {
    const Person = personClass();
    Person.setCallback("save", "before", function (this: InstanceType<typeof Person>) {
      this.history.push("parent");
    });

    class Employee extends Person {}

    const employee = new Employee();
    await employee.save();

    expect(employee.history).toEqual(["parent"]);
  });

  // Rails: a subclass adding callbacks does not affect the parent
  it("does not leak subclass callbacks back to the parent", async () => {
    const Person = personClass();
    Person.setCallback("save", "before", function (this: InstanceType<typeof Person>) {
      this.history.push("parent");
    });

    class Employee extends Person {}
    Employee.setCallback("save", "before", function (this: Employee) {
      this.history.push("child");
    });

    const employee = new Employee();
    await employee.save();
    expect(employee.history).toEqual(["parent", "child"]);

    const person = new Person();
    await person.save();
    expect(person.history).toEqual(["parent"]);
  });

  // Rails: a subclass can skip an inherited callback
  it("lets a subclass skip an inherited callback", async () => {
    class Person extends Callbacks {
      history: string[] = [];
      normalize(): void {
        this.history.push("normalized");
      }
      static {
        this.defineCallbacks("save");
      }
    }
    Person.setCallback("save", "before", "normalize");

    class Employee extends Person {}
    Employee.skipCallback("save", "before", "normalize");

    const employee = new Employee();
    await employee.runCallbacks("save", () => null);
    expect(employee.history).toEqual([]);

    const person = new Person();
    await person.runCallbacks("save", () => null);
    expect(person.history).toEqual(["normalized"]);
  });
});

describe("async callbacks", () => {
  // Altair-specific: Rails' chains are synchronous, ours are not.
  it("awaits async before, around and after callbacks in order", async () => {
    const Person = personClass();
    const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

    Person.setCallback("save", "before", async function (this: InstanceType<typeof Person>) {
      await tick();
      this.history.push("before");
    });
    Person.setCallback(
      "save",
      "around",
      async function (this: InstanceType<typeof Person>, _t, block) {
        await tick();
        this.history.push("around-in");
        await block();
        await tick();
        this.history.push("around-out");
      },
    );
    Person.setCallback("save", "after", async function (this: InstanceType<typeof Person>) {
      await tick();
      this.history.push("after");
    });

    const person = new Person();
    await person.save();

    expect(person.history).toEqual(["before", "around-in", "after", "around-out"]);
  });

  // Altair-specific: an async callback may abort.
  it("halts on an abort thrown from an async callback", async () => {
    const Person = personClass();
    Person.setCallback("save", "before", async () => {
      await Promise.resolve();
      abortCallback();
    });

    const person = new Person();

    expect(await person.save()).toBe(false);
    expect(person.saved).toBe(false);
  });
});

describe("free functions", () => {
  // The class-free API is what the ORM and controllers will build on.
  it("works without the base class", async () => {
    class Widget {
      history: string[] = [];
    }
    const record = function (this: Widget) {
      this.history.push("ran");
    };

    defineCallbacks(Widget, "save");
    setCallback<Widget>(Widget, "save", "before", record);
    expect(callbacksFor(Widget, "save")).toHaveLength(1);

    const widget = new Widget();
    expect(await runCallbacks(widget, "save", () => "done")).toBe("done");
    expect(widget.history).toEqual(["ran"]);

    skipCallback<Widget>(Widget, "save", "before", record);
    expect(callbacksFor(Widget, "save")).toHaveLength(0);

    setCallback<Widget>(Widget, "save", "before", record);
    resetCallbacks(Widget, "save");
    expect(callbacksFor(Widget, "save")).toHaveLength(0);
  });

  it("exports the abort error type", () => {
    expect(() => abortCallback()).toThrow(CallbackAbort);
  });
});
