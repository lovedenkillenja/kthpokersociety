// Pot, side-pot, uncalled-bet, odd-chip split, and showdown settlement for No-Limit Hold'em.

import { evaluate } from "./evaluator.js";

/**
 * Returns `allSeats` rotated clockwise starting with the first seat strictly left of `dealerSeat`.
 * Assumes seat numbers increase clockwise around the table.
 */
export function getClockwiseOrderFromLeftOfButton(allSeats, dealerSeat) {
  const sorted = [...new Set(allSeats)].sort((a, b) => a - b);
  if (sorted.length === 0) return [];
  const afterDealer = sorted.filter((s) => s > dealerSeat);
  const upToDealer = sorted.filter((s) => s <= dealerSeat);
  return [...afterDealer, ...upToDealer];
}

/**
 * Orders a subset of `candidateSeats` in clockwise order starting left of `dealerSeat`.
 */
export function orderSeatsLeftOfDealer(candidateSeats, dealerSeat, allSeats = candidateSeats) {
  const clockwise = getClockwiseOrderFromLeftOfButton(allSeats, dealerSeat);
  const candidateSet = new Set(candidateSeats);
  return clockwise.filter((s) => candidateSet.has(s));
}

/**
 * Computes main pot, side pots, and any uncalled bet from player commitments.
 *
 * Each element of `players` must have:
 *   - `seat`: number
 *   - `totalCommitted`: integer >= 0
 *   - `folded`: boolean
 *
 * Returns:
 *   - `pots`: Array of `{ index, name, amount, eligibleSeats, contributors }`
 *   - `uncalled`: `{ seat, amount }` or `null`
 *   - `totalContested`: sum of all `pots[i].amount`
 *   - `totalCommitted`: sum of all players' `totalCommitted`
 */
export function computeSidePots(players) {
  const cleanPlayers = players.map((p) => ({
    seat: p.seat,
    totalCommitted: Math.max(0, Math.trunc(Number(p.totalCommitted || 0))),
    folded: Boolean(p.folded)
  }));

  const totalCommitted = cleanPlayers.reduce((sum, p) => sum + p.totalCommitted, 0);
  const allNonFoldedSeats = cleanPlayers
    .filter((p) => !p.folded)
    .map((p) => p.seat)
    .sort((a, b) => a - b);

  // Distinct positive commitment levels in ascending order
  const levels = [...new Set(cleanPlayers.map((p) => p.totalCommitted).filter((v) => v > 0))].sort(
    (a, b) => a - b
  );

  const rawSlices = [];
  let uncalled = null;
  let prevLevel = 0;

  for (const level of levels) {
    const delta = level - prevLevel;
    const contributors = cleanPlayers
      .filter((p) => p.totalCommitted >= level)
      .map((p) => p.seat)
      .sort((a, b) => a - b);

    const eligibleSeats = cleanPlayers
      .filter((p) => p.totalCommitted >= level && !p.folded)
      .map((p) => p.seat)
      .sort((a, b) => a - b);

    const sliceAmount = delta * contributors.length;

    if (contributors.length === 1 && eligibleSeats.length === 1) {
      // Only a single non-folded player committed chips in this tier: uncalled bet
      const soleSeat = contributors[0];
      if (uncalled && uncalled.seat === soleSeat) {
        uncalled.amount += sliceAmount;
      } else {
        uncalled = { seat: soleSeat, amount: sliceAmount };
      }
    } else if (sliceAmount > 0) {
      rawSlices.push({
        amount: sliceAmount,
        eligibleSeats: eligibleSeats.length > 0 ? eligibleSeats : allNonFoldedSeats,
        contributors
      });
    }

    prevLevel = level;
  }

  // Merge adjacent contested slices that have the exact same set of eligible non-folded seats
  // (e.g., when an intermediate commitment level belonged to a player who folded).
  const mergedPots = [];
  for (const slice of rawSlices) {
    const key = slice.eligibleSeats.join(",");
    const prev = mergedPots[mergedPots.length - 1];
    if (prev && prev._key === key) {
      prev.amount += slice.amount;
      prev.contributors = [...new Set([...prev.contributors, ...slice.contributors])].sort(
        (a, b) => a - b
      );
    } else {
      mergedPots.push({
        _key: key,
        amount: slice.amount,
        eligibleSeats: slice.eligibleSeats,
        contributors: slice.contributors
      });
    }
  }

  const pots = mergedPots.map((p, idx) => ({
    index: idx,
    name: idx === 0 ? "Main Pot" : `Side Pot ${idx}`,
    amount: p.amount,
    eligibleSeats: p.eligibleSeats,
    contributors: p.contributors
  }));

  const totalContested = pots.reduce((sum, p) => sum + p.amount, 0);

  return {
    pots,
    uncalled,
    totalContested,
    totalCommitted
  };
}

/**
 * Splits `potAmount` among `winningSeats`, awarding any odd chip(s) (`potAmount % k`)
 * to the first winning seat(s) clockwise left of `dealerSeat`.
 */
