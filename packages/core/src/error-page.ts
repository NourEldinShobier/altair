/**
 * The page a developer sees when a request raises, ported from
 * `ActionDispatch::DebugExceptions`.
 *
 * A stack trace tells you where. This tells you where *and what the line said*,
 * which is the difference between reading a path and reading the code — and
 * the difference is several minutes, several times a day.
 *
 * Two things it does that a plain trace cannot:
 *
 * - **Separates the application's frames from the framework's.** A trace is
 *   forty lines and three of them are yours. Rails calls this the application
 *   trace and puts it first for the same reason.
 * - **Shows the source around the failing line.** Read from disk at the moment
 *   of the error, so it is the code that actually ran rather than the code as
 *   it was when the process booted.
 *
 * Development only. The caller decides — `showDetailedErrors` is the
 * environment's business, and everything here is a leak in production.
 */

import { relative, sep } from "node:path";

/** One line of a stack trace, taken apart. */
export interface StackFrame {
  /** The function, or "(anonymous)". */
  name: string;
  file: string;
  line: number;
  column: number;
  /** Whether this frame is the application's own code. */
  application: boolean;
}

/** A few lines of source around the one that failed. */
export interface SourceExtract {
  file: string;
  /** The failing line, 1-based. */
  line: number;
  lines: { number: number; text: string }[];
}

const FRAME = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/;

/**
 * Whether a frame belongs to the application rather than to a dependency.
 *
 * Anything under `node_modules`, anything the runtime made up (`node:`,
 * `bun:`), and anything outside the project are somebody else's. What is left
 * is what the developer can actually change.
 */
function isApplicationFrame(file: string, root: string): boolean {
  if (file.includes("node_modules")) return false;
  if (/^(node|bun|internal):/.test(file)) return false;

  const path = file.replace(/^file:\/\/\/?/, "");
  const away = relative(root, path);

  return away !== "" && !away.startsWith("..") && !away.startsWith(`..${sep}`);
}

/** Takes a stack apart into frames. */
export function parseStack(stack: string | undefined, root: string): StackFrame[] {
  if (!stack) return [];

  const frames: StackFrame[] = [];

  for (const raw of stack.split("\n")) {
    const match = FRAME.exec(raw);
    if (!match) continue;

    const file = (match[2] as string).replace(/^file:\/\/\/?/, "");

    frames.push({
      name: match[1] ?? "(anonymous)",
      file,
      line: Number(match[3]),
      column: Number(match[4]),
      application: isApplicationFrame(file, root),
    });
  }

  return frames;
}

/**
 * The source around a frame, or undefined when it cannot be read.
 *
 * Undefined rather than thrown: the error page is what is shown when something
 * has already gone wrong, and it failing to render because a file moved would
 * replace a useful page with a useless one.
 */
