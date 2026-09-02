/**
 * Wrapping a test's own setup and teardown, ported from
 * `ActiveSupport::Testing::SetupAndTeardown`.
 *
 * Almost everything a test needs is a pair: a transaction opened and rolled
 * back, a stub installed and restored, a clock held and released, a delivery
 * list emptied and emptied again. Wiring them up by hand works until there are
 * four of them, and then two things start going wrong and neither of them
 * fails loudly:
 *
 * - **A cleanup that throws skips the ones after it.** `afterEach` is one
 *   function; if the first line raises, the clock stays frozen and every test
 *   in every later file is in the wrong year — reported as a failure in a file
 *   that never touched time.
 * - **Teardown drifts out of step with setup.** Written by hand the two lists
 *   are separate, so a pair added to one and not the other leaks, and the test
 *   that notices is not the test that leaked.
 *
 * So the pairs are registered together and unwound in the opposite order —
 * what was acquired first is released last — and every teardown runs even when
 * one of them throws, with the first failure rethrown once the rest are done.
 *
 * Rails' reason for the four hooks is the same one: a test class that
 * overrides `setup` must otherwise remember to call `super`, and forgetting it
 * silently disables fixtures rather than failing.
 *
 *     const lifecycle = new TestLifecycle()
 *
 *     lifecycle.use(transactionalTests(() => database))
 *     lifecycle.afterTeardown(unstubAll)
 *
 *     const { setup, teardown } = lifecycle.hooks()
 *     beforeEach(setup)
 *     afterEach(teardown)
 *
 * Returned rather than registered, like `transactionalTests`, so this package
 * does not import a test runner — which would make it unusable from anything
 * that is not itself a test.
 */

export type LifecycleHook = () => void | Promise<void>;

/** A setup and its matching teardown, as `transactionalTests` returns. */
export interface LifecyclePair {
  setup?: LifecycleHook;
  teardown?: LifecycleHook;
}

/** The test's own setup and teardown, run in the middle of everything else. */
export interface TestBody {
  setup?: LifecycleHook;
  teardown?: LifecycleHook;
}

export class TestLifecycle {
  #beforeSetup: LifecycleHook[] = [];
  #afterSetup: LifecycleHook[] = [];
  #beforeTeardown: LifecycleHook[] = [];
  #afterTeardown: LifecycleHook[] = [];

  /**
   * Runs before the test's own setup. Rails' `before_setup`.
   *
   * Where anything the test's setup might depend on belongs: the transaction
   * has to be open before a fixture is inserted, and the clock has to be held
   * before anything reads it.
   */
  beforeSetup(hook: LifecycleHook): this {
    this.#beforeSetup.push(hook);

    return this;
  }

  /**
   * Runs after the test's own setup. Rails' `after_setup`.
   *
   * For the things that have to observe what the test set up rather than
   * prepare for it — recording a baseline, arming an assertion that compares
   * against the state the test started from.
   */
  afterSetup(hook: LifecycleHook): this {
    this.#afterSetup.push(hook);

    return this;
  }

  /** Runs before the test's own teardown. Rails' `before_teardown`. */
  beforeTeardown(hook: LifecycleHook): this {
    this.#beforeTeardown.push(hook);

    return this;
  }

  /**
   * Runs after everything else. Rails' `after_teardown`.
   *
   * The last chance to put a global back, which is why it runs even when an
   * earlier teardown threw.
   */
  afterTeardown(hook: LifecycleHook): this {
    this.#afterTeardown.push(hook);

    return this;
  }

  /**
   * Registers a pair, so the two cannot drift apart.
   *
   * The setup goes on the outside and the teardown on the outside of the
   * teardown phase, which together mean the pair brackets everything
   * registered after it. Registering the halves separately is possible and is
   * how a suite ends up rolling back a transaction it already closed.
   */
  use(pair: LifecyclePair): this {
    if (pair.setup) this.beforeSetup(pair.setup);
    if (pair.teardown) this.afterTeardown(pair.teardown);

    return this;
  }

  /**
   * The two functions to hand a test runner.
   *
   * The teardown phase runs in the opposite order to the setup phase: what was
   * acquired first is released last. A transaction opened before a stub was
   * installed has to be rolled back after the stub is gone, or the rollback
   * runs against a method that is still replaced.
   */
  hooks(own: TestBody = {}): { setup: () => Promise<void>; teardown: () => Promise<void> } {
    return {
      setup: async () => {
        await runAll([...this.#beforeSetup, ...listOf(own.setup), ...this.#afterSetup], false);
      },
      teardown: async () => {
        await runAll(
          [
            ...reversed(this.#beforeTeardown),
            ...listOf(own.teardown),
            ...reversed(this.#afterTeardown),
          ],
          true,
        );
      },
    };
  }
}

function listOf(hook: LifecycleHook | undefined): LifecycleHook[] {
  return hook ? [hook] : [];
}

function reversed(hooks: readonly LifecycleHook[]): LifecycleHook[] {
  return [...hooks].reverse();
}

/**
 * Runs hooks in order.
 *
 * `keepGoing` is the difference between the two phases, and it is not
 * symmetry for its own sake. A setup that fails should stop: the ones after it
 * were written assuming it worked, and running them produces a second,
 * misleading failure on top of the real one. A teardown that fails must not
 * stop, because the hooks after it are what put the globals back — and the
 * cost of skipping them is paid by a different test in a different file.
 *
 * The first failure is the one rethrown. Later ones are usually consequences
 * of it, and reporting the last would name the symptom rather than the cause.
 */
async function runAll(hooks: readonly LifecycleHook[], keepGoing: boolean): Promise<void> {
  let failure: unknown;
  let failed = false;

  for (const hook of hooks) {
    try {
      await hook();
    } catch (error) {
      if (!keepGoing) throw error;

      if (!failed) {
        failure = error;
        failed = true;
      }
    }
  }

  if (failed) throw failure;
}
