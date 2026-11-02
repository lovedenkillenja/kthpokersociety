// Texas Hold'em 5-to-7 card hand evaluator and comparator.
// Evaluates all 5-card combinations to determine exact category, tie-break kickers, and best 5 cards.

import { parseCard } from "./cards.js";

export const HAND_CATEGORIES = Object.freeze({
  HIGH_CARD: 0,
  ONE_PAIR: 1,
  TWO_PAIR: 2,
  THREE_OF_A_KIND: 3,
  STRAIGHT: 4,
  FLUSH: 5,
  FULL_HOUSE: 6,
  FOUR_OF_A_KIND: 7,
  STRAIGHT_FLUSH: 8
});

export const CATEGORY_NAMES = Object.freeze({
  0: "High Card",
  1: "One Pair",
  2: "Two Pair",
  3: "Three of a Kind",
  4: "Straight",
  5: "Flush",
  6: "Full House",
  7: "Four of a Kind",
  8: "Straight Flush"
});

function encodeScore(category, fiveValues) {
  return (
    (category << 20) |
    (fiveValues[0] << 16) |
    (fiveValues[1] << 12) |
    (fiveValues[2] << 8) |
    (fiveValues[3] << 4) |
    fiveValues[4]
  );
}

/**
 * Evaluates exactly 5 parsed cards.
 */
function evaluate5(cards5) {
  const sorted = [...cards5].sort((a, b) => b.value - a.value);
  const v0 = sorted[0].value;
  const v1 = sorted[1].value;
  const v2 = sorted[2].value;
  const v3 = sorted[3].value;
  const v4 = sorted[4].value;

  const isFlush =
    sorted[0].suit === sorted[1].suit &&
    sorted[1].suit === sorted[2].suit &&
    sorted[2].suit === sorted[3].suit &&
    sorted[3].suit === sorted[4].suit;

  const isRegularStraight =
    v0 - v1 === 1 && v1 - v2 === 1 && v2 - v3 === 1 && v3 - v4 === 1;

  // Wheel straight: A-2-3-4-5 (Ace plays low as 1, 5 is the high card)
  const isWheelStraight =
    v0 === 14 && v1 === 5 && v2 === 4 && v3 === 3 && v4 === 2;

  if (isFlush && (isRegularStraight || isWheelStraight)) {
    const orderedCards = isWheelStraight
      ? [sorted[1], sorted[2], sorted[3], sorted[4], sorted[0]]
      : sorted;
    const fiveValues = isWheelStraight ? [5, 4, 3, 2, 1] : [v0, v1, v2, v3, v4];
    const highRank = fiveValues[0];
    return {
      category: HAND_CATEGORIES.STRAIGHT_FLUSH,
      name: CATEGORY_NAMES[HAND_CATEGORIES.STRAIGHT_FLUSH],
      ranks: [highRank],
      fiveValues,
      cards: orderedCards.map((c) => c.code),
      score: encodeScore(HAND_CATEGORIES.STRAIGHT_FLUSH, fiveValues)
    };
  }

  // Group by rank value
  const groupsMap = new Map();
  for (const card of sorted) {
    const group = groupsMap.get(card.value);
    if (group) {
      group.cards.push(card);
    } else {
      groupsMap.set(card.value, { value: card.value, cards: [card] });
    }
  }

  // Sort groups by count descending, then rank value descending
  const groups = Array.from(groupsMap.values()).sort((a, b) => {
    if (b.cards.length !== a.cards.length) return b.cards.length - a.cards.length;
    return b.value - a.value;
  });

  const orderedCards = groups.flatMap((g) => g.cards);
  const fiveValues = orderedCards.map((c) => c.value);
  const counts = groups.map((g) => g.cards.length);
  const groupRanks = groups.map((g) => g.value);

  if (counts[0] === 4) {
    return {
      category: HAND_CATEGORIES.FOUR_OF_A_KIND,
      name: CATEGORY_NAMES[HAND_CATEGORIES.FOUR_OF_A_KIND],
      ranks: groupRanks, // [quadRank, kicker]
      fiveValues,
      cards: orderedCards.map((c) => c.code),
      score: encodeScore(HAND_CATEGORIES.FOUR_OF_A_KIND, fiveValues)
    };
  }

  if (counts[0] === 3 && counts[1] === 2) {
    return {
      category: HAND_CATEGORIES.FULL_HOUSE,
      name: CATEGORY_NAMES[HAND_CATEGORIES.FULL_HOUSE],
      ranks: groupRanks, // [tripsRank, pairRank]
      fiveValues,
      cards: orderedCards.map((c) => c.code),
      score: encodeScore(HAND_CATEGORIES.FULL_HOUSE, fiveValues)
    };
  }

  if (isFlush) {
    return {
      category: HAND_CATEGORIES.FLUSH,
      name: CATEGORY_NAMES[HAND_CATEGORIES.FLUSH],
      ranks: [v0, v1, v2, v3, v4],
      fiveValues: [v0, v1, v2, v3, v4],
      cards: sorted.map((c) => c.code),
      score: encodeScore(HAND_CATEGORIES.FLUSH, [v0, v1, v2, v3, v4])
    };
  }

  if (isRegularStraight || isWheelStraight) {
    const straightCards = isWheelStraight
      ? [sorted[1], sorted[2], sorted[3], sorted[4], sorted[0]]
      : sorted;
    const straightValues = isWheelStraight ? [5, 4, 3, 2, 1] : [v0, v1, v2, v3, v4];
    return {
      category: HAND_CATEGORIES.STRAIGHT,
      name: CATEGORY_NAMES[HAND_CATEGORIES.STRAIGHT],
      ranks: [straightValues[0]],
      fiveValues: straightValues,
      cards: straightCards.map((c) => c.code),
      score: encodeScore(HAND_CATEGORIES.STRAIGHT, straightValues)
    };
  }

  if (counts[0] === 3) {
    return {
      category: HAND_CATEGORIES.THREE_OF_A_KIND,
      name: CATEGORY_NAMES[HAND_CATEGORIES.THREE_OF_A_KIND],
      ranks: groupRanks, // [tripsRank, k1, k2]
      fiveValues,
      cards: orderedCards.map((c) => c.code),
      score: encodeScore(HAND_CATEGORIES.THREE_OF_A_KIND, fiveValues)
    };
  }

  if (counts[0] === 2 && counts[1] === 2) {
    return {
      category: HAND_CATEGORIES.TWO_PAIR,
      name: CATEGORY_NAMES[HAND_CATEGORIES.TWO_PAIR],
      ranks: groupRanks, // [highPair, lowPair, kicker]
      fiveValues,
      cards: orderedCards.map((c) => c.code),
      score: encodeScore(HAND_CATEGORIES.TWO_PAIR, fiveValues)
    };
  }

  if (counts[0] === 2) {
    return {
      category: HAND_CATEGORIES.ONE_PAIR,
      name: CATEGORY_NAMES[HAND_CATEGORIES.ONE_PAIR],
      ranks: groupRanks, // [pairRank, k1, k2, k3]
      fiveValues,
      cards: orderedCards.map((c) => c.code),
      score: encodeScore(HAND_CATEGORIES.ONE_PAIR, fiveValues)
    };
  }

  return {
    category: HAND_CATEGORIES.HIGH_CARD,
    name: CATEGORY_NAMES[HAND_CATEGORIES.HIGH_CARD],
    ranks: [v0, v1, v2, v3, v4],
    fiveValues: [v0, v1, v2, v3, v4],
    cards: sorted.map((c) => c.code),
    score: encodeScore(HAND_CATEGORIES.HIGH_CARD, [v0, v1, v2, v3, v4])
  };
}

