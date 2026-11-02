// Core request handlers for the `table` and `act` Supabase Edge Functions.
// Pure ES module using an injected `store` interface so it runs identically
// in Deno (production Edge Functions) and Node (`node --test` unit tests).

import { newHand, apply, cryptoRng } from "./engine/index.js";
import {
  ACTION_TIMEOUT_MS,
  IDLE_TABLE_TIMEOUT_MS,
  withTableLock,
  generateRoomCode,
  stampTurnTimer,
  errorResult,
  mapStoreError,
  buildPublicTableState,
  authenticateCaller,
  foldSeatInHandState,
  persistHandTransition,
  resolveExpiredTurns,
  loadAndBroadcastTableState
} from "./state-helpers.js";

export {
  ACTION_TIMEOUT_MS,
  IDLE_TABLE_TIMEOUT_MS,
  withTableLock,
  generateRoomCode,
  buildPublicTableState
};

const TABLE_INTENTS = new Set([
  "create",
  "join",
  "leave",
  "state",
  "get",
  "tick",
  "close",
  "close-table",
  "sit-in",
  "sitin",
  "sit-out",
  "sitout"
]);

/**
 * Handles `table` Edge Function intents:
 * `create`, `join`, `leave`, `state`, `tick`, `close`, `sit-in`, `sit-out`.
 */
