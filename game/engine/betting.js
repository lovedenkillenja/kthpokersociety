// No-Limit Texas Hold'em hand state machine:
// `newHand`, `legalActions`, `apply`, `showdown`, `publicView`, and `checkChipConservation`.

import { createDeck, shuffleDeck, cryptoRng } from "./cards.js";
import {
  getClockwiseOrderFromLeftOfButton,
  computeSidePots,
  settleFoldOutState,
  resolveShowdownState
} from "./pots.js";

const STREETS = Object.freeze(["preflop", "flop", "turn", "river", "showdown"]);

function makeError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function normalizeBlinds(blinds) {
  if (Array.isArray(blinds) && blinds.length >= 2) {
    return { sb: Math.trunc(Number(blinds[0])), bb: Math.trunc(Number(blinds[1])) };
  }
  const sb = Math.trunc(Number(blinds?.sb ?? blinds?.smallBlind ?? 10));
  const bb = Math.trunc(Number(blinds?.bb ?? blinds?.bigBlind ?? 20));
  if (!Number.isFinite(sb) || !Number.isFinite(bb) || sb <= 0 || bb < sb) {
    throw makeError("ERR_INVALID_BLINDS", "Blinds must be positive integers with bb >= sb.");
  }
  return { sb, bb };
}

function normalizeSeats(seats) {
  if (!Array.isArray(seats)) {
    throw makeError("ERR_INVALID_SEATS", "seats must be an array.");
  }
  const active = seats
    .map((s, idx) => {
      const seatNo = Number(s?.seat ?? s?.seat_no ?? s?.seatNo ?? idx);
      const stack = Math.trunc(Number(s?.stack ?? 0));
      const status = String(s?.status ?? "active").toLowerCase();
      return {
        seat: seatNo,
        id: s?.id ?? s?.member_id ?? s?.memberId ?? `seat-${seatNo}`,
        name: s?.display_name ?? s?.name ?? `Seat ${seatNo}`,
        stack,
        status
      };
    })
    .filter((s) => s.status === "active" && s.stack > 0)
    .sort((a, b) => a.seat - b.seat);

  if (active.length < 2) {
    throw makeError("ERR_NOT_ENOUGH_PLAYERS", "At least 2 active players with chips are required.");
  }
  return active;
}

function cloneState(state) {
  return {
    ...state,
    blinds: { ...state.blinds },
    board: [...state.board],
    deck: [...state.deck],
    seats: state.seats.map((p) => ({
      ...p,
      holeCards: [...p.holeCards]
    })),
    pots: state.pots ? state.pots.map((pot) => ({ ...pot, eligibleSeats: [...pot.eligibleSeats], contributors: [...pot.contributors] })) : [],
    actions: [...state.actions],
    payouts: state.payouts ? { ...state.payouts } : {},
    winners: state.winners ? [...state.winners] : [],
    uncalledReturned: state.uncalledReturned ? { ...state.uncalledReturned } : null,
    showdownResult: state.showdownResult ? structuredClone(state.showdownResult) : null
  };
}

/**
 * Finds the next player clockwise after `fromSeat` who is neither folded nor all-in
 * and still needs to act in the current betting round.
 */
function findNextActingSeat(seats, fromSeat) {
  const allSeatNos = seats.map((s) => s.seat);
  const clockwise = getClockwiseOrderFromLeftOfButton(allSeatNos, fromSeat);
  const bySeat = new Map(seats.map((s) => [s.seat, s]));

  for (const seatNo of clockwise) {
    const p = bySeat.get(seatNo);
    if (!p.folded && !p.allIn) {
      return seatNo;
    }
  }
  return null;
}

/**
 * Determines whether the current street's betting is finished.
 */
function isStreetBettingComplete(state) {
  const nonFolded = state.seats.filter((p) => !p.folded);
  if (nonFolded.length <= 1) return true;

  const canAct = nonFolded.filter((p) => !p.allIn);
  if (canAct.length === 0) return true;
  if (canAct.length === 1 && canAct[0].bet >= state.currentBet) return true;

  // Every player who still has chips must have acted and matched currentBet
  return canAct.every((p) => p.acted && p.bet === state.currentBet);
}

/**
 * Starts a new No-Limit Hold'em hand.
 */
