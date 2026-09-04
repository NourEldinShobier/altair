/**
 * The route table as something to read, ported from
 * `ActionDispatch::Routing::RoutesInspector`, `RouteWrapper` and
 * `ConsoleFormatter`.
 *
 * `dump.ts` emits typed helpers for a compiler. This is the other consumer of
 * the same table: a person, at a terminal, asking one of three questions.
 *
 * - **"Which route answers this path?"** — the reason routes print in
 *   declaration order rather than sorted. Matching is first-match-wins, so the
 *   order on screen *is* the answer, and sorting the output would show a route
 *   above one that shadows it.
 * - **"What is the helper called?"** — the first column, because the name is
 *   how the rest of the application refers to the route, and it is the one part
 *   that cannot be guessed from the path.
 * - **"Where is the code?"** — resolved to a file and line, so the answer to
 *   "what handles this" is a place to open rather than a name to grep for.
 *
 * A filter is a substring rather than a prefix, because the question is usually
 * "anything to do with comments" and a prefix match answers a question nobody
 * asked. Routes the framework itself defines are hidden by default: they are a
 * dozen lines an application never wrote, printed above the ones it did.
 */

import type { Route } from "./route.js";
import { helperKey } from "./polymorphic.js";
import { matchesFilter } from "./resource-scope.js";

/** What a route dispatches to, when it is not a controller action. */
export interface RackApp {
  name?: string;
  /** An engine mounted at a path: its own route table lives inside. */
  engine?: boolean;
}

/** A route, plus what only the application can say about it. */
export interface InspectedRoute {
  route: Route;
  /** Mounted apps and inline handlers, instead of a controller and action. */
  rackApp?: RackApp;
  /** Set for routes the framework defines, which are hidden by default. */
  internal?: boolean;
}

/**
 * Rails' `rack_app` — what a route ends at, when it is not an action.
 *
 * Named rather than left as "the route has no controller", because the three
 * cases read differently on screen and only one of them is somewhere to go: a
 * mounted engine has its own table, an inline handler has no name at all, and a
 * named app is a class you can open.
 */
export function rackApp(entry: InspectedRoute): RackApp | undefined {
  return entry.rackApp;
}

/** Rails' `endpoint` — the "what handles this" column. */
export function endpoint(entry: InspectedRoute): string {
  const app = rackApp(entry);

  if (app) return app.name ?? "Inline handler";

  return `${entry.route.controller}#${entry.route.action}`;
}

/**
 * Rails' `reqs` — the endpoint plus whatever else has to hold.
 *
 * The constraints are on the same line as the endpoint because they are part of
 * whether this route answers at all: two routes with one path differ only here,
 * and split across columns the difference is easy to read past.
 */
export function reqs(entry: InspectedRoute): string {
  const constraints = Object.entries(entry.route.constraints)
    .map(([name, pattern]) => `${name}: ${pattern.source}`)
    .join(", ");

  return constraints ? `${endpoint(entry)} {${constraints}}` : endpoint(entry);
}

/**
 * Rails' `action_source_file_and_line` — where the action is written.
 *
 * Undefined rather than a guess when the route does not end at an action, or
 * when the controller cannot be resolved: a path pointing at a file that does
 * not contain the code is worse than no path, because it is followed.
 */
export function actionSourceFileAndLine(
  entry: InspectedRoute,
  locate: (controller: string, action: string) => { file: string; line: number } | undefined,
): { file: string; line: number } | undefined {
  if (rackApp(entry)) return undefined;

  const { controller, action } = entry.route;

  // A dynamic segment: `/:controller/:action` names no controller, it names
  // whatever the request happens to say.
  if (controller.startsWith(":") || action.startsWith(":")) return undefined;

  return locate(controller, action);
}

/** Rails' `action_source_location` — the same, as one string. */
export function actionSourceLocation(
  entry: InspectedRoute,
  locate: (controller: string, action: string) => { file: string; line: number } | undefined,
): string | undefined {
  const found = actionSourceFileAndLine(entry, locate);

  return found && `${found.file}:${String(found.line)}`;
}

/**
 * Rails' `editor_url` — a link that opens the file at the line.
 *
 * The scheme is the editor's, and the placeholders are substituted rather than
 * appended: every editor spells the line differently, and an appended
 * `:12` that the editor does not understand opens the file at the top, which
 * looks like it worked.
 */
export function editorUrl(
  template: string,
  location: { file: string; line?: number },
): string | undefined {
  if (!template) return undefined;

  return template
    .replaceAll("%s", encodeURIComponent(location.file))
    .replaceAll("%l", String(location.line ?? 1));
}

// --- the named helpers -----------------------------------------------------

/**
 * The helper names a route table defines. Rails' `NamedRouteCollection`.
 *
 * Both spellings for every named route, because an application refers to a
 * route by `postPath` inside a view and by `postUrl` in a mailer, and the two
 * differ only in whether the host is included. Defining one and not the other
 * is how a mail with a relative link gets sent.
 */
export class UrlHelperNames {
  readonly #names = new Map<string, string>();

  /** Rails' `add_url_helper`. */
  addUrlHelper(name: string): void {
    this.#names.set(name, name);
  }

  /** Rails' `helper_names` — every helper this table defines. */
  helperNames(): string[] {
    return [...this.#names.keys()].flatMap((name) => [
      `${helperKey(name)}Path`,
      `${helperKey(name)}Url`,
    ]);
  }

  has(name: string): boolean {
    return this.#names.has(name);
  }

  clear(): void {
    this.#names.clear();
  }
}

/** Rails' `url_helpers` — the names a route table defines, in order. */
export function urlHelpers(routes: readonly InspectedRoute[]): string[] {
  const names = new UrlHelperNames();

  for (const entry of routes) {
    if (entry.route.name) names.addUrlHelper(entry.route.name);
  }

  return names.helperNames();
}

