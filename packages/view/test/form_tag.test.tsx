/**
 * `FormTag`, ported from `form_tag` in
 * `actionview/lib/action_view/helpers/form_tag_helper.rb` and the
 * `test_form_tag` cases in
 * `actionview/test/template/form_tag_helper_test.rb`.
 *
 * The `*_tag` family already had every field and no way to open the form they
 * go in, so the only way to use them was to write the element by hand. Two
 * things go wrong when somebody does, and neither fails visibly at the time.
 *
 * The authenticity token: a hand-written POST without one fails its own
 * submission with a 422 — the check working exactly as intended, against the
 * application's own page.
 *
 * The verb: a browser sends GET and POST and nothing else, so a hand-written
 * `method="delete"` is sent as a GET. The form appears to work and deletes
 * nothing, and a crawler following it deletes everything.
 */

import { describe, expect, it } from "bun:test";
import { Current } from "@altair/support";
import { FormTag } from "../src/form.js";
import { SearchFieldTag } from "../src/tags.js";
import { renderToString } from "../src/render.js";

const html = async (node: unknown): Promise<string> => await renderToString(node as never);

describe("the element", () => {
  it("posts by default", async () => {
    const rendered = await html(<FormTag url="/search" />);

    expect(rendered).toContain('<form action="/search" method="post"');
  });

  it("takes the action it was given", async () => {
    expect(await html(<FormTag url="/posts" />)).toContain('action="/posts"');
  });

  it("carries an id and a class", async () => {
    const rendered = await html(<FormTag url="/x" id="search" class="inline" />);

    expect(rendered).toContain('id="search"');
    expect(rendered).toContain('class="inline"');
  });

  it("carries anything else it was given", async () => {
    expect(await html(<FormTag url="/x" attributes={{ "data-turbo": "false" }} />)).toContain(
      'data-turbo="false"',
    );
  });

  it("holds the fields put inside it", async () => {
    const rendered = await html(
      <FormTag url="/search" method="get">
        <SearchFieldTag name="q" />
      </FormTag>,
    );

    expect(rendered).toContain('name="q"');
    expect(rendered).toContain("</form>");
  });
});

describe("the verb", () => {
  it("sends get as get", async () => {
    expect(await html(<FormTag url="/search" method="get" />)).toContain('method="get"');
  });

  /**
   * A browser sends GET and POST and nothing else, so anything else goes as a
   * POST carrying the verb the router reads.
   */
  it("sends a delete as a post that says so", async () => {
    const rendered = await html(<FormTag url="/posts/1" method="delete" />);

    expect(rendered).toContain('method="post"');
    expect(rendered).toContain('name="_method" value="delete"');
  });

  it("does the same for patch and put", async () => {
    expect(await html(<FormTag url="/posts/1" method="patch" />)).toContain('value="patch"');
    expect(await html(<FormTag url="/posts/1" method="put" />)).toContain('value="put"');
  });

  it("adds no override when the verb is one a browser sends", async () => {
    expect(await html(<FormTag url="/posts" method="post" />)).not.toContain("_method");
    expect(await html(<FormTag url="/posts" method="get" />)).not.toContain("_method");
  });
});

describe("the authenticity token", () => {
  it("is included on a post", async () => {
    expect(await html(<FormTag url="/posts" authenticityToken="abc123" />)).toContain(
      'name="authenticity_token" value="abc123"',
    );
  });

  it("is included on a delete, which is a post underneath", async () => {
    expect(
      await html(<FormTag url="/posts/1" method="delete" authenticityToken="abc123" />),
    ).toContain("authenticity_token");
  });

  /**
   * A GET changes nothing so it needs no token, and a token in a query string
   * is a token in browser history and in server logs.
   */
  it("is left out of a get", async () => {
    expect(
      await html(<FormTag url="/search" method="get" authenticityToken="abc123" />),
    ).not.toContain("authenticity_token");
  });

  /** Taken from the request when it was not given, which is what makes a form deep in a partial work. */
  it("comes from the request when the caller gave none", async () => {
    const rendered = await Current.run({ csrfToken: "from-request" }, async () =>
      html(<FormTag url="/posts" />),
    );

    expect(rendered).toContain('value="from-request"');
  });

  /**
   * For the rare form that posts to another origin. Asserted with a token in
   * scope, or it passes whether or not `null` does anything.
   */
  it("is left out when the caller says null", async () => {
    const rendered = await Current.run({ csrfToken: "from-request" }, async () =>
      html(<FormTag url="https://other.example" authenticityToken={null} />),
    );

    expect(rendered).not.toContain("authenticity_token");
  });

  it("is left out when there is none to be had", async () => {
    expect(await html(<FormTag url="/posts" />)).not.toContain("authenticity_token");
  });
});
