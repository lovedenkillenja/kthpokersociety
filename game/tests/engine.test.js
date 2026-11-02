import test from "node:test";
import assert from "node:assert/strict";
import {
  HAND_CATEGORIES,
  createDeck,
  createSeededRng,
  shuffleDeck,
  evaluate,
  compareHands,
  computeSidePots,
  distributePotToWinners,
  newHand,
  legalActions,
  apply,
  showdown,
  publicView,
  checkChipConservation
} from "../engine/index.js";

// Helper to build a full 52-card fixed deck starting with `prefixCards`
function buildFixedDeck(prefixCards) {
  const full = createDeck();
  const used = new Set(prefixCards);
  const rest = full.filter((c) => !used.has(c));
  return [...prefixCards, ...rest];
}

test("All hand ranks and kickers are ordered and broken accurately", () => {
  const royalFlush = evaluate(["As", "Ks", "Qs", "Js", "Ts", "2d", "3c"]);
  const kingStraightFlush = evaluate(["Ks", "Qs", "Js", "Ts", "9s", "Ad", "Ac"]);
  const steelWheel = evaluate(["As", "2s", "3s", "4s", "5s", "Kd", "Qc"]);

  const quadsAcesKing = evaluate(["As", "Ah", "Ad", "Ac", "Ks", "Qd", "Jc"]);
  const quadsAcesQueen = evaluate(["As", "Ah", "Ad", "Ac", "Qs", "Jd", "Tc"]);
  const quadsKingsAce = evaluate(["Ks", "Kh", "Kd", "Kc", "As", "Qd", "Jc"]);

  const fullHouseAcesOverKings = evaluate(["As", "Ah", "Ad", "Ks", "Kh", "Qd", "Qc"]);
  const fullHouseKingsOverAces = evaluate(["Ks", "Kh", "Kd", "As", "Ah", "2d", "3c"]);
  // Two three-of-a-kinds in 7 cards: AAA + KKK + 2 -> AAA full of KK
  const doubleTripsFullHouse = evaluate(["As", "Ah", "Ad", "Ks", "Kh", "Kd", "2c"]);

  const flushAceHighTen5th = evaluate(["As", "Qs", "Js", "9s", "Ts", "2s", "3d"]);
  const flushAceHighEight5th = evaluate(["As", "Qs", "Js", "9s", "8s", "4d", "3c"]);

  const broadwayStraight = evaluate(["As", "Kd", "Qh", "Jc", "Ts", "9d", "2c"]);
  const sixHighStraight = evaluate(["6s", "5d", "4h", "3c", "2s", "Kd", "Qc"]);
  const wheelStraight = evaluate(["As", "2d", "3h", "4c", "5s", "Kd", "Qc"]);

  const tripsQueensAceKing = evaluate(["Qs", "Qh", "Qd", "As", "Kd", "4c", "2s"]);
  const tripsQueensAceJack = evaluate(["Qs", "Qh", "Qd", "As", "Jd", "4c", "2s"]);

  // Three pairs in 7 cards: AA + KK + QQ + 2 -> Two Pair AA and KK with Q kicker
  const threePairsHand = evaluate(["As", "Ah", "Ks", "Kh", "Qs", "Qh", "2d"]);
  const twoPairAcesKingsJack = evaluate(["As", "Ah", "Ks", "Kh", "Jd", "9c", "2s"]);
  const twoPairAcesQueensAceKicker = evaluate(["As", "Ah", "Qs", "Qh", "Kd", "9c", "2s"]);

  const onePairTensKingQueenJack = evaluate(["Ts", "Th", "Ks", "Qd", "Jc", "4s", "2d"]);
  const onePairTensKingQueenNine = evaluate(["Ts", "Th", "Ks", "Qd", "9c", "4s", "2d"]);

  const highCardAce = evaluate(["As", "Kd", "Jh", "9c", "7s", "4d", "2c"]);
  const highCardAceLower5th = evaluate(["As", "Kd", "Jh", "9c", "6s", "4d", "2c"]);

  assert.equal(royalFlush.category, HAND_CATEGORIES.STRAIGHT_FLUSH);
  assert.equal(quadsAcesKing.category, HAND_CATEGORIES.FOUR_OF_A_KIND);
  assert.equal(fullHouseAcesOverKings.category, HAND_CATEGORIES.FULL_HOUSE);
  assert.equal(flushAceHighTen5th.category, HAND_CATEGORIES.FLUSH);
  assert.equal(broadwayStraight.category, HAND_CATEGORIES.STRAIGHT);
  assert.equal(tripsQueensAceKing.category, HAND_CATEGORIES.THREE_OF_A_KIND);
  assert.equal(threePairsHand.category, HAND_CATEGORIES.TWO_PAIR);
  assert.equal(onePairTensKingQueenJack.category, HAND_CATEGORIES.ONE_PAIR);
  assert.equal(highCardAce.category, HAND_CATEGORIES.HIGH_CARD);

  // Strict hierarchy and kicker tie-breaking
  const ordered = [
    royalFlush,
    kingStraightFlush,
    steelWheel,
    quadsAcesKing,
    quadsAcesQueen,
    quadsKingsAce,
    fullHouseAcesOverKings,
    fullHouseKingsOverAces,
    flushAceHighTen5th,
    flushAceHighEight5th,
    broadwayStraight,
    sixHighStraight,
    wheelStraight,
    tripsQueensAceKing,
    tripsQueensAceJack,
    threePairsHand,
    twoPairAcesKingsJack,
    twoPairAcesQueensAceKicker,
    onePairTensKingQueenJack,
    onePairTensKingQueenNine,
    highCardAce,
    highCardAceLower5th
  ];

  for (let i = 0; i < ordered.length - 1; i += 1) {
    assert.equal(
      compareHands(ordered[i], ordered[i + 1]),
      1,
      `Expected hand at index ${i} (${ordered[i].name}) to beat index ${i + 1} (${ordered[i + 1].name})`
    );
  }

  assert.equal(compareHands(fullHouseAcesOverKings, doubleTripsFullHouse), 0);
});

