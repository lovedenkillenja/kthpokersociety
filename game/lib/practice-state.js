// Public table state for practice mode, in exactly the shape the real server sends
// (`buildPublicTableState` in supabase/functions/_shared/state-helpers.js). Mirrored here so the browser page
// does not depend on the supabase/ folder; game/tests/practice-server.test.js checks the two stay identical.

import { legalActions, publicView } from "../engine/index.js";

export const PRACTICE_TURN_TIMEOUT_MS = 30_000;

export function buildPracticePublicState({
  table,
  seats,
  displayNamesByMemberId,
  handRow,
  callerMemberId = null,
  nowMs = Date.now()
}) {
  const handPub = handRow?.state ? publicView(handRow.state) : null;
  const handSeatsByNo = new Map((handPub?.seats || []).map((hs) => [hs.seat, hs]));

  const publicSeats = (seats || [])
    .filter((s) => s.status !== "left")
    .sort((a, b) => a.seat_no - b.seat_no)
    .map((s) => {
      const hs = handSeatsByNo.get(s.seat_no);
      const displayName =
        displayNamesByMemberId?.get?.(s.member_id) ||
        displayNamesByMemberId?.[s.member_id] ||
        `Seat ${s.seat_no + 1}`;
      return {
        seatNo: s.seat_no,
        displayName,
        stack: s.stack,
        status: s.status,
        consecutiveTimeouts: Number(s.consecutive_timeouts ?? 0),
        isSelf: Boolean(callerMemberId && s.member_id === callerMemberId),
        inHand: Boolean(hs),
        bet: hs ? hs.bet : 0,
        totalCommitted: hs ? hs.totalCommitted : 0,
        folded: hs ? hs.folded : false,
        allIn: hs ? hs.allIn : false,
        revealedCards: hs?.holeCards || null
      };
    });

  let publicHand = null;
  if (handRow && handPub) {
    const actingLegal =
      handPub.status === "playing" && handPub.actingSeat !== null
        ? legalActions(handRow.state, handPub.actingSeat)
        : null;
    const showdownSummary = handPub.showdownResult
      ? {
          pots: handPub.showdownResult.pots,
          payouts: handPub.showdownResult.payouts,
          winners: handPub.showdownResult.winners,
          uncalledReturned: handPub.showdownResult.uncalledReturned,
          oddChipWinners: handPub.showdownResult.oddChipWinners,
          hands: handPub.showdownResult.hands
        }
      : null;
    publicHand = {
      id: handRow.id,
      handNo: handRow.hand_no,
      status: handPub.status,
      street: handPub.street,
      dealerSeat: handPub.dealerSeat,
      sbSeat: handPub.sbSeat,
      bbSeat: handPub.bbSeat,
      board: handPub.board,
      pot: handPub.pot,
      pots: handPub.pots,
      currentBet: handPub.currentBet,
      lastRaiseSize: handPub.lastRaiseSize,
      actingSeat: handPub.actingSeat,
      actionSeq: Number(handRow.state?.actionSeq ?? 0),
      turnStartedAt: handRow.state?.turnStartedAt ?? null,
      turnDeadlineAt: handRow.state?.turnDeadlineAt ?? null,
      turnTimeoutMs: PRACTICE_TURN_TIMEOUT_MS,
      serverNow: nowMs,
      legalActions: actingLegal,
      payouts: handPub.payouts,
      winners: handPub.winners,
      uncalledReturned: handPub.uncalledReturned,
      showdown: showdownSummary
    };
  }

  return {
    id: table.id,
    code: table.code,
    sb: table.sb,
    bb: table.bb,
    minBuyIn: table.min_buyin,
    maxBuyIn: table.max_buyin,
    maxSeats: table.max_seats,
    status: table.status,
    isHost: Boolean(callerMemberId && table.host_id === callerMemberId),
    seats: publicSeats,
    hand: publicHand
  };
}
