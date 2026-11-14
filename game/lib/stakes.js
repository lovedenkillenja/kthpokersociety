// Table stakes presets chosen by the host when creating a table (pure, no DOM, no network).
// The server stays the final judge: it validates blinds and buy-in range on `create` and
// each seat's buy-in against the table's own min and max on `sit_down`.
// Every preset follows the same shape: bb = 2 x sb, min buy-in = 20 bb, max buy-in = 100 bb.

import { formatChips } from "./format.js";

export const STAKES_PRESETS = Object.freeze([
  Object.freeze({ id: "micro", name: "Micro", sb: 1, bb: 2, minBuyIn: 40, maxBuyIn: 200 }),
  Object.freeze({ id: "low", name: "Low", sb: 5, bb: 10, minBuyIn: 200, maxBuyIn: 1000 }),
  Object.freeze({ id: "standard", name: "Standard", sb: 10, bb: 20, minBuyIn: 400, maxBuyIn: 2000 })
]);

export const DEFAULT_STAKES_ID = "low";

/** Database limits (poker_tables check constraints). */
export const STAKES_DB_LIMITS = Object.freeze({ maxSb: 10000, maxBb: 20000, maxBuyIn: 100000 });

/**
 * Returns the preset for an id, or the default preset when the id is unknown.
 */
export function getStakesPreset(id) {
  const wanted = String(id ?? "").toLowerCase();
  return (
    STAKES_PRESETS.find((p) => p.id === wanted) ||
    STAKES_PRESETS.find((p) => p.id === DEFAULT_STAKES_ID)
  );
}

/**
 * Finds the preset whose blinds and buy-in range match a table, or null (custom table).
 */
export function findPresetForTable(table) {
  if (!table) return null;
  return (
    STAKES_PRESETS.find(
      (p) =>
        p.sb === Number(table.sb) &&
        p.bb === Number(table.bb) &&
        p.minBuyIn === Number(table.minBuyIn) &&
        p.maxBuyIn === Number(table.maxBuyIn)
    ) || null
  );
}

/**
 * "5 / 10 blinds"
 */
export function formatBlinds(sb, bb) {
  return `${formatChips(sb)} / ${formatChips(bb)} blinds`;
}

/**
 * "Buy-in 200–1,000 chips"
 */
export function formatBuyInRange(minBuyIn, maxBuyIn) {
  return `Buy-in ${formatChips(minBuyIn)}–${formatChips(maxBuyIn)} chips`;
}

/**
 * "5 / 10 blinds · Buy-in 200–1,000 chips". Accepts a preset or a table state
 * (`sb`, `bb`, `minBuyIn`, `maxBuyIn`).
 */
export function formatStakesLabel(stakes) {
  if (!stakes) return "";
  return `${formatBlinds(stakes.sb, stakes.bb)} · ${formatBuyInRange(stakes.minBuyIn, stakes.maxBuyIn)}`;
}

/**
 * Label for the buy-in input: "Your buy-in (200–1,000 chips)".
 */
export function formatBuyInFieldLabel(stakes) {
  if (!stakes) return "Your buy-in";
  return `Your buy-in (${formatChips(stakes.minBuyIn)}–${formatChips(stakes.maxBuyIn)} chips)`;
}

/**
 * Suggested starting buy-in: 50 big blinds, clamped to the range and to the balance.
 * When the balance is below the minimum buy-in the minimum is returned (validation then
 * explains the shortfall).
 */
export function defaultBuyInFor(stakes, balance = Infinity) {
  const target = 50 * stakes.bb;
  const cap = Math.min(stakes.maxBuyIn, Number.isFinite(Number(balance)) ? Math.trunc(Number(balance)) : stakes.maxBuyIn);
  if (cap < stakes.minBuyIn) return stakes.minBuyIn;
  return Math.min(cap, Math.max(stakes.minBuyIn, target));
}

/**
 * Attributes for a buy-in input following a stakes object.
 */
export function buyInInputAttrs(stakes, balance = Infinity) {
  return {
    min: stakes.minBuyIn,
    max: stakes.maxBuyIn,
    step: stakes.bb,
    value: defaultBuyInFor(stakes, balance)
  };
}

/**
 * Message for a join attempt whose buy-in is outside the joined table's own range.
 * Returns "" when the buy-in is inside the range.
 */
export function joinRangeMessage(table, amount) {
  const n = Number(amount);
  if (!table || !Number.isFinite(n)) return "";
  if (n >= table.minBuyIn && n <= table.maxBuyIn) return "";
  const where = table.code ? `Room ${table.code}` : "This table";
  return `${where} plays ${formatBlinds(table.sb, table.bb)} and needs a buy-in of ${formatChips(table.minBuyIn)}–${formatChips(table.maxBuyIn)} chips. Adjust your buy-in and join again.`;
}

/**
 * Generic copy that stays true for every preset.
 */
export function stakesSummaryCopy() {
  return STAKES_PRESETS.map((p) => `${p.name} ${p.sb}/${p.bb}`).join(", ").replace(/, ([^,]*)$/, " or $1");
}