test("Wheel straight (A-2-3-4-5) evaluates as 5-high straight and loses to 6-high straight", () => {
  const wheel = evaluate(["As", "2d", "3c", "4h", "5s", "Kh", "Jd"]);
  const sixHigh = evaluate(["2d", "3c", "4h", "5s", "6d", "Ah", "Kd"]);
  const trips = evaluate(["9s", "9h", "9d", "As", "Kd", "Qc", "2h"]);

  assert.equal(wheel.category, HAND_CATEGORIES.STRAIGHT);
  assert.deepEqual(wheel.ranks, [5]);
  assert.equal(compareHands(sixHigh, wheel), 1);
  assert.equal(compareHands(wheel, trips), 1);
});

test("Heads-up blind order: dealer posts small blind, acts first preflop, and acts last postflop", () => {
  const seats = [
    { seat: 0, stack: 1000, name: "Alice" },
    { seat: 1, stack: 1000, name: "Bob" }
  ];
  const deck = buildFixedDeck([
    "As", "Kd", // Seat 0 (Dealer / SB)
    "Qh", "Jc", // Seat 1 (BB)
    "2c", "7d", "9h", // Flop
    "3s", // Turn
    "4c"  // River
  ]);

  let state = newHand(seats, 0, { sb: 10, bb: 20 }, deck);
  assert.equal(state.dealerSeat, 0);
  assert.equal(state.sbSeat, 0);
  assert.equal(state.bbSeat, 1);
  assert.equal(state.actingSeat, 0, "Dealer (SB) must act first preflop in heads-up");
  assert.equal(state.seats[0].bet, 10);
  assert.equal(state.seats[1].bet, 20);

  // SB calls 10 -> BB must still get their option preflop
  state = apply(state, 0, { type: "call" });
  assert.equal(state.street, "preflop");
  assert.equal(state.actingSeat, 1, "BB must get preflop option after SB calls");

  const bbLegal = legalActions(state, 1);
  assert.equal(bbLegal.canCheck, true);
  assert.equal(bbLegal.canRaise, true);
  assert.equal(bbLegal.minRaiseTo, 40);

  // BB checks -> advances to flop, where BB (non-dealer, seat 1) acts first postflop
  state = apply(state, 1, { type: "check" });
  assert.equal(state.street, "flop");
  assert.equal(state.board.length, 3);
  assert.equal(state.actingSeat, 1, "Non-dealer (BB) must act first postflop in heads-up");
  assert.equal(checkChipConservation(state).conserved, true);
});

