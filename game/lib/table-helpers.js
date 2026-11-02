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
 * Arranges 1..5 clockwise opponent seats (`[L1, L2, ...]`) into a 2-column oval-felt grid
 * so that visual positions around the upper felt follow true clockwise poker seating:
 * - 1 opponent (2p): `[o0]` at top-center (12h)
 * - 2 opponents (3p): `o0` top-left (10h), `o1` top-right (2h)
 * - 3 opponents (4p): Row 1 `o1` top-center (12h); Row 2 `o0` mid-left (9h), `o2` mid-right (3h)
 * - 4 opponents (5p): Row 1 `o1` top-left (10h), `o2` top-right (2h); Row 2 `o0` mid-left (8h), `o3` mid-right (4h)
 * - 5 opponents (6p): Row 1 `o2` top-center (12h); Row 2 `o1` top-left (10h), `o3` top-right (2h); Row 3 `o0` mid-left (8h), `o4` mid-right (4h)
 */
export function layoutOpponentSeatsForGrid(opponentSeats = []) {
  const list = Array.isArray(opponentSeats) ? opponentSeats : [];
  const count = list.length;
  if (count === 0) return [];
  if (count === 1) {
    return [{ seat: list[0], position: "top-center", fullRow: true }];
  }
  if (count === 2) {
    return [
      { seat: list[0], position: "top-left", fullRow: false },
      { seat: list[1], position: "top-right", fullRow: false }
    ];
  }
  if (count === 3) {
    return [
      { seat: list[1], position: "top-center", fullRow: true },
      { seat: list[0], position: "mid-left", fullRow: false },
      { seat: list[2], position: "mid-right", fullRow: false }
    ];
  }
  if (count === 4) {
    return [
      { seat: list[1], position: "top-left", fullRow: false },
      { seat: list[2], position: "top-right", fullRow: false },
      { seat: list[0], position: "mid-left", fullRow: false },
      { seat: list[3], position: "mid-right", fullRow: false }
    ];
  }
  return [
    { seat: list[2], position: "top-center", fullRow: true },
    { seat: list[1], position: "top-left", fullRow: false },
    { seat: list[3], position: "top-right", fullRow: false },
    { seat: list[0], position: "mid-left", fullRow: false },
    { seat: list[4], position: "mid-right", fullRow: false }
  ];
}

/**
 * Maps Edge Function, database, auth, and network errors to clear, actionable instructions
 * per docs/poker/STYLE_GUIDE.md ("Errors say what to do next").
 */
export function friendlyTableError({ code = "", status = 0, error = "" } = {}) {
  const cleanCode = String(code || "").toUpperCase().trim();
  const rawMsg = String(error || "").trim();
  const upperMsg = rawMsg.toUpperCase();

  const matchCode = (target) => cleanCode === target || upperMsg.includes(target);

  if (status === 0 || matchCode("ERR_NETWORK")) {
    return "Connection lost. Reconnecting…";
  }
  if (status === 401 || matchCode("ERR_UNAUTHORIZED")) {
    return "Your session expired. Log in again to return to your seat.";
  }
  if (matchCode("ERR_TABLE_NOT_FOUND")) {
    return "Room code not found. Check the 5-character code with the host or create a new table.";
  }
  if (matchCode("ERR_TABLE_FULL")) {
    return "This table is full (all seats are taken). Ask for another room code or create a new table.";
  }
  if (matchCode("ERR_TABLE_CLOSED")) {
    return "This table has closed. Return to the lobby to join or create an open table.";
  }
  if (matchCode("ERR_SEAT_TAKEN")) {
    return "That seat was just taken. Try joining again to take another open seat.";
  }
  if (matchCode("ERR_INSUFFICIENT_CHIPS")) {
    return "Not enough chips in your balance for that buy-in. Claim daily +100 chips or lower your buy-in.";
  }
  if (matchCode("ERR_TOO_MANY_OPEN_TABLES")) {
    return "You already host 3 open tables. Close an empty table you created or return to an active room.";
  }
  if (matchCode("ERR_OUT_OF_TURN")) {
    return "It is not your turn to act yet. Wait for the active player.";
  }
  if (
    matchCode("ERR_STALE_ACTION_SEQ") ||
    matchCode("ERR_STALE_HAND") ||
    matchCode("ERR_CONCURRENT_ACTION") ||
    matchCode("ERR_ACTION_REPLAY")
  ) {
    return "Table state just updated. Syncing latest hand…";
  }
  if (matchCode("ERR_NOT_ENOUGH_PLAYERS")) {
    return "At least 2 active players with chips are required to deal a hand.";
  }
  if (matchCode("ERR_HAND_IN_PROGRESS")) {
    return "A hand is currently in progress. Wait for the current hand to finish.";
  }
  if (matchCode("ERR_TABLE_NOT_EMPTY")) {
    return "Players are still seated. Everyone must leave before the table can be closed.";
  }

  return rawMsg || "Could not complete that table action. Try again.";
}

