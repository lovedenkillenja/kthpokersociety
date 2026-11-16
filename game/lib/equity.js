// Poker probability helpers for practice mode (pure, no DOM, no network).
// - Monte Carlo equity of known hole cards + board against N unknown opponents (uses the engine's evaluator).
// - Exact helpers: outs for common draws, pot odds, required equity, "rule of 2 and 4", exact draw odds.
// Every random function takes an `rng` returning floats in [0, 1) so results are reproducible in tests.

import { createDeck, evaluate, RANK_VALUES } from "../engine/index.js";

export const DEFAULT_EQUITY_SAMPLES = 3000;

function uniqueCards(cards) {
  return [...new Set((cards || []).map((c) => String(c)))];
}

/** Cards not in `known` (hole cards, board, or anything else already seen). */
export function unseenCards(known = []) {
  const seen = new Set(known);
  return createDeck().filter((c) => !seen.has(c));
}

/**
 * Chen formula: a classic, easy-to-explain preflop hand score (about -1 to 20).
 * AA = 20, KK = 16, AKs = 12, 72o = -1.
 */
export function chenScore(c1, c2) {
  const v1 = RANK_VALUES[c1[0]];
  const v2 = RANK_VALUES[c2[0]];
  const hi = Math.max(v1, v2);
  const lo = Math.min(v1, v2);
  const pts = (v) => (v === 14 ? 10 : v === 13 ? 8 : v === 12 ? 7 : v === 11 ? 6 : v / 2);
  if (hi === lo) return Math.max(5, pts(hi) * 2);
  let score = pts(hi);
  if (c1[1] === c2[1]) score += 2;
  const gap = hi - lo - 1;
  score -= gap === 0 ? 0 : gap === 1 ? 1 : gap === 2 ? 2 : gap === 3 ? 4 : 5;
  if (gap <= 1 && hi < 12) score += 1;
  return Math.ceil(score);
}

/**
 * Monte Carlo equity: deals the missing board cards and `opponents` random hands `samples` times.
 * Equity = (wins + split shares) / samples, i.e. the share of the pot you would take in the long run
 * if nobody folded. `opponentFilter(c1, c2)` can tighten the opponents' range (rejection sampling).
 * Returns `{ equity, win, tie, samples, opponents }`.
 */
export function simulateEquity({
  hole,
  board = [],
  opponents = 1,
  samples = DEFAULT_EQUITY_SAMPLES,
  rng = Math.random,
  opponentFilter = null
} = {}) {
  const acc = createEquityAccumulator({ hole, board, opponents, rng, opponentFilter });
  acc.run(samples);
  return acc.result();
}

/**
 * Incremental version of `simulateEquity` so a UI can run a few hundred samples per frame.
 * `run(n)` adds n samples; `result()` reads the running estimate.
 */
export function createEquityAccumulator({ hole, board = [], opponents = 1, rng = Math.random, opponentFilter = null } = {}) {
  const myHole = uniqueCards(hole);
  const knownBoard = uniqueCards(board);
  if (myHole.length !== 2) throw new Error("Equity needs exactly two hole cards.");
  if (knownBoard.length > 5) throw new Error("A board has at most five cards.");
  const opps = Math.max(1, Math.min(9, Math.trunc(Number(opponents) || 1)));
  const deck = unseenCards([...myHole, ...knownBoard]);
  const missing = 5 - knownBoard.length;
  let total = 0;
  let wins = 0;
  let ties = 0;
  let share = 0;

  function sampleOnce() {
    // Partial Fisher-Yates over a working copy: draws without replacement.
    const pool = deck.slice();
    let end = pool.length;
    const draw = () => {
      const idx = Math.floor(rng() * end);
      const card = pool[idx];
      pool[idx] = pool[end - 1];
      pool[end - 1] = card;
      end -= 1;
      return card;
    };
    const oppHands = [];
    for (let o = 0; o < opps; o += 1) {
      let c1 = draw();
      let c2 = draw();
      if (opponentFilter) {
        let tries = 0;
        while (!opponentFilter(c1, c2) && tries < 12) {
          // Put the rejected pair back and redraw.
          end += 2;
          c1 = draw();
          c2 = draw();
          tries += 1;
        }
      }
      oppHands.push([c1, c2]);
    }
    const fullBoard = knownBoard.slice();
    for (let i = 0; i < missing; i += 1) fullBoard.push(draw());

    const myScore = evaluate([...myHole, ...fullBoard]).score;
    let best = true;
    let tiedWith = 0;
    for (const h of oppHands) {
      const s = evaluate([...h, ...fullBoard]).score;
      if (s > myScore) { best = false; break; }
      if (s === myScore) tiedWith += 1;
    }
    total += 1;
    if (!best) return;
    if (tiedWith === 0) { wins += 1; share += 1; }
    else { ties += 1; share += 1 / (tiedWith + 1); }
  }

  return {
    run(n) {
      const count = Math.max(0, Math.trunc(Number(n) || 0));
      for (let i = 0; i < count; i += 1) sampleOnce();
      return total;
    },
    result() {
      return {
        equity: total ? share / total : 0,
        win: total ? wins / total : 0,
        tie: total ? ties / total : 0,
        samples: total,
        opponents: opps
      };
    }
  };
}

/**
 * Runs `simulateEquity` in slices so the page never blocks. `schedule(fn)` defaults to setTimeout(fn, 0).
 * Calls `onProgress(result)` after each slice and `onDone(result)` at the end. Returns `{ cancel() }`.
 */