/**
 * Evaluates 5, 6, or 7 cards (e.g. `['As', 'Ks', 'Qs', 'Js', 'Ts', '2d', '3c']`)
 * and returns the best 5-card hand evaluation.
 */
export function evaluate(cards) {
  if (!Array.isArray(cards) || cards.length < 5 || cards.length > 7) {
    throw new Error(`evaluate(cards) requires an array of 5 to 7 cards (received ${cards?.length ?? 0}).`);
  }

  const parsed = cards.map(parseCard);
  const seen = new Set();
  for (const c of parsed) {
    if (seen.has(c.code)) {
      throw new Error(`Duplicate card "${c.code}" in hand evaluation.`);
    }
    seen.add(c.code);
  }

  const n = parsed.length;
  if (n === 5) {
    return evaluate5(parsed);
  }

  let best = null;
  for (let i = 0; i < n - 4; i += 1) {
    for (let j = i + 1; j < n - 3; j += 1) {
      for (let k = j + 1; k < n - 2; k += 1) {
        for (let l = k + 1; l < n - 1; l += 1) {
          for (let m = l + 1; m < n; m += 1) {
            const candidate = evaluate5([parsed[i], parsed[j], parsed[k], parsed[l], parsed[m]]);
            if (!best || candidate.score > best.score) {
              best = candidate;
            }
          }
        }
      }
    }
  }
  return best;
}

/**
 * Compares two hands (either already evaluated objects or 5–7 card arrays).
 * Returns 1 if handA > handB, -1 if handA < handB, 0 if tied.
 */
export function compareHands(handA, handB) {
  const evalA = Array.isArray(handA) ? evaluate(handA) : handA;
  const evalB = Array.isArray(handB) ? evaluate(handB) : handB;
  if (evalA.score > evalB.score) return 1;
  if (evalA.score < evalB.score) return -1;
  return 0;
}
