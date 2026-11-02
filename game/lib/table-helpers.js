// Pure helper functions for M4 table UI state normalization, raise presets, and status copy.
// Dependency-free so it runs in both the browser and `node --test`.

import { formatChips } from "./format.js";

const ROOM_CODE_REGEX = /^[A-Z0-9]{5}$/;

/**
 * Normalizes and validates a 5-character room code.
 */
export function normalizeRoomCode(raw) {
  const cleaned = String(raw ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 5);

  if (!ROOM_CODE_REGEX.test(cleaned)) {
    return {
      valid: false,
      value: cleaned,
      error: "Enter a 5-character table code (letters and numbers, e.g. KTH26)."
    };
  }
  return { valid: true, value: cleaned, error: "" };
}

/**
 * Validates a chip buy-in amount against table bounds and member balance.
 */
export function validateBuyIn(rawAmount, { minBuyIn = 400, maxBuyIn = 2000, balance = 0 } = {}) {
  const num = Number(rawAmount);
  if (!Number.isFinite(num) || !Number.isInteger(num)) {
    return { valid: false, value: 0, error: "Enter a whole number of chips." };
  }
  if (num < minBuyIn || num > maxBuyIn) {
    return {
      valid: false,
      value: num,
      error: `Buy-in must be between ${formatChips(minBuyIn)} and ${formatChips(maxBuyIn)} chips.`
    };
  }
  if (num > balance) {
    return {
      valid: false,
      value: num,
      error: `You have ${formatChips(balance)} chips available. Claim daily chips or lower your buy-in.`
    };
  }
  return { valid: true, value: num, error: "" };
}

/**
 * Ensures `isSelf` is preserved when a public state payload arrives over a shared Realtime broadcast
 * (where `callerMemberId` was null on the server).
 */
export function normalizeIncomingTableState(
  incomingTable,
  { knownSelfSeatNo = null, currentDisplayName = "" } = {}
) {
  if (!incomingTable || typeof incomingTable !== "object") return null;

  const rawSeats = Array.isArray(incomingTable.seats) ? incomingTable.seats : [];
  let resolvedSelfSeatNo = null;

  const explicitSelf = rawSeats.find((s) => s && s.isSelf === true);
  if (explicitSelf) {
    resolvedSelfSeatNo = explicitSelf.seatNo;
  } else if (
    knownSelfSeatNo !== null &&
    knownSelfSeatNo !== undefined &&
    rawSeats.some((s) => s && s.seatNo === knownSelfSeatNo)
  ) {
    resolvedSelfSeatNo = knownSelfSeatNo;
  } else if (currentDisplayName) {
    const byName = rawSeats.filter((s) => s && s.displayName === currentDisplayName);
    if (byName.length === 1) {
      resolvedSelfSeatNo = byName[0].seatNo;
    }
  }

  const seats = rawSeats.map((s) => ({
    ...s,
    isSelf: resolvedSelfSeatNo !== null && s.seatNo === resolvedSelfSeatNo
  }));

  return {
    ...incomingTable,
    selfSeatNo: resolvedSelfSeatNo,
    seats
  };
}

/**
 * Splits table seats into `{ selfSeat, opponentSeat, opponentSeats, otherSeats }` so the player's
 * own seat is always rendered at bottom-centre of the felt and up to 5 opponents are ordered
 * clockwise starting from the player's immediate left (`seatNo > selfSeat.seatNo`).
 */
export function partitionTableSeats(tableState) {
  const seats = Array.isArray(tableState?.seats)
    ? [...tableState.seats].sort((a, b) => Number(a.seatNo) - Number(b.seatNo))
    : [];
  const selfSeat = seats.find((s) => s.isSelf) || null;

  let orderedOthers;
  if (selfSeat) {
    const afterSelf = seats.filter((s) => s.seatNo > selfSeat.seatNo);
    const beforeSelf = seats.filter((s) => s.seatNo < selfSeat.seatNo);
    orderedOthers = [...afterSelf, ...beforeSelf];
  } else {
    orderedOthers = [...seats];
  }

  return {
    selfSeat,
    opponentSeat: orderedOthers[0] || null,
    opponentSeats: orderedOthers,
    otherSeats: orderedOthers
  };
}

/**
 * Computes the remaining seconds on the 30-second action clock (`0`..`30`), or `null` if no clock is active.
 */
export function computeRemainingTurnSeconds(hand, nowMs = Date.now(), clockSkewMs = 0) {
  if (!hand || hand.status !== "playing") return null;
  const deadline = Number(hand.turnDeadlineAt);
  if (!Number.isFinite(deadline) || deadline <= 0) return null;
  const serverNow = Number(nowMs) + Number(clockSkewMs || 0);
  return Math.max(0, Math.ceil((deadline - serverNow) / 1000));
}

/**
 * Computes legal raise preset targets (`min`, `halfPot`, `pot`, `allIn`) clamped to `[minRaiseTo, maxRaiseTo]`.
 */
