/**
 * The tools a preview actually needs, ported from
 * `ActiveStorage::Previewer::PopplerPDFPreviewer`,
 * `MuPDFPreviewer` and `VideoPreviewer`.
 *
 * `representable.ts` answers whether a *format* can be previewed, and its own
 * comment is the reason this file exists: "listing a type here is a promise
 * that a previewer exists for it, and a promise that is not kept surfaces as a
 * broken image on a page rather than as an error anybody sees."
 *
 * Nothing was keeping that promise. A PDF answered `isPreviewable` with true
 * and there was no previewer behind it, so a view that asked the question and
 * believed the answer rendered an image tag pointing at nothing.
 *
 * A preview is not something a runtime can do on its own — pulling the first
 * page out of a PDF or the first frame out of an H.264 stream means a decoder
 * for that container, which is why Rails shells out to poppler, mupdf or
 * ffmpeg. So the honest answer has two halves: the format is previewable, and
 * the tool for it is installed. `canPreview` asks both.
 */

/** A tool a previewer shells out to. */
export interface PreviewerTool {
  /** The executable's name, as it would be typed. */
  readonly command: string;
  /** What it is for, for the message when it is missing. */
  readonly handles: string;
}

export const FFMPEG: PreviewerTool = { command: "ffmpeg", handles: "video" };
export const MUTOOL: PreviewerTool = { command: "mutool", handles: "PDF" };
export const PDFTOPPM: PreviewerTool = { command: "pdftoppm", handles: "PDF" };

/**
 * Paths set by configuration, which win over what is on PATH.
 *
 * Needed because a container that installs ffmpeg somewhere deliberate, or a
 * machine with two versions, should not depend on how PATH happened to be
 * ordered when the process started.
 */
const overrides = new Map<string, string | null>();

/** Where a tool was found, remembered so the lookup happens once. */
const discovered = new Map<string, string | null>();

/** Points a tool at a specific binary, or at nothing to force it missing. */
export function setPreviewerPath(tool: PreviewerTool, path: string | null): void {
  overrides.set(tool.command, path);
  discovered.delete(tool.command);
}

/** Forgets what was configured and what was found. For a test, and for a reload. */
export function resetPreviewerPaths(): void {
  overrides.clear();
  discovered.clear();
}

/**
 * Where a tool is, or null.
 *
 * Cached because it is asked once per previewable attachment on a page, and
 * searching PATH for each of thirty thumbnails is thirty walks of the
 * filesystem to answer a question whose answer cannot change while the process
 * is running.
 */
export function previewerPath(tool: PreviewerTool): string | null {
  if (overrides.has(tool.command)) return overrides.get(tool.command) ?? null;

  const cached = discovered.get(tool.command);

  if (cached !== undefined) return cached;

  const found = Bun.which(tool.command);

  discovered.set(tool.command, found);

  return found;
}

/** Whether a tool is installed. */
export function previewerExists(tool: PreviewerTool): boolean {
  return previewerPath(tool) !== null;
}

/** Rails' `ffmpeg_path` and `ffmpeg_exists?`. */
export function ffmpegPath(): string | null {
  return previewerPath(FFMPEG);
}

export function ffmpegExists(): boolean {
  return previewerExists(FFMPEG);
}

/** Rails' `mutool_path` and `mutool_exists?`. */
export function mutoolPath(): string | null {
  return previewerPath(MUTOOL);
}

export function mutoolExists(): boolean {
  return previewerExists(MUTOOL);
}

/** Rails' `pdftoppm_path` and `pdftoppm_exists?`. */
export function pdftoppmPath(): string | null {
  return previewerPath(PDFTOPPM);
}

export function pdftoppmExists(): boolean {
  return previewerExists(PDFTOPPM);
}

/**
 * Which tool would handle a content type, and whether it is installed.
 *
 * PDFs list both, in Rails' order: mupdf first because it is one binary with
 * no rendering dependencies, poppler second because it is the one already
 * installed on most Linux images. Either produces the same page.
 */
export function previewerFor(contentType: string | null | undefined): PreviewerTool | null {
  const type = contentType?.split(";")[0]?.trim().toLowerCase();

  if (type === undefined || type === "") return null;

  if (type === "application/pdf") {
    if (previewerExists(MUTOOL)) return MUTOOL;
    if (previewerExists(PDFTOPPM)) return PDFTOPPM;

    // Named anyway when neither is installed, so a caller can say which tool
    // to install rather than only that something is missing.
    return MUTOOL;
  }

  return type.startsWith("video/") ? FFMPEG : null;
}

/**
 * Whether a preview can actually be produced right now.
 *
 * The difference from `isPreviewable`: that one is about the format and is the
 * same answer on every machine, which is what a stored value or a validation
 * message wants. This one is about this machine, and is what a view should ask
 * before rendering an image tag that a missing binary would leave broken.
 */
export function canPreview(contentType: string | null | undefined): boolean {
  const tool = previewerFor(contentType);

  return tool !== null && previewerExists(tool);
}

/** Says which tool is missing, for a log line or a startup check. */
export function missingPreviewerFor(contentType: string | null | undefined): string | null {
  const tool = previewerFor(contentType);

  if (tool === null || previewerExists(tool)) return null;

  return `No previewer for ${contentType ?? "this file"}: install ${tool.command} to preview ${tool.handles}.`;
}
