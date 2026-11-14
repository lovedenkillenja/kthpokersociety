// Shared table locking, public state projection, and hand persistence helpers for Edge Functions.

import {
  legalActions,
  apply,
  publicView,
  settleFoldOutState,
  cryptoRng
} from "./engine/index.js";

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const tableLocks = new Map();

export const ACTION_TIMEOUT_MS = 30_000;
export const IDLE_TABLE_TIMEOUT_MS = 30 * 60 * 1000;
/** Consecutive timeouts after which a seat is moved to `sitout` (and folded in the running hand). */
export const MAX_CONSECUTIVE_TIMEOUTS = 2;

export function stampTurnTimer(handState, nowMs = Date.now()) {
  if (!handState) return handState;
  if (
    handState.status === "playing" &&
    handState.actingSeat !== null &&
    handState.actingSeat !== undefined
  ) {
    handState.turnStartedAt = nowMs;
    handState.turnDeadlineAt = nowMs + ACTION_TIMEOUT_MS;
  } else {
    handState.turnStartedAt = null;
    handState.turnDeadlineAt = null;
  }
  return handState;
}

export async function withTableLock(lockKey, fn) {
  const key = String(lockKey || "global");
  const prev = tableLocks.get(key) || Promise.resolve();
  let release;
  const next = new Promise((resolve) => {
    release = resolve;
  });
  tableLocks.set(key, prev.then(() => next));

  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (tableLocks.get(key) === next) {
      tableLocks.delete(key);
    }
  }
}

export function generateRoomCode(rng = cryptoRng) {
  let code = "";
  for (let i = 0; i < 5; i += 1) {
    const r = Math.floor(rng() * ROOM_CODE_ALPHABET.length);
    const idx = Math.min(Math.max(r, 0), ROOM_CODE_ALPHABET.length - 1);
    code += ROOM_CODE_ALPHABET[idx];
  }
  return code;
}

export function errorResult(status, code, error) {
  return { status, body: { ok: false, code, error } };
}

export function mapStoreError(err) {
  const msg = String(err?.message || err || "");
  const knownCodes = [
    "ERR_FORBIDDEN",
    "ERR_NOT_HOST",
    "ERR_INVALID_ARGS",
    "ERR_NOT_A_MEMBER",
    "ERR_TABLE_NOT_FOUND",
    "ERR_HAND_NOT_FOUND",
    "ERR_TABLE_CLOSED",
    "ERR_TABLE_NOT_EMPTY",
    "ERR_INVALID_SEAT",
    "ERR_INVALID_BUYIN",
    "ERR_ALREADY_SEATED",
    "ERR_SEAT_TAKEN",
    "ERR_TABLE_FULL",
    "ERR_TOO_MANY_OPEN_TABLES",
    "ERR_INSUFFICIENT_CHIPS",
    "ERR_NOT_SEATED",
    "ERR_HAND_IN_PROGRESS",
    "ERR_NO_ACTIVE_HAND",
    "ERR_STALE_HAND",
    "ERR_STALE_ACTION_SEQ",
    "ERR_CONCURRENT_ACTION",
    "ERR_CHIP_CONSERVATION"
  ];
  for (const code of knownCodes) {
    if (msg.includes(code)) {
      const status =
        code === "ERR_FORBIDDEN" || code === "ERR_NOT_HOST"
          ? 403
          : code === "ERR_TABLE_NOT_FOUND" ||
              code === "ERR_HAND_NOT_FOUND" ||
              code === "ERR_NOT_SEATED"
            ? 404
            : code === "ERR_ALREADY_SEATED" ||
                code === "ERR_SEAT_TAKEN" ||
                code === "ERR_HAND_IN_PROGRESS" ||
                code === "ERR_TABLE_NOT_EMPTY" ||
                code === "ERR_STALE_HAND" ||
                code === "ERR_STALE_ACTION_SEQ" ||
                code === "ERR_CONCURRENT_ACTION"
              ? 409
              : 400;
      return errorResult(status, code, msg.replace(`${code}: `, ""));
    }
  }
  return errorResult(400, err?.code || "ERR_OPERATION_FAILED", msg || "Operation failed.");
}

