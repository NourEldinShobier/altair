/**
 * Driving a browser from a test, and the bookkeeping between tests, ported from
 * `ActionDispatch::SystemTestCase`, `SystemTesting::Driver` and the per-test
 * reset hooks in `ActionController::TestCase`.
 *
 * `controller_harness.ts` drives a controller directly. This is the layer for
 * tests that go through a real browser, plus the state-clearing those and
 * controller tests share.
 *
 * A system test is slow, flaky and occasionally the only thing that catches a
 * bug, and almost every rule here is about the first two:
 *
 * - **A screenshot is taken on failure, automatically.** A system test that
 *   fails in CI with only a stack trace is a test somebody re-runs locally,
 *   cannot reproduce, and eventually deletes. The screenshot is the difference
 *   between a bug report and a flake.
 * - **State is cleared between tests, and the list is explicit.** A browser
 *   session, a thread-local, an instance variable from the last request — each
 *   survives a test by default, and each produces a *pass* on the next test for
 *   the wrong reason. That is worse than a failure.
 * - **The driver is chosen per test class, not globally.** A suite where one
 *   test needs JavaScript and the rest do not should not pay for a real browser
 *   everywhere, and a suite that silently used a headless driver for a test
 *   about a modal would pass without testing anything.
 */

// --- choosing a driver ---------------------------------------------------------------

export type DriverName =
  | "rack_test"
  | "headless_chrome"
  | "headless_firefox"
  | "chrome"
  | "firefox";

export interface DriverSpec {
  name: DriverName;
  screenSize: [number, number];
  /** Whether this driver runs JavaScript at all. */
  javascript: boolean;
  options: Record<string, unknown>;
}

const JAVASCRIPT_DRIVERS: readonly DriverName[] = [
  "headless_chrome",
  "headless_firefox",
  "chrome",
  "firefox",
];

/**
 * Rails' `driven_by`.
 *
 * The screen size is part of the driver rather than set per test, because a
 * responsive layout behaves differently at different widths — and a test that
 * inherited whatever width the last one left would pass or fail depending on
 * the order the suite ran in.
 */
export function drivenBy(
  name: DriverName,
  {
    screenSize = [1400, 1400],
    options = {},
  }: {
    screenSize?: [number, number];
    options?: Record<string, unknown>;
  } = {},
): DriverSpec {
  if (screenSize[0] <= 0 || screenSize[1] <= 0) {
    throw new Error(
      `A screen of ${screenSize[0]}x${screenSize[1]} has no visible area, so every element is off ` +
        `screen and every click misses — which reads as a broken page rather than a broken size.`,
    );
  }

  return { name, screenSize, javascript: JAVASCRIPT_DRIVERS.includes(name), options };
}

/**
 * Whether a test needing JavaScript can run under this driver.
 *
 * Asked explicitly rather than discovered, because the failure otherwise is an
 * element that "is not on the page" — which sends the reader to the template
 * rather than to the driver that never ran the script putting it there.
 */
export function supportsJavascript(driver: DriverSpec): boolean {
  return driver.javascript;
}

// --- screenshots ------------------------------------------------------------------------

export type ScreenshotFormat = "png" | "html";

export interface Screenshot {
  path: string;
  format: ScreenshotFormat;
  encoding: "inline" | "file";
}

/**
 * Rails' `take_screenshot`.
 *
 * The name includes the test's name and a counter, because a test that takes
 * two screenshots would otherwise overwrite the first with the second — and
 * the first is usually the one showing the state that led to the failure.
 */
export function takeScreenshot(
  testName: string,
  {
    index = 0,
    format = "png",
    inline = false,
    root = "tmp/screenshots",
  }: {
    index?: number;
    format?: ScreenshotFormat;
    inline?: boolean;
    root?: string;
  } = {},
): Screenshot {
  const safe = testName.replaceAll(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "");

  return {
    path: `${root}/${index === 0 ? "" : `${index}_`}${safe}.${format}`,
    format,
    encoding: inline ? "inline" : "file",
  };
}

/**
 * Rails' `take_failed_screenshot`.
 *
 * Only on failure, and never after a skip. A skipped test has no browser state
 * worth capturing, and writing one anyway fills the artefact directory with
 * images of a blank page — which is how the directory gets ignored.
 */
export function takeFailedScreenshot(
  testName: string,
  outcome: "passed" | "failed" | "skipped",
  options: Parameters<typeof takeScreenshot>[1] = {},
): Screenshot | undefined {
  return outcome === "failed" ? takeScreenshot(testName, options) : undefined;
}

/**
 * Rails' `save_and_open_page` — the page as it is, on disk, for a human.
 *
 * HTML rather than an image, because the question it answers is usually "what
 * is actually in the DOM" — and a screenshot cannot be searched.
 */
export function saveAndOpenPage(
  html: string,
  { root = "tmp/pages" } = {},
): {
  path: string;
  html: string;
} {
  return { path: `${root}/page.html`, html };
}

// --- what gets cleared between tests -------------------------------------------------------

/**
 * The instance variables a controller test must not carry across.
 *
 * Explicit rather than "everything", because a test case legitimately holds
 * fixtures and helpers on itself, and clearing those would break every test
 * that set one up in a `before`.
 */
export const PER_REQUEST_IVARS: readonly string[] = [
  "request",
  "response",
  "controller",
  "params",
  "session",
  "flash",
  "renderedViews",
];

