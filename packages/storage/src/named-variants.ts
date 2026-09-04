/**
 * Variants under a name, ported from `ActiveStorage::Attached::Model`'s
 * `variant` declarations and the service operations beside them.
 *
 * A transformation written at the call site is written slightly differently at
 * the next one, and the day the design changes there are eleven places to
 * find. Naming it puts the decision in the model:
 *
 *     hasOneAttached(this, "avatar", {
 *       variants: { thumb: { resize: [100, 100] }, hero: { resize: [1200, 600] } },
 *     })
 *
 *     await user.avatar.variant("thumb")
 */

import type { Transformations } from "./variant.js";

const declarations = new Map<string, Map<string, Transformations>>();

/** Remembers the variants declared for one attachment on one model. */
export function declareVariants(
  model: string,
  attachment: string,
  variants: Record<string, Transformations>,
): void {
  const key = `${model}#${attachment}`;
  const named = declarations.get(key) ?? new Map();

  for (const [name, transformations] of Object.entries(variants)) {
    named.set(name, transformations);
  }

  declarations.set(key, named);
}

/** What a name stands for, or undefined when nobody declared it. */
export function namedVariant(
  model: string,
  attachment: string,
  name: string,
): Transformations | undefined {
  return declarations.get(`${model}#${attachment}`)?.get(name);
}

/** Every name declared for an attachment. */
export function namedVariants(model: string, attachment: string): string[] {
  return [...(declarations.get(`${model}#${attachment}`)?.keys() ?? [])].sort();
}

export function resetNamedVariants(): void {
  declarations.clear();
}

/**
 * Resolves what a caller asked for into transformations.
 *
 * A name that nobody declared is refused rather than treated as no
 * transformation at all — a typo would otherwise hand back the original image
 * at full size, which looks like the variant working until somebody notices
 * the page weighs nine megabytes.
 */
export function transformationsFor(
  model: string,
  attachment: string,
  wanted: string | Transformations,
): Transformations {
  if (typeof wanted !== "string") return wanted;

  const found = namedVariant(model, attachment, wanted);

  if (!found) {
    const known = namedVariants(model, attachment);

    throw new Error(
      `No variant named "${wanted}" on ${model}'s ${attachment}.` +
        (known.length > 0 ? ` Declared: ${known.join(", ")}.` : " None are declared."),
    );
  }

  return found;
}
