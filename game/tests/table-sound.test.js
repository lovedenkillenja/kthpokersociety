import test from "node:test";
import assert from "node:assert/strict";
import { planSoundCues, clickCountForBet, panForX, timerWarningCue, CUE_NAMES } from "../ui/table-sound.js";
import { makeSnapshot, diffSnapshots, describeWinningHand, computeWinSpec, winTimeline } from "../ui/table-motion.js";
import { evaluate } from "../engine/evaluator.js";

const seat = (seatNo, extra = {}) => ({ seatNo, displayName: `P${seatNo}`, bet: 0, folded: false, isSelf: seatNo === 0, revealedCards: null, ...extra });
const table = ({ handId = "h1", status = "playing", board = [], pot = 30, seats, dealerSeat = 0, payouts = null, actingSeat = 1, actionSeq = 1, bb = 20, winners, showdown } = {}) => ({
  code: "ABC",
  bb,
  seats: seats || [seat(0), seat(1), seat(2)],
  hand: handId ? { id: handId, status, board, pot, dealerSeat, payouts, actingSeat, actionSeq, winners, showdown } : null
});
const snap = (t, o) => makeSnapshot(t, o);
const ctx = (extra = {}) => ({ seatNos: [0, 1, 2], dealtSeats: [0, 1, 2], selfSeatNo: 0, seatPans: { 0: 0, 1: -0.6, 2: 0.6 }, bb: 20, ...extra });

test("every cue the planner can emit is a known cue name", () => {
  const prev = snap(table({ handId: null }));
  const next = snap(table({ seats: [seat(0), seat(1, { bet: 10, totalCommitted: 10 }), seat(2, { bet: 20, totalCommitted: 20 })] }));
  const cues = planSoundCues(diffSnapshots(prev, next), ctx());
  assert.ok(cues.length > 0);
  cues.forEach((c) => assert.ok(CUE_NAMES.includes(c.cue), c.cue));
});

test("nothing plays on the first snapshot, on another table, or on a plain re-render", () => {
  const t = table({ board: ["As", "Kd", "2c"] });
  assert.deepEqual(planSoundCues(diffSnapshots(null, snap(t)), ctx()), []);
  assert.deepEqual(planSoundCues(diffSnapshots(snap(t), snap(t)), ctx()), []);
  assert.deepEqual(planSoundCues({}, ctx()), []);
  assert.deepEqual(planSoundCues(null, ctx()), []);
});

test("a new hand deals one sound per card, in dealing order, panned by seat, timed with the deal animation", () => {
  const prev = snap(table({ handId: null }));
  const next = snap(table({ dealerSeat: 2 }));
  const deals = planSoundCues(diffSnapshots(prev, next), ctx()).filter((c) => c.cue === "deal");
  assert.equal(deals.length, 6);
  assert.deepEqual(deals.map((c) => c.at), [0, 0.1, 0.2, 0.3, 0.4, 0.5]);
  // dealer is seat 2, so the first card goes to seat 0 (centre), then seat 1 (left), then seat 2 (right)
  assert.deepEqual(deals.slice(0, 3).map((c) => c.pan), [0, -0.6, 0.6]);
});

test("board cards flip once each; folds and checks pan to their seat", () => {
  const a = snap(table({ board: [], actionSeq: 3, actingSeat: 1 }));
  const b = snap(table({ board: ["As", "Kd", "2c"], actionSeq: 4, actingSeat: 2 }));
  const cues = planSoundCues(diffSnapshots(a, b), ctx());
  assert.equal(cues.filter((c) => c.cue === "flip").length, 3);
  const check = cues.find((c) => c.cue === "check");
  assert.ok(check, "the acting seat checked");
  assert.equal(check.pan, -0.6);

  const c = snap(table({ seats: [seat(0), seat(1), seat(2, { folded: true })], actionSeq: 5, actingSeat: 0 }));
  const folds = planSoundCues(diffSnapshots(b, c), ctx()).filter((x) => x.cue === "fold");
  assert.equal(folds.length, 1);
  assert.equal(folds[0].pan, 0.6);
});

test("a bet is not a check; a call that closes the street still clicks chips", () => {
  const before = snap(table({ actionSeq: 3, actingSeat: 1, seats: [seat(0, { bet: 40, totalCommitted: 40 }), seat(1, { bet: 0, totalCommitted: 20 }), seat(2)] }));
  const called = snap(table({ actionSeq: 4, actingSeat: 0, board: ["As", "Kd", "2c"], seats: [seat(0, { bet: 0, totalCommitted: 40 }), seat(1, { bet: 0, totalCommitted: 40 }), seat(2)] }));
  const ev = diffSnapshots(before, called);
  assert.equal(ev.checks, undefined, "chips went in, so it is not a check");
  assert.deepEqual(ev.commits, [{ seatNo: 1, delta: 20 }]);
  const cues = planSoundCues(ev, ctx());
  assert.ok(cues.some((c) => c.cue === "bet" && c.pan === -0.6));
});

