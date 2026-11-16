// Design harness mock data. Generates table states in the exact shape of `buildPublicTableState`
// (supabase/functions/_shared/state-helpers.js) using the real engine and fixed decks.
// No network, no Supabase. Pure ES module (also runs in Node).

import { newHand, apply, publicView, legalActions, createDeck } from "../engine/index.js";

/** Frozen "server now" so every countdown is deterministic. */
export const FIXED_NOW = 1_800_000_000_000;
const TURN_TIMEOUT_MS = 30_000;

export const STATE_NAMES = [
  "waiting-1",
  "waiting-3",
  "preflop-2",
  "preflop-6",
  "flop-self-to-act",
  "turn-allin-sidepots",
  "river-folded-self",
  "showdown-split",
  "sitout",
  "sitout-in-hand-to-act",
  "timer-low"
];

const TABLE_BASE = {
  id: "harness-table-1",
  code: "DEMO7",
  sb: 10,
  bb: 20,
  minBuyIn: 400,
  maxBuyIn: 2000,
  maxSeats: 6,
  status: "open",
  isHost: false
};

/** Fixed deck: seat-ordered hole cards, then board cards, then the rest of a standard deck. */
function fixedDeck(holes, board) {
  const used = [...holes.flat(), ...board];
  const rest = createDeck()
    .map((c) => (typeof c === "string" ? c : c.code))
    .filter((c) => !used.includes(c));
  return [...used, ...rest];
}

/** Engine seat order is by seat number, so `holes` follows ascending seat numbers. */
function play({ players, dealer, holes, board, actions, blinds = { sb: 10, bb: 20 } }) {
  const deck = fixedDeck(holes, board);
  let state = newHand(
    players.map((p) => ({ seat: p.seat, id: p.id, name: p.name, stack: p.stack, status: "active" })),
    dealer,
    blinds,
    deck
  );
  for (const [seat, action] of actions) state = apply(state, seat, action);
  return state;
}

/** Mirrors buildPublicTableState (same field names), fed with an engine state. */
function toPublicTable({ players, engineState, selfSeat, remainingSeconds = 24, handNo = 7 }) {
  const pub = engineState ? publicView(engineState) : null;
  const bySeat = new Map((pub?.seats || []).map((s) => [s.seat, s]));

  const seats = players
    .slice()
    .sort((a, b) => a.seat - b.seat)
    .map((p) => {
      const hs = bySeat.get(p.seat);
      return {
        seatNo: p.seat,
        displayName: p.name,
        stack: hs ? hs.stack : p.stack,
        status: p.status || "active",
        consecutiveTimeouts: 0,
        isSelf: p.seat === selfSeat,
        inHand: Boolean(hs),
        bet: hs ? hs.bet : 0,
        totalCommitted: hs ? hs.totalCommitted : 0,
        folded: hs ? hs.folded : false,
        allIn: hs ? hs.allIn : false,
        revealedCards: hs?.holeCards || null
      };
    });

  let hand = null;
  if (pub) {
    const playing = pub.status === "playing" && pub.actingSeat !== null;
    const legal = playing ? legalActions(engineState, pub.actingSeat) : null;
    const sd = pub.showdownResult;
    hand = {
      id: "harness-hand-" + handNo,
      handNo,
      status: pub.status,
      street: pub.street,
      dealerSeat: pub.dealerSeat,
      sbSeat: pub.sbSeat,
      bbSeat: pub.bbSeat,
      board: pub.board,
      pot: pub.pot,
      pots: pub.pots,
      currentBet: pub.currentBet,
      lastRaiseSize: pub.lastRaiseSize,
      actingSeat: pub.actingSeat,
      actionSeq: Number(engineState.actionSeq ?? 0),
      turnStartedAt: playing ? FIXED_NOW - (TURN_TIMEOUT_MS - remainingSeconds * 1000) : null,
      turnDeadlineAt: playing ? FIXED_NOW + remainingSeconds * 1000 : null,
      turnTimeoutMs: TURN_TIMEOUT_MS,
      serverNow: FIXED_NOW,
      legalActions: legal,
      payouts: pub.payouts,
      winners: pub.winners,
      uncalledReturned: pub.uncalledReturned,
      showdown: sd
        ? {
            pots: sd.pots,
            payouts: sd.payouts,
            winners: sd.winners,
            uncalledReturned: sd.uncalledReturned,
            oddChipWinners: sd.oddChipWinners,
            hands: sd.hands
          }
        : null
    };
  }
  return { ...TABLE_BASE, seats, hand };
}

