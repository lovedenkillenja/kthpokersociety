// Pure helpers for the decorative chip graphics. The numeric amount stays the source of truth;
// these only decide which chips to draw, never what a player owns.

/** Chip denominations, largest first. */
export const DENOMINATIONS = Object.freeze([1000, 500, 100, 25, 5, 1]);

/**
 * Breaks an amount into a small visual set of stacks, largest denomination first.
 * Each stack is `{ denom, count }`. The drawing is capped (default max 5 chips per stack and max 3 stacks),
 * so it is an approximation of the amount, e.g. 1,380 is drawn as 1000x1, 100x3, 25x3 and never as 50 chips.
 * Returns [] for zero, negative or non-numeric amounts.
 */
export function chipStacks(amount, { maxPerStack = 5, maxStacks = 3 } = {}) {
  let rest = Math.floor(Number(amount));
  if (!Number.isFinite(rest) || rest <= 0) return [];
  const perStack = Math.max(1, Math.floor(maxPerStack));
  const stackLimit = Math.max(1, Math.floor(maxStacks));
  const stacks = [];
  for (const denom of DENOMINATIONS) {
    if (stacks.length >= stackLimit) break;
    const count = Math.floor(rest / denom);
    if (count < 1) continue;
    stacks.push({ denom, count: Math.min(count, perStack) });
    rest -= count * denom;
  }
  return stacks;
}

/** The highest denomination that fits in the amount (at least 1), used for the single chip icon beside a stack amount. */
export function iconDenomination(amount) {
  const n = Math.floor(Number(amount));
  if (!Number.isFinite(n) || n < 1) return 1;
  return DENOMINATIONS.find((d) => n >= d) || 1;
}

/** Number of edge inserts drawn on the rim: a second cue besides colour. */
export const RIM_INSERTS = Object.freeze({ 1: 4, 5: 6, 25: 8, 100: 10, 500: 12, 1000: 16 });