test("Min-raise rules: full raises update minRaiseTo; short all-in does not reopen raising for prior actors", () => {
  const seats = [
    { seat: 0, stack: 1000, name: "Button" },
    { seat: 1, stack: 1000, name: "SB" },
    { seat: 2, stack: 1000, name: "BB" },
    { seat: 3, stack: 95, name: "ShortUTG" }
  ];
  let state = newHand(seats, 0, { sb: 10, bb: 20 }, createSeededRng(42));

  // 4-handed with dealer=0: SB=1, BB=2, UTG=3 acts first preflop
  assert.equal(state.sbSeat, 1);
  assert.equal(state.bbSeat, 2);
  assert.equal(state.actingSeat, 3);

  // Seat 3 (ShortUTG, stack 95) min-raise is 40, max is 95
  let legal3 = legalActions(state, 3);
  assert.equal(legal3.minRaiseTo, 40);
  assert.equal(legal3.maxRaiseTo, 95);

  // Seat 3 calls 20 -> Seat 0 (Button) raises to 70 (raise increment = 50)
  state = apply(state, 3, "call");
  assert.equal(state.actingSeat, 0);

  // Illegal raise below minRaiseTo (40) must throw
  assert.throws(
    () => apply(state, 0, { type: "raise", amount: 30 }),
    (err) => err.code === "ERR_INVALID_RAISE_AMOUNT"
  );

  state = apply(state, 0, { type: "raise", amount: 70 });
  assert.equal(state.currentBet, 70);
  assert.equal(state.lastRaiseSize, 50);

  // Now Seat 1 (SB) faces 70 with lastRaiseSize=50 -> minRaiseTo must be 70 + 50 = 120
  const legal1 = legalActions(state, 1);
  assert.equal(legal1.minRaiseTo, 120);
  assert.throws(
    () => apply(state, 1, { type: "raise", amount: 100 }),
    (err) => err.code === "ERR_INVALID_RAISE_AMOUNT"
  );

  // Seat 1 and Seat 2 fold -> action back to Seat 3 (who has 20 in and 75 left, total 95)
  state = apply(state, 1, "fold");
  state = apply(state, 2, "fold");
  assert.equal(state.actingSeat, 3);

  // Seat 3 cannot make a full raise to 120 because maxRaiseTo is 95; only all-in (95) is allowed
  legal3 = legalActions(state, 3);
  assert.equal(legal3.canRaise, true);
  assert.equal(legal3.minRaiseTo, 95);
  assert.equal(legal3.maxRaiseTo, 95);

  // Seat 3 goes all-in for 95 (a short raise of +25, which is < lastRaiseSize of 50)
  state = apply(state, 3, "all-in");
  assert.equal(state.currentBet, 95);
  assert.equal(state.actingSeat, 0);

  // Seat 0 ALREADY acted at the 70 level, so the short raise to 95 does NOT reopen raising for Seat 0
  const legal0 = legalActions(state, 0);
  assert.equal(legal0.canCall, true);
  assert.equal(legal0.callAmount, 25);
  assert.equal(legal0.canRaise, false, "Short all-in raise must not reopen raising for prior full-raise actor");
});

test("Fold-out wins contested pot and returns uncalled bet back to bettor", () => {
  const seats = [
    { seat: 0, stack: 1000, name: "Alice" },
    { seat: 1, stack: 1000, name: "Bob" }
  ];
  let state = newHand(seats, 0, { sb: 10, bb: 20 }, createSeededRng(7));

  // Preflop: Alice (SB/Dealer) calls 20, Bob (BB) checks -> Flop (pot = 40)
  state = apply(state, 0, "call");
  state = apply(state, 1, "check");
  assert.equal(state.street, "flop");
  assert.equal(state.pot, 40);

  // Flop: Bob bets 60, Alice raises to 200, Bob folds
  state = apply(state, 1, { type: "raise", amount: 60 });
  state = apply(state, 0, { type: "raise", amount: 200 });
  state = apply(state, 1, "fold");

  // Uncalled portion of Alice's flop raise is 200 - 60 = 140
  // Contested pot is 40 (preflop) + 60 (Bob flop) + 60 (Alice matched flop) = 160
  assert.equal(state.status, "complete");
  assert.deepEqual(state.uncalledReturned, { seat: 0, amount: 140 });
  assert.equal(state.pot, 160);
  assert.equal(state.payouts[0], 160);
  assert.deepEqual(state.winners, [0]);

  // Alice started with 1000, Bob lost 20 + 60 = 80 -> Alice ends with 1080, Bob with 920
  assert.equal(state.seats[0].stack, 1080);
  assert.equal(state.seats[1].stack, 920);
  assert.equal(checkChipConservation(state).conserved, true);
});