// --- printing --------------------------------------------------------------

/** One route, reduced to what a formatter prints. */
export interface RouteRow {
  name: string;
  verb: string;
  path: string;
  reqs: string;
}

export interface InspectOptions {
  /** Substring match against name, path or endpoint. */
  grep?: string;
  /** Only this controller. */
  controller?: string;
  /** Framework-defined routes are hidden unless this is set. */
  showInternal?: boolean;
}

export function routeRow(entry: InspectedRoute): RouteRow {
  return {
    name: entry.route.name ?? "",
    verb: entry.route.method,
    path: entry.route.pattern,
    reqs: reqs(entry),
  };
}

/**
 * Rails' filtering, as one pass.
 *
 * The substring match itself is `matchesFilter` in `resource-scope.ts` — a
 * second one would mean `rails routes -g` and the routing error page disagreed
 * about what a filter matches, which is the sort of difference nobody notices
 * until they are already lost.
 *
 * What is added here is hiding the framework's own routes. They are a dozen
 * lines the application never wrote, printed above the ones it did.
 */
export function filterRoutes(
  routes: readonly InspectedRoute[],
  options: InspectOptions = {},
): InspectedRoute[] {
  return routes.filter((entry) => {
    if (entry.internal && !options.showInternal) return false;

    if (options.controller !== undefined && entry.route.controller !== options.controller) {
      return false;
    }

    if (options.grep === undefined) return true;

    return matchesFilter(
      {
        ...(entry.route.name === undefined ? {} : { name: entry.route.name }),
        verb: entry.route.method,
        path: entry.route.pattern,
        controller: entry.route.controller,
        action: entry.route.action,
        constraints: entry.route.constraints,
        defaults: entry.route.defaults,
      },
      options.grep,
    );
  });
}

/** What a formatter contributes around the rows. Rails' `ConsoleFormatter`. */
export interface RouteFormatter {
  sectionTitle: (title: string) => string[];
  header: (rows: readonly RouteRow[]) => string[];
  section: (rows: readonly RouteRow[]) => string[];
  footer: (rows: readonly RouteRow[]) => string[];
}

function widths(rows: readonly RouteRow[]): [number, number, number] {
  return [
    Math.max("Prefix".length, ...rows.map((row) => row.name.length)),
    Math.max("Verb".length, ...rows.map((row) => row.verb.length)),
    Math.max("URI Pattern".length, ...rows.map((row) => row.path.length)),
  ];
}

/**
 * The table `bin/rails routes` prints. Rails' `ConsoleFormatter::Sheet`.
 *
 * Columns are padded to the widest value rather than to a fixed width, because
 * a fixed width either wraps the long paths — which are the interesting ones —
 * or wastes half the terminal on an application whose routes are all short.
 */
export const sheetFormatter: RouteFormatter = {
  sectionTitle: (title) => [`${title}:`],

  header: (rows) => {
    const [name, verb, path] = widths(rows);

    return [
      `${"Prefix".padStart(name)} ${"Verb".padEnd(verb)} ${"URI Pattern".padEnd(path)} Controller#Action`,
    ];
  },

  section: (rows) => {
    const [name, verb, path] = widths(rows);

    // The name is right-aligned and everything else left-aligned, so the names
    // end where the verbs begin: the eye follows one straight edge down the
    // page rather than two ragged ones.
    return rows.map(
      (row) =>
        `${row.name.padStart(name)} ${row.verb.padEnd(verb)} ${row.path.padEnd(path)} ${row.reqs}`,
    );
  },

  footer: () => [""],
};

/**
 * Rails' `ConsoleFormatter::Expanded`, for a terminal too narrow for a table.
 *
 * One route per block rather than per line. A table narrower than its content
 * wraps mid-column and the alignment that made it readable is what makes the
 * wrapped version unreadable.
 */
export const expandedFormatter: RouteFormatter = {
  sectionTitle: (title) => [`${title}:`],
  header: () => [],

  section: (rows) =>
    rows.flatMap((row, index) => [
      `--[ Route ${String(index + 1)} ]${"-".repeat(Math.max(0, 60 - String(index + 1).length))}`,
      `Prefix            | ${row.name}`,
      `Verb              | ${row.verb}`,
      `URI               | ${row.path}`,
      `Controller#Action | ${row.reqs}`,
    ]),

  footer: () => [""],
};

/**
 * Rails' `no_routes` — what to say instead of an empty table.
 *
 * Which of the three it is matters: "no routes at all" and "your filter matched
 * nothing" send the reader to different places, and one message for both sends
 * half of them to the wrong one.
 */
export function noRoutesMessage(options: InspectOptions = {}): string {
  if (options.controller !== undefined) return "No routes were found for this controller.";
  if (options.grep !== undefined) return "No routes were found for this grep pattern.";

  return "You don't have any routes defined! Add some in your routes file.";
}

/**
 * The whole listing. Rails' `RoutesInspector#format`.
 *
 * In declaration order, because matching is first-match-wins: the order on
 * screen is the answer to "which route answers this path", and sorting would
 * print a route above the one that shadows it.
 */
export function inspectRoutes(
  routes: readonly InspectedRoute[],
  formatter: RouteFormatter = sheetFormatter,
  options: InspectOptions = {},
): string {
  const matching = filterRoutes(routes, options);

  if (matching.length === 0) return noRoutesMessage(options);

  const rows = matching.map((entry) => routeRow(entry));

  return [...formatter.header(rows), ...formatter.section(rows), ...formatter.footer(rows)]
    .join("\n")
    .trimEnd();
}
