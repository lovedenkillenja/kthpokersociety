// Practice-mode bots: three simple, explainable styles (pure, no DOM, no network).
// A bot only ever sees `buildBotView(state, seat)`: the public hand view plus its own two hole cards.
// Preflop it reads a hand-strength chart (Chen score) by position; postflop it compares simulated equity
// with pot odds, with a little bluffing and slow-playing. Every decision is mapped onto `legalActions`.

import { legalActions, publicView } from "../engine/index.js";
import { chenScore, simulateEquity } from "./equity.js";

export const BOT_STYLES = Object.freeze({
  tight: Object.freeze({
    id: "tight",
    label: "Tight",
    open: { early: 10, middle: 9, late: 8, blinds: 9 },
    call: 9,
    threeBet: 12,
    limp: 0,
    valueEq: 0.66,
    raiseEq: 0.82,
    callMargin: 0.05,
    bluffBet: 0.05,
    bluffRaise: 0.02,
    slowPlay: 0.25,
    betFrac: [0.5, 0.66]
  }),
  balanced: Object.freeze({
    id: "balanced",
    label: "Balanced",
    open: { early: 9, middle: 8, late: 7, blinds: 8 },
    call: 8,
    threeBet: 11,
    limp: 0,
    valueEq: 0.6,
    raiseEq: 0.76,
    callMargin: 0.02,
    bluffBet: 0.12,
    bluffRaise: 0.05,
    slowPlay: 0.15,
    betFrac: [0.5, 0.75]
  }),
  loose: Object.freeze({
    id: "loose",
    label: "Loose",
    open: { early: 7, middle: 6, late: 5, blinds: 6 },
    call: 6,
    threeBet: 10,
    limp: 3,
    valueEq: 0.55,
    raiseEq: 0.72,
    callMargin: -0.03,
    bluffBet: 0.25,
    bluffRaise: 0.1,
    slowPlay: 0.1,
    betFrac: [0.6, 1]
  })
});

export const BOT_STYLE_IDS = Object.freeze(Object.keys(BOT_STYLES));

/**
 * Everything a seat may know when it acts: the public view (no deck, no other hole cards)
 * plus its own hole cards and its legal actions.
 */
export function buildBotView(state, seat) {
  const pub = publicView(state);
  const me = state.seats.find((p) => p.seat === seat);
  return {
    seat,
    holeCards: me ? [...me.holeCards] : [],
    street: pub.street,
    board: [...pub.board],
    pot: pub.pot,
    currentBet: pub.currentBet,
    blinds: { ...pub.blinds },
    dealerSeat: pub.dealerSeat,
    sbSeat: pub.sbSeat,
    bbSeat: pub.bbSeat,
    seats: pub.seats.map((s) => ({
      seat: s.seat,
      stack: s.stack,
      bet: s.bet,
      totalCommitted: s.totalCommitted,
      folded: s.folded,
      allIn: s.allIn
    })),
    actions: state.actions.map((a) => ({ street: a.street, seat: a.seat, type: a.type, amount: a.amount })),
    legal: legalActions(state, seat)
  };
}

/** Position bucket of `seat` among the players dealt in: "early" | "middle" | "late" | "blinds". */
export function positionOf(view) {
  const order = view.seats.map((s) => s.seat).sort((a, b) => a - b);
  const n = order.length;
  if (view.seat === view.sbSeat || view.seat === view.bbSeat) {
    // Heads-up the dealer is also the small blind and acts last postflop.
    return n === 2 && view.seat === view.dealerSeat ? "late" : "blinds";
  }
  // Seats clockwise from the dealer's left: SB, BB, UTG, ..., dealer.
  const dIdx = order.indexOf(view.dealerSeat);
  const clockwise = [];
  for (let i = 1; i <= n; i += 1) clockwise.push(order[(dIdx + i) % n]);
  const idx = clockwise.indexOf(view.seat);
  const fromButton = n - 1 - idx; // 0 = dealer, 1 = cutoff
  if (fromButton <= 1) return "late";
  const nonBlindSeats = n - 2;
  return idx - 2 < nonBlindSeats / 2 ? "early" : "middle";
}

function roundTo(amount, unit) {
  const u = Math.max(1, unit);
  return Math.round(amount / u) * u;
}

/** Maps a wanted action onto the legal ones. Never folds when a check is free. */
export function sanitizeAction(wanted, legal) {
  const type = wanted?.type;
  if (type === "raise") {
    if (legal.canRaise) {
      const amt = Math.min(legal.maxRaiseTo, Math.max(legal.minRaiseTo, Math.trunc(Number(wanted.amount) || legal.minRaiseTo)));
      return { type: "raise", amount: amt };
    }
    if (legal.canCall) return { type: "call" };
    if (legal.canCheck) return { type: "check" };
    return { type: "fold" };
  }
  if (type === "call") {
    if (legal.canCall) return { type: "call" };
    if (legal.canCheck) return { type: "check" };
    return { type: "fold" };
  }
  if (legal.canCheck) return { type: "check" };
  return { type: "fold" };
}

function sizeBet(view, fraction) {
  const { legal, blinds, currentBet, pot } = view;
  const me = view.seats.find((s) => s.seat === view.seat);
  const toCall = legal.callAmount || 0;
  const target = currentBet + fraction * (pot + toCall);
  let amount = roundTo(Math.max(target, legal.minRaiseTo || 0), blinds.sb);
  if (legal.maxRaiseTo && amount >= 0.85 * legal.maxRaiseTo) amount = legal.maxRaiseTo;
  if (me && legal.maxRaiseTo && amount > legal.maxRaiseTo) amount = legal.maxRaiseTo;
  return amount;
}