test("Ties and split pots: board-played royal flush splits pot evenly", () => {
  const seats = [
    { seat: 0, stack: 500, name: "Alice" },
    { seat: 1, stack: 500, name: "Bob" }
  ];
  const deck = buildFixedDeck([
    "2c", "3c", // Alice hole cards
    "4d", "5d", // Bob hole cards
    "As", "Ks", "Qs", "Js", "Ts" // Board: Royal Flush in spades
  ]);

  let state = newHand(seats, 0, { sb: 10, bb: 20 }, deck);
  state = apply(state, 0, "all-in");
  state = apply(state, 1, "call");

  assert.equal(state.status, "complete");
  assert.equal(state.pot, 1000);
  assert.deepEqual(state.winners, [0, 1]);
  assert.equal(state.payouts[0], 500);
  assert.equal(state.payouts[1], 500);
  assert.equal(state.seats[0].stack, 500);
  assert.equal(state.seats[1].stack, 500);
  assert.equal(checkChipConservation(state).conserved, true);
});

test("3-way all-in with different stacks creates side pots and awards each pot to its eligible winner", () => {
  // Scenario A: 3 all-in stacks (100, 300, 600) + 4th player covering 600 -> Main Pot + 2 Side Pots
  // Seat 0 (stack 100): best hand (Quad Aces) -> wins Main Pot (4 * 100 = 400)
  // Seat 1 (stack 300): second-best hand (Full House Kings full) -> wins Side Pot 1 (3 * 200 = 600)
  // Seat 2 (stack 600): third-best hand (Flush) -> wins Side Pot 2 (2 * 300 = 600)
  // Seat 3 (stack 600): fourth-best hand (High Card) -> wins 0
  const seats = [
    { seat: 0, stack: 100, name: "Short" },
    { seat: 1, stack: 300, name: "Medium" },
    { seat: 2, stack: 600, name: "DeepA" },
    { seat: 3, stack: 600, name: "DeepB" }
  ];

  const deck = buildFixedDeck([
    "Ad", "Ac", // Seat 0: makes Quad Aces on board Ah As Kh 2h 3h
    "Kd", "Kc", // Seat 1: makes Kings full of Aces (KKK AA)
    "Qh", "Jh", // Seat 2: makes Ace-high Hearts Flush (Ah Kh Qh Jh 3h)
    "7d", "8c", // Seat 3: pair of Aces only
    "Ah", "As", "Kh", "2h", "3h" // Board
  ]);

  let state = newHand(seats, 0, { sb: 10, bb: 20 }, deck);
  // Dealer=0 -> SB=1, BB=2, UTG=3 acts first
  state = apply(state, 3, "all-in"); // Seat 3 all-in 600
  state = apply(state, 0, "all-in"); // Seat 0 all-in 100
  state = apply(state, 1, "all-in"); // Seat 1 all-in 300
  state = apply(state, 2, "call");   // Seat 2 calls 600 all-in

  assert.equal(state.status, "complete");
  assert.equal(state.pots.length, 3, "Expected Main Pot + 2 Side Pots");

  assert.equal(state.pots[0].name, "Main Pot");
  assert.equal(state.pots[0].amount, 400);
  assert.deepEqual(state.pots[0].eligibleSeats, [0, 1, 2, 3]);
  assert.deepEqual(state.pots[0].winners, [0]);

  assert.equal(state.pots[1].name, "Side Pot 1");
  assert.equal(state.pots[1].amount, 600);
  assert.deepEqual(state.pots[1].eligibleSeats, [1, 2, 3]);
  assert.deepEqual(state.pots[1].winners, [1]);

  assert.equal(state.pots[2].name, "Side Pot 2");
  assert.equal(state.pots[2].amount, 600);
  assert.deepEqual(state.pots[2].eligibleSeats, [2, 3]);
  assert.deepEqual(state.pots[2].winners, [2]);

  assert.equal(state.seats[0].stack, 400);
  assert.equal(state.seats[1].stack, 600);
  assert.equal(state.seats[2].stack, 600);
  assert.equal(state.seats[3].stack, 0);
  assert.equal(checkChipConservation(state, 1600).conserved, true);

  // Scenario B: 3 players total with stacks 100, 250, 500 all going all-in
  // Main Pot = 300 (eligible 0,1,2), Side Pot 1 = 300 (eligible 1,2), Uncalled = 250 returned to seat 2
  const seats3 = [
    { seat: 0, stack: 100 },
    { seat: 1, stack: 250 },
    { seat: 2, stack: 500 }
  ];
  const deck3 = buildFixedDeck([
    "Ad", "Ac", // Seat 0: Quad Aces -> wins Main Pot (300)
    "Kd", "Kc", // Seat 1: Kings full -> wins Side Pot 1 (300)
    "7d", "8c", // Seat 2: loses both pots, gets 250 uncalled back
    "Ah", "As", "Kh", "2c", "3d"
  ]);
  let state3 = newHand(seats3, 0, { sb: 10, bb: 20 }, deck3);
  state3 = apply(state3, 0, "all-in");
  state3 = apply(state3, 1, "all-in");
  state3 = apply(state3, 2, "all-in");

  assert.equal(state3.status, "complete");
  assert.deepEqual(state3.uncalledReturned, { seat: 2, amount: 250 });
  assert.equal(state3.seats[0].stack, 300);
  assert.equal(state3.seats[1].stack, 300);
  assert.equal(state3.seats[2].stack, 250);
  assert.equal(checkChipConservation(state3, 850).conserved, true);
});