/**
 * Builds structured showdown and pot-winner breakdown details for a completed hand.
 */
export function summarizeShowdown(tableState) {
  const hand = tableState?.hand;
  if (!hand || hand.status !== "complete") return null;

  const seats = Array.isArray(tableState?.seats) ? tableState.seats : [];
  const winners = Array.isArray(hand.winners) ? hand.winners : [];
  const payouts = hand.payouts || {};
  const showdownHands = hand.showdown?.hands || {};
  const isShowdown = Boolean(hand.showdown);

  const seatName = (seatNo) => {
    const s = seats.find((item) => item.seatNo === seatNo);
    if (!s) return `Seat ${Number(seatNo) + 1}`;
    return s.isSelf ? `You (${s.displayName || "You"})` : s.displayName || `Seat ${s.seatNo + 1}`;
  };

  const shortSeatName = (seatNo) => {
    const s = seats.find((item) => item.seatNo === seatNo);
    if (!s) return `Seat ${Number(seatNo) + 1}`;
    return s.isSelf ? "You" : s.displayName || `Seat ${s.seatNo + 1}`;
  };

  const winnerRows = winners.map((seatNo) => {
    const s = seats.find((item) => item.seatNo === seatNo);
    const wonAmount = Number(payouts[seatNo] ?? hand.pot ?? 0);
    const handInfo = showdownHands[seatNo] || null;
    const cards =
      Array.isArray(s?.revealedCards) && s.revealedCards.length === 2 ? s.revealedCards : null;
    return {
      seatNo,
      displayName: seatName(seatNo),
      shortName: shortSeatName(seatNo),
      isSelf: Boolean(s?.isSelf),
      wonAmount,
      handName: handInfo?.name || "",
      cards
    };
  });

  const rawPots = hand.showdown?.pots || hand.pots || [];
  const potBreakdowns = rawPots.map((p, idx) => {
    const label = idx === 0 ? (rawPots.length > 1 ? "Main pot" : "Pot") : `Side pot ${idx}`;
    const potWinners = Array.isArray(p.winners) ? p.winners : [];
    const winnerNames = potWinners.map(shortSeatName);
    return {
      label,
      amount: Number(p.amount || 0),
      winnerSeats: potWinners,
      winnerNames,
      isSplit: potWinners.length > 1
    };
  });

  const isSplitPot = winners.length > 1 || potBreakdowns.some((p) => p.isSplit);

  return {
    handId: hand.id,
    handNo: hand.handNo,
    pot: Number(hand.pot || 0),
    board: Array.isArray(hand.board) ? hand.board : [],
    isShowdown,
    isSplitPot,
    winnerSeats: winners,
    winnerRows,
    potBreakdowns
  };
}

/**
 * Creates a compact hand-history entry for a completed hand (kept up to last 10 hands in the UI).
 */
export function buildHandHistoryEntry(tableState) {
  const summary = summarizeShowdown(tableState);
  if (!summary) return null;
  const status = describeHandStatus(tableState);
  return {
    handId: summary.handId || `hand-${summary.handNo}`,
    handNo: summary.handNo || 1,
    pot: summary.pot,
    board: [...summary.board],
    headline: status.headline,
    detail: status.detail,
    isShowdown: summary.isShowdown,
    isSplitPot: summary.isSplitPot,
    winnerRows: summary.winnerRows,
    potBreakdowns: summary.potBreakdowns
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