export async function sourceFor(
  frame: StackFrame,
  context = 6,
): Promise<SourceExtract | undefined> {
  try {
    const text = await Bun.file(frame.file).text();
    const all = text.split("\n");

    const from = Math.max(1, frame.line - context);
    const to = Math.min(all.length, frame.line + context);

    const lines: { number: number; text: string }[] = [];
    for (let at = from; at <= to; at += 1) lines.push({ number: at, text: all[at - 1] ?? "" });

    return { file: frame.file, line: frame.line, lines };
  } catch {
    return undefined;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** What the request carried, for the panel at the bottom. */
function requestRows(request: Request, params: Record<string, unknown>): string {
  const url = new URL(request.url);
  const headers = [...request.headers.entries()]
    // A page that prints the session cookie is a page that gets pasted into a
    // chat window with the session cookie in it.
    .filter(([name]) => !/^(cookie|authorization)$/i.test(name))
    .map(([name, value]) => `<tr><th>${escapeHtml(name)}</th><td>${escapeHtml(value)}</td></tr>`)
    .join("");

  const parameters = Object.entries(params)
    .map(
      ([name, value]) =>
        `<tr><th>${escapeHtml(name)}</th><td>${escapeHtml(JSON.stringify(value) ?? "")}</td></tr>`,
    )
    .join("");

  return `
    <section>
      <h2>Request</h2>
      <table>
        <tr><th>Method</th><td>${escapeHtml(request.method)}</td></tr>
        <tr><th>Path</th><td>${escapeHtml(url.pathname + url.search)}</td></tr>
      </table>
    </section>
    ${parameters ? `<section><h2>Parameters</h2><table>${parameters}</table></section>` : ""}
    <section><h2>Headers</h2><table>${headers}</table></section>`;
}

function frameRows(frames: StackFrame[], root: string): string {
  if (frames.length === 0) return "<p class=empty>No frames.</p>";

  return frames
    .map((frame) => {
      const shown = frame.application ? relative(root, frame.file) : frame.file;

      return `<li${frame.application ? ' class="app"' : ""}><code>${escapeHtml(shown)}:${frame.line}</code> <span>in ${escapeHtml(frame.name)}</span></li>`;
    })
    .join("");
}

function sourceBlock(extract: SourceExtract | undefined, root: string): string {
  if (!extract) return "";

  const rows = extract.lines
    .map(
      (one) =>
        `<tr${one.number === extract.line ? ' class="here"' : ""}><td class=n>${one.number}</td><td class=s>${escapeHtml(one.text)}</td></tr>`,
    )
    .join("");

  return `
    <section>
      <h2>${escapeHtml(relative(root, extract.file))}<span class=at>:${extract.line}</span></h2>
      <table class=source>${rows}</table>
    </section>`;
}

/**
 * Renders the page.
 *
 * Everything is inline — no stylesheet, no script, no font. The error page has
 * to work when the asset pipeline is what broke.
 */
export async function renderErrorPage(
  error: unknown,
  request: Request,
  options: { root: string; status: number; params?: Record<string, unknown> },
): Promise<string> {
  const { root, status } = options;

  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  const frames = parseStack(error instanceof Error ? error.stack : undefined, root);

  // The first frame the developer can act on. A trace whose top frame is deep
  // inside a dependency opens on a file nobody is going to edit.
  const first = frames.find((frame) => frame.application) ?? frames[0];
  const extract = first ? await sourceFor(first) : undefined;

  const application = frames.filter((frame) => frame.application);

  return `<!doctype html>
<html lang=en>
<head>
<meta charset=utf-8>
<meta name=viewport content="width=device-width, initial-scale=1">
<title>${escapeHtml(name)}: ${escapeHtml(message)}</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#1a1a1a; --dim:#666; --line:#e3e3e3; --bad:#b4232c; --badbg:#fdf0f0; --code:#f7f7f8; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#161618; --fg:#e8e8ea; --dim:#9a9aa2; --line:#2c2c31; --bad:#ff7b72; --badbg:#2a1a1b; --code:#1e1e21; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
         font:14px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  header { background:var(--badbg); border-bottom:1px solid var(--line); padding:24px 28px; }
  h1 { margin:0 0 6px; font-size:15px; color:var(--bad); letter-spacing:.02em; }
  .msg { margin:0; font-size:20px; line-height:1.35; white-space:pre-wrap; word-break:break-word; }
  .status { color:var(--dim); font-size:12px; margin-top:10px; }
  main { padding:8px 28px 48px; max-width:1100px; }
  section { margin:28px 0 0; }
  h2 { font-size:12px; text-transform:uppercase; letter-spacing:.08em; color:var(--dim);
       margin:0 0 10px; font-weight:600; }
  .at { color:var(--dim); text-transform:none; letter-spacing:0; }
  table { border-collapse:collapse; width:100%; font-size:13px; }
  th { text-align:left; color:var(--dim); font-weight:500; padding:3px 14px 3px 0;
       white-space:nowrap; vertical-align:top; width:1%; }
  td { padding:3px 0; word-break:break-word; }
  table.source { background:var(--code); border:1px solid var(--line); border-radius:6px;
                 overflow:hidden; }
  table.source td { padding:1px 0; }
  td.n { color:var(--dim); text-align:right; padding:1px 14px 1px 12px; width:1%;
         user-select:none; white-space:nowrap; }
  td.s { white-space:pre; padding-right:12px; }
  tr.here { background:var(--badbg); }
  tr.here td.n { color:var(--bad); font-weight:700; }
  ol { margin:0; padding:0 0 0 0; list-style:none; }
  li { padding:3px 0; color:var(--dim); border-left:2px solid transparent; padding-left:10px; }
  li.app { color:var(--fg); border-left-color:var(--bad); }
  li code { color:inherit; }
  li span { color:var(--dim); }
  details { margin-top:10px; }
  summary { cursor:pointer; color:var(--dim); font-size:12px; }
  p.empty { color:var(--dim); }
  .scroll { overflow-x:auto; }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(name)}</h1>
  <p class=msg>${escapeHtml(message)}</p>
  <p class=status>${status} · ${escapeHtml(request.method)} ${escapeHtml(new URL(request.url).pathname)}</p>
</header>
<main>
  <div class=scroll>${sourceBlock(extract, root)}</div>
  <section>
    <h2>Application trace</h2>
    <ol>${frameRows(application, root)}</ol>
    <details>
      <summary>Full trace (${frames.length} frames)</summary>
      <ol>${frameRows(frames, root)}</ol>
    </details>
  </section>
  ${requestRows(request, options.params ?? {})}
</main>
</body>
</html>`;
}
