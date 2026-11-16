// Practice-mode coach: turns the numbers of a spot into short, friendly teaching text (pure, no DOM).
// It never guarantees an outcome; it talks about what pays "in the long run".

import { formatChips } from "./format.js";
import { countOuts, potOdds, callExpectedValue, ruleOf2And4, drawOddsExact, unseenCards } from "./equity.js";

const STREET_NAMES = Object.freeze({ preflop: "preflop", flop: "on the flop", turn: "on the turn", river: "on the river" });

export function pct(x, digits = 0) {
  const v = Math.max(0, Math.min(1, Number(x) || 0)) * 100;
  return `${v.toFixed(digits)}%`;
}

/** Equity a hand needs to bet for value against `opponents` random hands (fair share plus a margin). */
export function valueThreshold(opponents) {
  const n = Math.max(1, Number(opponents) || 1);
  return Math.min(0.6, 1 / (n + 1) + 0.25);
}

function opponentsLabel(n) {
  return `${n} opponent${n === 1 ? "" : "s"}`;
}

/**
 * Outs and draw odds for the spot, or null when there is no common draw (or no card to come).
 */
export function describeOuts(hole, board) {
  if (!Array.isArray(board) || board.length < 3 || board.length > 4) return null;
  const info = countOuts(hole, board);
  if (info.outs === 0) return null;
  const unseen = unseenCards([...hole, ...board]).length;
  const toCome = 5 - board.length;
  const exactNext = drawOddsExact(info.outs, unseen, 1);
  const exactRiver = drawOddsExact(info.outs, unseen, toCome);
  const rule = ruleOf2And4(info.outs, toCome);
  const names = info.draws.map((d) => d.label).join(" + ");
  const text =
    toCome === 2
      ? `${info.outs} outs (${names}): ~${pct(exactRiver)} to hit by the river, ~${pct(exactNext)} on the next card`
      : `${info.outs} outs (${names}): ~${pct(exactRiver)} to hit on the river`;
  const o = info.outs;
  const exactFormula =
    toCome === 2
      ? `1 − (${unseen - o}/${unseen} × ${unseen - o - 1}/${unseen - 1}) = ${pct(exactRiver, 1)}`
      : `${o}/${unseen} = ${pct(exactRiver, 1)}`;
  const why = `Outs: ${o} cards complete your ${names}. Rule of 2 and 4: ${o} × ${toCome === 2 ? 4 : 2} ≈ ${pct(rule)}. Exact: ${exactFormula}.`;
  return { ...info, unseen, toCome, exactNext, exactRiver, rule, text, why };
}

/**
 * Builds the coach text for the player's turn.
 * `equity` is a fraction (or null while the simulation runs); `pot` is everything already in the middle.
 * Returns `{ equityText, potOddsText, verdict: { kind, text }, outs, why: string[], summary }`.
 */