export async function handleTableRequest({
  store,
  jwt,
  payload = {},
  rng = cryptoRng,
  now = () => Date.now()
}) {
  const auth = await authenticateCaller(store, jwt, payload);
  if (auth.error) return auth.error;
  const callerId = auth.user.id;
  const nowMs = Number(now());

  const intent = String(payload?.intent || "").toLowerCase().trim();

  if (intent === "create") {
    const sb = Math.trunc(Number(payload.sb ?? 10));
    const bb = Math.trunc(Number(payload.bb ?? 20));
    const minBuyIn = Math.trunc(Number(payload.minBuyIn ?? payload.min_buyin ?? bb * 20));
    const maxBuyIn = Math.trunc(Number(payload.maxBuyIn ?? payload.max_buyin ?? bb * 100));
    const maxSeats = Math.trunc(Number(payload.maxSeats ?? payload.max_seats ?? 6));

    if (![sb, bb, minBuyIn, maxBuyIn, maxSeats].every(Number.isSafeInteger)) {
      return errorResult(400, "ERR_INVALID_TABLE_PARAMS", "Table parameters must be whole numbers.");
    }
    if (sb <= 0 || bb < sb || minBuyIn <= 0 || maxBuyIn < minBuyIn || maxSeats < 2 || maxSeats > 6) {
      return errorResult(400, "ERR_INVALID_TABLE_PARAMS", "Invalid table blinds, buy-in limits, or seat count.");
    }

    if (typeof store.closeIdleTables === "function") {
      try {
        await store.closeIdleTables(nowMs);
      } catch (_err) {
        // Non-fatal if opportunistic cleanup fails; DB trigger also runs on insert
      }
    }

    if (typeof store.countOpenTablesByHost === "function") {
      try {
        const openCount = await store.countOpenTablesByHost(callerId);
        if (openCount >= 3) {
          return errorResult(
            400,
            "ERR_TOO_MANY_OPEN_TABLES",
            "You can host at most 3 open tables at a time."
          );
        }
      } catch (err) {
        return mapStoreError(err);
      }
    }

    let createdTable = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = generateRoomCode(rng);
      try {
        createdTable = await store.createTable({
          code,
          hostId: callerId,
          sb,
          bb,
          minBuyIn,
          maxBuyIn,
          maxSeats
        });
        if (createdTable) break;
      } catch (err) {
        if (String(err?.message || err || "").includes("ERR_TOO_MANY_OPEN_TABLES")) {
          return mapStoreError(err);
        }
        // Retry if 5-char code collided
      }
    }

    if (!createdTable) {
      return errorResult(500, "ERR_CREATE_TABLE_FAILED", "Could not create table. Try again.");
    }

    if (payload.buyIn !== undefined && payload.buyIn !== null) {
      if (!Number.isSafeInteger(Math.trunc(Number(payload.buyIn)))) {
        return errorResult(400, "ERR_INVALID_BUYIN", "Buy-in must be a whole number.");
      }
      try {
        await store.sitDown({
          tableId: createdTable.id,
          memberId: callerId,
          seatNo: Number(payload.seat ?? 0),
          buyIn: Math.trunc(Number(payload.buyIn))
        });
      } catch (err) {
        return mapStoreError(err);
      }
    }

    const publicState = await loadAndBroadcastTableState(store, createdTable.id, callerId, nowMs);
    return { status: 200, body: { ok: true, table: publicState } };
  }

  const tableRef = payload?.table ?? payload?.tableId ?? payload?.code;
  if (!tableRef) {
    return errorResult(400, "ERR_MISSING_TABLE", "Table code or ID is required.");
  }

  return withTableLock(tableRef, async () => {
    const ctx = await store.getTableContext(tableRef);
    if (!ctx || !ctx.table) {
      return errorResult(404, "ERR_TABLE_NOT_FOUND", "Table not found.");
    }
    const { table, seats } = ctx;
    let { hand } = ctx;

    // Opportunistically enforce the 30-second action deadline before serving any table intent
    let timeoutInfo = { timedOut: false };
    try {
      timeoutInfo = await resolveExpiredTurns({
        store,
        table,
        seats,
        handRow: hand,
        nowMs
      });
      if (timeoutInfo.timedOut) {
        hand = timeoutInfo.handRow;
      }
    } catch (err) {
      return mapStoreError(err);
    }

    if (intent === "tick") {
      const publicState = timeoutInfo.timedOut
        ? await loadAndBroadcastTableState(store, table.id, callerId, nowMs)
        : buildPublicTableState({
            table,
            seats,
            displayNamesByMemberId: ctx.displayNamesByMemberId,
            handRow: hand,
            callerMemberId: callerId,
            nowMs
          });
      return {
        status: 200,
        body: {
          ok: true,
          timedOut: Boolean(timeoutInfo.timedOut),
          timedOutSeatNo: timeoutInfo.timedOutSeatNo ?? null,
          satOut: Boolean(timeoutInfo.satOut),
          table: publicState
        }
      };
    }

    if (intent === "state" || intent === "get") {
      const publicState = timeoutInfo.timedOut
        ? await loadAndBroadcastTableState(store, table.id, callerId, nowMs)
        : buildPublicTableState({
            table,
            seats,
            displayNamesByMemberId: ctx.displayNamesByMemberId,
            handRow: hand,
            callerMemberId: callerId,
            nowMs
          });
      return { status: 200, body: { ok: true, table: publicState } };
    }

    if (intent === "close" || intent === "close-table") {
      if (table.host_id !== callerId) {
        return errorResult(403, "ERR_NOT_HOST", "Only the table host can close this table.");
      }
      if (hand && !hand.ended_at && hand.state?.status === "playing") {
        return errorResult(409, "ERR_HAND_IN_PROGRESS", "Cannot close table while a hand is in progress.");
      }
      const seatedCount = seats.filter((s) => s.status === "active" || s.status === "sitout").length;
      if (seatedCount > 0) {
        return errorResult(
          409,
          "ERR_TABLE_NOT_EMPTY",
          "Cannot close table while players are still seated."
        );
      }

      try {
        if (typeof store.closeTable === "function") {
          await store.closeTable({ tableId: table.id, hostId: callerId });
        } else {
          table.status = "closed";
        }
      } catch (err) {
        return mapStoreError(err);
      }

      const publicState = await loadAndBroadcastTableState(store, table.id, callerId, nowMs);
      return { status: 200, body: { ok: true, table: publicState } };
    }

    if (intent === "sit-in" || intent === "sitin" || intent === "sit-out" || intent === "sitout") {
      const callerSeat = seats.find(
        (s) => s.member_id === callerId && (s.status === "active" || s.status === "sitout")
      );
      if (!callerSeat) {
        return errorResult(404, "ERR_NOT_SEATED", "You are not seated at this table.");
      }

      const targetStatus = intent === "sit-in" || intent === "sitin" ? "active" : "sitout";

      if (
        targetStatus === "sitout" &&
        hand &&
        !hand.ended_at &&
        hand.state?.status === "playing"
      ) {
        const inHand = hand.state.seats.find((p) => p.seat === callerSeat.seat_no && !p.folded);
        if (inHand) {
          const nextState = foldSeatInHandState(hand.state, callerSeat.seat_no);
          try {
            await persistHandTransition({
              store,
              table,
              handRow: hand,
              prevState: hand.state,
              nextState,
              seatStatusOverrides: { [callerSeat.seat_no]: "sitout" },
              nowMs
            });
          } catch (err) {
            return mapStoreError(err);
          }
        }
      }

      try {
        if (typeof store.setSeatStatus === "function") {
          await store.setSeatStatus({
            tableId: table.id,
            memberId: callerId,
            status: targetStatus
          });
        } else {
          callerSeat.status = targetStatus;
          if (targetStatus === "active") callerSeat.consecutive_timeouts = 0;
        }
      } catch (err) {
        return mapStoreError(err);
      }

      const publicState = await loadAndBroadcastTableState(store, table.id, callerId, nowMs);
      return { status: 200, body: { ok: true, table: publicState } };
    }

    if (intent === "join") {
      const occupiedSeatNos = new Set(
        seats.filter((s) => s.status === "active" || s.status === "sitout").map((s) => s.seat_no)
      );
      let seatNo = payload.seat ?? payload.seatNo ?? payload.seat_no;
      if (seatNo === undefined || seatNo === null) {
        for (let i = 0; i < table.max_seats; i += 1) {
          if (!occupiedSeatNos.has(i)) {
            seatNo = i;
            break;
          }
        }
      }
      if (seatNo === undefined || seatNo === null) {
        return errorResult(400, "ERR_TABLE_FULL", "Table is full.");
      }

      const buyIn = Math.trunc(Number(payload.buyIn ?? payload.buyin ?? payload.amount ?? table.min_buyin));
      if (!Number.isSafeInteger(buyIn)) {
        return errorResult(400, "ERR_INVALID_BUYIN", "Buy-in must be a whole number.");
      }
      try {
        await store.sitDown({
          tableId: table.id,
          memberId: callerId,
          seatNo: Math.trunc(Number(seatNo)),
          buyIn
        });
      } catch (err) {
        return mapStoreError(err);
      }

      const publicState = await loadAndBroadcastTableState(store, table.id, callerId, nowMs);
      return { status: 200, body: { ok: true, table: publicState } };
    }

    if (intent === "leave") {
      const callerSeat = seats.find(
        (s) => s.member_id === callerId && (s.status === "active" || s.status === "sitout")
      );
      if (!callerSeat) {
        return errorResult(404, "ERR_NOT_SEATED", "You are not seated at this table.");
      }

      let handStillRunning = false;
      if (hand && !hand.ended_at && hand.state && hand.state.status === "playing") {
        const inHand = hand.state.seats.find((p) => p.seat === callerSeat.seat_no && !p.folded);
        let nextState = hand.state;
        if (inHand) {
          nextState = foldSeatInHandState(hand.state, callerSeat.seat_no);
        }
        if (nextState.status === "playing") {
          handStillRunning = true;
          const pending = new Set(nextState.pendingLeaveMemberIds || []);
          pending.add(callerId);
          nextState = { ...nextState, pendingLeaveMemberIds: [...pending] };
        }
        try {
          await persistHandTransition({
            store,
            table,
            handRow: hand,
            prevState: hand.state,
            nextState,
            seatStatusOverrides: handStillRunning ? { [callerSeat.seat_no]: "sitout" } : null,
            nowMs
          });
        } catch (err) {
          return mapStoreError(err);
        }
      }

      if (handStillRunning) {
        const publicState = await loadAndBroadcastTableState(store, table.id, callerId, nowMs);
        return {
          status: 200,
          body: { ok: true, pendingCashout: true, table: publicState }
        };
      }

      try {
        await store.leaveSeat({
          tableId: table.id,
          memberId: callerId
        });
      } catch (err) {
        return mapStoreError(err);
      }

      const publicState = await loadAndBroadcastTableState(store, table.id, callerId, nowMs);
      return { status: 200, body: { ok: true, table: publicState } };
    }

    return errorResult(400, "ERR_UNKNOWN_INTENT", `Unknown table intent "${intent}".`);
  });
}

