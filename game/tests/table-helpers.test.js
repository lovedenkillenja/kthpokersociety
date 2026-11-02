import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeRoomCode,
  validateBuyIn,
  normalizeIncomingTableState,
  partitionTableSeats,
  computeRemainingTurnSeconds,
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
    seats: [{ seatNo: 0, displayName: "Alice K.", status: "active", stack: 500, isSelf: true }],
    hand: null
  });
  assert.match(waiting.headline, /Waiting for players/);

  const myTurn = describeHandStatus({
    code: "KTH26",
    seats: [
      { seatNo: 0, displayName: "Alice K.", status: "active", stack: 500, isSelf: true },
      { seatNo: 1, displayName: "Bob L.", status: "active", stack: 500, isSelf: false }
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
      { seatNo: 0, displayName: "Alice K.", status: "active", stack: 560, isSelf: true },
      { seatNo: 1, displayName: "Bob L.", status: "active", stack: 440, isSelf: false }
    ],
    hand: {
      handNo: 1,
      status: "complete",
      street: "complete",
      pot: 120,
      winners: [0],
      payouts: { 0: 120 },
      showdown: {
        pots: [
          { name: "Main Pot", amount: 80, winners: [0] },
          { name: "Side Pot 1", amount: 40, winners: [0] }
        ],
        hands: {
          0: { name: "Two Pair" }
        }
      }
    }
  });
  assert.match(showdownDone.headline, /You won 120 chips \(Two Pair\)/);
  assert.match(showdownDone.detail, /Main pot: 80 · Side pot 1: 40/);
});

test("partitionTableSeats orders up to 5 opponents clockwise starting left of selfSeat", () => {
  const table6Max = {
    code: "SIXMX",
    seats: [
      { seatNo: 0, displayName: "S0", isSelf: false },
      { seatNo: 1, displayName: "S1", isSelf: false },
      { seatNo: 2, displayName: "Me (S2)", isSelf: true },
      { seatNo: 3, displayName: "S3", isSelf: false },
      { seatNo: 4, displayName: "S4", isSelf: false },
      { seatNo: 5, displayName: "S5", isSelf: false }
    ]
  };
  const { selfSeat, opponentSeats } = partitionTableSeats(table6Max);
  assert.equal(selfSeat.seatNo, 2);
  assert.deepEqual(
    opponentSeats.map((s) => s.seatNo),
    [3, 4, 5, 0, 1]
  );
});

test("computeRemainingTurnSeconds accounts for server clock skew and clamps at 0", () => {
  const hand = {
    status: "playing",
    turnStartedAt: 100_000,
    turnDeadlineAt: 130_000
  };
  assert.equal(computeRemainingTurnSeconds(hand, 105_000, 0), 25);
  assert.equal(computeRemainingTurnSeconds(hand, 100_000, 5_000), 25);
  assert.equal(computeRemainingTurnSeconds(hand, 135_000, 0), 0);
  assert.equal(computeRemainingTurnSeconds({ status: "complete", turnDeadlineAt: 130_000 }, 105_000), null);
});
