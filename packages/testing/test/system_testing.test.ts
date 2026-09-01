/**
 * Driving a browser from a test and the bookkeeping between tests, ported from
 * `actionpack/test/dispatch/system_testing/driver_test.rb`,
 * `system_testing/screenshot_helper_test.rb` and the reset cases in
 * `actionpack/test/controller/test_case_test.rb`.
 *
 * The failures worth testing are the ones that produce a *pass*: state left
 * over from one test making the next one succeed for the wrong reason.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  NonInferrableController,
  PER_REQUEST_IVARS,
  cleanUpThreadLocals,
  clearInstanceVariablesBetweenRequests,
  controllerClassFor,
  controllerClassName,
  controllerInstance,
  currentController,
  determineDefaultControllerClass,
  differentController,
  drivenBy,
  newControllerThread,
  resetBody,
  saveAndOpenPage,
  setCurrentController,
  setThreadLocal,
  setupControllerRequestAndResponse,
  supportsJavascript,
  takeFailedScreenshot,
  takeScreenshot,
  threadLocal,
  withDefaults,
  withRouting,
} from "../src/system_testing.js";

afterEach(() => {
  cleanUpThreadLocals();
  setCurrentController(undefined);
});

describe("choosing a driver", () => {
  /**
   * A suite that silently used a headless driver for a test about a modal
   * would pass without testing anything.
   */
  it("says whether it runs JavaScript", () => {
    expect(supportsJavascript(drivenBy("rack_test"))).toBe(false);
    expect(supportsJavascript(drivenBy("headless_chrome"))).toBe(true);
    expect(supportsJavascript(drivenBy("firefox"))).toBe(true);
  });

  /**
   * A responsive layout behaves differently at different widths, and a test
   * inheriting whatever the last one left would pass or fail depending on the
   * order the suite ran in.
   */
  it("carries its own screen size", () => {
    expect(drivenBy("headless_chrome").screenSize).toEqual([1400, 1400]);
    expect(drivenBy("headless_chrome", { screenSize: [375, 812] }).screenSize).toEqual([375, 812]);
  });

  /** Every element is off screen and every click misses. */
  it("refuses a screen with no area", () => {
    expect(() => drivenBy("chrome", { screenSize: [0, 800] })).toThrow("every click misses");
  });

  it("carries driver options through", () => {
    expect(drivenBy("chrome", { options: { binary: "/usr/bin/chrome" } }).options).toEqual({
      binary: "/usr/bin/chrome",
    });
  });
});

describe("screenshots", () => {
  it("names the file after the test", () => {
    expect(takeScreenshot("posts controller test").path).toBe(
      "tmp/screenshots/posts_controller_test.png",
    );
  });

  /**
   * A test taking two screenshots would otherwise overwrite the first with the
   * second — and the first is usually the one showing the state that led to
   * the failure.
   */
  it("numbers the ones after the first", () => {
    expect(takeScreenshot("a test", { index: 1 }).path).toBe("tmp/screenshots/1_a_test.png");
  });

  it("takes HTML when asked", () => {
    expect(takeScreenshot("a test", { format: "html" }).path).toEndWith(".html");
  });

  it("can be inline for a terminal that renders images", () => {
    expect(takeScreenshot("a test", { inline: true }).encoding).toBe("inline");
    expect(takeScreenshot("a test").encoding).toBe("file");
  });

  /**
   * A system test that fails in CI with only a stack trace is one somebody
   * cannot reproduce locally and eventually deletes.
   */
  it("is taken on failure", () => {
    expect(takeFailedScreenshot("a test", "failed")).toBeDefined();
  });

  /**
   * A skipped test has no browser state worth capturing, and writing one
   * anyway fills the artefact directory with blank pages — which is how the
   * directory gets ignored.
   */
  it("is not taken for a pass or a skip", () => {
    expect(takeFailedScreenshot("a test", "passed")).toBeUndefined();
    expect(takeFailedScreenshot("a test", "skipped")).toBeUndefined();
  });

  /** A screenshot cannot be searched, and the question is what is in the DOM. */
  it("saves the page as HTML", () => {
    expect(saveAndOpenPage("<p>hi</p>")).toEqual({
      path: "tmp/pages/page.html",
      html: "<p>hi</p>",
    });
  });
});

describe("what gets cleared between tests", () => {
  /**
   * A "no flash" assertion succeeding because the previous test's redirect
   * cleared it is a pass for the wrong reason — worse than a failure, because
   * nothing looks at it.
   */
  it("clears the per-request state", () => {
    const target: Record<string, unknown> = { request: {}, flash: { notice: "a" }, fixtures: {} };

    expect(clearInstanceVariablesBetweenRequests(target)).toEqual(["request", "flash"]);
    expect(target["request"]).toBeUndefined();
  });

  /**
   * Explicit rather than "everything": a test case legitimately holds fixtures
   * and helpers on itself, and clearing those would break every test that set
   * one up in a `before`.
   */
  it("leaves everything else alone", () => {
    const target: Record<string, unknown> = { fixtures: { posts: [] } };

    clearInstanceVariablesBetweenRequests(target);

    expect(target["fixtures"]).toBeDefined();
  });

  it("names what it clears", () => {
    expect(PER_REQUEST_IVARS).toContain("flash");
    expect(PER_REQUEST_IVARS).not.toContain("fixtures");
  });

  /**
   * A thread-local outlives every test on that thread, so one test setting a
   * current user leaves it set for the rest of the file.
   */
  it("clears thread locals separately", () => {
    setThreadLocal("currentUser", { id: 1 });

    expect(threadLocal("currentUser")).toBeDefined();
    expect(cleanUpThreadLocals()).toBe(1);
    expect(threadLocal("currentUser")).toBeUndefined();
  });
});