export function newHand(seats, dealer = 0, blinds = { sb: 10, bb: 20 }, rng = cryptoRng) {
  const activeSeats = normalizeSeats(seats);
  const cleanBlinds = normalizeBlinds(blinds);
  const seatNumbers = activeSeats.map((s) => s.seat);

  // Resolve dealer seat: exact match if active, otherwise next active seat clockwise
  const dealerSeat = seatNumbers.includes(dealer)
    ? dealer
    : getClockwiseOrderFromLeftOfButton(seatNumbers, dealer)[0];

  const clockwiseFromLeft = getClockwiseOrderFromLeftOfButton(seatNumbers, dealerSeat);
  const isHeadsUp = activeSeats.length === 2;

  // Heads-up rule: dealer posts small blind and acts first preflop;
  // 3+ players: first left of dealer posts SB, second left posts BB, third left (UTG) acts first preflop.
  const sbSeat = isHeadsUp ? dealerSeat : clockwiseFromLeft[0];
  const bbSeat = isHeadsUp ? clockwiseFromLeft[0] : clockwiseFromLeft[1];

  const deck = shuffleDeck(createDeck(), rng);
  let deckCursor = 0;

  const initialTotalChips = activeSeats.reduce((sum, s) => sum + s.stack, 0);

  const playerStates = activeSeats.map((s) => {
    const holeCards = [deck[deckCursor], deck[deckCursor + 1]];
    deckCursor += 2;
    return {
      seat: s.seat,
      id: s.id,
      name: s.name,
      initialStack: s.stack,
      stack: s.stack,
      bet: 0,
      totalCommitted: 0,
      folded: false,
      allIn: false,
      acted: false,
      actedSinceFullRaise: false,
      holeCards
    };
  });

  const bySeat = new Map(playerStates.map((p) => [p.seat, p]));

  // Post Small Blind
  const sbPlayer = bySeat.get(sbSeat);
  const sbPosted = Math.min(sbPlayer.stack, cleanBlinds.sb);
  sbPlayer.stack -= sbPosted;
  sbPlayer.bet = sbPosted;
  sbPlayer.totalCommitted = sbPosted;
  if (sbPlayer.stack === 0) sbPlayer.allIn = true;

  // Post Big Blind
  const bbPlayer = bySeat.get(bbSeat);
  const bbPosted = Math.min(bbPlayer.stack, cleanBlinds.bb);
  bbPlayer.stack -= bbPosted;
  bbPlayer.bet = bbPosted;
  bbPlayer.totalCommitted = bbPosted;
  if (bbPlayer.stack === 0) bbPlayer.allIn = true;

  // In heads-up, if BB is all-in for less than bb, SB only needs to match Math.max(sbPosted, bbPosted).
  // In 3+ players, the opening bet level to call is the full big blind (or max posted).
  const currentBet = isHeadsUp
    ? Math.max(sbPosted, bbPosted)
    : Math.max(cleanBlinds.bb, sbPosted, bbPosted);

  // Determine first player to act preflop
  // Heads-up: dealer (sbSeat) acts first; 3+ players: first active seat clockwise after bbSeat
  const preflopStartAnchor = isHeadsUp ? bbSeat : bbSeat;
  const actingSeat = findNextActingSeat(playerStates, preflopStartAnchor);

  const state = {
    status: "playing",
    street: "preflop",
    dealerSeat,
    sbSeat,
    bbSeat,
    blinds: cleanBlinds,
    board: [],
    deck,
    deckCursor,
    seats: playerStates,
    pot: sbPosted + bbPosted,
    pots: computeSidePots(playerStates).pots,
    currentBet,
    lastRaiseSize: cleanBlinds.bb,
    actingSeat,
    initialTotalChips,
    actions: [
      { street: "preflop", seat: sbSeat, type: "post-sb", amount: sbPosted },
      { street: "preflop", seat: bbSeat, type: "post-bb", amount: bbPosted }
    ],
    payouts: {},
    winners: [],
    uncalledReturned: null,
    showdownResult: null
  };

  // Edge case: if all players (or all but one who already covers) are all-in from the blinds
  const canActCount = state.seats.filter((p) => !p.folded && !p.allIn).length;
  if (canActCount === 0 || (canActCount === 1 && isStreetBettingComplete(state))) {
    return advanceStreetsOrSettle(state);
  }

  return state;
}