test("chip clicks grow with the bet; a big bet or an all-in cascades", () => {
  assert.equal(clickCountForBet(20, 20), 2);
  assert.equal(clickCountForBet(60, 20), 3);
  assert.equal(clickCountForBet(160, 20), 4);
  assert.equal(clickCountForBet(1000, 20), 5);
  assert.equal(clickCountForBet(0, 20), 2);
  const big = planSoundCues({ commits: [{ seatNo: 1, delta: 400 }] }, ctx()).find((c) => c.cue === "bet");
  assert.equal(big.cascade, true);
  const small = planSoundCues({ commits: [{ seatNo: 1, delta: 40 }] }, ctx()).find((c) => c.cue === "bet");
  assert.equal(small.cascade, false);
  const allIn = planSoundCues({ commits: [{ seatNo: 1, delta: 120 }] }, ctx({ allInSeats: [1] })).find((c) => c.cue === "bet");
  assert.equal(allIn.cascade, true);
});

test("chips swept into the pot make one soft rattle", () => {
  const cues = planSoundCues({ sweep: [{ seatNo: 1, amount: 40 }, { seatNo: 2, amount: 40 }] }, ctx());
  assert.equal(cues.filter((c) => c.cue === "sweep").length, 1);
});

test("the player's own win plays the win cue (big flag for big pots); someone else's win has no jingle", () => {
  const winSelf = { kind: "showdown", selfWins: true, big: false };
  const events = { payouts: [{ seatNo: 0, amount: 140 }], reveal: [1] };
  const mine = planSoundCues(events, ctx({ win: winSelf }));
  assert.equal(mine.filter((c) => c.cue === "win").length, 1);
  assert.equal(mine.find((c) => c.cue === "win").big, false);
  assert.equal(planSoundCues(events, ctx({ win: { ...winSelf, big: true } })).find((c) => c.cue === "win").big, true);

  const others = planSoundCues({ payouts: [{ seatNo: 1, amount: 140 }] }, ctx({ win: { kind: "fold-out", selfWins: false, big: false } }));
  assert.equal(others.some((c) => c.cue === "win"), false);
  assert.ok(others.some((c) => c.cue === "sweep"), "only the soft pot slide");
});

test("win cues follow the win timeline (the payout slide), later for a showdown than for a fold-out", () => {
  const events = { payouts: [{ seatNo: 0, amount: 100 }] };
  const showdown = planSoundCues(events, ctx({ win: { kind: "showdown", selfWins: true } })).find((c) => c.cue === "win");
  const foldOut = planSoundCues(events, ctx({ win: { kind: "fold-out", selfWins: true } })).find((c) => c.cue === "win");
  assert.ok(showdown.at > foldOut.at);
  assert.ok(Math.abs(showdown.at - (winTimeline(events, "showdown").payout + 60) / 1000) < 1e-9);
});

test("planned cues are sorted by time, panned inside [-0.65, 0.65], and a burst stays small", () => {
  const prev = snap(table({ handId: null }));
  const seats = [0, 1, 2, 3, 4, 5].map((n) => seat(n, { bet: n ? 20 : 0, totalCommitted: n ? 20 : 0 }));
  const cues = planSoundCues(diffSnapshots(prev, snap(table({ seats }))), ctx({ seatNos: [0, 1, 2, 3, 4, 5], dealtSeats: [0, 1, 2, 3, 4, 5], seatPans: { 0: 0, 1: -1, 2: 1 } }));
  for (let i = 1; i < cues.length; i += 1) assert.ok(cues[i].at >= cues[i - 1].at);
  assert.ok(cues.length <= 12 + 6, `a new hand plans ${cues.length} cues`);
});

test("pan follows the seat's x position and is clamped; timer warning only at 10 and 5 seconds on your own turn", () => {
  assert.equal(panForX(50), 0);
  assert.ok(panForX(0) < 0 && panForX(100) > 0);
  assert.ok(Math.abs(panForX(-500)) <= 0.65);
  assert.equal(panForX(Number.NaN), 0);
  assert.equal(timerWarningCue(10, true).cue, "tick");
  assert.equal(timerWarningCue(5, true).cue, "tick");
  assert.equal(timerWarningCue(9, true), null);
  assert.equal(timerWarningCue(10, false), null);
  assert.equal(timerWarningCue(null, true), null);
});

/* ---------------------------------------------------------------- win spec */

const sdHands = (entries) => Object.fromEntries(entries.map(([s, cards]) => [s, evaluate(cards)]));

