/**
 * Working out which channel a test is about, ported from
 * `ActionCable::Channel::TestCase` and `Connection::TestCase`.
 *
 * `channel-testing.ts` drives a channel once a test has one. This is the step
 * before: `ChatChannelTest` tests `ChatChannel`, so the test does not say so.
 *
 * The whole feature is one inference and one refusal, and the refusal is the
 * important half. A test whose subject could not be inferred and quietly got
 * nothing would pass — it would assert against a channel that never received
 * anything, which is indistinguishable from a channel that received everything
 * and did nothing. Rails raises instead, naming the class it looked for.
 */

import { determineConstantFromTestName } from "@altair/support";

export class NonInferrableChannel extends Error {
  constructor(testName: string, looked: string) {
    super(
      `Could not work out which channel ${testName} is about; expected ${looked}. Say so with ` +
        `tests(SomeChannel). Inferring nothing and carrying on would let the test pass against a ` +
        `channel that never received anything, which looks exactly like one that received ` +
        `everything and did nothing.`,
    );
    this.name = "NonInferrableChannel";
  }
}

export class NonInferrableConnection extends Error {
  constructor(testName: string, looked: string) {
    super(
      `Could not work out which connection ${testName} is about; expected ${looked}. Say so with ` +
        `testsConnection(SomeConnection).`,
    );
    this.name = "NonInferrableConnection";
  }
}

/** Rails' `determine_default_channel`. */
export function determineDefaultChannel(
  testName: string,
  known: ReadonlyMap<string, unknown>,
): unknown {
  const found = determineConstantFromTestName(`${testName}Channel`, (name) => known.get(name));

  if (found === undefined) throw new NonInferrableChannel(testName, `${testName}Channel`);

  return found;
}

/** Rails' `determine_default_connection`. */
export function determineDefaultConnection(
  testName: string,
  known: ReadonlyMap<string, unknown>,
): unknown {
  const found = determineConstantFromTestName(`${testName}Connection`, (name) => known.get(name));

  if (found === undefined) throw new NonInferrableConnection(testName, `${testName}Connection`);

  return found;
}

export interface TestSubject {
  channelClass?: unknown;
  connectionClass?: unknown;
  messages: unknown[];
}

export function newTestSubject(): TestSubject {
  return { messages: [] };
}

/**
 * Rails' `tests` — say which channel explicitly.
 *
 * Takes a name or the class itself. A name is resolved rather than stored,
 * because a name that resolves to nothing has to fail here rather than at the
 * first assertion — where the failure would be about a channel that received
 * no messages instead of about a name nothing answers.
 */
export function tests(
  subject: TestSubject,
  channel: string | object,
  known: ReadonlyMap<string, unknown> = new Map(),
): unknown {
  subject.channelClass = resolve(channel, known, (name) => new NonInferrableChannel(name, name));

  return subject.channelClass;
}

/** Rails' `tests_connection`. */
export function testsConnection(
  subject: TestSubject,
  connection: string | object,
  known: ReadonlyMap<string, unknown> = new Map(),
): unknown {
  subject.connectionClass = resolve(
    connection,
    known,
    (name) => new NonInferrableConnection(name, name),
  );

  return subject.connectionClass;
}

function resolve(
  value: string | object,
  known: ReadonlyMap<string, unknown>,
  error: (name: string) => Error,
): unknown {
  if (typeof value !== "string") return value;

  const found = known.get(value);

  if (found === undefined) throw error(value);

  return found;
}

/**
 * Rails' `connection_class` — what was declared, or what the name implies.
 *
 * Declared first: a test that said which connection it uses has said something
 * the name cannot, and inferring over an explicit declaration would make the
 * declaration silently do nothing.
 */
export function connectionClass(
  subject: TestSubject,
  testName: string,
  known: ReadonlyMap<string, unknown>,
): unknown {
  return subject.connectionClass ?? determineDefaultConnection(testName, known);
}

/** The same for the channel. */
export function channelClass(
  subject: TestSubject,
  testName: string,
  known: ReadonlyMap<string, unknown>,
): unknown {
  return subject.channelClass ?? determineDefaultChannel(testName, known);
}

/**
 * Rails' `clear_messages`.
 *
 * Between two actions in one test. Left in place, a message from the first
 * makes "transmitted nothing" on the second pass for the wrong reason — and
 * that assertion is the one most likely to be wrong, since it passes by
 * default.
 */
export function clearMessages(subject: TestSubject): TestSubject {
  subject.messages.length = 0;

  return subject;
}

/**
 * Rails' `stream_or_reject_for` — stream for a record, or reject if there is
 * none.
 *
 * The pattern exists because the alternative is a subscription that succeeds
 * and streams from `"posts:"`. The client believes it is subscribed, receives
 * nothing forever, and has no way to tell that from a quiet stream. Rejecting
 * is the only outcome the client can act on.
 */
export function streamOrRejectFor(
  record: unknown,
  streamFor: (record: object) => void,
  reject: () => void,
): boolean {
  if (record === undefined || record === null || record === false) {
    reject();

    return false;
  }

  streamFor(record as object);

  return true;
}
