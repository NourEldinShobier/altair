/**
 * Replacing something for the length of one test, ported from
 * `ActiveSupport::Testing::ConstantStubbing`, `MethodCallAssertions` and
 * `TimeHelpers`' stack of stubs.
 *
 * A test that replaces a method and does not put it back does not fail. It
 * passes, and some *later* test — usually one that looks unrelated, often one
 * that passes alone — fails instead. That is the worst failure a suite can
 * have, because the test that reports it is not the test that caused it, and
 * running it alone makes the symptom disappear.
 *
 * So everything here is built around restoring:
 *
 * - A stub records what was there *and whether it was there at all*, because
 *   deleting a property and restoring `undefined` are different: the first
 *   leaves the prototype's version visible again, the second shadows it with
 *   `undefined` forever.
 * - Restoration happens in a `finally`, and `unstubAll` exists for a suite to
 *   call from a teardown that runs whatever the test did.
 * - Restoring is idempotent, so a test that restores explicitly *and* has a
 *   teardown does not put back a stub the second time.
 */

interface Stubbed {
  target: Record<string, unknown>;
  property: string;
  original: unknown;
  /** Whether the target owned the property itself before the stub. */
  owned: boolean;
  restored: boolean;
}

const active: Stubbed[] = [];

/**
 * Replaces a property for the length of the suite, until restored.
 *
 * Records `owned` as well as the value. Deleting a property the target did not
 * own and then assigning `undefined` back would shadow the prototype's version
 * permanently — which is a stub that never really ends.
 */
export function stubObject(target: object, property: string, replacement: unknown): () => void {
  const holder = target as Record<string, unknown>;
  const entry: Stubbed = {
    target: holder,
    property,
    original: holder[property],
    owned: Object.hasOwn(holder, property),
    restored: false,
  };

  holder[property] = replacement;
  active.push(entry);

  return () => restore(entry);
}

function restore(entry: Stubbed): void {
  // Idempotent: a test that restores explicitly and also has a teardown must
  // not put the stub back on the second call.
  if (entry.restored) return;

  entry.restored = true;

  if (entry.owned) entry.target[entry.property] = entry.original;
  else delete entry.target[entry.property];
}

/** Rails' `stub_const` — the same, for an entry in a registry. */
export function stubConst(
  registry: Map<string, unknown>,
  name: string,
  replacement: unknown,
): () => void {
  const had = registry.has(name);
  const original = registry.get(name);
  let restored = false;

  registry.set(name, replacement);

  const undo = (): void => {
    if (restored) return;

    restored = true;

    if (had) registry.set(name, original);
    else registry.delete(name);
  };

  constStubs.push(undo);

  return undo;
}

const constStubs: (() => void)[] = [];

/** Whether anything is currently stubbed. Rails' `stubbing?`. */
export function stubbing(): boolean {
  return active.some((entry) => !entry.restored) || constStubs.length > 0;
}

/** What is stubbed right now, for a teardown that wants to report a leak. */
export function stubbed(): { target: string; property: string }[] {
  return active
    .filter((entry) => !entry.restored)
    .map((entry) => ({
      target: (entry.target as { constructor?: { name?: string } }).constructor?.name ?? "object",
      property: entry.property,
    }));
}

/**
 * Puts everything back. Rails' `unstub_all!`.
 *
 * The safety net a suite calls from a teardown that runs whatever the test
 * did — including after it threw, which is exactly when a test skips its own
 * cleanup.
 *
 * In reverse order, because two stubs of the same property have to unwind the
 * way they were applied; forwards, the first restore would put back the
 * *second* stub's value.
 */
export function unstubAll(): number {
  let count = 0;

  for (let index = active.length - 1; index >= 0; index -= 1) {
    const entry = active[index] as Stubbed;

    if (!entry.restored) count += 1;

    restore(entry);
  }

  for (let index = constStubs.length - 1; index >= 0; index -= 1) {
    (constStubs[index] as () => void)();
    count += 1;
  }

  active.length = 0;
  constStubs.length = 0;

  return count;
}

/**
 * Runs a body with something stubbed, restoring afterwards.
 *
 * The `finally` is the whole function: a body that throws is precisely the
 * case where a test's own cleanup does not run.
 */
export async function withStub<T>(
  target: object,
  property: string,
  replacement: unknown,
  body: () => Promise<T> | T,
): Promise<T> {
  const undo = stubObject(target, property, replacement);

  try {
    return await body();
  } finally {
    undo();
  }
}

// --- recording calls --------------------------------------------------------

export interface CallRecord {
  args: unknown[];
  result?: unknown;
}

/**
 * A replacement that remembers how it was called. Rails' `assert_called`.
 *
 * Records arguments rather than only a count, because "was it called" is
 * rarely the question — "was it called with the id of the record the test
 * created" is, and a count cannot tell a right call from a wrong one.
 */
export function recorder<T extends unknown[], R>(
  result?: R | ((...args: T) => R),
): ((...args: T) => R) & { calls: CallRecord[] } {
  const calls: CallRecord[] = [];

  const fn = (...args: T): R => {
    const value =
      typeof result === "function" ? (result as (...args: T) => R)(...args) : (result as R);

    calls.push({ args, result: value });

    return value;
  };

  return Object.assign(fn, { calls });
}

/** How many times a recorder was called with arguments matching a predicate. */
export function calledWith(
  recorded: { calls: CallRecord[] },
  matches: (args: unknown[]) => boolean,
): number {
  return recorded.calls.filter((call) => matches(call.args)).length;
}

export class UnexpectedCallCount extends Error {
  constructor(name: string, expected: number, actual: number) {
    super(
      `Expected ${JSON.stringify(name)} to be called ${expected} time${expected === 1 ? "" : "s"}, ` +
        `not ${actual}. A count that is too high usually means a loop calling something it could ` +
        `hoist; one that is too low usually means a guard nobody meant to add.`,
    );
    this.name = "UnexpectedCallCount";
  }
}

/** Rails' `assert_called` / `assert_called_times`. */
export function assertCalled(name: string, recorded: { calls: CallRecord[] }, times = 1): void {
  if (recorded.calls.length !== times) {
    throw new UnexpectedCallCount(name, times, recorded.calls.length);
  }
}

/** Rails' `assert_not_called`. */
export function assertNotCalled(name: string, recorded: { calls: CallRecord[] }): void {
  assertCalled(name, recorded, 0);
}