test("Odd-chip split: awards odd chip to the tied winner first clockwise left of the dealer button", () => {
  // Direct unit check on distributePotToWinners
  // Seats: [0, 1, 2], Dealer = 1 -> clockwise order left of dealer is [2, 0, 1]
  // If seat 0 and seat 2 tie for a 101-chip pot, seat 2 is first left of dealer (1) and gets 51; seat 0 gets 50.
  const split2 = distributePotToWinners(101, [0, 2], 1, [0, 1, 2]);
  assert.equal(split2.payouts[2], 51);
  assert.equal(split2.payouts[0], 50);
  assert.deepEqual(split2.oddChipSeats, [2]);

  // Full hand check with odd chip in pot:
  // 3 players: Seat 0 (Dealer), Seat 1 (SB, stack 15), Seat 2 (BB, stack 15)
  // Seat 1 posts 10, Seat 2 posts 15 (all-in), Seat 0 calls 15, Seat 1 folds!
  // Wait: if Seat 1 folds after posting 5 (blinds 5/10), and Seat 0 & Seat 2 tie on the board:
  // Total pot = 5 (dead SB from Seat 1) + 10 (Seat 2) + 10 (Seat 0) = 25 chips (odd!).
  // Dealer is Seat 0 -> between tied winners Seat 0 and Seat 2, Seat 2 is first clockwise left of Dealer (0),
  // so Seat 2 receives 13 chips and Seat 0 receives 12 chips!
  const seats = [
    { seat: 0, stack: 100, name: "Dealer" },
    { seat: 1, stack: 100, name: "SB" },
    { seat: 2, stack: 100, name: "BB" }
  ];
  const deck = buildFixedDeck([
    "2c", "3d", // Seat 0
    "4c", "5d", // Seat 1 (folds)
    "2h", "3s", // Seat 2
    "As", "Ks", "Qs", "Js", "Ts" // Royal flush on board -> Seat 0 and Seat 2 tie!
  ]);

  let state = newHand(seats, 0, { sb: 5, bb: 10 }, deck);
  // Dealer=0 -> SB=1 (posts 5), BB=2 (posts 10), UTG=0 acts first
  state = apply(state, 0, "call");  // Seat 0 calls 10
  state = apply(state, 1, "fold");  // Seat 1 folds (leaves 5 dead chips in pot)
  state = apply(state, 2, "check"); // Seat 2 checks -> Flop (pot = 25)

  // Check down Flop, Turn, River (Seat 2 acts first postflop as first active left of dealer 0)
  for (const street of ["flop", "turn", "river"]) {
    assert.equal(state.street, street);
    assert.equal(state.actingSeat, 2);
    state = apply(state, 2, "check");
    state = apply(state, 0, "check");
  }

  assert.equal(state.status, "complete");
  assert.equal(state.pot, 25);
  assert.equal(state.payouts[2], 13, "First tied winner left of button (Seat 2) gets the odd chip (13)");
  assert.equal(state.payouts[0], 12, "Button (Seat 0) gets 12");
  assert.deepEqual(state.showdownResult.oddChipWinners, [2]);
  assert.equal(checkChipConservation(state, 300).conserved, true);
});