export function buildCoachAdvice({
  hole,
  board = [],
  pot = 0,
  toCall = 0,
  opponents = 1,
  equity = null,
  samples = 0,
  canRaise = true
} = {}) {
  const n = Math.max(1, Number(opponents) || 1);
  const facing = Number(toCall) > 0;
  const odds = facing ? potOdds(toCall, pot) : null;
  const outs = describeOuts(hole, board);
  const why = [];
  const known = equity !== null && equity !== undefined && Number.isFinite(Number(equity));

  const equityText = known ? `Equity ~${pct(equity)} vs ${opponentsLabel(n)}` : `Working out your equity vs ${opponentsLabel(n)}…`;
  const potOddsText = odds
    ? `Call ${formatChips(odds.call)} to win ${formatChips(odds.pot)}: you need ${pct(odds.requiredEquity)}`
    : null;

  let verdict = { kind: "pending", text: "Running the numbers…" };
  if (known) {
    const fair = 1 / (n + 1);
    const vt = valueThreshold(n);
    why.push(
      `Equity: we dealt out the rest of this hand ${formatChips(samples)} times, giving your ${opponentsLabel(n)} random cards. ` +
        `You won or split ${pct(equity)} of the pot on average. Your fair share with ${n + 1} players is ${pct(fair)}.`
    );
    if (odds) {
      const ev = callExpectedValue(equity, odds.call, odds.pot);
      why.push(
        `Pot odds: you put in ${formatChips(odds.call)} to win the ${formatChips(odds.pot)} already in the pot. ` +
          `${formatChips(odds.call)} ÷ (${formatChips(odds.pot)} + ${formatChips(odds.call)}) = ${pct(odds.requiredEquity)} is the break-even equity.`
      );
      why.push(
        `Value of calling ≈ ${pct(equity)} × ${formatChips(odds.winTotal)} − ${formatChips(odds.call)} = ` +
          `${ev >= 0 ? "+" : "−"}${formatChips(Math.round(Math.abs(ev)))} chips per call in the long run (ignores later betting).`
      );
      const req = odds.requiredEquity;
      if (canRaise && equity >= Math.max(req + 0.15, vt)) verdict = { kind: "value", text: "Strong enough to raise for value" };
      else if (equity >= req + 0.03) verdict = { kind: "call", text: "Calling is profitable in the long run" };
      else if (equity <= req - 0.03) verdict = { kind: "fold", text: "Folding loses the least" };
      else verdict = { kind: "close", text: "A close spot: calling and folding are about even in the long run" };
    } else if (equity >= vt) {
      verdict = { kind: "value", text: "Strong enough to bet for value" };
      why.push(`Nobody has bet. With ${pct(equity)} against a fair share of ${pct(fair)}, a bet gets chips in while you are ahead.`);
    } else if (outs && outs.outs >= 8) {
      verdict = { kind: "check", text: "Checking is free; with a strong draw a bet is also fine" };
      why.push("Nobody has bet, so checking costs nothing. A bet with a big draw can win the pot now or improve later.");
    } else {
      verdict = { kind: "check", text: "Checking is free and keeps the pot small" };
      why.push(`Nobody has bet, so checking costs nothing. Below ${pct(vt)} equity a bet is mostly called by better hands.`);
    }
    if (outs) why.push(outs.why);
    why.push("Real players fold weak hands, so against a bet your true equity is usually a bit lower than against random cards.");
  }

  const summaryParts = [known ? `~${pct(equity)} equity` : "Thinking…"];
  if (odds) summaryParts.push(`need ${pct(odds.requiredEquity)}`);
  if (known) summaryParts.push(verdict.text);
  return {
    equityText,
    potOddsText,
    verdict,
    outs,
    outsText: outs ? outs.text : null,
    why,
    summary: summaryParts.join(" · ")
  };
}

/** Picks the decision that mattered most: the biggest call faced, otherwise the last decision. */
export function pickKeyDecision(decisions = []) {
  const withNumbers = decisions.filter((d) => d && Number.isFinite(Number(d.equity)));
  if (withNumbers.length === 0) return null;
  const facing = withNumbers.filter((d) => Number(d.toCall) > 0);
  if (facing.length > 0) return facing.reduce((a, b) => (Number(b.toCall) >= Number(a.toCall) ? b : a));
  return withNumbers[withNumbers.length - 1];
}

function verbFor(action, toCall) {
  if (action === "fold" || action === "timeout-fold") return "folded";
  if (action === "check") return "checked";
  if (action === "call") return `called ${formatChips(toCall)}`;
  if (action === "raise") return toCall > 0 ? "raised" : "bet";
  return action || "acted";
}

/**
 * One short review line for the key decision, plus a line on the hand ranks at showdown.
 * `decision`: `{ street, action, equity, toCall, pot, opponents }`; `table`: the public state of the finished hand.
 */
