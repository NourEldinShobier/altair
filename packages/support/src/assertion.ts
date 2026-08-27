/**
 * The error every assertion in the framework raises.
 *
 * Here rather than in `@altair/testing` because the components ship their own
 * assertions — Action Cable's broadcast helpers, Active Job's enqueue helpers —
 * and a test that catches one should not have to know which package it came
 * from. `@altair/testing` re-exports it, so nothing that already imports it
 * from there has to change.
 */
export class AssertionFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssertionFailed";
  }
}
