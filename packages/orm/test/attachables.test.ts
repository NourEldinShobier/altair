/**
 * Records embedded in rich text, ported from
 * `actiontext/test/unit/attachment_test.rb` and `attachable_test.rb`.
 *
 * The half of rich text that was missing. A body could hold formatting and
 * links; it could not hold a record. The cases that matter are the security
 * ones — a body is user input, so a placeholder anybody can type must not
 * become a way to read a row they cannot see.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  attachablesIn,
  attachmentsIn,
  configureAttachables,
  fromAttachable,
  fromAttachableSgid,
  fromAttachables,
  renderAttachments,
  resetAttachables,
  signedIdFor,
  toPlainText,
} from "../src/attachables.js";

/** A record, near enough: an id, a class name, and something to show. */
class Person {
  constructor(
    readonly id: number,
    readonly name: string,
  ) {}

  static rows = new Map<number, Person>([
    [1, new Person(1, "Ada")],
    [2, new Person(2, "Grace")],
  ]);

  static async find(id: unknown): Promise<Person> {
    const found = Person.rows.get(Number(id));
    if (!found) throw new Error("not found");

    return found;
  }
}

class Secret {
  constructor(readonly id: number) {}

  static async find(id: unknown): Promise<Secret> {
    return new Secret(Number(id));
  }
}

const ada = () => Person.rows.get(1) as unknown as Parameters<typeof fromAttachable>[0];

beforeEach(() => {
  configureAttachables({ secret: "a".repeat(64), classes: { Person } });
});

afterEach(() => {
  resetAttachables();
});

describe("a placeholder for a record", () => {
  it("carries a signed id", () => {
    const html = fromAttachable(ada());

    expect(html).toStartWith("<action-text-attachment ");
    expect(html).toContain('sgid="');
    expect(html).toEndWith("></action-text-attachment>");
  });

  it("carries whatever else it is given", () => {
    const html = fromAttachable(ada(), { contentType: "text/plain", caption: "A note" });

    // Spelled as the markup spells it rather than as JavaScript does.
    expect(html).toContain('content-type="text/plain"');
    expect(html).toContain('caption="A note"');
  });

  it("escapes what goes in an attribute", () => {
    expect(fromAttachable(ada(), { caption: '"><script>' })).not.toContain("<script>");
  });

  it("takes several at once, in order", () => {
    const html = fromAttachables([Person.rows.get(1) as never, Person.rows.get(2) as never]);

    expect(attachmentsIn(html)).toHaveLength(2);
  });
});

describe("reading a placeholder back", () => {
  it("finds the record it names", async () => {
    const found = (await fromAttachableSgid(signedIdFor(ada()))) as Person;

    expect(found.name).toBe("Ada");
  });

  it("finds every record a body embeds", async () => {
    const html = `<p>Hello ${fromAttachable(Person.rows.get(1) as never)} and ${fromAttachable(Person.rows.get(2) as never)}</p>`;

    expect(((await attachablesIn(html)) as Person[]).map((one) => one.name)).toEqual([
      "Ada",
      "Grace",
    ]);
  });

  /**
   * A body is user input. Without a signature anybody could type a placeholder
   * naming a record they cannot see, and the page would render it for them.
   */
  it("refuses an id nobody signed", async () => {
    expect(await fromAttachableSgid("Person/1")).toBeNull();
  });

  it("refuses one signed with another secret", async () => {
    const signed = signedIdFor(ada());

    configureAttachables({ secret: "b".repeat(64), classes: { Person } });

    expect(await fromAttachableSgid(signed)).toBeNull();
  });

  it("refuses a tampered one", async () => {
    const signed = signedIdFor(ada());

    expect(await fromAttachableSgid(`${signed.slice(0, -4)}AAAA`)).toBeNull();
  });

  /**
   * A signature proves the id was minted here. It does not prove the class is
   * one the application meant to expose — so only a registered class is
   * looked up, and the list is required rather than optional.
   */
  it("refuses a class that was not registered", async () => {
    configureAttachables({ secret: "a".repeat(64), classes: { Person, Secret } });
    const signed = signedIdFor(new Secret(1) as never);

    configureAttachables({ secret: "a".repeat(64), classes: { Person } });

    expect(await fromAttachableSgid(signed)).toBeNull();
  });

  // A record can be deleted after the body was written, and that is not the
  // reader's problem.
  it("leaves out a record that has gone", async () => {
    const signed = signedIdFor({ id: 99, constructor: { name: "Person" } } as never);
    const html = `<p>${fromAttachable(ada())}</p><p><action-text-attachment sgid="${signed}"></action-text-attachment></p>`;

    expect(await attachablesIn(html)).toHaveLength(1);
  });

  it("says nothing without a secret configured", () => {
    resetAttachables();

    expect(() => signedIdFor(ada())).toThrow(/configureAttachables/);
  });
});

describe("rendering a body", () => {
  it("replaces each placeholder with what the application says", async () => {
    const html = `<p>Hello ${fromAttachable(ada())}!</p>`;

    const rendered = await renderAttachments(html, (record) => `<b>${(record as Person).name}</b>`);

    expect(rendered).toBe("<p>Hello <b>Ada</b>!</p>");
  });

  it("hands the attributes over as well as the record", async () => {
    const html = fromAttachable(ada(), { caption: "A note" });

    const rendered = await renderAttachments(
      html,
      (_record, attachment) => attachment.caption ?? "",
    );

    expect(rendered).toBe("A note");
  });

  it("renders a missing record as nothing", async () => {
    const signed = signedIdFor({ id: 99, constructor: { name: "Person" } } as never);

    expect(
      await renderAttachments(
        `<p><action-text-attachment sgid="${signed}"></action-text-attachment></p>`,
        () => "x",
      ),
    ).toBe("<p></p>");
  });

  it("leaves a body with no placeholders alone", async () => {
    expect(await renderAttachments("<p>Plain</p>", () => "x")).toBe("<p>Plain</p>");
  });
});

describe("a body as words", () => {
  it("strips the markup and describes the records", async () => {
    const html = `<h1>Title</h1><p>Hello ${fromAttachable(ada())}</p>`;

    expect(await toPlainText(html, (record) => (record as Person).name)).toBe("Title\nHello Ada");
  });

  it("turns breaks into newlines", async () => {
    expect(await toPlainText("<p>a<br>b</p>")).toBe("a\nb");
  });

  it("describes an attachment generically when not told how", async () => {
    expect(await toPlainText(`<p>${fromAttachable(ada())}</p>`)).toBe("[attachment]");
  });
});
