/**
 * Vite integration, in place of Rails' asset pipeline.
 *
 * Rails ships Propshaft to fingerprint assets and Sprockets before it. Vite
 * already does that and writes a manifest saying which built file each source
 * entry became, so the framework's job is only to read it and emit the right
 * tags — and to get out of the way entirely in development, where Vite serves
 * the modules itself.
 *
 *     <ViteAssets entry="app/frontend/entrypoint.tsx" />
 *
 * The part that is easy to get wrong, and only wrong in production: a chunk
 * the entry imports can bring its own stylesheet, so the CSS has to be
 * collected through the whole import graph. Missing it gives an unstyled page
 * that development never shows.
 */

import { useCspNonce } from "./context.js";
import type { Node } from "./render.js";

/** One entry in Vite's manifest. */
export interface ManifestChunk {
  file: string;
  name?: string;
  src?: string;
  isEntry?: boolean;
  css?: string[];
  assets?: string[];
  imports?: string[];
  dynamicImports?: string[];
  isDynamicEntry?: boolean;
}

export type ViteManifest = Record<string, ManifestChunk>;

export interface ViteConfig {
  /** The manifest Vite wrote. Absent in development. */
  manifest?: ViteManifest;
  /** Where built files are served from. */
  base?: string;
  /**
   * The dev server's origin. Set it and the manifest is ignored, because Vite
   * is serving the modules and nothing is built yet.
   */
  devServer?: string;
}

let config: ViteConfig = { base: "/" };

export function configureVite(next: ViteConfig): void {
  config = { base: "/", ...next };
}

export function viteConfig(): ViteConfig {
  return config;
}

/** Reads the manifest Vite writes, usually `dist/.vite/manifest.json`. */
export async function loadManifest(path: string): Promise<ViteManifest> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`No Vite manifest at ${path}. Run \`vite build\` first.`);
  }

  return (await file.json()) as ViteManifest;
}

export interface ResolvedEntry {
  /** The built module to load. */
  script: string;
  /** Every stylesheet the entry needs, its imports included. */
  styles: string[];
  /** Chunks worth fetching early, because the entry will ask for them. */
  preloads: string[];
}

/**
 * Everything an entry needs, found by walking the import graph.
 *
 * Depth-first through `imports`, because the CSS of a chunk two levels down is
 * as necessary as the entry's own — and it is exactly the kind of thing that
 * works in development and not in production.
 */
export function resolveEntry(manifest: ViteManifest, entry: string): ResolvedEntry {
  const chunk = manifest[entry];
  if (!chunk) {
    const entries = Object.keys(manifest).filter((key) => manifest[key]?.isEntry);
    throw new Error(
      entries.length > 0
        ? `No Vite entry named "${entry}". Entries: ${entries.join(", ")}.`
        : `No Vite entry named "${entry}".`,
    );
  }

  const styles: string[] = [];
  const preloads: string[] = [];
  const seen = new Set<string>();

  const walk = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);

    const current = manifest[name];
    if (!current) return;

    for (const stylesheet of current.css ?? []) {
      if (!styles.includes(stylesheet)) styles.push(stylesheet);
    }

    for (const imported of current.imports ?? []) {
      const dependency = manifest[imported];
      // A dynamic import is fetched when it is reached, so preloading it would
      // spend bandwidth on a page that may never ask.
      if (dependency && !preloads.includes(dependency.file)) preloads.push(dependency.file);
      walk(imported);
    }
  };

  walk(entry);

  return { script: chunk.file, styles, preloads };
}

/** A built file's public URL. */
export function assetUrl(file: string, base: string = config.base ?? "/"): string {
  if (/^(https?:)?\/\//.test(file)) return file;
  return `${base.replace(/\/$/, "")}/${file.replace(/^\//, "")}`;
}

/**
 * The tags an entry needs.
 *
 * In development this is Vite's client plus the source module, served by the
 * dev server. In production it is the built module, its stylesheets, and a
 * preload for each chunk it will ask for.
 */
export function ViteAssets(props: { entry: string; config?: ViteConfig }): Node {
  const settings = props.config ?? config;
  const nonce = useCspNonce();
  const scriptAttributes = nonce ? { nonce } : {};

  if (settings.devServer) {
    const origin = settings.devServer.replace(/\/$/, "");

    return (
      <>
        {/* Vite's own client, which is what makes hot replacement work. */}
        <script type="module" src={`${origin}/@vite/client`} {...scriptAttributes} />
        <script
          type="module"
          src={`${origin}/${props.entry.replace(/^\//, "")}`}
          {...scriptAttributes}
        />
      </>
    );
  }

  if (!settings.manifest) {
    throw new Error(
      "Vite is not configured. Call configureVite with a manifest, or a devServer in development.",
    );
  }

  const resolved = resolveEntry(settings.manifest, props.entry);
  const base = settings.base ?? "/";

  return (
    <>
      {resolved.styles.map((stylesheet) => (
        <link rel="stylesheet" href={assetUrl(stylesheet, base)} />
      ))}
      {resolved.preloads.map((chunk) => (
        <link rel="modulepreload" href={assetUrl(chunk, base)} />
      ))}
      <script type="module" src={assetUrl(resolved.script, base)} {...scriptAttributes} />
    </>
  );
}

/**
 * A single asset's built URL, for one referenced from a template.
 *
 * Rails' `asset_path`. In development Vite serves the source path as it is.
 */
export function viteAsset(source: string, settings: ViteConfig = config): string {
  if (settings.devServer) {
    return `${settings.devServer.replace(/\/$/, "")}/${source.replace(/^\//, "")}`;
  }

  const chunk = settings.manifest?.[source];
  if (!chunk) throw new Error(`No Vite asset named "${source}".`);

  return assetUrl(chunk.file, settings.base ?? "/");
}