test("describeWinningHand names every category with its high cards", () => {
  const name = (cards) => describeWinningHand(evaluate(cards));
  assert.equal(name(["Ks", "Qh", "Jd", "Tc", "9s"]), "Straight, King high");
  assert.equal(name(["Ah", "2d", "3c", "4s", "5h"]), "Straight, Five high");
  assert.equal(name(["Ks", "Kd", "7c", "4s", "2h"]), "Pair of Kings");
  assert.equal(name(["Ks", "Kd", "7c", "7s", "2h"]), "Two pair, Kings and Sevens");
  assert.equal(name(["8s", "8d", "8c", "4s", "2h"]), "Three of a kind, Eights");
  assert.equal(name(["Ks", "Kd", "Kc", "9s", "9h"]), "Full house, Kings over Nines");
  assert.equal(name(["As", "Js", "8s", "6s", "2s"]), "Flush, Ace high");
  assert.equal(name(["Qs", "Qd", "Qh", "Qc", "2s"]), "Four of a kind, Queens");
  assert.equal(name(["9h", "8h", "7h", "6h", "5h"]), "Straight flush, Nine high");
  assert.equal(name(["As", "Ks", "Qs", "Js", "Ts"]), "Royal flush");
  assert.equal(name(["As", "Qd", "9c", "6h", "3d"]), "Ace high");
  assert.equal(describeWinningHand(null), "");
});

test("computeWinSpec: nothing for a running hand or a hand without winners", () => {
  assert.equal(computeWinSpec(table()), null);
  assert.equal(computeWinSpec(table({ status: "complete", winners: [], payouts: {} })), null);
  assert.equal(computeWinSpec({}), null);
});

test("computeWinSpec: fold-out win skips hand details", () => {
  const t = table({ status: "complete", pot: 140, winners: [1], payouts: { 1: 140 }, seats: [seat(0), seat(1, { displayName: "Sam" }), seat(2, { folded: true })] });
  const win = computeWinSpec(t);
  assert.equal(win.kind, "fold-out");
  assert.equal(win.headline, "Sam wins 140");
  assert.equal(win.detail, "Everyone else folded");
  assert.deepEqual(win.boardWin, []);
  assert.equal(win.selfWins, false);
  assert.equal(win.big, false);
});

test("computeWinSpec: showdown finds the five winning cards from revealed cards and names the hand", () => {
  const board = ["Kh", "Qd", "Jc", "2s", "3d"];
  const t = table({
    status: "complete", board, pot: 1380, winners: [1], payouts: { 1: 1380 }, showdown: { hands: {} },
    seats: [seat(0, { revealedCards: ["7c", "8c"] }), seat(1, { displayName: "Sam", revealedCards: ["As", "Td"] })]
  });
  const win = computeWinSpec(t);
  assert.equal(win.kind, "showdown");
  assert.equal(win.headline, "Straight, Ace high");
  assert.equal(win.detail, "Sam wins 1,380");
  assert.deepEqual(win.boardWin, [0, 1, 2]);
  assert.deepEqual(win.holeWin[1].sort(), ["As", "Td"]);
  assert.equal(win.big, true);
});

test("computeWinSpec: prefers the server's showdown.hands and uses your own hole cards only when they are yours", () => {
  const board = ["As", "Ks", "Qh", "Jd", "Tc"];
  const hands = sdHands([[0, ["2c", "3d", ...board]], [1, ["2h", "3s", ...board]]]);
  const t = table({
    status: "complete", board, pot: 140, winners: [0, 1], payouts: { 0: 70, 1: 70 }, showdown: { hands },
    seats: [seat(0, { displayName: "Alex" }), seat(1, { displayName: "Sam", revealedCards: ["2h", "3s"] })]
  });
  const win = computeWinSpec(t, { myHoleCards: ["2c", "3d"], myHoleCardsHandId: "h1" });
  assert.equal(win.split, true);
  assert.equal(win.selfWins, true);
  assert.equal(win.headline, "Straight, Ace high");
  assert.equal(win.detail, "You win 70 · Sam wins 70");
  assert.deepEqual(win.boardWin, [0, 1, 2, 3, 4]);
  assert.deepEqual(win.holeWin, {});
  // Cards from another hand are never used
  const stale = computeWinSpec(t, { myHoleCards: ["2c", "3d"], myHoleCardsHandId: "other" });
  assert.equal(stale.winners[0].handName, "Straight, Ace high");
});

test("computeWinSpec never uses cards the server did not reveal", () => {
  const board = ["Kh", "Qd", "Jc", "2s", "3d"];
  const t = table({
    status: "complete", board, pot: 100, winners: [1], payouts: { 1: 100 }, showdown: { hands: {} },
    seats: [seat(0), seat(1, { displayName: "Sam" })] // Sam's cards were not revealed
  });
  const win = computeWinSpec(t);
  assert.equal(win.winners[0].handName, "");
  assert.deepEqual(win.winners[0].cards5, []);
  assert.deepEqual(win.boardWin, []);
  assert.equal(win.headline, "Showdown");
});

test("winTimeline: showdown 2.1 s, fold-out 1.5 s, and a run-out delays the reveal until the board is dealt", () => {
  const sd = winTimeline({}, "showdown");
  assert.ok(sd.end >= 1600 && sd.end <= 2200);
  assert.ok(sd.reveal < sd.highlight && sd.highlight < sd.banner && sd.banner < sd.payout && sd.payout < sd.glow && sd.glow < sd.end);
  const fo = winTimeline({}, "fold-out");
  assert.ok(fo.end < sd.end);
  const run = winTimeline({ board: { from: 0, to: 5 } }, "showdown");
  assert.ok(run.reveal > 800);
});