/**
 * Handles `act` Edge Function intents:
 * `start`, `fold`, `check`, `call`, `raise`, `bet`, `all-in`, `tick`
 * (plus table intents forwarded to `handleTableRequest`).
 */
export async function handleActRequest({
  store,
  jwt,
  payload = {},
  rng = cryptoRng,
  now = () => Date.now()
}) {
  const intent = String(payload?.intent || payload?.action || "").toLowerCase().trim();

  if (TABLE_INTENTS.has(intent)) {
    return handleTableRequest({ store, jwt, payload: { ...payload, intent }, rng, now });
  }

  const auth = await authenticateCaller(store, jwt, payload);
  if (auth.error) return auth.error;
  const callerId = auth.user.id;
  const nowMs = Number(now());

  const tableRef = payload?.table ?? payload?.tableId ?? payload?.code;
  if (!tableRef) {
    return errorResult(400, "ERR_MISSING_TABLE", "Table code or ID is required.");
  }

  return withTableLock(tableRef, async () => {
    const ctx = await store.getTableContext(tableRef);
    if (!ctx || !ctx.table) {
      return errorResult(404, "ERR_TABLE_NOT_FOUND", "Table not found.");
    }
    const { table, seats, displayNamesByMemberId } = ctx;
    let { hand } = ctx;

    // Enforce any expired 30s action timer before processing the caller's action
    let timeoutInfo = { timedOut: false };
    try {
      timeoutInfo = await resolveExpiredTurns({
        store,
        table,
        seats,
        handRow: hand,
        nowMs
      });
      if (timeoutInfo.timedOut) {
        hand = timeoutInfo.handRow;
        await loadAndBroadcastTableState(store, table.id, callerId, nowMs);
      }
    } catch (err) {
      return mapStoreError(err);
    }

    const callerSeat = seats.find(
      (s) => s.member_id === callerId && (s.status === "active" || s.status === "sitout")
    );
    if (!callerSeat) {
      return errorResult(403, "ERR_NOT_SEATED", "You must be seated at the table to act.");
    }

    if (intent === "start" || intent === "start-hand" || intent === "deal") {
      if (hand && !hand.ended_at && hand.state?.status === "playing") {
        return errorResult(409, "ERR_HAND_IN_PROGRESS", "A hand is already in progress at this table.");
      }

      const eligibleSeats = seats
        .filter((s) => s.status === "active" && s.stack > 0)
        .sort((a, b) => a.seat_no - b.seat_no);

      if (eligibleSeats.length < 2) {
        return errorResult(400, "ERR_NOT_ENOUGH_PLAYERS", "At least 2 active players with chips are required to deal a hand.");
      }

      const lastHandNo = Number(ctx.lastHandNo ?? hand?.hand_no ?? 0);
      const nextHandNo = lastHandNo + 1;

      const seatNos = eligibleSeats.map((s) => s.seat_no);
      let dealerSeat = seatNos[0];
      if (hand && typeof hand.dealer_seat === "number") {
        const afterPrev = seatNos.filter((s) => s > hand.dealer_seat);
        dealerSeat = afterPrev.length > 0 ? afterPrev[0] : seatNos[0];
      }

      const engineSeats = eligibleSeats.map((s) => ({
        seat: s.seat_no,
        id: s.member_id,
        name: displayNamesByMemberId?.get?.(s.member_id) || `Seat ${s.seat_no + 1}`,
        stack: s.stack,
        status: s.status
      }));

      const handState = newHand(
        engineSeats,
        dealerSeat,
        { sb: table.sb, bb: table.bb },
        rng
      );
      handState.actionSeq = 0;
      stampTurnTimer(handState, nowMs);

      const endedAt = handState.status === "complete" ? new Date(nowMs).toISOString() : null;
      const tableStatus = handState.status === "complete" ? "open" : "playing";
      const seatStacks = handState.seats.map((p) => ({
        seatNo: p.seat,
        stack: Math.trunc(Number(p.stack))
      }));
      const holeCardRows = handState.seats.map((p) => ({
        member_id: p.id,
        cards: p.holeCards
      }));
      const initialActions = handState.actions.map((a) => ({
        seat_no: a.seat,
        action: a.type,
        amount: a.amount
      }));

      try {
        await store.startHandTx({
          tableId: table.id,
          handNo: nextHandNo,
          dealerSeat: handState.dealerSeat,
          board: handState.board,
          pot: handState.pot,
          state: handState,
          showdown: handState.showdownResult || null,
          endedAt,
          seatStacks,
          holeCards: holeCardRows,
          actions: initialActions,
          tableStatus
        });
      } catch (err) {
        return mapStoreError(err);
      }

      const publicState = await loadAndBroadcastTableState(store, table.id, callerId, nowMs);
      return { status: 200, body: { ok: true, table: publicState } };
    }

    const validActions = new Set(["fold", "check", "call", "raise", "bet", "all-in", "allin"]);
    if (!validActions.has(intent)) {
      return errorResult(400, "ERR_UNKNOWN_INTENT", `Unsupported action intent "${intent}".`);
    }

    if (!hand || hand.ended_at || hand.state?.status !== "playing") {
      return errorResult(400, "ERR_NO_ACTIVE_HAND", "There is no active hand at this table.");
    }

    if (payload.handId && String(payload.handId) !== String(hand.id)) {
      return errorResult(409, "ERR_STALE_HAND", "Action targets a hand that is no longer active.");
    }
    if (
      payload.actionSeq !== undefined &&
      payload.actionSeq !== null &&
      Number(payload.actionSeq) !== Number(hand.state.actionSeq ?? 0)
    ) {
      return errorResult(409, "ERR_STALE_ACTION_SEQ", "Hand state has already advanced; action was not re-applied.");
    }

    let nextState;
    try {
      nextState = apply(hand.state, callerSeat.seat_no, {
        type: intent,
        amount: payload.amount
      });
    } catch (err) {
      return errorResult(400, err.code || "ERR_ILLEGAL_ACTION", err.message);
    }

    try {
      await persistHandTransition({
        store,
        table,
        handRow: hand,
        prevState: hand.state,
        nextState,
        seatTimeoutOverrides: { [callerSeat.seat_no]: 0 },
        nowMs
      });
    } catch (err) {
      return mapStoreError(err);
    }

    const publicState = await loadAndBroadcastTableState(store, table.id, callerId, nowMs);
    return { status: 200, body: { ok: true, table: publicState } };
  });
}