export function computeRaisePresets({
  pot = 0,
  currentBet = 0,
  myBet = 0,
  minRaiseTo = 0,
  maxRaiseTo = 0
} = {}) {
  const min = Math.trunc(Number(minRaiseTo || 0));
  const max = Math.trunc(Number(maxRaiseTo || 0));
  if (min <= 0 || max <= 0 || max < min) {
    return { min: 0, halfPot: 0, pot: 0, allIn: 0 };
  }

  const clamp = (v) => Math.min(max, Math.max(min, Math.trunc(v)));
  const callDiff = Math.max(0, Number(currentBet || 0) - Number(myBet || 0));
  const potAfterCall = Math.max(0, Number(pot || 0) + callDiff);

  const halfPotTarget = clamp(Number(currentBet || 0) + Math.round(potAfterCall / 2));
  const potTarget = clamp(Number(currentBet || 0) + potAfterCall);

  return {
    min,
    halfPot: halfPotTarget,
    pot: potTarget,
    allIn: max
  };
}

/**
 * Builds a concise human-readable banner describing the current street, turn, or hand winner.
 */
export function describeHandStatus(tableState) {
  if (!tableState) {
    return { headline: "No table loaded", detail: "", isMyTurn: false };
  }

  if (tableState.status === "closed") {
    return {
      headline: "Table closed",
      detail: "This table has been closed.",
      isMyTurn: false
    };
  }

  const seats = Array.isArray(tableState.seats) ? tableState.seats : [];
  const selfSeat = seats.find((s) => s.isSelf) || null;
  const hand = tableState.hand || null;
  const activeSeats = seats.filter((s) => s.status === "active" && Number(s.stack) > 0);

  if (!hand) {
    if (activeSeats.length < 2) {
      const hasSitout = seats.some((s) => s.status === "sitout");
      return {
        headline: hasSitout && seats.length >= 2 ? "Waiting for players to sit in" : "Waiting for players",
        detail: `Share code ${tableState.code} so friends can join (up to ${tableState.maxSeats || 6} seats).`,
        isMyTurn: false
      };
    }
    return {
      headline: `Ready to deal (${activeSeats.length} players)`,
      detail: "Seated players are ready. Press Deal hand to begin.",
      isMyTurn: false
    };
  }

  if (hand.status === "complete") {
    const winners = Array.isArray(hand.winners) ? hand.winners : [];
    const payouts = hand.payouts || {};
    const showdownHands = hand.showdown?.hands || {};

    if (winners.length === 0) {
      return {
        headline: `Hand #${hand.handNo} complete`,
        detail: "Ready for the next hand.",
        isMyTurn: false
      };
    }

    const parts = winners.map((seatNo) => {
      const seat = seats.find((s) => s.seatNo === seatNo);
      const who = seat?.isSelf ? "You" : seat?.displayName || `Seat ${seatNo + 1}`;
      const won = Number(payouts[seatNo] ?? hand.pot ?? 0);
      const handName = showdownHands[seatNo]?.name || "";
      return handName
        ? `${who} won ${formatChips(won)} chips (${handName})`
        : `${who} won ${formatChips(won)} chips`;
    });

    const isFoldOut = !hand.showdown;
    const potsList = hand.showdown?.pots || hand.pots || [];
    let detail = isFoldOut ? "Won without showdown (all others folded)." : "Showdown complete.";
    if (!isFoldOut && potsList.length > 1) {
      const potBreakdown = potsList
        .map((p, idx) => `${idx === 0 ? "Main pot" : `Side pot ${idx}`}: ${formatChips(p.amount)}`)
        .join(" · ");
      detail = `${potBreakdown}`;
    }

    return {
      headline: parts.join(" · "),
      detail,
      isMyTurn: false
    };
  }

  const streetLabels = {
    preflop: "Preflop",
    flop: "Flop",
    turn: "Turn",
    river: "River",
    showdown: "Showdown"
  };
  const streetLabel = streetLabels[hand.street] || "Hand in progress";
  const actingSeat = seats.find((s) => s.seatNo === hand.actingSeat);
  const isMyTurn = Boolean(selfSeat && hand.actingSeat === selfSeat.seatNo);

  if (isMyTurn) {
    const legal = hand.legalActions || {};
    const callHint = legal.canCheck
      ? "Check or raise"
      : legal.canCall
        ? `Call ${formatChips(legal.callAmount)} or raise`
        : "Choose your action";
    return {
      headline: `${streetLabel} · Your turn`,
      detail: callHint,
      isMyTurn: true
    };
  }

  const actorName = actingSeat?.displayName || `Seat ${(hand.actingSeat ?? 0) + 1}`;
  return {
    headline: `${streetLabel} · ${actorName}'s turn`,
    detail: `Pot ${formatChips(hand.pot)} chips`,
    isMyTurn: false
  };
}