/**
 * Returns the legal actions for `seat` in the given `state`.
 */
export function legalActions(state, seat) {
  if (!state || state.status !== "playing" || state.actingSeat !== seat) {
    return {
      canFold: false,
      canCheck: false,
      canCall: false,
      callAmount: 0,
      canRaise: false,
      minRaiseTo: null,
      maxRaiseTo: null,
      actions: []
    };
  }

  const player = state.seats.find((p) => p.seat === seat);
  if (!player || player.folded || player.allIn) {
    return {
      canFold: false,
      canCheck: false,
      canCall: false,
      callAmount: 0,
      canRaise: false,
      minRaiseTo: null,
      maxRaiseTo: null,
      actions: []
    };
  }

  const toCall = Math.max(0, state.currentBet - player.bet);
  const callAmount = Math.min(player.stack, toCall);
  const canFold = true;
  const canCheck = toCall === 0;
  const canCall = toCall > 0;

  const maxRaiseTo = player.bet + player.stack;
  const canRaise =
    maxRaiseTo > state.currentBet &&
    !player.actedSinceFullRaise;

  let minRaiseTo = null;
  if (canRaise) {
    const fullMinRaiseTo =
      state.currentBet === 0
        ? state.blinds.bb
        : state.currentBet + state.lastRaiseSize;
    minRaiseTo = Math.min(fullMinRaiseTo, maxRaiseTo);
  }

  const actions = ["fold"];
  if (canCheck) actions.push("check");
  if (canCall) actions.push("call");
  if (canRaise) actions.push("raise");
  if (player.stack > 0 && (canCall || canRaise)) actions.push("all-in");

  return {
    canFold,
    canCheck,
    canCall,
    callAmount,
    canRaise,
    minRaiseTo,
    maxRaiseTo: canRaise ? maxRaiseTo : null,
    actions
  };
}

/**
 * Deals the next community card(s) and advances the street, or resolves the hand if complete.
 */
function advanceStreetsOrSettle(state) {
  const nonFolded = state.seats.filter((p) => !p.folded);

  // 1. Fold-out: only 1 non-folded player remains
  if (nonFolded.length === 1) {
    return settleFoldOutState(state, nonFolded[0]);
  }

  // 2. Check if further betting is possible on future streets
  const canStillBet = nonFolded.filter((p) => !p.allIn);
  if (canStillBet.length <= 1) {
    // Run out remaining community cards up to 5 and go to showdown
    while (state.board.length < 5) {
      if (state.board.length === 0) {
        state.board.push(
          state.deck[state.deckCursor],
          state.deck[state.deckCursor + 1],
          state.deck[state.deckCursor + 2]
        );
        state.deckCursor += 3;
      } else {
        state.board.push(state.deck[state.deckCursor]);
        state.deckCursor += 1;
      }
    }
    state.street = "showdown";
    state.actingSeat = null;
    return showdown(state);
  }

  // 3. Advance to next street with normal betting
  if (state.street === "preflop") {
    state.board.push(
      state.deck[state.deckCursor],
      state.deck[state.deckCursor + 1],
      state.deck[state.deckCursor + 2]
    );
    state.deckCursor += 3;
    state.street = "flop";
  } else if (state.street === "flop") {
    state.board.push(state.deck[state.deckCursor]);
    state.deckCursor += 1;
    state.street = "turn";
  } else if (state.street === "turn") {
    state.board.push(state.deck[state.deckCursor]);
    state.deckCursor += 1;
    state.street = "river";
  } else if (state.street === "river") {
    state.street = "showdown";
    state.actingSeat = null;
    return showdown(state);
  }

  // Reset per-street betting state for the new street
  for (const p of state.seats) {
    p.bet = 0;
    p.acted = false;
    p.actedSinceFullRaise = false;
  }
  state.currentBet = 0;
  state.lastRaiseSize = state.blinds.bb;
  // Postflop: first active player clockwise left of dealer acts first
  state.actingSeat = findNextActingSeat(state.seats, state.dealerSeat);

  return state;
}

/**
 * Applies a player action (`fold`, `check`, `call`, `raise`/`bet`, `all-in`) and returns the new state.
 */
