// Card representations, 52-card deck builder, and deterministic/cryptographic Fisher-Yates shuffle.
// Dependency-free ES module compatible with Node and Deno (Supabase Edge Functions).

export const RANKS = Object.freeze([
  "2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"
]);

export const SUITS = Object.freeze(["s", "h", "d", "c"]);

export const RANK_VALUES = Object.freeze({
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
  "8": 8,
  "9": 9,
  "T": 10,
  "J": 11,
  "Q": 12,
  "K": 13,
  "A": 14
});

export const VALUE_RANKS = Object.freeze({
  1: "A",
  2: "2",
  3: "3",
  4: "4",
  5: "5",
  6: "6",
  7: "7",
  8: "8",
  9: "9",
  10: "T",
  11: "J",
  12: "Q",
  13: "K",
  14: "A"
});

const VALID_SUITS = new Set(SUITS);

/**
 * Parses a 2-character card code such as "As", "Td", "2c".
 */
export function parseCard(card) {
  if (typeof card !== "string" || card.length !== 2) {
    throw new Error(`Invalid card "${card}": expected 2-character string such as "As" or "Td".`);
  }
  const rank = card[0].toUpperCase();
  const suit = card[1].toLowerCase();
  const value = RANK_VALUES[rank];
  if (!value || !VALID_SUITS.has(suit)) {
    throw new Error(`Invalid card "${card}": unknown rank or suit.`);
  }
  return { code: `${rank}${suit}`, rank, value, suit };
}

/**
 * Creates a fresh 52-card deck in canonical order.
 */
export function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push(`${rank}${suit}`);
    }
  }
  return deck;
}

/**
 * Cryptographically secure uniform random float in [0, 1) using Web Crypto (`crypto.getRandomValues`).
 */
export function cryptoRng() {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0] / 0x100000000;
}

/**
 * Creates a deterministic seeded PRNG (Mulberry32) returning floats in [0, 1).
 * Useful for reproducible unit tests.
 */
export function createSeededRng(seed = 1) {
  let state = seed >>> 0;
  return function nextFloat() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

/**
 * Returns a shuffled copy of `deck` using Fisher-Yates.
 * - If `rng` is an Array of card codes, validates and returns a copy of that fixed deck directly.
 * - If `rng` is a function `() => float`, uses it for deterministic shuffling.
 * - If `rng` is omitted, defaults to `cryptoRng`.
 */
export function shuffleDeck(deck = createDeck(), rng = cryptoRng) {
  if (Array.isArray(rng)) {
    const fixed = rng.map((c) => parseCard(c).code);
    const seen = new Set(fixed);
    if (seen.size !== fixed.length) {
      throw new Error("Fixed deck contains duplicate cards.");
    }
    return fixed;
  }

  const randomFn = typeof rng === "function" ? rng : cryptoRng;
  const copy = deck.map((c) => parseCard(c).code);

  for (let i = copy.length - 1; i > 0; i -= 1) {
    const raw = Number(randomFn());
    const clamped = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 0.999999999999) : 0;
    const j = Math.floor(clamped * (i + 1));
    const tmp = copy[i];
    copy[i] = copy[j];
    copy[j] = tmp;
  }
  return copy;
}