export function runEquityInSlices(options, {
  samples = DEFAULT_EQUITY_SAMPLES,
  sliceSize = 300,
  onProgress = null,
  onDone = null,
  schedule = (fn) => setTimeout(fn, 0)
} = {}) {
  const acc = createEquityAccumulator(options);
  let cancelled = false;
  function step() {
    if (cancelled) return;
    const left = samples - acc.result().samples;
    acc.run(Math.min(sliceSize, left));
    const res = acc.result();
    if (res.samples >= samples) {
      if (onDone) onDone(res);
      return;
    }
    if (onProgress) onProgress(res);
    schedule(step);
  }
  schedule(step);
  return { cancel() { cancelled = true; } };
}

/** Number of combinations C(n, k). */
export function combinations(n, k) {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i += 1) r = (r * (n - k + i)) / i;
  return r;
}

/**
 * Exact probability that at least one of `outs` cards arrives in the next `cardsToCome` cards,
 * drawn from `unseen` cards (47 on the flop, 46 on the turn from one player's point of view).
 */
export function drawOddsExact(outs, unseen, cardsToCome) {
  const o = Math.max(0, Math.trunc(outs));
  const n = Math.max(0, Math.trunc(unseen));
  const k = Math.max(0, Math.trunc(cardsToCome));
  if (o === 0 || k === 0 || n === 0) return 0;
  return 1 - combinations(n - o, k) / combinations(n, k);
}

/**
 * "Rule of 2 and 4": outs x 4 with two cards to come (flop, all-in), outs x 2 with one card to come.
 * Returns a fraction (0..1), capped at 1.
 */
export function ruleOf2And4(outs, cardsToCome) {
  const k = Math.trunc(cardsToCome);
  if (k <= 0) return 0;
  const pct = outs * (k >= 2 ? 4 : 2);
  return Math.min(100, pct) / 100;
}

/**
 * Pot odds when facing a bet. `pot` is everything already in the middle (including the bet you face).
 * Returns `{ call, pot, winTotal, requiredEquity }`: you need `requiredEquity` to break even.
 */
export function potOdds(call, pot) {
  const c = Math.max(0, Number(call) || 0);
  const p = Math.max(0, Number(pot) || 0);
  return { call: c, pot: p, winTotal: p + c, requiredEquity: c > 0 ? c / (p + c) : 0 };
}

/**
 * Long-run chip value of calling now and seeing the hand through with no further betting:
 * equity x (pot + call) - call.
 */
export function callExpectedValue(equity, call, pot) {
  return equity * (Number(pot) + Number(call)) - Number(call);
}

const STRAIGHT_WINDOWS = (() => {
  // Rank-value windows of five consecutive ranks; the wheel uses the ace as 1.
  const wins = [];
  for (let hi = 5; hi <= 14; hi += 1) wins.push([hi, hi - 1, hi - 2, hi - 3, hi - 4].map((v) => (v === 1 ? 14 : v)));
  return wins;
})();

function makesStraight(valueSet, holeValues) {
  return STRAIGHT_WINDOWS.some((w) => w.every((v) => valueSet.has(v)) && w.some((v) => holeValues.has(v)));
}

/**
 * Outs for common draws, counted exactly from the unseen cards:
 * - flush draw (four to a flush using a hole card): 9 outs
 * - open-ended straight draw: 8 outs, gutshot: 4 outs (straight must use a hole card)
 * - pocket pair hoping for a set: 2 outs (only reported when there is no other draw)
 * Overlapping cards (a card that completes both) are counted once.
 * Returns `{ outs, cards, draws: [{ kind, label, outs }] }`. Only meaningful on the flop and turn.
 */
export function countOuts(hole, board = []) {
  const myHole = uniqueCards(hole);
  const b = uniqueCards(board);
  const empty = { outs: 0, cards: [], draws: [] };
  if (myHole.length !== 2 || b.length < 3 || b.length > 4) return empty;
  const all = [...myHole, ...b];
  const unseen = unseenCards(all);
  const current = evaluate(all);
  const draws = [];
  const outSet = new Set();

  // Flush draw
  if (current.category < 5) {
    for (const suit of ["s", "h", "d", "c"]) {
      const n = all.filter((c) => c[1] === suit).length;
      const holeHas = myHole.some((c) => c[1] === suit);
      if (n === 4 && holeHas) {
        const cards = unseen.filter((c) => c[1] === suit);
        cards.forEach((c) => outSet.add(c));
        draws.push({ kind: "flush", label: "flush draw", outs: cards.length });
      }
    }
  }

  // Straight draws
  if (current.category < 4) {
    const values = new Set(all.map((c) => RANK_VALUES[c[0]]));
    const holeValues = new Set(myHole.map((c) => RANK_VALUES[c[0]]));
    const outValues = [];
    for (let v = 2; v <= 14; v += 1) {
      if (values.has(v)) continue;
      const withV = new Set(values);
      withV.add(v);
      const holeWithV = new Set(holeValues);
      if (makesStraight(withV, holeWithV)) outValues.push(v);
    }
    if (outValues.length > 0) {
      const cards = unseen.filter((c) => outValues.includes(RANK_VALUES[c[0]]));
      cards.forEach((c) => outSet.add(c));
      const kind = outValues.length >= 2 ? "open-ended" : "gutshot";
      draws.push({
        kind,
        label: kind === "open-ended" ? "open-ended straight draw" : "gutshot straight draw",
        outs: cards.length
      });
    }
  }

  // Pocket pair to a set
  if (draws.length === 0 && myHole[0][0] === myHole[1][0] && current.category === 1) {
    const cards = unseen.filter((c) => c[0] === myHole[0][0]);
    cards.forEach((c) => outSet.add(c));
    draws.push({ kind: "set", label: "pocket pair to a set", outs: cards.length });
  }

  const cards = [...outSet].sort();
  return { outs: cards.length, cards, draws };
}
