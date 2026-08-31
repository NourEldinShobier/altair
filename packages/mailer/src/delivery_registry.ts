/**
 * Which delivery method an application uses, and what happens when one fails.
 * Ported from `ActionMailer::Base` — `delivery_methods`, `wrap_delivery_behavior`
 * and the `rescue_from` path.
 *
 * `message.ts` defines what a delivery method is and `mailer.ts` picks one per
 * environment. What is missing is the registry between them, and the reason it
 * is worth having is the failure mode of not having one:
 *
 * A delivery method chosen by a conditional inside the mailer means every
 * environment's choice is in one expression, and the test environment's branch
 * is the one that has to be right — because the branch that is wrong sends
 * real mail from a test suite, to real addresses, and nobody finds out from a
 * failing assertion.
 *
 * The other half is what to do when sending fails. Mail is not a request: the
 * user has gone, there is nothing to render, and the only choices are to
 * retry, to drop it, or to let it take down whatever was sending. Rails lets
 * the mailer say which, and defaults to raising — because a mailer that
 * swallows its own failures reports success for every message it never sent.
 */

import type { DeliveryMethod, MessageFields } from "./message.js";

/** What a delivery method needs to be built. */
export type DeliveryMethodBuilder = (settings: Record<string, unknown>) => DeliveryMethod;

const methods = new Map<string, DeliveryMethodBuilder>();

/** Rails' `add_delivery_method`. */
export function addDeliveryMethod(name: string, build: DeliveryMethodBuilder): void {
  methods.set(name, build);
}

export function deliveryMethodNames(): string[] {
  return Array.from(methods.keys()).sort();
}

export function removeDeliveryMethod(name: string): boolean {
  return methods.delete(name);
}

export class UnknownDeliveryMethod extends Error {
  constructor(name: string, known: readonly string[]) {
    super(
      `No delivery method called "${name}". Registered: ${known.join(", ") || "none"}. ` +
        `A misspelled one must not silently fall back to sending real mail.`,
    );
    this.name = "UnknownDeliveryMethod";
  }
}

/**
 * Builds one. Rails' `wrap_delivery_behavior`.
 *
 * Throws for a name nobody registered rather than falling back. A typo that
 * quietly resolves to the real SMTP method is how a test suite mails a
 * customer.
 */
export function wrapDeliveryBehavior(
  name: string,
  settings: Record<string, unknown> = {},
): DeliveryMethod {
  const build = methods.get(name);

  if (!build) throw new UnknownDeliveryMethod(name, deliveryMethodNames());

  return build(settings);
}

export function resetDeliveryMethods(): void {
  methods.clear();
}

/** What to do when a delivery throws. */
export type DeliveryFailureAction = "raise" | "discard" | "retry";

export interface ExceptionRule {
  /** The error's name, or `"*"` for anything. */
  error: string;
  action: DeliveryFailureAction;
}

const rules: ExceptionRule[] = [];

/** Rails' `rescue_from` for a mailer. */
export function handleException(error: string, action: DeliveryFailureAction): void {
  // Newest first, so a specific rule added after a catch-all still wins.
  rules.unshift({ error, action });
}

export function exceptionRules(): readonly ExceptionRule[] {
  return rules;
}

export function clearExceptionRules(): void {
  rules.length = 0;
}

/**
 * What to do about a failed delivery. Rails' `handle_exceptions`.
 *
 * Raising is the default, and it is the right one: a mailer that swallows its
 * own failures reports success for every message it never sent, and the first
 * anybody knows is a support ticket about a missing password reset.
 */
export function handleExceptions(error: unknown): DeliveryFailureAction {
  const name = error instanceof Error ? error.name : "Error";
  const rule =
    rules.find((each) => each.error === name) ?? rules.find((each) => each.error === "*");

  return rule?.action ?? "raise";
}

/**
 * Something that wraps a delivery. Rails' `around_deliver`.
 *
 * Distinct from the before/after hooks `mailer.ts` already has: those are
 * told a delivery happened, this one decides whether and how it happens —
 * which is what a timing measurement or a retry needs.
 */
export type AroundDeliveryHook = (
  message: MessageFields,
  deliver: () => Promise<void>,
) => Promise<void>;

const aroundHooks: AroundDeliveryHook[] = [];

export function aroundDeliver(hook: AroundDeliveryHook): void {
  aroundHooks.push(hook);
}

export function aroundDeliveryHooks(): readonly AroundDeliveryHook[] {
  return aroundHooks;
}

export function clearAroundDeliveryHooks(): void {
  aroundHooks.length = 0;
}

/**
 * Sends one message, with everything registered around it. Rails'
 * `deliver_mail`.
 *
 * The hooks nest outermost-first, so one registered earlier wraps one
 * registered later — which is what makes a timing hook that was added at boot
 * actually measure the retry hook added by a feature.
 */