function preflopDecision(view, style, rng) {
  const { legal, blinds, currentBet } = view;
  const chen = chenScore(view.holeCards[0], view.holeCards[1]);
  const pos = positionOf(view);
  const me = view.seats.find((s) => s.seat === view.seat);
  const preflopRaises = view.actions.filter((a) => a.street === "preflop" && a.type === "raise").length;
  const limpers = view.actions.filter((a) => a.street === "preflop" && a.type === "call").length;
  const facingRaise = currentBet > blinds.bb;
  const toCall = legal.callAmount || 0;
  const stack = me ? me.stack : 0;

  if (!facingRaise) {
    if (chen >= style.open[pos]) {
      return { type: "raise", amount: roundTo(blinds.bb * (3 + limpers), blinds.sb), reason: `Opened: hand score ${chen} meets the ${pos} chart (${style.open[pos]}+)` };
    }
    if (legal.canCheck) return { type: "check", reason: `Checked the big blind: hand score ${chen}` };
    if (style.limp && chen >= style.open[pos] - style.limp) return { type: "call", reason: `Limped: loose style, hand score ${chen}` };
    if (view.seat === view.sbSeat && toCall <= blinds.sb && chen >= style.open.blinds - 2) {
      return { type: "call", reason: `Completed the small blind: cheap price, hand score ${chen}` };
    }
    return { type: "fold", reason: `Folded: hand score ${chen} is below the ${pos} chart (${style.open[pos]}+)` };
  }

  if (chen >= style.threeBet) {
    const mult = preflopRaises >= 2 ? 2.5 : 3;
    const amount = chen >= 16 && preflopRaises >= 2 ? legal.maxRaiseTo : roundTo(currentBet * mult, blinds.sb);
    return { type: "raise", amount, reason: `Re-raised: hand score ${chen} (${style.threeBet}+)` };
  }
  const cheap = toCall <= Math.max(blinds.bb * 2, 0.15 * (view.pot + toCall));
  if ((chen >= style.call && (toCall <= 0.25 * (stack + toCall) || chen >= 10)) || (cheap && chen >= style.call - 2)) {
    return { type: "call", reason: `Called the raise: hand score ${chen}` };
  }
  if (style.bluffRaise > 0 && preflopRaises === 1 && pos === "late" && rng() < style.bluffRaise / 2) {
    return { type: "raise", amount: roundTo(currentBet * 3, blinds.sb), reason: "Re-raised as a bluff" };
  }
  return { type: "fold", reason: `Folded to a raise: hand score ${chen}` };
}

function postflopDecision(view, style, rng, samples) {
  const { legal, street } = view;
  const opponents = view.seats.filter((s) => s.seat !== view.seat && !s.folded).length;
  const facingAggression = view.actions.some((a) => a.street === street && a.seat !== view.seat && a.type === "raise");
  // A player who bets usually holds more than a random hand: tighten their range a little.
  const opponentFilter = facingAggression ? (c1, c2) => chenScore(c1, c2) >= 6 : null;
  const { equity } = simulateEquity({
    hole: view.holeCards,
    board: view.board,
    opponents: Math.max(1, opponents),
    samples,
    rng,
    opponentFilter
  });
  const scale = Math.sqrt(2 / (Math.max(1, opponents) + 1));
  const valueEq = style.valueEq * scale;
  const raiseEq = style.raiseEq * scale;
  const pct = Math.round(equity * 100);
  const frac = style.betFrac[0] + rng() * (style.betFrac[1] - style.betFrac[0]);

  if (legal.canCheck) {
    if (equity >= valueEq) {
      if (equity >= 0.8 * scale + 0.1 && rng() < style.slowPlay) return { type: "check", reason: `Slow-played: equity ${pct}%` };
      return { type: "raise", amount: sizeBet(view, frac), reason: `Bet for value: equity ${pct}%` };
    }
    if (opponents <= 2 && rng() < style.bluffBet) {
      return { type: "raise", amount: sizeBet(view, 0.5), reason: `Bluffed: equity ${pct}%` };
    }
    return { type: "check", reason: `Checked: equity ${pct}%` };
  }

  const toCall = legal.callAmount || 0;
  const required = toCall / (view.pot + toCall);
  if (equity >= raiseEq && legal.canRaise) {
    return { type: "raise", amount: sizeBet(view, frac), reason: `Raised for value: equity ${pct}%` };
  }
  if (equity >= required + style.callMargin) {
    return { type: "call", reason: `Called: equity ${pct}% vs ${Math.round(required * 100)}% needed` };
  }
  if (opponents === 1 && legal.canRaise && rng() < style.bluffRaise) {
    return { type: "raise", amount: sizeBet(view, 0.75), reason: `Raised as a bluff: equity ${pct}%` };
  }
  return { type: "fold", reason: `Folded: equity ${pct}% vs ${Math.round(required * 100)}% needed` };
}

/**
 * Chooses a legal action for a bot from what it may know. Returns `{ type, amount?, reason }`.
 * Deterministic for a given `rng`.
 */
export function decideBotAction(view, styleId = "balanced", rng = Math.random, { samples = 200 } = {}) {
  const style = BOT_STYLES[styleId] || BOT_STYLES.balanced;
  const legal = view.legal;
  if (!legal || legal.actions.length === 0) return null;
  const wanted =
    view.street === "preflop" ? preflopDecision(view, style, rng) : postflopDecision(view, style, rng, samples);
  const action = sanitizeAction(wanted, legal);
  return { ...action, reason: wanted.reason };
}
