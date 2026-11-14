import test from "node:test";
import assert from "node:assert/strict";
import { makeSnapshot, diffSnapshots, dealOrder } from "../ui/table-motion.js";

const seat = (seatNo, extra = {}) => ({ seatNo, bet: 0, folded: false, isSelf: seatNo === 0, revealedCards: null, ...extra });
const table = ({ handId = "h1", status = "playing", board = [], pot = 30, seats, dealerSeat = 0, payouts = null, code = "ABC" } = {}) => ({
  code,
  seats: seats || [seat(0), seat(1), seat(2)],
  hand: handId ? { id: handId, status, board, pot, dealerSeat, payouts } : null
});
const snap = (t, o) => makeSnapshot(t, o);

test("first snapshot or another table never animates (page load, reconnect)", () => {
  assert.deepEqual(diffSnapshots(null, snap(table())), {});
  assert.deepEqual(diffSnapshots(snap(table({ code: "AAA" })), snap(table({ code: "BBB" }))), {});
});

test("a plain re-render of the same state has no events", () => {
  const t = table({ board: ["As", "Kd", "2c"] });
  assert.deepEqual(diffSnapshots(snap(t), snap(t)), {});
});

test("new hand: deal plus blinds", () => {
  const prev = snap(table({ handId: null }));
  const next = snap(table({ seats: [seat(0), seat(1, { bet: 10 }), seat(2, { bet: 20 })] }));
  const ev = diffSnapshots(prev, next);
  assert.equal(ev.deal.dealerSeat, 0);
  assert.deepEqual(ev.bets.map((b) => b.seatNo), [1, 2]);
  assert.equal(ev.board, undefined);
});

test("flop, turn and river report the new board range", () => {
  const a = snap(table({ board: [] }));
  const b = snap(table({ board: ["As", "Kd", "2c"] }));
  const c = snap(table({ board: ["As", "Kd", "2c", "9h"] }));
  assert.deepEqual(diffSnapshots(a, b).board, { from: 0, to: 3 });
  assert.deepEqual(diffSnapshots(b, c).board, { from: 3, to: 4 });
});

test("fold and bet are detected per seat", () => {
  const prev = snap(table({ seats: [seat(0), seat(1, { bet: 20 }), seat(2)] }));
  const next = snap(table({ seats: [seat(0), seat(1, { bet: 60 }), seat(2, { folded: true })] }));
  const ev = diffSnapshots(prev, next);
  assert.deepEqual(ev.folds, [2]);
  assert.deepEqual(ev.bets, [{ seatNo: 1, amount: 60 }]);
});

test("end of street sweeps bets into the pot", () => {
  const prev = snap(table({ seats: [seat(0, { bet: 40 }), seat(1, { bet: 40 }), seat(2)], board: [] }));
  const next = snap(table({ seats: [seat(0), seat(1), seat(2)], board: ["As", "Kd", "2c"], pot: 80 }));
  const ev = diffSnapshots(prev, next);
  assert.deepEqual(ev.sweep, [{ seatNo: 0, amount: 40 }, { seatNo: 1, amount: 40 }]);
  assert.deepEqual(ev.board, { from: 0, to: 3 });
  assert.equal(ev.bets, undefined);
});

test("a hand that ends with bets still in front sweeps them, then pays", () => {
  const prev = snap(table({ seats: [seat(0, { bet: 200 }), seat(1), seat(2)] }));
  const next = snap(table({ status: "complete", seats: [seat(0, { bet: 200 }), seat(1, { bet: 200 }), seat(2)], payouts: { 1: 400 } }));
  const ev = diffSnapshots(prev, next);
  assert.deepEqual(ev.sweep, [{ seatNo: 0, amount: 200 }, { seatNo: 1, amount: 200 }]);
  assert.deepEqual(ev.payouts, [{ seatNo: 1, amount: 400 }]);
  assert.equal(ev.bets, undefined);
});

test("hand completing pays the pot to every winner (split pots)", () => {
  const prev = snap(table());
  const next = snap(table({ status: "complete", payouts: { 0: 50, 1: 50, 2: 0 } }));
  assert.deepEqual(diffSnapshots(prev, next).payouts, [{ seatNo: 0, amount: 50 }, { seatNo: 1, amount: 50 }]);
  // already complete and rendered again: nothing pays twice
  assert.equal(diffSnapshots(next, next).payouts, undefined);
});

test("opponent cards turning face-up at showdown are a reveal", () => {
  const prev = snap(table());
  const next = snap(table({ status: "complete", seats: [seat(0), seat(1, { revealedCards: ["As", "Ks"] }), seat(2)] }));
  assert.deepEqual(diffSnapshots(prev, next).reveal, [1]);
});

test("own hole cards arriving flips them only for a hand dealt in this session", () => {
  const prev = snap(table(), { selfCardsKnown: false });
  const next = snap(table(), { selfCardsKnown: true });
  assert.equal(diffSnapshots(prev, next, { dealtHandId: "h1" }).flipSelf, true);
  assert.equal(diffSnapshots(prev, next, { dealtHandId: null }).flipSelf, undefined);
});

test("dealOrder starts with the seat after the dealer and wraps", () => {
  assert.deepEqual(dealOrder([0, 1, 2, 3], 1), [2, 3, 0, 1]);
  assert.deepEqual(dealOrder([3, 0, 5], 5), [0, 3, 5]);
  assert.deepEqual(dealOrder([2, 1], null), [1, 2]);
});