const P = (seat, name, stack, extra = {}) => ({ seat, id: `mock-${seat}`, name, stack, ...extra });

function build(name) {
  switch (name) {
    case "waiting-1":
      return { table: toPublicTable({ players: [P(0, "Alex", 1000)], engineState: null, selfSeat: 0 }), self: 0 };

    case "waiting-3":
      return {
        table: toPublicTable({
          players: [P(0, "Alex", 1000), P(1, "Sam", 800), P(2, "Kim", 1200)],
          engineState: null,
          selfSeat: 0
        }),
        self: 0
      };

    case "preflop-2": {
      // Heads-up: dealer (seat 0 = self) posts SB and acts first, facing the big blind.
      const players = [P(0, "Alex", 1000), P(1, "Sam", 1000)];
      const st = play({ players, dealer: 0, holes: [["As", "Kd"], ["7c", "2h"]], board: ["Qh", "9s", "4d", "Jc", "3s"], actions: [] });
      return { table: toPublicTable({ players, engineState: st, selfSeat: 0, remainingSeconds: 24 }), self: 0, st };
    }

    case "preflop-6": {
      // Dealer seat 0 (self). UTG (3) folds, 4 raises to 60, seat 5 is acting.
      const players = [P(0, "Alex", 1000), P(1, "Sam", 950), P(2, "Kim", 1100), P(3, "Robin", 800), P(4, "Noa", 1500), P(5, "Eli", 600)];
      const st = play({
        players,
        dealer: 0,
        holes: [["Qs", "Qd"], ["8h", "7h"], ["Ac", "Jd"], ["5s", "2c"], ["Kh", "Ts"], ["9d", "9c"]],
        board: ["2d", "6s", "Jh", "3c", "Kd"],
        actions: [[3, "fold"], [4, { type: "raise", amount: 60 }]]
      });
      return { table: toPublicTable({ players, engineState: st, selfSeat: 0, remainingSeconds: 23 }), self: 0, st };
    }

    case "flop-self-to-act": {
      // Dealer seat 2 (self). Limped pot, flop: seat 0 checks, seat 1 bets 60, self faces the bet.
      const players = [P(0, "Sam", 980), P(1, "Kim", 1020), P(2, "Alex", 1000)];
      const st = play({
        players,
        dealer: 2,
        holes: [["Jh", "Tc"], ["6d", "6s"], ["Ah", "Qh"]],
        board: ["Kh", "9h", "2c", "5d", "8s"],
        actions: [
          [2, "call"], [0, "call"], [1, "check"],
          [0, "check"], [1, { type: "raise", amount: 60 }]
        ]
      });
      return { table: toPublicTable({ players, engineState: st, selfSeat: 2, remainingSeconds: 21 }), self: 2, st };
    }

    case "turn-allin-sidepots": {
      // Sam (short stack) is all-in on the turn, Kim raised over it, Jo called: main + side pot.
      const players = [P(0, "Alex", 1000), P(1, "Sam", 300), P(2, "Kim", 600), P(3, "Jo", 1500)];
      const st = play({
        players,
        dealer: 3,
        holes: [["Ad", "Ks"], ["Jc", "Jd"], ["Qh", "Qd"], ["9s", "8s"]],
        board: ["Qc", "7h", "2d", "Kd", "3c"],
        actions: [
          [2, { type: "raise", amount: 60 }], [3, "call"], [0, "call"], [1, "call"],
          [0, "check"], [1, "check"], [2, { type: "raise", amount: 100 }], [3, "call"], [0, "call"], [1, "call"],
          [0, "check"], [1, "all-in"], [2, { type: "raise", amount: 300 }], [3, "call"]
        ]
      });
      return { table: toPublicTable({ players, engineState: st, selfSeat: 0, remainingSeconds: 18 }), self: 0, st };
    }

    case "river-folded-self": {
      // Self (seat 0) folded on the flop; river is being played between Sam and Kim.
      const players = [P(0, "Alex", 1000), P(1, "Sam", 1000), P(2, "Kim", 1000)];
      const st = play({
        players,
        dealer: 2,
        holes: [["4c", "3c"], ["Ah", "Jh"], ["Kd", "Kc"]],
        board: ["Ts", "8h", "2h", "Qh", "5s"],
        actions: [
          [2, "call"], [0, "call"], [1, "check"],
          [0, "fold"], [1, "check"], [2, "check"],
          [1, "check"], [2, { type: "raise", amount: 40 }], [1, "call"],
          [1, "check"]
        ]
      });
      return { table: toPublicTable({ players, engineState: st, selfSeat: 0, remainingSeconds: 12 }), self: 0, st };
    }

    case "showdown-split": {
      // Broadway on the board: Alex and Sam split, Kim folded on the flop. Both show cards.
      const players = [P(0, "Alex", 1000), P(1, "Sam", 1000), P(2, "Kim", 1000)];
      const st = play({
        players,
        dealer: 2,
        holes: [["2c", "3d"], ["2h", "3s"], ["9c", "8c"]],
        board: ["As", "Ks", "Qh", "Jd", "Tc"],
        actions: [
          [2, "call"], [0, "call"], [1, "check"],
          [0, "check"], [1, { type: "raise", amount: 40 }], [2, "fold"], [0, "call"],
          [0, "check"], [1, "check"],
          [0, "check"], [1, "check"]
        ]
      });
      return { table: toPublicTable({ players, engineState: st, selfSeat: 0 }), self: 0, st };
    }

    case "sitout": {
      // Self (seat 0) is sitting out while the other three play a hand.
      const live = [P(1, "Sam", 1000), P(2, "Kim", 1000), P(3, "Jo", 1000)];
      const st = play({
        players: live,
        dealer: 3,
        holes: [["Ah", "9h"], ["Kc", "Kd"], ["7s", "6s"]],
        board: ["2c", "5d", "Jh", "9c", "3s"],
        actions: [[3, "call"]]
      });
      const players = [P(0, "Alex", 1000, { status: "sitout" }), ...live];
      return { table: toPublicTable({ players, engineState: st, selfSeat: 0, remainingSeconds: 17 }), self: 0, st };
    }

    case "sitout-in-hand-to-act": {
      // Heads-up, self (seat 1) is `sitout` but still dealt into this hand: Sam (dealer, SB) called,
      // and it is self's turn with a free check (BB option). The action controls must show.
      const players = [P(0, "Sam", 1000), P(1, "Alex", 1000, { status: "sitout" })];
      const st = play({
        players,
        dealer: 0,
        holes: [["Kc", "Jd"], ["8s", "8d"]],
        board: ["Ah", "7c", "2s", "Td", "4h"],
        actions: [[0, "call"]]
      });
      return { table: toPublicTable({ players, engineState: st, selfSeat: 1, remainingSeconds: 22 }), self: 1, st };
    }

    case "timer-low": {
      const players = [P(0, "Alex", 1000), P(1, "Sam", 1000)];
      const st = play({ players, dealer: 0, holes: [["Th", "Td"], ["Ac", "5s"]], board: ["2d", "9s", "Kh", "4c", "7d"], actions: [] });
      return { table: toPublicTable({ players, engineState: st, selfSeat: 0, remainingSeconds: 5 }), self: 0, st };
    }

    default:
      return null;
  }
}

