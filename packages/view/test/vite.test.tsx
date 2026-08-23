/**
 * Vite integration.
 *
 * There is no Rails fixture to port: Propshaft fingerprints assets itself and
 * Vite writes a manifest saying what it built. What is tested is reading that
 * manifest correctly — and in particular collecting the CSS through the whole
 * import graph, which is the one mistake that only shows up in production.
 */

import { describe, expect, it } from "bun:test";
import { Current } from "@altair/support";
import { renderToString } from "../src/render.js";
import {
  assetUrl,
  configureVite,
  resolveEntry,
  viteAsset,
  ViteAssets,
  type ViteManifest,
} from "../src/vite.js";

/** The shape Vite writes, including a chunk that brings its own stylesheet. */
const manifest: ViteManifest = {
  "app/frontend/entrypoint.tsx": {
    file: "assets/entrypoint-a1b2c3.js",
    name: "entrypoint",
    src: "app/frontend/entrypoint.tsx",
    isEntry: true,
    css: ["assets/entrypoint-d4e5f6.css"],
    imports: ["_shared-g7h8i9.js"],
  },
  "_shared-g7h8i9.js": {
    file: "assets/shared-g7h8i9.js",
    css: ["assets/shared-j1k2l3.css"],
    imports: ["_deep-m4n5o6.js"],
  },
  "_deep-m4n5o6.js": {
    file: "assets/deep-m4n5o6.js",
    css: ["assets/deep-p7q8r9.css"],
  },
  "app/frontend/logo.svg": {
    file: "assets/logo-s1t2u3.svg",
  },
};

describe("resolving an entry", () => {
  it("finds the built module", () => {
    expect(resolveEntry(manifest, "app/frontend/entrypoint.tsx").script).toBe(
      "assets/entrypoint-a1b2c3.js",
    );
  });

  // The mistake that works in development and not in production: a chunk two
  // levels down brings a stylesheet the page needs.
  it("collects stylesheets through the whole import graph", () => {
    const { styles } = resolveEntry(manifest, "app/frontend/entrypoint.tsx");

    expect(styles).toEqual([
      "assets/entrypoint-d4e5f6.css",
      "assets/shared-j1k2l3.css",
      "assets/deep-p7q8r9.css",
    ]);
  });

  it("preloads the chunks the entry will ask for", () => {
    const { preloads } = resolveEntry(manifest, "app/frontend/entrypoint.tsx");
    expect(preloads).toContain("assets/shared-g7h8i9.js");
  });

  it("visits a shared chunk once", () => {
    const diamond: ViteManifest = {
      entry: { file: "e.js", isEntry: true, imports: ["a", "b"] },
      a: { file: "a.js", imports: ["shared"] },
      b: { file: "b.js", imports: ["shared"] },
      shared: { file: "shared.js", css: ["shared.css"] },
    };

    const resolved = resolveEntry(diamond, "entry");
    expect(resolved.styles).toEqual(["shared.css"]);
    expect(resolved.preloads.filter((file) => file === "shared.js")).toHaveLength(1);
  });

  it("names the entries it knows when asked for one it does not", () => {
    expect(() => resolveEntry(manifest, "nope.tsx")).toThrow(
      "Entries: app/frontend/entrypoint.tsx",
    );
  });

  it("handles an entry with nothing imported", () => {
    const plain: ViteManifest = { "main.ts": { file: "assets/main.js", isEntry: true } };
    const resolved = resolveEntry(plain, "main.ts");

    expect(resolved.styles).toEqual([]);
    expect(resolved.preloads).toEqual([]);
  });
});

describe("asset urls", () => {
  it("join the base", () => {
    expect(assetUrl("assets/app.js", "/")).toBe("/assets/app.js");
    expect(assetUrl("assets/app.js", "/static/")).toBe("/static/assets/app.js");
  });

  it("leave an absolute url alone", () => {
    expect(assetUrl("https://cdn.example.com/app.js", "/static/")).toBe(
      "https://cdn.example.com/app.js",
    );
  });
});

describe("the tags in production", () => {
  const settings = { manifest, base: "/" };

  it("load the built module", async () => {
    const html = await renderToString(
      <ViteAssets entry="app/frontend/entrypoint.tsx" config={settings} />,
    );

    expect(html).toContain('<script type="module" src="/assets/entrypoint-a1b2c3.js">');
  });

  it("link every stylesheet", async () => {
    const html = await renderToString(
      <ViteAssets entry="app/frontend/entrypoint.tsx" config={settings} />,
    );

    expect(html).toContain('<link rel="stylesheet" href="/assets/entrypoint-d4e5f6.css">');
    expect(html).toContain('<link rel="stylesheet" href="/assets/deep-p7q8r9.css">');
  });

  it("preload the chunks", async () => {
    const html = await renderToString(
      <ViteAssets entry="app/frontend/entrypoint.tsx" config={settings} />,
    );

    expect(html).toContain('<link rel="modulepreload" href="/assets/shared-g7h8i9.js">');
  });

  // Stylesheets before the module, so the page is not laid out twice.
  it("put the stylesheets first", async () => {
    const html = await renderToString(
      <ViteAssets entry="app/frontend/entrypoint.tsx" config={settings} />,
    );

    expect(html.indexOf("stylesheet")).toBeLessThan(html.indexOf('type="module"'));
  });

  it("respect a base the assets are served from", async () => {
    const html = await renderToString(
      <ViteAssets entry="app/frontend/entrypoint.tsx" config={{ manifest, base: "/static/" }} />,
    );

    expect(html).toContain('src="/static/assets/entrypoint-a1b2c3.js"');
  });
});