export function buildPublicTableState({
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
        // Dealt into the current (or last) hand; a `sitout` seat can still be in a running hand
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
      turnTimeoutMs: ACTION_TIMEOUT_MS,
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

export async function authenticateCaller(store, jwt, payload) {
  if (!jwt) {
    return { error: errorResult(401, "ERR_UNAUTHORIZED", "Missing bearer token. Log in first.") };
  }
  const user = await store.verifyUserJwt(jwt);
  if (!user || !user.id) {
    return { error: errorResult(401, "ERR_UNAUTHORIZED", "Invalid or expired session. Log in again.") };
  }

  const bodyMemberId = payload?.member_id ?? payload?.memberId ?? payload?.user_id ?? null;
  if (bodyMemberId && String(bodyMemberId) !== String(user.id)) {
    return {
      error: errorResult(
        403,
        "ERR_FORGED_MEMBER_ID",
        "Cannot specify a different member_id than the authenticated user."
      )
    };
  }
  return { user };
}

export function foldSeatInHandState(handState, seatNo) {
  if (handState.status !== "playing") return handState;
  if (handState.actingSeat === seatNo) {
    return apply(handState, seatNo, { type: "fold" });
  }

  const cloned = structuredClone(handState);
  const player = cloned.seats.find((p) => p.seat === seatNo);
  if (!player || player.folded) return cloned;

  player.folded = true;
  player.acted = true;
  player.actedSinceFullRaise = true;
  cloned.actions.push({ street: cloned.street, seat: seatNo, type: "fold", amount: 0 });

  const nonFolded = cloned.seats.filter((p) => !p.folded);
  if (nonFolded.length === 1) {
    return settleFoldOutState(cloned, nonFolded[0]);
  }
  return cloned;
}

export async function persistHandTransition({
  store,
  table,
  handRow,
  prevState,
  nextState,
  seatStatusOverrides = null,
  seatTimeoutOverrides = null,
  holeCards = [],
  nowMs = Date.now()
}) {
  const prevActionCount = prevState?.actions?.length || 0;
  const prevActionSeq = Number(prevState?.actionSeq ?? 0);
  nextState.actionSeq = prevActionSeq + 1;

  const turnAdvanced =
    nextState.status !== "playing" ||
    nextState.actingSeat !== prevState?.actingSeat ||
    nextState.street !== prevState?.street ||
    !prevState?.turnDeadlineAt;

  if (turnAdvanced) {
    stampTurnTimer(nextState, nowMs);
  }

  const newActions = nextState.actions.slice(prevActionCount).map((a) => ({
    hand_id: handRow.id,
    seat_no: a.seat,
    action: a.allIn && a.type === "raise" ? "all-in" : a.type,
    amount: a.amount || 0
  }));

  if (nextState.status === "complete") {
    if (nextState.showdownResult) {
      newActions.push({
        hand_id: handRow.id,
        seat_no: nextState.dealerSeat,
        action: "showdown",
        amount: nextState.pot
      });
    }
    for (const [seatStr, wonAmount] of Object.entries(nextState.payouts || {})) {
      if (wonAmount > 0) {
        newActions.push({
          hand_id: handRow.id,
          seat_no: Number(seatStr),
          action: "win",
          amount: wonAmount
        });
      }
    }
  }

  const endedAt = nextState.status === "complete" ? new Date(nowMs).toISOString() : null;
  const tableStatus = nextState.status === "complete" ? "open" : "playing";
  const seatStacks = nextState.seats.map((p) => {
    const entry = { seatNo: p.seat, stack: Math.trunc(Number(p.stack)) };
    if (seatStatusOverrides && seatStatusOverrides[p.seat]) {
      entry.status = seatStatusOverrides[p.seat];
    }
    if (seatTimeoutOverrides && seatTimeoutOverrides[p.seat] !== undefined) {
      const timeouts = Math.max(0, Math.trunc(Number(seatTimeoutOverrides[p.seat])));
      entry.consecutiveTimeouts = timeouts;
      if (timeouts >= MAX_CONSECUTIVE_TIMEOUTS && !entry.status) {
        entry.status = "sitout";
      }
    }
    return entry;
  });

  const updatedHand = await store.applyHandTx({
    handId: handRow.id,
    expectedActionSeq: prevActionSeq,
    board: nextState.board,
    pot: nextState.pot,
    state: nextState,
    showdown: nextState.showdownResult || null,
    endedAt,
    seatStacks,
    holeCards,
    actions: newActions,
    tableStatus
  });

  if (!updatedHand) {
    const err = new Error("ERR_STALE_ACTION_SEQ: Hand state changed concurrently; retry.");
    err.code = "ERR_STALE_ACTION_SEQ";
    throw err;
  }

  if (nextState.status === "complete" && Array.isArray(nextState.pendingLeaveMemberIds)) {
    for (const leavingMemberId of nextState.pendingLeaveMemberIds) {
      try {
        await store.leaveSeat({ tableId: table.id, memberId: leavingMemberId });
      } catch (_err) {
        // Already cashed out
      }
    }
  }
  return updatedHand;
}

export async function resolveExpiredTurns({
  store,
  table,
  seats,
  handRow,
  nowMs = Date.now()
}) {
  if (!handRow || handRow.ended_at || handRow.state?.status !== "playing") {
    return { timedOut: false, handRow };
  }

  const deadline = Number(handRow.state?.turnDeadlineAt);
  if (!Number.isFinite(deadline) || nowMs < deadline) {
    return { timedOut: false, handRow };
  }

  const timedOutSeatNo = handRow.state.actingSeat;
  if (timedOutSeatNo === null || timedOutSeatNo === undefined) {
    return { timedOut: false, handRow };
  }

  const seatRow = (seats || []).find((s) => s.seat_no === timedOutSeatNo);
  const nextTimeouts = Number(seatRow?.consecutive_timeouts ?? 0) + 1;
  const shouldSitOut = nextTimeouts >= MAX_CONSECUTIVE_TIMEOUTS;
  // A seat that is already sitting out, or is sat out by this timeout, is folded even when a check
  // would be legal, so a hand never auto-checks street after street between absent players.
  const wasSitout = seatRow?.status === "sitout";
  const forceFold = wasSitout || shouldSitOut;
  const nextState = apply(handRow.state, timedOutSeatNo, { type: "timeout", fold: forceFold });

  const updatedHand = await persistHandTransition({
    store,
    table,
    handRow,
    prevState: handRow.state,
    nextState,
    seatStatusOverrides: shouldSitOut ? { [timedOutSeatNo]: "sitout" } : null,
    seatTimeoutOverrides: { [timedOutSeatNo]: nextTimeouts },
    nowMs
  });

  if (seatRow) {
    seatRow.consecutive_timeouts = nextTimeouts;
    if (shouldSitOut) {
      seatRow.status = "sitout";
    }
  }

  return {
    timedOut: true,
    timedOutSeatNo,
    consecutiveTimeouts: nextTimeouts,
    satOut: shouldSitOut || wasSitout,
    folded: Boolean(nextState.seats.find((p) => p.seat === timedOutSeatNo)?.folded),
    handRow: updatedHand
  };
}

export async function loadAndBroadcastTableState(
  store,
  tableIdOrCode,
  callerMemberId,
  nowMs = Date.now()
) {
  const ctx = await store.getTableContext(tableIdOrCode);
  if (!ctx || !ctx.table) return null;

  const broadcastState = buildPublicTableState({
    table: ctx.table,
    seats: ctx.seats,
    displayNamesByMemberId: ctx.displayNamesByMemberId,
    handRow: ctx.hand,
    callerMemberId: null,
    nowMs
  });
  await store.broadcastTableState(ctx.table.code, broadcastState);

  return buildPublicTableState({
    table: ctx.table,
    seats: ctx.seats,
    displayNamesByMemberId: ctx.displayNamesByMemberId,
    handRow: ctx.hand,
    callerMemberId,
    nowMs
  });
}