test("publicView hides deck and unrevealed hole cards, and chip conservation holds across random hands", () => {
  const rng = createSeededRng(2026);
  const seats = [
    { seat: 0, stack: 1000 },
    { seat: 1, stack: 1000 },
    { seat: 2, stack: 1000 }
  ];

  const state = newHand(seats, 0, { sb: 10, bb: 20 }, rng);
  const pub = publicView(state);

  assert.equal("deck" in pub, false, "publicView must never expose the deck");
  assert.equal(pub.seats.every((s) => s.holeCards === null), true, "publicView must hide hole cards during play");
  assert.equal(checkChipConservation(state, 3000).conserved, true);
});

test("3-6 player hands: dealer rotation, SB/BB/UTG positions, and skipping sitout seats", () => {
  const rng = createSeededRng(2027);
  // 6 seats where seat 2 is sitting out -> active seats are [0, 1, 3, 4, 5]
  const seats = [
    { seat: 0, stack: 500, status: "active", name: "P0" },
    { seat: 1, stack: 500, status: "active", name: "P1" },
    { seat: 2, stack: 500, status: "sitout", name: "P2-Sitout" },
    { seat: 3, stack: 500, status: "active", name: "P3" },
    { seat: 4, stack: 500, status: "active", name: "P4" },
    { seat: 5, stack: 500, status: "active", name: "P5" }
  ];

  // Hand 1 with dealer=0: SB=1, BB=3 (skips seat 2), UTG=4
  const h1 = newHand(seats, 0, { sb: 10, bb: 20 }, rng);
  assert.equal(h1.seats.length, 5, "Sitout seat must be skipped when dealing");
  assert.equal(h1.dealerSeat, 0);
  assert.equal(h1.sbSeat, 1);
  assert.equal(h1.bbSeat, 3);
  assert.equal(h1.actingSeat, 4);

  // Hand 2 with dealer requested at 2 (sitout) -> resolves clockwise to seat 3; SB=4, BB=5, UTG=0
  const h2 = newHand(seats, 2, { sb: 10, bb: 20 }, rng);
  assert.equal(h2.dealerSeat, 3);
  assert.equal(h2.sbSeat, 4);
  assert.equal(h2.bbSeat, 5);
  assert.equal(h2.actingSeat, 0);
});

test("Engine timeout action checks when free and folds when facing a bet, logging timeout-fold", () => {
  const seats = [
    { seat: 0, stack: 500, name: "P0" },
    { seat: 1, stack: 500, name: "P1" },
    { seat: 2, stack: 500, name: "P2" }
  ];
  let state = newHand(seats, 0, { sb: 10, bb: 20 }, createSeededRng(88));
  // 3-handed: dealer=0, SB=1, BB=2, UTG=0 acts first facing 20 BB -> timeout must fold
  assert.equal(state.actingSeat, 0);
  state = apply(state, 0, { type: "timeout" });
  assert.equal(state.seats.find((s) => s.seat === 0).folded, true);
  assert.equal(state.actions.at(-1).type, "timeout-fold");
  assert.equal(state.actions.at(-1).mode, "fold");

  // SB (seat 1) calls 20 -> now BB (seat 2) has option to check for free -> timeout must check!
  state = apply(state, 1, { type: "call" });
  assert.equal(state.actingSeat, 2);
  state = apply(state, 2, { type: "timeout" });
  assert.equal(state.seats.find((s) => s.seat === 2).folded, false, "Timeout when canCheck is true must check, not fold");
  assert.equal(state.street, "flop");
  assert.equal(state.actions.at(-1).type, "timeout-fold");
  assert.equal(state.actions.at(-1).mode, "check");
  assert.equal(checkChipConservation(state, 1500).conserved, true);
});
