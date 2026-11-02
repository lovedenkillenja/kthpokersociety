// Core request handlers for the `table` and `act` Supabase Edge Functions.
// Pure ES module using an injected `store` interface so it runs identically
// in Deno (production Edge Functions) and Node (`node --test` unit tests).

import { newHand, apply, cryptoRng } from "./engine/index.js";
import {
  withTableLock,
  generateRoomCode,
  errorResult,
  mapStoreError,
  buildPublicTableState,
  authenticateCaller,
  foldSeatInHandState,
  persistHandTransition,
  loadAndBroadcastTableState
} from "./state-helpers.js";

export { withTableLock, generateRoomCode, buildPublicTableState };

/**
 * Handles `table` Edge Function intents: `create`, `join`, `leave`, `state`.
 */
export async function handleTableRequest({ store, jwt, payload = {}, rng = cryptoRng }) {
  const auth = await authenticateCaller(store, jwt, payload);
  if (auth.error) return auth.error;
  const callerId = auth.user.id;

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
      } catch (_err) {
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

    const publicState = await loadAndBroadcastTableState(store, createdTable.id, callerId);
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
    const { table, seats, hand } = ctx;

    if (intent === "state" || intent === "get") {
      const publicState = buildPublicTableState({
        table,
        seats,
        displayNamesByMemberId: ctx.displayNamesByMemberId,
        handRow: hand,
        callerMemberId: callerId
      });
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

      const publicState = await loadAndBroadcastTableState(store, table.id, callerId);
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
            nextState
          });
        } catch (err) {
          return mapStoreError(err);
        }
      }

      if (handStillRunning) {
        await store.updateSeatStatus(table.id, callerSeat.seat_no, "sitout");
        const publicState = await loadAndBroadcastTableState(store, table.id, callerId);
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

      const publicState = await loadAndBroadcastTableState(store, table.id, callerId);
      return { status: 200, body: { ok: true, table: publicState } };
    }

    return errorResult(400, "ERR_UNKNOWN_INTENT", `Unknown table intent "${intent}".`);
  });
}

/**
 * Handles `act` Edge Function intents:
 * `start`, `fold`, `check`, `call`, `raise`, `bet`, `all-in` (plus `join`/`leave`/`state`).
 */
export async function handleActRequest({ store, jwt, payload = {}, rng = cryptoRng }) {
  const intent = String(payload?.intent || payload?.action || "").toLowerCase().trim();

  if (intent === "create" || intent === "join" || intent === "leave" || intent === "state") {
    return handleTableRequest({ store, jwt, payload: { ...payload, intent }, rng });
  }

  const auth = await authenticateCaller(store, jwt, payload);
  if (auth.error) return auth.error;
  const callerId = auth.user.id;

  const tableRef = payload?.table ?? payload?.tableId ?? payload?.code;
  if (!tableRef) {
    return errorResult(400, "ERR_MISSING_TABLE", "Table code or ID is required.");
  }

  return withTableLock(tableRef, async () => {
    const ctx = await store.getTableContext(tableRef);
    if (!ctx || !ctx.table) {
      return errorResult(404, "ERR_TABLE_NOT_FOUND", "Table not found.");
    }
    const { table, seats, hand, displayNamesByMemberId } = ctx;

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

      const endedAt = handState.status === "complete" ? new Date().toISOString() : null;
      const insertedHand = await store.insertHand({
        tableId: table.id,
        handNo: nextHandNo,
        dealerSeat: handState.dealerSeat,
        board: handState.board,
        pot: handState.pot,
        state: handState,
        showdown: handState.showdownResult || null,
        endedAt
      });

      const holeCardRows = handState.seats.map((p) => ({
        hand_id: insertedHand.id,
        member_id: p.id,
        cards: p.holeCards
      }));
      await store.insertHoleCards(holeCardRows);

      await store.syncSeatStacks(
        table.id,
        handState.seats.map((p) => ({ seatNo: p.seat, stack: p.stack }))
      );

      const initialActions = handState.actions.map((a) => ({
        hand_id: insertedHand.id,
        seat_no: a.seat,
        action: a.type,
        amount: a.amount
      }));
      if (initialActions.length > 0) {
        await store.insertHandActions(initialActions);
      }

      await store.updateTableStatus(table.id, handState.status === "complete" ? "open" : "playing");

      const publicState = await loadAndBroadcastTableState(store, table.id, callerId);
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
        nextState
      });
    } catch (err) {
      return mapStoreError(err);
    }

    const publicState = await loadAndBroadcastTableState(store, table.id, callerId);
    return { status: 200, body: { ok: true, table: publicState } };
  });
}