/**
 * Returns `{ table, holeCards }` for a state name (or null if unknown).
 * `holeCards` is the self seat's two private cards, delivered the way `fetchOwnHoleCards` returns them.
 */
export function getMockState(name) {
  const built = build(name);
  if (!built) return null;
  const selfEngine = built.st?.seats.find((s) => s.seat === built.self);
  return {
    table: built.table,
    holeCards: selfEngine && built.table.hand ? [...selfEngine.holeCards] : null
  };
}


/**
 * Steps of one realistic hand for the animated demo (`?state=demo-hand`), produced by the real engine.
 * Each step is `{ label, table, holeCards }`; the harness shows them one after another so the deal, bet, fold,
 * street change and showdown motion can be reviewed without a server.
 */
export function getDemoSteps() {
  const four = [P(0, "Alex", 1000), P(1, "Sam", 1000), P(2, "Kim", 1000), P(3, "Jo", 1000)];
  const two = [P(0, "Alex", 1000), P(1, "Sam", 1000)];
  const steps = [{ label: "Waiting", table: toPublicTable({ players: four, engineState: null, selfSeat: 0 }), holeCards: null }];

  // One hand through the real engine; every state becomes a step. The first step of a hand has `first: true` and `handName`.
  const hand = ({ name, players, dealer, holes, board, script, handNo }) => {
    let st = newHand(
      players.map((p) => ({ seat: p.seat, id: p.id, name: p.name, stack: p.stack, status: "active" })),
      dealer,
      { sb: 10, bb: 20 },
      fixedDeck(holes, board)
    );
    const push = (label, first = false) => {
      const mine = st.seats.find((s) => s.seat === 0);
      steps.push({
        label: `${name}: ${label}`,
        handName: name,
        first,
        table: toPublicTable({ players, engineState: st, selfSeat: 0, remainingSeconds: 24, handNo }),
        holeCards: [...mine.holeCards]
      });
    };
    push("deal, blinds posted", true);
    for (const [seat, action, label] of script) {
      st = apply(st, seat, action);
      push(label);
    }
  };

  // 1. Showdown win by the player (pair of aces over a pair of kings)
  hand({
    name: "Showdown win",
    players: four,
    dealer: 3,
    handNo: 7,
    holes: [["As", "Ah"], ["8c", "8d"], ["Kd", "Qd"], ["5c", "3c"]],
    board: ["Kh", "7d", "2c", "9s", "4h"],
    script: [
      [2, { type: "raise", amount: 60 }, "Kim raises to 60"],
      [3, "fold", "Jo folds"],
      [0, "call", "Alex calls"],
      [1, "call", "Sam calls, flop"],
      [0, "check", "Alex checks"],
      [1, "check", "Sam checks"],
      [2, { type: "raise", amount: 100 }, "Kim bets 100"],
      [0, "call", "Alex calls"],
      [1, "fold", "Sam folds, turn"],
      [0, "check", "Alex checks"],
      [2, "check", "Kim checks, river"],
      [0, { type: "raise", amount: 200 }, "Alex bets 200"],
      [2, "call", "Kim calls, showdown"]
    ]
  });

  // 2. Fold-out win (Sam wins without a showdown)
  hand({
    name: "Fold-out win",
    players: four,
    dealer: 0,
    handNo: 8,
    holes: [["Qs", "7d"], ["Kc", "Kd"], ["9h", "4c"], ["Jd", "2s"]],
    board: ["3h", "8d", "Tc", "5s", "Ah"],
    script: [
      [3, "fold", "Jo folds"],
      [0, "fold", "Alex folds"],
      [1, { type: "raise", amount: 60 }, "Sam raises to 60"],
      [2, "call", "Kim calls, flop"],
      [1, { type: "raise", amount: 40 }, "Sam bets 40"],
      [2, "fold", "Kim folds, Sam wins"]
    ]
  });

  // 3. Split pot (the board plays for Alex and Sam)
  hand({
    name: "Split pot",
    players: four,
    dealer: 3,
    handNo: 9,
    holes: [["2c", "3d"], ["2h", "3s"], ["9c", "8c"], ["4d", "4h"]],
    board: ["As", "Ks", "Qh", "Jd", "Tc"],
    script: [
      [2, "call", "Kim calls"],
      [3, "fold", "Jo folds"],
      [0, "call", "Alex calls"],
      [1, "check", "Sam checks, flop"],
      [0, "check", "Alex checks"],
      [1, { type: "raise", amount: 40 }, "Sam bets 40"],
      [2, "fold", "Kim folds"],
      [0, "call", "Alex calls, turn"],
      [0, "check", "Alex checks"],
      [1, "check", "Sam checks, river"],
      [0, "check", "Alex checks"],
      [1, "check", "Sam checks, showdown"]
    ]
  });

  // 4. Big pot: both all-in before the flop, Alex's aces hold up
  hand({
    name: "Big pot",
    players: two,
    dealer: 0,
    handNo: 10,
    holes: [["Ac", "Ad"], ["Kc", "Kd"]],
    board: ["7d", "8c", "2s", "Jh", "4d"],
    script: [
      [0, "all-in", "Alex all-in"],
      [1, "call", "Sam calls, run-out"]
    ]
  });

  // 5. An opponent wins at showdown (no jingle for the player)
  hand({
    name: "Opponent wins",
    players: two,
    dealer: 0,
    handNo: 11,
    holes: [["7c", "2d"], ["As", "Ks"]],
    board: ["Qs", "9s", "4s", "3h", "Jd"],
    script: [
      [0, "call", "Alex calls"],
      [1, "check", "Sam checks, flop"],
      [1, { type: "raise", amount: 40 }, "Sam bets 40"],
      [0, "call", "Alex calls, turn"],
      [1, "check", "Sam checks"],
      [0, "check", "Alex checks, river"],
      [1, "check", "Sam checks"],
      [0, "check", "Alex checks, showdown"]
    ]
  });
  return steps;
}
