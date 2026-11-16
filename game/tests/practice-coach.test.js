import test from "node:test";
import assert from "node:assert/strict";
import { buildCoachAdvice, buildHandReview, pickKeyDecision, describeOuts, valueThreshold } from "../lib/practice-coach.js";

test("facing a bet: pot odds line, a +EV call verdict and the arithmetic", () => {
  const a = buildCoachAdvice({ hole: ["Ah", "7h"], board: ["Kh", "9h", "2c"], pot: 180, toCall: 60, opponents: 2, equity: 0.41, samples: 3000 });
  assert.equal(a.equityText, "Equity ~41% vs 2 opponents");
  assert.equal(a.potOddsText, "Call 60 to win 180: you need 25%");
  assert.equal(a.verdict.kind, "call");
  assert.equal(a.verdict.text, "Calling is profitable in the long run");
  assert.match(a.outsText, /^9 outs \(flush draw\): ~35% to hit by the river/);
  assert.ok(a.why.some((l) => l.includes("60 ÷ (180 + 60) = 25%")));
  assert.ok(a.why.some((l) => l.includes("Rule of 2 and 4: 9 × 4 ≈ 36%")));
  assert.ok(a.why.some((l) => l.includes("in the long run")));
});

test("verdicts: fold when short of the price, value when far ahead, check when nobody bet", () => {
  assert.equal(buildCoachAdvice({ hole: ["7c", "2d"], board: ["Kh", "9h", "Ac"], pot: 100, toCall: 100, opponents: 1, equity: 0.1, samples: 3000 }).verdict.text, "Folding loses the least");
  assert.equal(buildCoachAdvice({ hole: ["As", "Ad"], pot: 30, toCall: 10, opponents: 1, equity: 0.85, samples: 3000 }).verdict.kind, "value");
  assert.equal(buildCoachAdvice({ hole: ["As", "Ad"], board: ["2c", "7d", "9s"], pot: 60, toCall: 0, opponents: 1, equity: 0.88, samples: 3000 }).verdict.text, "Strong enough to bet for value");
  const check = buildCoachAdvice({ hole: ["7c", "2d"], board: ["Kh", "9h", "Ac"], pot: 60, toCall: 0, opponents: 2, equity: 0.12, samples: 3000 });
  assert.equal(check.verdict.kind, "check");
  assert.equal(check.potOddsText, null);
  const pending = buildCoachAdvice({ hole: ["7c", "2d"], pot: 15, toCall: 5, opponents: 3, equity: null });
  assert.equal(pending.verdict.kind, "pending");
  assert.equal(valueThreshold(1), 0.6);
});

test("the coach never promises an outcome", () => {
  const texts = [];
  for (const equity of [0.05, 0.3, 0.5, 0.9]) {
    for (const toCall of [0, 50]) {
      const a = buildCoachAdvice({ hole: ["Qs", "Js"], board: ["Ts", "2h", "3s"], pot: 150, toCall, opponents: 2, equity, samples: 3000 });
      texts.push(a.verdict.text, ...a.why);
    }
  }
  for (const t of texts) assert.doesNotMatch(t, /guarantee|sure win|can't lose|will win/i);
});

test("hand review: a thin raise is not called +EV just because a call was", () => {
  const table = { seats: [{ seatNo: 0, displayName: "Player", isSelf: true }], hand: { status: "complete", winners: [0], showdown: null } };
  const thin = buildHandReview({ decisions: [{ street: "turn", action: "raise", equity: 0.27, toCall: 40, pot: 115, opponents: 1 }], table });
  assert.match(thin.decisionLine, /calling was \+EV and the raise also needs folds/);
  const strong = buildHandReview({ decisions: [{ street: "flop", action: "raise", equity: 0.8, toCall: 40, pot: 115, opponents: 1 }], table });
  assert.match(strong.decisionLine, /a raise for value fit the numbers/);
});

test("outs on the turn use one card to come", () => {
  const o = describeOuts(["8c", "7d"], ["6h", "5s", "Kc", "2d"]);
  assert.equal(o.outs, 8);
  assert.equal(o.toCome, 1);
  assert.match(o.why, /8 × 2 ≈ 16%/);
  assert.match(o.why, /8\/46 = 17\.4%/);
});

test("hand review: key decision by the numbers and the hand ranks", () => {
  const decisions = [
    { street: "flop", action: "check", equity: 0.3, toCall: 0, pot: 60, opponents: 2 },
    { street: "turn", action: "call", equity: 0.41, toCall: 60, pot: 180, opponents: 1 }
  ];
  assert.equal(pickKeyDecision(decisions).street, "turn");
  const table = {
    seats: [{ seatNo: 0, displayName: "Player", isSelf: true }, { seatNo: 1, displayName: "Alva · Tight" }],
    hand: { status: "complete", winners: [1], showdown: { hands: { 0: { name: "Two Pair" }, 1: { name: "Flush" } } } }
  };
  const r = buildHandReview({ decisions, table });
  assert.equal(r.ev, true);
  assert.equal(r.decisionLine, "Key decision: you called 60 on the turn needing 25% with ~41% equity: +EV by the numbers.");
  assert.equal(r.resultLine, "You had Two Pair. Won by Alva · Tight (Flush).");

  const bad = buildHandReview({ decisions: [{ street: "river", action: "fold", equity: 0.4, toCall: 50, pot: 200, opponents: 1 }], table });
  assert.equal(bad.ev, false);
  assert.match(bad.decisionLine, /calling was \+EV/);

  const foldOut = buildHandReview({ decisions: [], table: { seats: table.seats, hand: { status: "complete", winners: [0], showdown: null } } });
  assert.equal(foldOut.decisionLine, "No decision with numbers this hand.");
  assert.equal(foldOut.resultLine, "You won without a showdown.");
});