export function buildHandReview({ decisions = [], table, selfSeatNo = 0 } = {}) {
  const key = pickKeyDecision(decisions);
  let decisionLine = "No decision with numbers this hand.";
  let ev = null;
  if (key) {
    const where = STREET_NAMES[key.street] || "";
    const eq = Number(key.equity);
    const toCall = Number(key.toCall) || 0;
    if (toCall > 0) {
      const req = potOdds(toCall, key.pot).requiredEquity;
      const folded = key.action === "fold" || key.action === "timeout-fold";
      const plusEv = eq >= req;
      ev = folded ? !plusEv : plusEv;
      if (folded) {
        decisionLine = plusEv
          ? `Key decision: you folded ${where} with ~${pct(eq)} equity when you needed only ${pct(req)}: calling was +EV by the numbers.`
          : `Key decision: you folded ${where} with ~${pct(eq)} equity when you needed ${pct(req)}: a sound fold by the numbers.`;
      } else if (key.action === "raise") {
        const strong = eq >= Math.max(req + 0.15, valueThreshold(key.opponents));
        decisionLine = strong
          ? `Key decision: you raised ${where} with ~${pct(eq)} equity (a call needed ${pct(req)}): a raise for value fit the numbers.`
          : plusEv
            ? `Key decision: you raised ${where} with ~${pct(eq)} equity; a call needed ${pct(req)}, so calling was +EV and the raise also needs folds to pay.`
            : `Key decision: you raised ${where} with ~${pct(eq)} equity when a call needed ${pct(req)}: the raise only pays if others fold often enough.`;
      } else {
        decisionLine = plusEv
          ? `Key decision: you ${verbFor(key.action, toCall)} ${where} needing ${pct(req)} with ~${pct(eq)} equity: +EV by the numbers.`
          : `Key decision: you ${verbFor(key.action, toCall)} ${where} needing ${pct(req)} with ~${pct(eq)} equity: −EV by the numbers; folding loses less in the long run.`;
      }
    } else {
      const vt = valueThreshold(key.opponents);
      const strong = eq >= vt;
      const bet = key.action === "raise";
      ev = strong ? bet : true;
      decisionLine = strong
        ? `Key decision: no bet to face ${where}; with ~${pct(eq)} equity ${bet ? "your bet for value fit the numbers" : "a value bet would have fit the numbers"}.`
        : `Key decision: no bet to face ${where}; with ~${pct(eq)} equity ${bet ? "your bet was a bluff or semi-bluff" : "checking cost nothing"}.`;
    }
  }

  const hand = table?.hand || null;
  const seats = Array.isArray(table?.seats) ? table.seats : [];
  const nameOf = (no) => {
    const s = seats.find((x) => x.seatNo === no);
    return no === selfSeatNo ? "you" : s?.displayName || `Seat ${no + 1}`;
  };
  let resultLine = "";
  if (hand?.status === "complete") {
    const winners = Array.isArray(hand.winners) ? hand.winners : [];
    const hands = hand.showdown?.hands || null;
    if (hands && Object.keys(hands).length > 0) {
      const mine = hands[selfSeatNo]?.name;
      const others = winners.filter((w) => w !== selfSeatNo);
      const othersText = others.map((w) => `${nameOf(w)}${hands[w]?.name ? ` (${hands[w].name})` : ""}`).join(" and ");
      if (winners.includes(selfSeatNo)) {
        resultLine = `You won with ${mine || "the best hand"}${others.length ? `, splitting with ${othersText}` : ""}.`;
      } else {
        resultLine = `${mine ? `You had ${mine}. ` : ""}Won by ${othersText}.`;
      }
    } else if (winners.length > 0) {
      resultLine = `${winners.includes(selfSeatNo) ? "You" : nameOf(winners[0])} won without a showdown.`;
    }
  }
  return { decisionLine, resultLine, ev, text: [decisionLine, resultLine].filter(Boolean).join(" ") };
}
