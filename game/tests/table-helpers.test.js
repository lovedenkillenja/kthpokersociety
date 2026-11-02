import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeRoomCode,
  validateBuyIn,
  normalizeIncomingTableState,
  partitionTableSeats,
  computeRaisePresets,
  describeHandStatus
} from "../lib/table-helpers.js";

test("normalizeRoomCode uppercases and validates 5-character table codes", () => {
  assert.deepEqual(normalizeRoomCode(" kth26 "), {
    valid: true,
    value: "KTH26",
    error: ""
  });
  assert.equal(normalizeRoomCode("AB1").valid, false);
  assert.equal(normalizeRoomCode("").valid, false);
});

test("validateBuyIn enforces integer, 400..2000 range, and available balance", () => {
  assert.equal(validateBuyIn(500, { minBuyIn: 400, maxBuyIn: 2000, balance: 1000 }).valid, true);
  assert.equal(validateBuyIn(300, { minBuyIn: 400, maxBuyIn: 2000, balance: 1000 }).valid, false);
  assert.equal(validateBuyIn(2500, { minBuyIn: 400, maxBuyIn: 2000, balance: 3000 }).valid, false);
  assert.equal(validateBuyIn(800, { minBuyIn: 400, maxBuyIn: 2000, balance: 600 }).valid, false);
  assert.equal(validateBuyIn("500.5", { minBuyIn: 400, maxBuyIn: 2000, balance: 1000 }).valid, false);
});

test("normalizeIncomingTableState and partitionTableSeats preserve selfSeat across Realtime broadcasts", () => {
  // HTTP response where Seat 1 is marked isSelf: true
  const httpTable = {
    code: "ABCDE",
    seats: [
      { seatNo: 0, displayName: "Alice K.", stack: 500, isSelf: false },
      { seatNo: 1, displayName: "Bob L.", stack: 500, isSelf: true }
    ]
  };
  const norm1 = normalizeIncomingTableState(httpTable);
  assert.equal(norm1.selfSeatNo, 1);

  // Subsequent Realtime broadcast has isSelf: false on all seats
  const broadcastTable = {
    code: "ABCDE",
    seats: [
      { seatNo: 0, displayName: "Alice K.", stack: 490, isSelf: false },
      { seatNo: 1, displayName: "Bob L.", stack: 480, isSelf: false }
    ]
  };
  const norm2 = normalizeIncomingTableState(broadcastTable, {
    knownSelfSeatNo: norm1.selfSeatNo
  });
  assert.equal(norm2.selfSeatNo, 1);

  const { selfSeat, opponentSeat } = partitionTableSeats(norm2);
  assert.equal(selfSeat.seatNo, 1);
  assert.equal(selfSeat.displayName, "Bob L.");
  assert.equal(opponentSeat.seatNo, 0);
  assert.equal(opponentSeat.displayName, "Alice K.");
});

test("computeRaisePresets calculates Min, 1/2 pot, Pot, and All-in clamped to legal bounds", () => {
  // Preflop heads-up: SB (myBet=10) facing BB (currentBet=20), pot=30, minRaiseTo=40, maxRaiseTo=500
  // Call diff = 10 -> potAfterCall = 40 -> halfPot = 20 + 20 = 40, pot = 20 + 40 = 60
  const presets = computeRaisePresets({
    pot: 30,
    currentBet: 20,
    myBet: 10,
    minRaiseTo: 40,
    maxRaiseTo: 500
  });
  assert.deepEqual(presets, {
    min: 40,
    halfPot: 40,
    pot: 60,
    allIn: 500
  });

  // Short stack where pot raise exceeds maxRaiseTo is clamped to maxRaiseTo
  const shortPresets = computeRaisePresets({
    pot: 300,
    currentBet: 100,
    myBet: 0,
    minRaiseTo: 200,
    maxRaiseTo: 250
  });
  assert.deepEqual(shortPresets, {
    min: 200,
    halfPot: 250,
    pot: 250,
    allIn: 250
  });
});

test("describeHandStatus summarizes waiting, active turns, and showdown winners", () => {
  const waiting = describeHandStatus({
    code: "KTH26",
    seats: [{ seatNo: 0, displayName: "Alice K.", isSelf: true }],
    hand: null
  });
  assert.match(waiting.headline, /Waiting for a second player/);

  const myTurn = describeHandStatus({
    code: "KTH26",
    seats: [
      { seatNo: 0, displayName: "Alice K.", isSelf: true },
      { seatNo: 1, displayName: "Bob L.", isSelf: false }
    ],
    hand: {
      handNo: 1,
      status: "playing",
      street: "flop",
      pot: 80,
      actingSeat: 0,
      legalActions: { canCheck: true }
    }
  });
  assert.equal(myTurn.isMyTurn, true);
  assert.match(myTurn.headline, /Flop · Your turn/);

  const showdownDone = describeHandStatus({
    code: "KTH26",
    seats: [
      { seatNo: 0, displayName: "Alice K.", isSelf: true },
      { seatNo: 1, displayName: "Bob L.", isSelf: false }
    ],
    hand: {
      handNo: 1,
      status: "complete",
      street: "complete",
      pot: 120,
      winners: [0],
      payouts: { 0: 120 },
      showdown: {
        hands: {
          0: { name: "Two Pair" }
        }
      }
    }
  });
  assert.match(showdownDone.headline, /You won 120 chips \(Two Pair\)/);
});