/**
 * Rails' `clear_instance_variables_between_requests`.
 *
 * Each of these survives a test by default and produces a *pass* on the next
 * one for the wrong reason — a "no flash" assertion succeeding because the
 * flash was cleared by the previous test's redirect, not by the code under
 * test. A wrong pass is worse than a failure, because nothing looks at it.
 */
export function clearInstanceVariablesBetweenRequests(
  target: Record<string, unknown>,
  names: readonly string[] = PER_REQUEST_IVARS,
): string[] {
  const cleared: string[] = [];

  for (const name of names) {
    if (!(name in target)) continue;

    delete target[name];
    cleared.push(name);
  }

  return cleared;
}

const threadLocals = new Map<string, unknown>();

export function setThreadLocal(name: string, value: unknown): void {
  threadLocals.set(name, value);
}

export function threadLocal(name: string): unknown {
  return threadLocals.get(name);
}

/**
 * Rails' `clean_up_thread_locals`.
 *
 * Separate from the instance variables because they leak differently: an
 * instance variable belongs to one test object and dies with it, while a
 * thread-local outlives every test on that thread — so one test setting a
 * current user leaves it set for the rest of the file.
 */
export function cleanUpThreadLocals(): number {
  const count = threadLocals.size;
  threadLocals.clear();

  return count;
}

// --- which controller a test is about --------------------------------------------------------

export class NonInferrableController extends Error {
  constructor(testName: string, looked: string) {
    super(
      `Could not work out which controller ${testName} is about; expected ${looked}. Say so with ` +
        `tests(SomeController). A test with no controller passes every assertion about what did ` +
        `not happen, which is most of them.`,
    );
    this.name = "NonInferrableController";
  }
}

/** Rails' `controller_class_name` — `PostsControllerTest` names `PostsController`. */
export function controllerClassName(testName: string): string {
  return `${testName.replace(/Test$/, "")}`;
}

/** Rails' `determine_default_controller_class`. */
export function determineDefaultControllerClass(
  testName: string,
  known: ReadonlyMap<string, unknown>,
): unknown {
  const name = controllerClassName(testName);
  const found = known.get(name);

  if (found === undefined) throw new NonInferrableController(testName, name);

  return found;
}

/** Rails' `controller_class_for` — declared, or inferred. */
export function controllerClassFor(
  declared: unknown,
  testName: string,
  known: ReadonlyMap<string, unknown>,
): unknown {
  return declared ?? determineDefaultControllerClass(testName, known);
}

export interface ControllerSession {
  controller: unknown;
  name: string;
}

let current: ControllerSession | undefined;

/**
 * Rails' `controller_instance` / `current_controller`.
 *
 * The instance the last request ran through, kept so assertions can ask about
 * it. Replaced rather than stacked: a test making two requests asserts about
 * the second, and keeping the first would make `assigns` return whichever
 * happened to be looked up first.
 */
export function setCurrentController(session: ControllerSession | undefined): void {
  current = session;
}

export function currentController(): ControllerSession | undefined {
  return current;
}

export function controllerInstance(): unknown {
  return current?.controller;
}

/**
 * Rails' `different_controller?` — whether a request left the controller under
 * test.
 *
 * Worth knowing because a redirect that lands on another controller means the
 * assertions after it are about a page the test did not mean to be on — and
 * they usually still pass, since most of them are about absence.
 */
export function differentController(expected: string, actual: string | undefined): boolean {
  return actual !== undefined && actual !== expected;
}

/**
 * Rails' `new_controller_thread` — run a request in its own scope.
 *
 * The current controller is restored afterwards, so a nested request — a test
 * helper that signs in by posting to a session controller — does not leave the
 * outer test asserting against the wrong one.
 */
export async function newControllerThread<T>(body: () => Promise<T> | T): Promise<T> {
  const held = current;

  try {
    return await body();
  } finally {
    current = held;
  }
}

/** Rails' `setup_controller_request_and_response`. */
export function setupControllerRequestAndResponse(
  controller: unknown,
  name: string,
): ControllerSession {
  const session: ControllerSession = { controller, name };
  setCurrentController(session);

  return session;
}

/**
 * Rails' `reset_body` — empties a response for reuse between requests.
 *
 * A body left behind is read by the next assertion as the *new* response, so a
 * test asserting on content that its second request never produced passes
 * against the first request's page.
 */
export function resetBody(response: { body?: unknown; status?: number }): void {
  delete response.body;
  delete response.status;
}

// --- routing inside one test -------------------------------------------------------------------

/**
 * Rails' `with_routing` — a different route set for one block.
 *
 * Restored afterwards, and restored on failure. Routes left replaced make
 * every later test in the file route against a set it never declared, and the
 * failures are in whichever test happens to run next.
 */
export async function withRouting<R, T>(
  holder: { routes: R },
  routes: R,
  body: () => Promise<T> | T,
): Promise<T> {
  const held = holder.routes;
  holder.routes = routes;

  try {
    return await body();
  } finally {
    holder.routes = held;
  }
}

/**
 * Rails' `with_defaults` — default URL options for one block.
 *
 * Merged onto what is there rather than replacing it, so a block adding a
 * locale does not lose the host — and a generated URL without a host is a
 * relative one, which works in the test and breaks in an email.
 */
export async function withDefaults<T>(
  holder: { defaults: Record<string, unknown> },
  defaults: Record<string, unknown>,
  body: () => Promise<T> | T,
): Promise<T> {
  const held = holder.defaults;
  holder.defaults = { ...held, ...defaults };

  try {
    return await body();
  } finally {
    holder.defaults = held;
  }
}
