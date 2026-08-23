/**
 * ActiveModel.
 *
 * Mirrors activemodel/test/cases/{naming,validations,errors,serialization,
 * dirty,conversion}_test.rb — the part of a model that has nothing to do with
 * a database, and which Rails keeps separate precisely so a form object can
 * use it without inventing a table.
 */

import { describe, expect, it } from "bun:test";
import { Connection, Model, SchemaStatements, setConnection } from "../src/index.js";
import {
  ActiveModel,
  errorHeading,
  humanAttributeName,
  ModelName,
  modelNameFor,
  partialPathFor,
  ValidationErrors,
} from "../src/index.js";

class Signup extends ActiveModel {
  declare email: string;
  declare terms: boolean;
  declare age: number;

  static {
    this.validates("email", { presence: true, format: { with: /@/ } });
    this.validates("terms", { acceptance: true });
    this.validates("age", { numericality: { greaterThan: 12 }, allowNil: true });
  }

  get domain(): string {
    return this.email?.split("@")[1] ?? "";
  }
}

class BlogPost extends ActiveModel {
  declare title: string;
}

describe("naming", () => {
  it("derives every name from the class name", () => {
    const name = new ModelName("BlogPost");

    expect(name.name).toBe("BlogPost");
    expect(name.singular).toBe("blog_post");
    expect(name.plural).toBe("blog_posts");
    expect(name.element).toBe("blog_post");
    expect(name.collection).toBe("blog_posts");
  });

  // The key a form nests its fields under, and the name the route helpers get.
  // They come from one place so they cannot disagree.
  it("names the form key and the route helpers", () => {
    const name = new ModelName("BlogPost");

    expect(name.paramKey).toBe("blog_post");
    expect(name.routeKey).toBe("blogPosts");
    expect(name.singularRouteKey).toBe("blogPost");
  });

  it("follows the inflections", () => {
    expect(new ModelName("Person").plural).toBe("people");
    expect(new ModelName("Category").plural).toBe("categories");
  });

  it("gives a heading nobody has translated yet", () => {
    expect(new ModelName("BlogPost").human).toBe("Blog post");
  });

  it("names the partial a record renders with", () => {
    expect(new ModelName("BlogPost").partialPath).toBe("blog_posts/blog_post");
    expect(partialPathFor(new BlogPost())).toBe("blog_posts/blog_post");
  });

  it("hangs off the class and the record alike", () => {
    expect(BlogPost.modelName.singular).toBe("blog_post");
    expect(new BlogPost().modelName.singular).toBe("blog_post");
  });

  it("computes it once", () => {
    expect(modelNameFor(BlogPost)).toBe(modelNameFor(BlogPost));
  });

  it("reads as its name in a string", () => {
    expect(`${new ModelName("BlogPost")}`).toBe("BlogPost");
  });
});

describe("attributes", () => {
  it("takes them in the constructor", () => {
    const signup = new Signup({ email: "a@b.com", terms: true });

    expect(signup.email).toBe("a@b.com");
    expect(signup.terms).toBe(true);
  });

  it("reports them, and nothing else", () => {
    expect(new Signup({ email: "a@b.com" }).attributes()).toEqual({ email: "a@b.com" });
  });

  // `errors` and the dirty snapshot are on the object, so they have to be
  // hidden from enumeration or every serialization would carry them.
  it("keeps the bookkeeping out of them", () => {
    const keys = Object.keys(new Signup({ email: "a@b.com" }));
    expect(keys).toEqual(["email"]);
  });

  // A class field with an initializer runs after the base constructor, so it
  // overwrites whatever the constructor assigned. Found by trying it; `build`
  // assigns after construction and is right either way.
  it("survives a field with a default", () => {
    class Filter extends ActiveModel {
      query = "";
      page = 1;
    }

    expect(new Filter({ query: "bun" }).query).toBe("");
    expect(Filter.build({ query: "bun" }).query).toBe("bun");
    expect(Filter.build({ query: "bun" }).page).toBe(1);
    expect(Filter.build({ query: "bun" }).changed()).toEqual([]);
  });

  it("assigns more later", () => {
    const signup = new Signup({ email: "a@b.com" });
    signup.assign({ terms: true });

    expect(signup.terms).toBe(true);
  });
});

