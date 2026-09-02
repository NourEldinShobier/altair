/**
 * Where a model's generated methods live, ported from
 * `activerecord/test/cases/attribute_methods_test.rb` (the
 * `instance_method_already_implemented?` and dangerous-attribute cases) and
 * `activerecord/test/cases/relation/delegation_test.rb`.
 *
 * Every case here is about a collision that leaves no trace: a generated method
 * and a hand-written one land in the same place and whichever ran last wins.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  applicationMethodsOf,
  delegatedClasses,
  generateMethod,
  generateRelationMethod,
  generatedAssociationMethods,
  generatedAttributeMethods,
  generatedMethods,
  initializeRelationDelegateCache,
  instanceMethodAlreadyImplemented,
  registerDelegatedClass,
  relationDelegateClass,
  resetDelegatedClasses,
  uncacheableMethods,
} from "../src/generated_methods.js";

afterEach(() => {
  resetDelegatedClasses();
});

describe("the module generated methods go in", () => {
  /**
   * The collision this exists to remove: a hand-written accessor and a
   * generated reader on one prototype, where the answer depends on whether the
   * column was introspected before or after the class body ran.
   */
  it("lets the class's own definition win, whatever the order", () => {
    class Post {
      get title(): string {
        return "written by hand";
      }
    }

    generateMethod(generatedAttributeMethods(Post), "title", () => "generated");

    expect(new Post().title).toBe("written by hand");
  });

  /** Reachable underneath, so a hand-written accessor can call it. */
  it("keeps the generated one reachable", () => {
    class Post {}
    generateMethod(generatedAttributeMethods(Post), "title", () => "generated");

    expect((new Post() as unknown as { title: () => string }).title()).toBe("generated");
  });

  it("is the same module each time it is asked for", () => {
    class Post {}

    expect(generatedAttributeMethods(Post)).toBe(generatedAttributeMethods(Post));
    expect(generatedMethods(Post, "attributes")).toBe(generatedAttributeMethods(Post));
  });

  /**
   * Separate modules per concern, so an association reader and an attribute
   * reader of the same name do not silently become one method.
   */
  it("is a different module per namespace", () => {
    class Post {}

    expect(generatedAssociationMethods(Post)).not.toBe(generatedAttributeMethods(Post));
  });

  it("does not break the chain to the superclass", () => {
    class Record {
      save(): string {
        return "saved";
      }
    }
    class Post extends Record {}

    generatedAttributeMethods(Post);

    expect(new Post()).toBeInstanceOf(Record);
    expect(new Post().save()).toBe("saved");
  });

  /** A subclass sees what its parent generated, as an included module would. */
  it("is inherited", () => {
    class Post {}
    generateMethod(generatedAttributeMethods(Post), "title", () => "generated");

    class Draft extends Post {}

    expect((new Draft() as unknown as { title: () => string }).title()).toBe("generated");
  });
});

describe("defining one", () => {
  it("defines it", () => {
    const target = {};

    expect(generateMethod(target, "title", () => 1)).toBe(true);
    expect((target as { title: () => number }).title()).toBe(1);
  });

  /**
   * Two associations that generate the same name keep whichever was declared
   * first: redefining silently would make behaviour depend on the order of
   * lines in a file.
   */
  it("does not redefine", () => {
    const target = {};
    generateMethod(target, "title", () => "first");

    expect(generateMethod(target, "title", () => "second")).toBe(false);
    expect((target as { title: () => string }).title()).toBe("first");
  });

  /**
   * A generated method that appeared in `Object.keys` would be serialised into
   * JSON responses and copied by every spread.
   */
  it("does not make it enumerable", () => {
    const target = {};
    generateMethod(target, "title", () => 1);

    expect(Object.keys(target)).toEqual([]);
    expect({ ...target }).toEqual({});
  });
});

describe("whether the application defined a method", () => {
  /**
   * The distinction the dangerous-attribute check rests on: a column named
   * `save` must be refused, a `save` somebody wrote must be respected, and both
   * are "a method exists with that name".
   */
  it("is true for one the class itself defines", () => {
    class Post {
      save(): void {}
    }

    expect(instanceMethodAlreadyImplemented(Post, "save")).toBe(true);
  });

  it("is false for one that was generated", () => {
    class Post {}
    generateMethod(generatedAttributeMethods(Post), "save", () => undefined);

    expect(instanceMethodAlreadyImplemented(Post, "save")).toBe(false);
  });

  /** Otherwise every column named after a base-class method looks deliberate. */
  it("is false for one inherited from the framework", () => {
    class Record {
      save(): void {}
    }
    class Post extends Record {}

    expect(instanceMethodAlreadyImplemented(Post, "save")).toBe(false);
  });

  it("is false for a name nobody defined", () => {
    class Post {}

    expect(instanceMethodAlreadyImplemented(Post, "title")).toBe(false);
  });

  it("lists what the class itself defines, without its constructor", () => {
    class Post {
      save(): void {}
      publish(): void {}
    }
    generateMethod(generatedAttributeMethods(Post), "title", () => undefined);

    expect([...applicationMethodsOf(Post)].sort()).toEqual(["publish", "save"]);
  });
});