export function apply(inputState, seat, rawAction) {
  if (!inputState || inputState.status !== "playing") {
    throw makeError("ERR_HAND_NOT_ACTIVE", "Hand is already complete.");
  }
  if (inputState.actingSeat !== seat) {
    throw makeError("ERR_NOT_YOUR_TURN", `It is seat ${inputState.actingSeat}'s turn, not seat ${seat}.`);
  }

  const state = cloneState(inputState);
  const player = state.seats.find((p) => p.seat === seat);
  const legal = legalActions(state, seat);

  const actionObj = typeof rawAction === "string" ? { type: rawAction } : rawAction || {};
  const type = String(actionObj.type || actionObj.intent || "").toLowerCase().trim();

  if (type === "timeout" || type === "timeout-fold") {
    // A timeout checks when checking is free, unless the caller forces a fold (`{ type: "timeout", fold: true }`,
    // used when the timed-out seat is, or is now being, sat out). A timed-out check is logged as a plain
    // `check` (flagged `timeout: true`); only a real fold is logged as `timeout-fold`.
    const forceFold = actionObj.fold === true;
    if (legal.canCheck && !forceFold) {
      player.acted = true;
      player.actedSinceFullRaise = true;
      state.actions.push({
        street: state.street,
        seat,
        type: "check",
        amount: 0,
        timeout: true
      });
    } else {
      player.folded = true;
      player.acted = true;
      player.actedSinceFullRaise = true;
      state.actions.push({
        street: state.street,
        seat,
        type: "timeout-fold",
        amount: 0,
        timeout: true
      });
    }
  } else if (type === "fold") {
    player.folded = true;
    player.acted = true;
    player.actedSinceFullRaise = true;
    state.actions.push({ street: state.street, seat, type: "fold", amount: 0 });
  } else if (type === "check") {
    if (!legal.canCheck) {
      throw makeError("ERR_ILLEGAL_ACTION", "Cannot check when facing a bet.");
    }
    player.acted = true;
    player.actedSinceFullRaise = true;
    state.actions.push({ street: state.street, seat, type: "check", amount: 0 });
  } else if (type === "call") {
    if (!legal.canCall) {
      throw makeError("ERR_ILLEGAL_ACTION", "Nothing to call; use check instead.");
    }
    const added = legal.callAmount;
    player.stack -= added;
    player.bet += added;
    player.totalCommitted += added;
    player.acted = true;
    player.actedSinceFullRaise = true;
    if (player.stack === 0) player.allIn = true;
    state.actions.push({ street: state.street, seat, type: "call", amount: added });
  } else if (type === "raise" || type === "bet" || type === "all-in" || type === "allin") {
    let targetBet;
    if (type === "all-in" || type === "allin") {
      if (player.stack <= 0) {
        throw makeError("ERR_ILLEGAL_ACTION", "No chips left to go all-in.");
      }
      targetBet = player.bet + player.stack;
      // If all-in does not exceed currentBet, treat as an all-in call
      if (targetBet <= state.currentBet) {
        if (!legal.canCall) {
          throw makeError("ERR_ILLEGAL_ACTION", "Cannot go all-in here.");
        }
        const added = player.stack;
        player.stack = 0;
        player.bet += added;
        player.totalCommitted += added;
        player.allIn = true;
        player.acted = true;
        player.actedSinceFullRaise = true;
        state.actions.push({ street: state.street, seat, type: "call", amount: added, allIn: true });
      }
    } else {
      targetBet = Math.trunc(Number(actionObj.amount));
    }

    // Handle raise above currentBet
    if (targetBet > state.currentBet || (type !== "all-in" && type !== "allin")) {
      if (!legal.canRaise) {
        throw makeError("ERR_ILLEGAL_ACTION", "Raising is not allowed in this spot.");
      }
      if (
        !Number.isFinite(targetBet) ||
        targetBet < legal.minRaiseTo ||
        targetBet > legal.maxRaiseTo
      ) {
        throw makeError(
          "ERR_INVALID_RAISE_AMOUNT",
          `Raise target must be between ${legal.minRaiseTo} and ${legal.maxRaiseTo} (received ${actionObj.amount}).`
        );
      }

      const added = targetBet - player.bet;
      const raiseIncrement = targetBet - state.currentBet;
      const isFullRaise = raiseIncrement >= state.lastRaiseSize;

      player.stack -= added;
      player.bet = targetBet;
      player.totalCommitted += added;
      player.acted = true;
      player.actedSinceFullRaise = true;
      if (player.stack === 0) player.allIn = true;

      if (isFullRaise) {
        state.lastRaiseSize = raiseIncrement;
        // Full raise reopens betting for all other non-folded, non-all-in players
        for (const other of state.seats) {
          if (other.seat !== seat && !other.folded && !other.allIn) {
            other.acted = false;
            other.actedSinceFullRaise = false;
          }
        }
      } else {
        // Short all-in raise: players who haven't acted yet still need to match the new bet,
        // and players whose bet is now < targetBet must act (call/fold only if actedSinceFullRaise is true).
        for (const other of state.seats) {
          if (other.seat !== seat && !other.folded && !other.allIn && other.bet < targetBet) {
            other.acted = false;
          }
        }
      }

      state.currentBet = targetBet;
      state.actions.push({
        street: state.street,
        seat,
        type: "raise",
        amount: targetBet,
        added,
        allIn: player.allIn
      });
    }
  } else {
    throw makeError("ERR_UNKNOWN_ACTION", `Unknown action type "${type}".`);
  }

  // Update total pot and side pots snapshot
  state.pot = state.seats.reduce((sum, p) => sum + p.totalCommitted, 0);
  state.pots = computeSidePots(state.seats).pots;

  // Check if street betting is complete or if only 1 player remains
  if (isStreetBettingComplete(state)) {
    return advanceStreetsOrSettle(state);
  }

  // Advance turn to next active player clockwise
  state.actingSeat = findNextActingSeat(state.seats, seat);
  return state;
}