describe("validations", () => {
  it("passes a record that satisfies them", async () => {
    expect(await new Signup({ email: "a@b.com", terms: true }).validate()).toBe(true);
  });

  it("fails one that does not", async () => {
    const signup = new Signup({ email: "", terms: false });

    expect(await signup.validate()).toBe(false);
    expect(signup.errors.on("email")).toContain("can't be blank");
    expect(signup.errors.on("terms")).toContain("must be accepted");
  });

  it("fills the errors even when the caller only reads the boolean", async () => {
    const signup = new Signup({ email: "nope" });
    await signup.validate();

    expect(signup.errors.fullMessages()).toContain("Email is invalid");
  });

  it("clears the previous run", async () => {
    const signup = new Signup({ email: "" });
    await signup.validate();

    signup.assign({ email: "a@b.com", terms: true });
    await signup.validate();

    expect(signup.errors.isEmpty).toBe(true);
  });

  it("skips a rule when the value is allowed to be missing", async () => {
    const signup = new Signup({ email: "a@b.com", terms: true });
    expect(await signup.validate()).toBe(true);
  });

  it("applies it when the value is there", async () => {
    const signup = new Signup({ email: "a@b.com", terms: true, age: 4 });

    expect(await signup.validate()).toBe(false);
    expect(signup.errors.on("age")).toContain("must be greater than 12");
  });

  it("runs rules written in code too", async () => {
    class Booking extends ActiveModel {
      declare nights: number;

      override async runValidations(): Promise<void> {
        if (this.nights > 30) this.errors.add("nights", "is longer than we take bookings for");
      }
    }

    const booking = new Booking({ nights: 40 });
    expect(await booking.validate()).toBe(false);
    expect(booking.errors.on("nights")).toHaveLength(1);
  });

  // Copy on write: a subclass adding rules must not add them to its parent.
  it("does not leak a subclass's rules into its parent", async () => {
    class Trial extends Signup {
      static {
        this.validates("company", { presence: true });
      }
      declare company: string;
    }

    expect(Trial.validations.length).toBe(Signup.validations.length + 1);
    expect(Signup.validations.some((v) => v.attribute === "company")).toBe(false);
    expect(await new Trial({ email: "a@b.com", terms: true }).validate()).toBe(false);
  });

  it("answers `invalid?` as well", async () => {
    expect(await new Signup({ email: "" }).isInvalid()).toBe(true);
  });
});

describe("errors", () => {
  const errors = () => {
    const collected = new ValidationErrors();
    collected.add("first_name", "can't be blank");
    collected.add("first_name", "is too short (minimum is 2 characters)");
    collected.add("age", "is not a number");
    return collected;
  };

  it("counts every message, not every attribute", () => {
    expect(errors().count).toBe(3);
    expect(errors().size).toBe(3);
    expect(errors().attributes).toEqual(["first_name", "age"]);
  });

  // These go straight into a page, and every Rails form shows the humanized
  // form of the attribute in front of the message.
  it("humanizes the attribute in a full message", () => {
    expect(errors().fullMessages()).toContain("First name can't be blank");
    expect(errors().fullMessage("age", "is not a number")).toBe("Age is not a number");
  });

  it("gives the full messages for one attribute", () => {
    expect(errors().fullMessagesFor("age")).toEqual(["Age is not a number"]);
    expect(errors().fullMessagesFor("nothing")).toEqual([]);
  });

  it("says whether an attribute went wrong", () => {
    expect(errors().has("age")).toBe(true);
    expect(errors().has("email")).toBe(false);
  });

  it("says whether a particular message was added", () => {
    expect(errors().added("age", "is not a number")).toBe(true);
    expect(errors().added("age", "is not a duck")).toBe(false);
  });

  it("drops one attribute's errors", () => {
    const collected = errors();

    expect(collected.delete("age")).toEqual(["is not a number"]);
    expect(collected.has("age")).toBe(false);
    expect(collected.count).toBe(2);
  });

  it("iterates attribute and message pairs", () => {
    expect([...errors()]).toContainEqual({ attribute: "age", message: "is not a number" });
    expect([...errors()]).toHaveLength(3);
  });

  it("serializes as messages by attribute", () => {
    expect(JSON.parse(JSON.stringify(errors()))).toEqual({
      first_name: ["can't be blank", "is too short (minimum is 2 characters)"],
      age: ["is not a number"],
    });
  });

  it("humanizes an attribute on its own, for a label", () => {
    expect(humanAttributeName("first_name")).toBe("First name");
    expect(humanAttributeName("author_id")).toBe("Author");
  });

  it("writes the heading a scaffold puts above the form", () => {
    expect(errorHeading(1)).toBe("1 error prohibited this record from being saved");
    expect(errorHeading(3)).toBe("3 errors prohibited this record from being saved");
  });
});