export async function deliverMail(
  message: MessageFields,
  method: DeliveryMethod,
  hooks: readonly AroundDeliveryHook[] = aroundHooks,
): Promise<DeliveryFailureAction | "delivered"> {
  const send = async (): Promise<void> => {
    await method.sendMail(message);
  };

  const wrapped = [...hooks]
    .reverse()
    .reduce<() => Promise<void>>((next, hook) => async () => hook(message, next), send);

  try {
    await wrapped();

    return "delivered";
  } catch (error) {
    const action = handleExceptions(error);

    if (action === "raise") throw error;

    return action;
  }
}

/**
 * The mailer class a name refers to. Rails' `mailer_class` /
 * `determine_default_mailer`.
 *
 * Named rather than guessed from the controller, because a mailer resolved by
 * convention from something that was renamed fails at send time — which is
 * inside a job, on a queue, with a stack that names the queue.
 */
const mailers = new Map<string, unknown>();

export function registerMailer(name: string, mailer: unknown): void {
  mailers.set(name, mailer);
}

export function mailerClass(name: string): unknown {
  return mailers.get(name);
}

export class UnknownMailer extends Error {
  constructor(name: string, known: readonly string[]) {
    super(`No mailer called "${name}". Registered: ${known.join(", ") || "none"}.`);
    this.name = "UnknownMailer";
  }
}

export function determineDefaultMailer(name: string): unknown {
  const found = mailers.get(name);

  if (found === undefined) throw new UnknownMailer(name, Array.from(mailers.keys()).sort());

  return found;
}

export function resetMailers(): void {
  mailers.clear();
}

/**
 * Methods a mailer defines that are not actions. Rails' `internal_methods`.
 *
 * Every public method on a mailer becomes a mail-sending action, so anything
 * inherited or helper-shaped has to be excluded — otherwise `attachments` and
 * `headers` are routable, and a URL that reaches one produces a mail with no
 * template and an exception nobody can place.
 */
export const INTERNAL_METHODS: ReadonlySet<string> = new Set([
  "attachments",
  "headers",
  "mail",
  "deliver",
  "message",
  "constructor",
  "toString",
  "valueOf",
]);

export function internalMethods(): ReadonlySet<string> {
  return INTERNAL_METHODS;
}

/** The action methods of a mailer: everything public that is not internal. */
export function actionMethods(names: Iterable<string>): string[] {
  return Array.from(names).filter(
    (name) => !INTERNAL_METHODS.has(name) && !name.startsWith("_") && !name.startsWith("#"),
  );
}

/**
 * A fixture's contents, for a test asserting on a rendered mail. Rails'
 * `read_fixture`.
 *
 * Trailing whitespace is kept and the trailing newline is not. A fixture read
 * one way and a template rendered the other differ by a newline nobody can
 * see, and the assertion failure shows two identical-looking strings.
 */
export function readFixture(contents: string): string[] {
  return contents.replace(/\n$/, "").split("\n");
}

/**
 * An observer registered under a name. Rails' `observer_class_for`.
 *
 * `message.ts` already keeps an anonymous list, which cannot answer "is the
 * metrics observer installed?" — and an application that registers one twice
 * on a reload then counts every mail twice.
 */
export interface NamedObserver {
  delivered(message: MessageFields): void | Promise<void>;
}

const observers = new Map<string, NamedObserver>();

export function registerNamedObserver(name: string, observer: NamedObserver): void {
  observers.set(name, observer);
}

export function observerClassFor(name: string): NamedObserver | undefined {
  return observers.get(name);
}

export function namedObservers(): NamedObserver[] {
  return Array.from(observers.values());
}

export function clearNamedObservers(): void {
  observers.clear();
}

/**
 * Tells every observer a message went out.
 *
 * One observer failing does not stop the others, and none of them can fail the
 * delivery: the mail has already been sent, so raising here would report a
 * failure for something that succeeded — and a retry would send it twice.
 */
export async function notifyNamedObservers(message: MessageFields): Promise<void> {
  for (const observer of observers.values()) {
    try {
      await observer.delivered(message);
    } catch {
      // The mail is gone. Nothing here can un-send it.
    }
  }
}

/** A per-mailer setting that is not one of the standard ones. Rails' `custom`. */
const custom = new Map<string, Record<string, unknown>>();

export function setCustom(mailer: string, settings: Record<string, unknown>): void {
  custom.set(mailer, { ...custom.get(mailer), ...settings });
}

export function customFor(mailer: string): Record<string, unknown> {
  return { ...custom.get(mailer) };
}

export function clearCustom(): void {
  custom.clear();
}