/**
 * Evaluates showdown hands, resolves main pot and all side pots, splits ties,
 * awards odd chips to the first winner clockwise left of the dealer button,
 * and returns any uncalled bet. Idempotent if called on an already settled state.
 */
export function showdown(inputState) {
  if (!inputState) {
    throw makeError("ERR_INVALID_STATE", "showdown requires a hand state.");
  }
  if (inputState.status === "complete" && inputState.showdownResult) {
    return cloneState(inputState);
  }
  return resolveShowdownState(cloneState(inputState));
}

/**
 * Strips server-only fields (`deck`, `deckCursor`, and unrevealed `holeCards`)
 * so the returned object is safe to broadcast to all clients.
 */
export function publicView(state) {
  const isShowdownDone = state.status === "complete" && Boolean(state.showdownResult);
  return {
    status: state.status,
    street: state.street,
    dealerSeat: state.dealerSeat,
    sbSeat: state.sbSeat,
    bbSeat: state.bbSeat,
    blinds: { ...state.blinds },
    board: [...state.board],
    pot: state.pot,
    pots: state.pots,
    currentBet: state.currentBet,
    lastRaiseSize: state.lastRaiseSize,
    actingSeat: state.actingSeat,
    seats: state.seats.map((p) => ({
      seat: p.seat,
      id: p.id,
      name: p.name,
      stack: p.stack,
      bet: p.bet,
      totalCommitted: p.totalCommitted,
      folded: p.folded,
      allIn: p.allIn,
      holeCards: isShowdownDone && !p.folded ? [...p.holeCards] : null
    })),
    payouts: { ...state.payouts },
    winners: [...state.winners],
    uncalledReturned: state.uncalledReturned ? { ...state.uncalledReturned } : null,
    showdownResult: state.showdownResult
  };
}

/**
 * Verifies the chip conservation invariant:
 * - While playing: sum(seat.stack + seat.totalCommitted) === expectedTotal
 * - When complete: sum(seat.stack) === expectedTotal
 */
export function checkChipConservation(state, expectedTotal = state.initialTotalChips) {
  const stackSum = state.seats.reduce((sum, p) => sum + p.stack, 0);
  const inPot =
    state.status === "complete"
      ? 0
      : state.seats.reduce((sum, p) => sum + p.totalCommitted, 0);
  const actualTotal = stackSum + inPot;
  return {
    conserved: actualTotal === expectedTotal,
    actualTotal,
    expectedTotal,
    delta: actualTotal - expectedTotal
  };
}
