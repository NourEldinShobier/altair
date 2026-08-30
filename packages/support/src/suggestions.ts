/**
 * "Did you mean?", ported from Rails' `did_you_mean` integration and
 * `ActiveSupport::Correctable`.
 *
 *     corrections("titel", ["title", "body", "author"])   // ["title"]
 *
 * Worth having because of what the alternative error looks like. `unknown
 * attribute 'titel'` is correct, unhelpful, and identical whether the caller
 * made a typo, used the wrong model, or is reading a column that was renamed
 * three migrations ago. Naming the near miss collapses the first case — much
 * the commonest — from a search through the schema to a glance.
 *
 * The distance is Damerau-Levenshtein rather than plain Levenshtein: it counts
 * a transposition as one edit rather than two, and transpositions are what
 * typing produces. `titel` for `title` is one swap and would otherwise score
 * the same as two unrelated substitutions, which is enough to push the right
 * answer below the threshold.
 */

/**
 * How many single-character edits separate two words, counting a swap of
 * neighbours as one.
 *
 * Bounded so a caller comparing against a large list is not paying for exact
 * distances it is going to discard: once a row's best is past the limit,
 * nothing later can come back under it.
 */
export function editDistance(a: string, b: string, limit = Number.POSITIVE_INFINITY): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  if (Math.abs(a.length - b.length) > limit) return limit + 1;

  // Three rows rather than the whole matrix: the recurrence reaches back two
  // rows for a transposition and no further, so the rest is never read again.
  let twoBack = Array.from<number>({ length: b.length + 1 }).fill(0);
  let oneBack = Array.from({ length: b.length + 1 }, (_, index) => index);
  let current = Array.from<number>({ length: b.length + 1 }).fill(0);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    let best = current[0];

    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;

      let value = Math.min(
        (current[j - 1] as number) + 1, // insertion
        (oneBack[j] as number) + 1, // deletion
        (oneBack[j - 1] as number) + cost, // substitution
      );

      // The transposition: `ab` -> `ba` is one edit, not two.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, (twoBack[j - 2] as number) + 1);
      }

      current[j] = value;
      best = Math.min(best, value);
    }

    if (best > limit) return limit + 1;

    [twoBack, oneBack, current] = [oneBack, current, twoBack];
  }

  return oneBack[b.length] as number;
}

export interface CorrectionOptions {
  /**
   * How many to name. More than a couple stops being a suggestion and starts
   * being the list the caller already could not read.
   */
  limit?: number;
  /**
   * How far a word may be and still count, as a fraction of its length.
   *
   * Proportional rather than fixed, because one wrong letter in `id` is a
   * different word and one wrong letter in `authenticated_at` is a typo. A
   * fixed threshold either rejects the second or accepts nonsense for the
   * first.
   */
  tolerance?: number;
}

/**
 * The words from `candidates` that `word` was probably meant to be. Rails'
 * `corrections`.
 *
 * Ordered by how close they are, so the first is the best guess. An exact
 * match is not returned: if the word were in the list there would be no error
 * to explain.
 */
export function corrections(
  word: string,
  candidates: Iterable<string>,
  options: CorrectionOptions = {},
): string[] {
  const limit = options.limit ?? 3;
  const tolerance = options.tolerance ?? 0.34;
  const target = word.toLowerCase();

  const scored: { candidate: string; distance: number }[] = [];

  for (const candidate of candidates) {
    if (candidate === word) continue;

    const lowered = candidate.toLowerCase();

    // Sized against the longer of the two, so a typo that dropped a character
    // is measured against the real word rather than against itself: `ip` for
    // `zip` gets the allowance `zip` deserves, not the none that a two-letter
    // word would.
    //
    // No floor of 1: with one, every two-letter word is one edit from every
    // other and `ad` starts suggesting `id`, which is a different column and
    // not a typo. Words too short for a proportional allowance get no
    // suggestion, which is the right answer for them.
    const allowed = Math.floor(Math.max(target.length, lowered.length) * tolerance);
    const distance = editDistance(target, lowered, allowed);

    if (distance <= allowed) scored.push({ candidate, distance });
  }

  return scored
    .sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate))
    .slice(0, limit)
    .map((one) => one.candidate);
}

/** Whether anything is close enough to be worth naming. Rails' `corrections?`. */
export function hasCorrections(
  word: string,
  candidates: Iterable<string>,
  options?: CorrectionOptions,
): boolean {
  return corrections(word, candidates, options).length > 0;
}

/**
 * The sentence to put after an error message, or an empty string.
 *
 * Empty rather than something like "no suggestions", because a message that
 * always adds a clause teaches people to stop reading the clause — and the
 * whole value here is that its presence means something.
 */
export function didYouMean(
  word: string,
  candidates: Iterable<string>,
  options?: CorrectionOptions,
): string {
  const found = corrections(word, candidates, options);

  if (found.length === 0) return "";

  return ` Did you mean ${found.map((one) => `\`${one}\``).join(" or ")}?`;
}