describe("which controller a test is about", () => {
  const known = new Map<string, unknown>([["PostsController", { name: "posts" }]]);

  it("infers it from the test name", () => {
    expect(controllerClassName("PostsControllerTest")).toBe("PostsController");
    expect(determineDefaultControllerClass("PostsControllerTest", known)).toEqual({
      name: "posts",
    });
  });

  /**
   * A test with no controller passes every assertion about what did not
   * happen, which is most of them.
   */
  it("refuses to infer nothing", () => {
    expect(() => determineDefaultControllerClass("NowhereTest", known)).toThrow(
      NonInferrableController,
    );
    expect(() => determineDefaultControllerClass("NowhereTest", known)).toThrow("did not happen");
  });

  it("prefers what was declared", () => {
    const declared = { name: "declared" };

    expect(controllerClassFor(declared, "NowhereTest", known)).toBe(declared);
    expect(controllerClassFor(undefined, "PostsControllerTest", known)).toEqual({ name: "posts" });
  });
});

describe("the controller a request ran through", () => {
  /**
   * Replaced rather than stacked: a test making two requests asserts about the
   * second, and keeping the first would make lookups return whichever came
   * first.
   */
  it("is the most recent one", () => {
    setupControllerRequestAndResponse({ id: 1 }, "PostsController");
    setupControllerRequestAndResponse({ id: 2 }, "CommentsController");

    expect(controllerInstance()).toEqual({ id: 2 });
    expect(currentController()?.name).toBe("CommentsController");
  });

  /**
   * A helper that signs in by posting to a session controller must not leave
   * the outer test asserting against that one.
   */
  it("is restored after a nested request", async () => {
    setupControllerRequestAndResponse({ id: 1 }, "PostsController");

    await newControllerThread(() => {
      setupControllerRequestAndResponse({ id: 2 }, "SessionsController");
    });

    expect(currentController()?.name).toBe("PostsController");
  });

  it("is restored even when the nested request throws", async () => {
    setupControllerRequestAndResponse({ id: 1 }, "PostsController");

    await expect(
      newControllerThread(() => {
        // Set first, then fail: a nested request that got far enough to change
        // the current controller is exactly the case a restore has to survive.
        setupControllerRequestAndResponse({ id: 2 }, "SessionsController");

        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(currentController()?.name).toBe("PostsController");
  });

  /**
   * A redirect landing on another controller means the assertions after it are
   * about a page the test did not mean to be on — and they usually still pass,
   * since most are about absence.
   */
  it("notices a request that left the controller under test", () => {
    expect(differentController("PostsController", "SessionsController")).toBe(true);
    expect(differentController("PostsController", "PostsController")).toBe(false);
    expect(differentController("PostsController", undefined)).toBe(false);
  });

  /**
   * A body left behind is read by the next assertion as the new response, so a
   * test asserting on content its second request never produced passes against
   * the first request's page.
   */
  it("empties a response for reuse", () => {
    const response: { body?: unknown; status?: number } = { body: "old", status: 200 };

    resetBody(response);

    expect(response.body).toBeUndefined();
    expect(response.status).toBeUndefined();
  });
});

describe("changing routes or defaults for one block", () => {
  /**
   * Routes left replaced make every later test in the file route against a set
   * it never declared, and the failures are in whichever test runs next.
   */
  it("restores the routes afterwards", async () => {
    const holder = { routes: "real" };

    await withRouting(holder, "fake", () => {
      expect(holder.routes).toBe("fake");
    });

    expect(holder.routes).toBe("real");
  });

  it("restores them when the block throws", async () => {
    const holder = { routes: "real" };

    await expect(
      withRouting(holder, "fake", () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(holder.routes).toBe("real");
  });

  /**
   * Merged rather than replaced: a block adding a locale must not lose the
   * host, and a generated URL without a host is relative — which works in the
   * test and breaks in an email.
   */
  it("merges defaults onto what is there", async () => {
    const holder = { defaults: { host: "example.com" } as Record<string, unknown> };

    await withDefaults(holder, { locale: "fr", host: "other.example" }, () => {
      // The block's value wins for a key both name, or a block asking for a
      // different host quietly gets the outer one and generates URLs nobody
      // asked for.
      expect(holder.defaults).toEqual({ host: "other.example", locale: "fr" });
    });

    expect(holder.defaults).toEqual({ host: "example.com" });
  });

  it("restores defaults when the block throws", async () => {
    const holder = { defaults: { host: "example.com" } as Record<string, unknown> };

    await expect(
      withDefaults(holder, { locale: "fr" }, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(holder.defaults).toEqual({ host: "example.com" });
  });
});