export function distributePotToWinners(
  potAmount,
  winningSeats,
  dealerSeat,
  allSeats = winningSeats
) {
  if (!Array.isArray(winningSeats) || winningSeats.length === 0) {
    throw new Error("distributePotToWinners requires at least one winning seat.");
  }

  const orderedWinners = orderSeatsLeftOfDealer(winningSeats, dealerSeat, allSeats);
  const count = orderedWinners.length;
  const baseShare = Math.floor(potAmount / count);
  const oddChips = potAmount % count;

  const payouts = {};
  const oddChipSeats = [];

  orderedWinners.forEach((seat, idx) => {
    const getsOddChip = idx < oddChips;
    if (getsOddChip) {
      oddChipSeats.push(seat);
    }
    payouts[seat] = baseShare + (getsOddChip ? 1 : 0);
  });

  return {
    payouts,
    baseShare,
    oddChips,
    oddChipSeats,
    orderedWinners
  };
}

/**
 * Settles a hand won by fold-out (when all other players fold).
 * Returns any uncalled bet to the winner and awards the contested pot.
 */
export function settleFoldOutState(state, winner) {
  const sidePotInfo = computeSidePots(state.seats);

  if (sidePotInfo.uncalled && sidePotInfo.uncalled.amount > 0) {
    const uncalledPlayer = state.seats.find((p) => p.seat === sidePotInfo.uncalled.seat);
    uncalledPlayer.stack += sidePotInfo.uncalled.amount;
    uncalledPlayer.totalCommitted -= sidePotInfo.uncalled.amount;
    state.uncalledReturned = { ...sidePotInfo.uncalled };
  }

  const contestedPot = sidePotInfo.totalContested;
  winner.stack += contestedPot;

  state.pot = contestedPot;
  state.pots = sidePotInfo.pots;
  state.payouts = { [winner.seat]: contestedPot };
  state.winners = [winner.seat];
  state.actingSeat = null;
  state.status = "complete";
  state.street = "complete";

  return state;
}

/**
 * Resolves showdown on a cloned hand state: deals any missing community cards up to 5,
 * returns uncalled bets, evaluates 7-card hands, distributes main and side pots,
 * and awards odd chips to the first tied winner clockwise left of the dealer button.
 */
export function resolveShowdownState(state) {
  while (state.board.length < 5) {
    state.board.push(state.deck[state.deckCursor]);
    state.deckCursor += 1;
  }

  const sidePotInfo = computeSidePots(state.seats);

  if (sidePotInfo.uncalled && sidePotInfo.uncalled.amount > 0) {
    const uncalledPlayer = state.seats.find((p) => p.seat === sidePotInfo.uncalled.seat);
    uncalledPlayer.stack += sidePotInfo.uncalled.amount;
    uncalledPlayer.totalCommitted -= sidePotInfo.uncalled.amount;
    state.uncalledReturned = { ...sidePotInfo.uncalled };
  }

  const handEvaluations = {};
  for (const player of state.seats) {
    if (!player.folded) {
      handEvaluations[player.seat] = evaluate([...player.holeCards, ...state.board]);
    }
  }

  const allSeatNumbers = state.seats.map((p) => p.seat);
  const payouts = {};
  const potResults = [];
  const allWinnerSeats = new Set();
  const oddChipWinners = [];

  for (const pot of sidePotInfo.pots) {
    const eligible = pot.eligibleSeats.filter((s) => handEvaluations[s]);
    let bestScore = -1;
    for (const seatNo of eligible) {
      if (handEvaluations[seatNo].score > bestScore) {
        bestScore = handEvaluations[seatNo].score;
      }
    }

    const potWinners = eligible.filter((seatNo) => handEvaluations[seatNo].score === bestScore);
    const dist = distributePotToWinners(pot.amount, potWinners, state.dealerSeat, allSeatNumbers);

    for (const [seatKey, chipShare] of Object.entries(dist.payouts)) {
      const seatNo = Number(seatKey);
      payouts[seatNo] = (payouts[seatNo] || 0) + chipShare;
      if (chipShare > 0) allWinnerSeats.add(seatNo);
    }

    if (dist.oddChipSeats.length > 0) {
      oddChipWinners.push(...dist.oddChipSeats);
    }

    potResults.push({
      index: pot.index,
      name: pot.name,
      amount: pot.amount,
      eligibleSeats: pot.eligibleSeats,
      winners: dist.orderedWinners,
      payouts: dist.payouts,
      oddChipSeats: dist.oddChipSeats,
      winningHandName: handEvaluations[potWinners[0]]?.name || ""
    });
  }

  for (const player of state.seats) {
    player.stack += payouts[player.seat] || 0;
  }

  state.pot = sidePotInfo.totalContested;
  state.pots = potResults;
  state.payouts = payouts;
  state.winners = [...allWinnerSeats].sort((a, b) => a - b);
  state.actingSeat = null;
  state.status = "complete";
  state.street = "complete";
  state.showdownResult = {
    pots: potResults,
    payouts,
    winners: state.winners,
    hands: handEvaluations,
    uncalledReturned: state.uncalledReturned,
    oddChipWinners
  };

  return state;
}