describe("the relation subclasses a model gets", () => {
  class Relation {
    where(): string {
      return "where";
    }
  }
  class CollectionProxy extends Relation {
    build(): string {
      return "build";
    }
  }

  it("is one per registered kind", () => {
    registerDelegatedClass(Relation);
    registerDelegatedClass(CollectionProxy);

    expect(delegatedClasses()).toEqual([Relation, CollectionProxy]);
  });

  it("registers a kind once", () => {
    registerDelegatedClass(Relation);
    registerDelegatedClass(Relation);

    expect(delegatedClasses()).toHaveLength(1);
  });

  /**
   * Per model rather than shared: methods compiled into `Post`'s relation class
   * are not on `Comment`'s, so `Comment.all.published` is a missing method
   * rather than a query against the wrong table.
   */
  it("belongs to one model", () => {
    class Post {}
    class Comment {}
    initializeRelationDelegateCache(Post, [Relation]);
    initializeRelationDelegateCache(Comment, [Relation]);

    generateRelationMethod(Post, "published", () => "published posts");

    const posts = relationDelegateClass(Post, Relation) as unknown as new () => {
      published?: () => string;
    };
    const comments = relationDelegateClass(Comment, Relation) as unknown as new () => {
      published?: () => string;
    };

    expect(new posts().published?.()).toBe("published posts");
    expect(new comments().published).toBeUndefined();
  });

  it("is still a relation", () => {
    class Post {}
    initializeRelationDelegateCache(Post, [Relation]);

    const subclass = relationDelegateClass(Post, Relation) as unknown as new () => Relation;

    expect(new subclass()).toBeInstanceOf(Relation);
    expect(new subclass().where()).toBe("where");
  });

  it("is named after the model and the kind", () => {
    class Post {}
    initializeRelationDelegateCache(Post, [Relation]);

    expect(relationDelegateClass(Post, Relation)?.name).toBe("Post_Relation");
  });

  it("has none for a kind that was not built", () => {
    class Post {}
    initializeRelationDelegateCache(Post, [Relation]);

    expect(relationDelegateClass(Post, CollectionProxy)).toBeUndefined();
  });

  /**
   * A scope has to work the same on `Post.all`, on `post.comments` and on a
   * chained relation; on only one of them it is missing exactly where the chain
   * got long enough to be worth having.
   */
  it("gets a compiled method on every kind", () => {
    class Post {}
    initializeRelationDelegateCache(Post, [Relation, CollectionProxy]);

    expect(generateRelationMethod(Post, "published", () => "yes")).toBe(2);

    for (const base of [Relation, CollectionProxy]) {
      const subclass = relationDelegateClass(Post, base) as unknown as new () => {
        published: () => string;
      };

      expect(new subclass().published()).toBe("yes");
    }
  });

  it("builds the cache on demand", () => {
    class Post {}
    registerDelegatedClass(Relation);

    expect(generateRelationMethod(Post, "published", () => "yes")).toBe(1);
    expect(relationDelegateClass(Post, Relation)).toBeDefined();
  });

  /**
   * A compiled method lands on the subclass, so it shadows the base's method of
   * that name. That is not a bug to fix here — it is exactly why
   * `uncacheableMethods` exists to name the methods a caller must not compile.
   */
  it("shadows the base's method of the same name", () => {
    class Post {}
    initializeRelationDelegateCache(Post, [CollectionProxy]);
    generateRelationMethod(Post, "build", () => "compiled");

    const subclass = relationDelegateClass(Post, CollectionProxy) as unknown as new () => {
      build: () => string;
    };

    expect(new subclass().build()).toBe("compiled");

    registerDelegatedClass(Relation);
    registerDelegatedClass(CollectionProxy);

    expect(uncacheableMethods(Relation).has("build")).toBe(true);
  });
});

describe("what must not be compiled into a delegation", () => {
  class Relation {
    where(): string {
      return "where";
    }
  }
  class CollectionProxy extends Relation {
    build(): string {
      return "build";
    }
  }

  /**
   * `post.comments.build` delegated to the model would build against `Comment`
   * and lose the owner — a record saved with a null foreign key rather than an
   * error.
   */
  it("is what a delegated kind has and the base relation does not", () => {
    registerDelegatedClass(Relation);
    registerDelegatedClass(CollectionProxy);

    expect([...uncacheableMethods(Relation)]).toEqual(["build"]);
  });

  it("is nothing when every kind is the base", () => {
    registerDelegatedClass(Relation);

    expect([...uncacheableMethods(Relation)]).toEqual([]);
  });
});
