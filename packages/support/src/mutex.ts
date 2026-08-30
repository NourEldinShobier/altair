/**
 * Running one thing at a time, ported from the `synchronize` Rails takes from
 * Ruby's `Mutex` and uses throughout its connection and cache internals.
 *
 * JavaScript has no mutex because it has no threads, and that reasoning is
 * exactly half right. Nothing preempts a synchronous block — but every `await`
 * is a place another task can run, so two calls to the same async function
 * interleave freely, and any invariant that spans an await is not protected by
 * anything at all.
 *
 *     if (!token) token = await fetchToken()
 *
 * Two callers reaching that together both see no token, both fetch one, and
 * one of them throws the other's away — along with whatever was keyed to it.
 * The same shape covers opening a connection, rotating a key, initialising a
 * pool, and writing a file two requests both want to write.
 */

/** A queue of waiters, oldest first. */
export class Mutex {
  #locked = false;
  readonly #waiting: (() => void)[] = [];

  /** Whether anything holds it right now. */
  get locked(): boolean {
    return this.#locked;
  }

  /** How many callers are queued behind it. */
  get waiting(): number {
    return this.#waiting.length;
  }

  /**
   * Runs a block with the lock held. Rails' `synchronize`.
   *
   * The lock is released in a `finally`, which is the whole safety of the
   * thing: a block that throws while holding it would otherwise leave every
   * later caller waiting for ever, and the symptom — requests that hang rather
   * than fail — points nowhere near the code that threw.
   */
  async synchronize<T>(body: () => T | Promise<T>): Promise<T> {
    await this.#acquire();

    try {
      return await body();
    } finally {
      this.#release();
    }
  }

  async #acquire(): Promise<void> {
    if (!this.#locked) {
      this.#locked = true;

      return;
    }

    // Queued rather than polled: a poll wakes up to find the lock still held
    // and costs a timer per waiter per interval, and its latency is the
    // interval rather than zero.
    await new Promise<void>((resolve) => this.#waiting.push(resolve));
  }

  #release(): void {
    const next = this.#waiting.shift();

    // Handed straight to the next waiter rather than unlocked and re-raced:
    // unlocking first leaves a moment where the lock reads as free, and a
    // caller arriving in it would take the lock ahead of somebody already
    // waiting.
    //
    // Reasoning rather than a tested guarantee. The window is a microtask
    // wide, and every test written for it here also passed against the
    // unfair version — so the claim is that this shape has no window, not
    // that a test caught one.
    if (next) next();
    else this.#locked = false;
  }
}

const named = new Map<string, Mutex>();

/**
 * Runs a block with a lock held under a name.
 *
 * For the common case where the thing being protected has no object to hang a
 * mutex on — a file path, a cache key, a singleton being built. Keyed rather
 * than global, so two unrelated things are not serialised against each other
 * for having both wanted a lock.
 */
export async function synchronize<T>(name: string, body: () => T | Promise<T>): Promise<T> {
  let mutex = named.get(name);

  if (!mutex) {
    mutex = new Mutex();
    named.set(name, mutex);
  }

  return await mutex.synchronize(body);
}

/**
 * Runs a block once, however many callers arrive together.
 *
 * The pattern the whole file exists for. The result is remembered, so the
 * second caller gets the first's answer rather than starting its own attempt —
 * and a failure is *not* remembered, since a token fetch that failed once
 * should be retried rather than turned into a permanent error.
 */
const settled = new Map<string, unknown>();

export async function computeOnce<T>(name: string, body: () => Promise<T>): Promise<T> {
  if (settled.has(name)) return settled.get(name) as T;

  return await synchronize(name, async () => {
    // Checked again inside the lock. The first check is what makes the common
    // path free; this one is what makes it correct, because everything queued
    // behind the lock passed the first check before the winner had an answer.
    if (settled.has(name)) return settled.get(name) as T;

    const value = await body();

    settled.set(name, value);

    return value;
  });
}

/** Forgets a remembered value, so the next caller computes it again. */
export function forgetOnce(name: string): void {
  settled.delete(name);
}

/** Forgets everything. For a test, and for a reload. */
export function resetOnce(): void {
  settled.clear();
  named.clear();
}