describe("the tags in development", () => {
  const settings = { devServer: "http://localhost:5173" };

  // Vite serves the modules itself, so nothing is built and the manifest is
  // not consulted at all.
  it("load Vite's client and the source module", async () => {
    const html = await renderToString(
      <ViteAssets entry="app/frontend/entrypoint.tsx" config={settings} />,
    );

    expect(html).toContain('src="http://localhost:5173/@vite/client"');
    expect(html).toContain('src="http://localhost:5173/app/frontend/entrypoint.tsx"');
  });

  it("need no manifest", async () => {
    const html = await renderToString(<ViteAssets entry="anything.tsx" config={settings} />);
    expect(html).toContain("@vite/client");
  });

  it("say so when neither is configured", async () => {
    await expect(renderToString(<ViteAssets entry="app.tsx" config={{}} />)).rejects.toThrow(
      "Vite is not configured",
    );
  });
});

// A policy that allows one nonce is no use if the tag the framework writes
// does not carry it.
describe("with a content security policy", () => {
  it("carries the nonce onto the script tag", async () => {
    await Current.run({ cspNonce: "abc123" }, async () => {
      const html = await renderToString(
        <ViteAssets entry="app/frontend/entrypoint.tsx" config={{ manifest }} />,
      );

      expect(html).toContain('nonce="abc123"');
    });
  });

  it("writes no nonce when there is none", async () => {
    const html = await renderToString(
      <ViteAssets entry="app/frontend/entrypoint.tsx" config={{ manifest }} />,
    );

    expect(html).not.toContain("nonce=");
  });
});

describe("a single asset", () => {
  it("resolves through the manifest", () => {
    expect(viteAsset("app/frontend/logo.svg", { manifest, base: "/" })).toBe(
      "/assets/logo-s1t2u3.svg",
    );
  });

  it("is served from the dev server in development", () => {
    expect(viteAsset("app/frontend/logo.svg", { devServer: "http://localhost:5173" })).toBe(
      "http://localhost:5173/app/frontend/logo.svg",
    );
  });

  it("says when it does not know one", () => {
    expect(() => viteAsset("missing.svg", { manifest })).toThrow(
      'No Vite asset named "missing.svg"',
    );
  });
});

describe("configuring globally", () => {
  it("is what the component uses when given nothing", async () => {
    configureVite({ manifest, base: "/" });

    const html = await renderToString(<ViteAssets entry="app/frontend/entrypoint.tsx" />);
    expect(html).toContain("/assets/entrypoint-a1b2c3.js");

    configureVite({ base: "/" });
  });
});

// Taken verbatim from what Vite 7 wrote for two entries sharing a static
// import. Fixtures written from the same assumptions as the code agree with
// it by construction; this one did not come from here.
describe("a manifest Vite actually wrote", () => {
  const real: ViteManifest = {
    "_shared-9z0Iyj3G.css": { file: "assets/shared-9z0Iyj3G.css", src: "_shared-9z0Iyj3G.css" },
    "_shared-SBzk6Ca2.js": {
      file: "assets/shared-SBzk6Ca2.js",
      name: "shared",
      css: ["assets/shared-9z0Iyj3G.css"],
    },
    "src/entry.js": {
      file: "assets/entry-DTstGvjZ.js",
      name: "entry",
      src: "src/entry.js",
      isEntry: true,
      imports: ["_shared-SBzk6Ca2.js"],
      css: ["assets/entry-W1erjkBN.css"],
    },
    "src/other.js": {
      file: "assets/other-BCNo0t_l.js",
      name: "other",
      src: "src/other.js",
      isEntry: true,
      imports: ["_shared-SBzk6Ca2.js"],
    },
  };

  // The shared chunk's stylesheet hangs off the chunk, not the entry. Reading
  // only the entry's own `css` ships a page missing its shared styles, in
  // production and nowhere else.
  it("finds the stylesheet on the imported chunk", () => {
    expect(resolveEntry(real, "src/entry.js").styles).toEqual([
      "assets/entry-W1erjkBN.css",
      "assets/shared-9z0Iyj3G.css",
    ]);
  });

  it("gives a second entry the shared stylesheet too", () => {
    expect(resolveEntry(real, "src/other.js").styles).toEqual(["assets/shared-9z0Iyj3G.css"]);
  });

  it("preloads the shared chunk", () => {
    expect(resolveEntry(real, "src/entry.js").preloads).toEqual(["assets/shared-SBzk6Ca2.js"]);
  });

  // Vite lists these separately, and it loads their CSS when the chunk is
  // fetched. Preloading them would spend bandwidth on a page that may never
  // reach that code.
  it("leaves a dynamic import to be fetched when it is reached", () => {
    const lazy: ViteManifest = {
      "src/entry.js": {
        file: "assets/entry.js",
        isEntry: true,
        dynamicImports: ["src/lazy.js"],
        css: ["assets/entry.css"],
      },
      "src/lazy.js": { file: "assets/lazy.js", isDynamicEntry: true, css: ["assets/lazy.css"] },
    };

    const resolved = resolveEntry(lazy, "src/entry.js");
    expect(resolved.styles).toEqual(["assets/entry.css"]);
    expect(resolved.preloads).toEqual([]);
  });
});