describe("serialization", () => {
  const signup = () => new Signup({ email: "a@b.com", terms: true, age: 30 });

  it("is the attributes by default", () => {
    expect(signup().serializableHash()).toEqual({ email: "a@b.com", terms: true, age: 30 });
  });

  it("takes only what it was asked for", () => {
    expect(signup().serializableHash({ only: ["email"] })).toEqual({ email: "a@b.com" });
  });

  it("leaves out what it was told to", () => {
    expect(signup().serializableHash({ except: ["age", "terms"] })).toEqual({ email: "a@b.com" });
  });

  // Rails ignores `except` when `only` is given, rather than intersecting.
  it("ignores except when only is given", () => {
    expect(signup().serializableHash({ only: ["email"], except: ["email"] })).toEqual({
      email: "a@b.com",
    });
  });

  it("includes methods it is asked for", () => {
    expect(signup().serializableHash({ only: [], methods: ["domain"] })).toEqual({
      domain: "b.com",
    });
  });

  it("goes through JSON.stringify", () => {
    expect(JSON.parse(JSON.stringify(signup()))).toEqual({
      email: "a@b.com",
      terms: true,
      age: 30,
    });
  });
});

describe("conversion", () => {
  it("has nowhere to be stored", () => {
    const signup = new Signup({ email: "a@b.com" });

    expect(signup.persisted).toBe(false);
    expect(signup.toKey()).toBeNull();
    expect(signup.toParam()).toBeNull();
  });

  it("names its partial", () => {
    expect(new BlogPost().toPartialPath()).toBe("blog_posts/blog_post");
  });
});

describe("dirty tracking", () => {
  it("starts clean", () => {
    const signup = new Signup({ email: "a@b.com" });

    expect(signup.hasChanged()).toBe(false);
    expect(signup.changed()).toEqual([]);
  });

  it("reports what changed, and what it was", () => {
    const signup = new Signup({ email: "a@b.com" });
    signup.email = "c@d.com";

    expect(signup.changed()).toEqual(["email"]);
    expect(signup.changes()).toEqual({ email: ["a@b.com", "c@d.com"] });
    expect(signup.attributeWas("email")).toBe("a@b.com");
    expect(signup.hasChanged("email")).toBe(true);
    expect(signup.hasChanged("age")).toBe(false);
  });

  it("does not count a value set back to what it was", () => {
    const signup = new Signup({ email: "a@b.com" });
    signup.email = "c@d.com";
    signup.email = "a@b.com";

    expect(signup.hasChanged()).toBe(false);
  });

  // What a form does when the person cancels.
  it("puts the changes back", () => {
    const signup = new Signup({ email: "a@b.com", terms: true });
    signup.email = "c@d.com";
    signup.terms = false;

    signup.restoreAttributes(["email"]);
    expect(signup.email).toBe("a@b.com");
    expect(signup.terms).toBe(false);

    signup.restoreAttributes();
    expect(signup.terms).toBe(true);
  });

  it("takes a fresh snapshot when told to", () => {
    const signup = new Signup({ email: "a@b.com" });
    signup.email = "c@d.com";
    signup.changesApplied();

    expect(signup.hasChanged()).toBe(false);
    expect(signup.attributeWas("email")).toBe("c@d.com");
  });
});

// The point of putting these on both: a view handed a record should not have
// to know whether it came out of a table.
describe("a database-backed model has the same API", () => {
  interface ArticleRow {
    id: number;
    title: string;
    body: string;
  }

  class Article extends Model<ArticleRow>("articles") {
    get excerpt(): string {
      return String(this.body).slice(0, 5);
    }
  }

  const setup = async () => {
    const connection = new Connection("sqlite://:memory:");
    setConnection(connection);
    Article.columnCache = undefined;
    Article.columnTypeCache = undefined;

    await new SchemaStatements(connection).createTable("articles", (t) => {
      t.string("title");
      t.text("body");
    });
  };

  it("names itself the same way", async () => {
    await setup();
    const article = await Article.create({ title: "Hello", body: "World" });

    expect(Article.modelName.paramKey).toBe("article");
    expect(article.modelName.human).toBe("Article");
    expect(article.toPartialPath()).toBe("articles/article");
  });

  it("serializes the same way", async () => {
    await setup();
    const article = await Article.create({ title: "Hello", body: "World" });

    expect(article.serializableHash({ only: ["title"], methods: ["excerpt"] })).toEqual({
      title: "Hello",
      excerpt: "World",
    });
  });

  it("tracks changes the same way", async () => {
    await setup();
    const article = await Article.create({ title: "Hello", body: "World" });
    article.title = "Goodbye";

    expect(article.changes()).toEqual({ title: ["Hello", "Goodbye"] });
    expect(article.attributeWas("title")).toBe("Hello");

    article.restoreAttributes();
    expect(article.title).toBe("Hello");
    expect(article.hasChanged()).toBe(false);
  });

  it("reports the same full messages", async () => {
    await setup();
    Article.validates("title", { presence: true });

    const article = Article.build({ body: "no title" });
    await article.validate();

    expect(article.errors.fullMessages()).toEqual(["Title can't be blank"]);
  });
});
