/**
 * Permissions Policy.
 *
 * Mirrors actionpack/test/dispatch/permissions_policy_test.rb.
 *
 * The header says which browser features a page may use, and — the part that
 * earns it — which of them the frames it embeds may use. A page with no policy
 * can be asked for the camera by any third-party frame it loads, and the
 * prompt the user sees says the top-level site's name.
 *
 * Most of these are about the syntax, because it fails open: `camera=()`
 * forbids it and `camera=*` allows it everywhere, and the difference is two
 * characters.
 */

import { describe, expect, it } from "bun:test";
import { PermissionsPolicy, permissionsPolicy } from "../src/permissions-policy.js";

const header = (policy: PermissionsPolicy) => policy.toString();

describe("the value it builds", () => {
  it("forbids a feature with an empty list", () => {
    expect(header(new PermissionsPolicy().camera("none"))).toBe("camera=()");
  });

  it("allows one to this origin", () => {
    expect(header(new PermissionsPolicy().geolocation("self"))).toBe("geolocation=(self)");
  });

  it("allows one everywhere", () => {
    expect(header(new PermissionsPolicy().autoplay("*"))).toBe("autoplay=(*)");
  });

  // `self` is bare and an origin is quoted, which is the opposite of how a
  // Content Security Policy spells the same idea.
  it("quotes an origin and not a keyword", () => {
    expect(header(new PermissionsPolicy().fullscreen("self", "https://player.example.com"))).toBe(
      'fullscreen=(self "https://player.example.com")',
    );
  });

  it("separates directives with a comma", () => {
    const policy = new PermissionsPolicy().camera("none").microphone("self");

    expect(header(policy)).toBe("camera=(), microphone=(self)");
  });

  // The header spells it `picture-in-picture`; the method is a method name.
  it("writes a feature name the way the header does", () => {
    expect(header(new PermissionsPolicy().pictureInPicture("self"))).toStartWith(
      "picture-in-picture=",
    );
    expect(header(new PermissionsPolicy().encryptedMedia("self"))).toStartWith("encrypted-media=");
  });

  it("takes a feature it has never heard of", () => {
    expect(header(new PermissionsPolicy().allow("browsing-topics", "none"))).toBe(
      "browsing-topics=()",
    );
  });

  it("treats naming a feature with no sources as forbidding it", () => {
    expect(header(new PermissionsPolicy().allow("camera"))).toBe("camera=()");
  });

  it("lets a later call replace an earlier one", () => {
    const policy = new PermissionsPolicy().camera("self").camera("none");

    expect(header(policy)).toBe("camera=()");
  });

  it("says nothing when nothing was said", () => {
    expect(header(new PermissionsPolicy())).toBe("");
  });
});

describe("the middleware", () => {
  const send = async (policy: PermissionsPolicy) =>
    await permissionsPolicy(policy)(
      new Request("http://test.host/"),
      async () => new Response("ok"),
    );

  it("sets the header", async () => {
    const response = await send(new PermissionsPolicy().camera("none"));

    expect(response.headers.get("permissions-policy")).toBe("camera=()");
  });

  it("leaves the response otherwise alone", async () => {
    const response = await send(new PermissionsPolicy().camera("none"));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  // An empty `Permissions-Policy` is not the same as no policy, and a header
  // meaning "no opinion" is worth leaving off rather than guessing at.
  it("sends nothing when the policy says nothing", async () => {
    const response = await send(new PermissionsPolicy());

    expect(response.headers.get("permissions-policy")).toBeNull();
  });
});
