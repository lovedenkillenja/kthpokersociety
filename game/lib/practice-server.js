// In-browser "server" for practice mode: one player against 1-5 bots on the real engine.
// Pure logic with injectable time and timers, so it runs in Node tests and in the page alike.
// Practice chips live only in this object: nothing is read from or written to the chip ledger,
// and nothing here talks to a network.

import { newHand, apply, checkChipConservation } from "../engine/index.js";
import { buildPracticePublicState, PRACTICE_TURN_TIMEOUT_MS } from "./practice-state.js";
import { buildBotView, decideBotAction, BOT_STYLES, BOT_STYLE_IDS } from "./practice-bots.js";
import { getStakesPreset } from "./stakes.js";

export const PRACTICE_SELF_ID = "practice-self";
export const PRACTICE_TABLE_CODE = "PRACTICE";
export const PRACTICE_BOT_NAMES = Object.freeze(["Alva", "Bo", "Cleo", "Dag", "Elsa"]);
export const MAX_PRACTICE_BOTS = 5;
const MAX_CONSECUTIVE_TIMEOUTS = 2;

let sessionCounter = 0;

function fail(status, code, error) {
  return { ok: false, status, code, error };
}

/** Shuffles a copy of `list` with `rng` (Fisher-Yates). */
function shuffled(list, rng) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Clamps the setup choices to what practice mode supports. */
export function normalizePracticeConfig({ botCount = 3, stakesId = "low", startingStack } = {}) {
  const stakes = getStakesPreset(stakesId);
  const rawBots = Math.trunc(Number(botCount));
  const bots = Number.isFinite(rawBots) ? Math.min(MAX_PRACTICE_BOTS, Math.max(1, rawBots)) : 3;
  const wanted = Math.trunc(Number(startingStack));
  const stack = Number.isFinite(wanted) && wanted > 0
    ? Math.min(stakes.maxBuyIn, Math.max(stakes.minBuyIn, wanted))
    : stakes.maxBuyIn;
  return { botCount: bots, stakes, startingStack: stack };
}

export function createPracticeServer({
  botCount = 3,
  stakesId = "low",
  startingStack = undefined,
  playerName = "Player",
  useClock = false,
  rng = Math.random,
  now = () => Date.now(),
  timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id) },
  botDelayMs = [600, 1600],
  dealPauseMs = 2400,
  showdownPauseMs = 4200,
  firstDealMs = 700,
  botSamples = 200,
  autoDeal = true
} = {}) {
  const config = normalizePracticeConfig({ botCount, stakesId, startingStack });
  const { stakes } = config;
  sessionCounter += 1;
  const sessionId = `${sessionCounter}${Math.floor(rng() * 1e6).toString(36)}`;

  const table = {
    id: `practice-${sessionId}`,
    code: PRACTICE_TABLE_CODE,
    sb: stakes.sb,
    bb: stakes.bb,
    min_buyin: stakes.minBuyIn,
    max_buyin: stakes.maxBuyIn,
    max_seats: config.botCount + 1,
    status: "open",
    host_id: PRACTICE_SELF_ID
  };

  const styleOrder = shuffled(BOT_STYLE_IDS, rng);
  const names = new Map([[PRACTICE_SELF_ID, playerName]]);
  const bots = new Map(); // memberId -> styleId
  const seats = [
    { seat_no: 0, member_id: PRACTICE_SELF_ID, stack: config.startingStack, status: "active", consecutive_timeouts: 0 }
  ];
  for (let i = 0; i < config.botCount; i += 1) {
    const memberId = `practice-bot-${i + 1}`;
    const styleId = styleOrder[i % styleOrder.length];
    bots.set(memberId, styleId);
    names.set(memberId, `${PRACTICE_BOT_NAMES[i]} · ${BOT_STYLES[styleId].label}`);
    seats.push({ seat_no: i + 1, member_id: memberId, stack: config.startingStack, status: "active", consecutive_timeouts: 0 });
  }

  let handRow = null;
  let handNo = 0;
  let dealer = Math.floor(rng() * seats.length);
  let clockOn = Boolean(useClock);
  let timerId = null;
  let destroyed = false;
  let bustNotifiedHandId = null;
  const stateListeners = new Set();
  const eventListeners = new Set();

  const seatByNo = (no) => seats.find((s) => s.seat_no === no);
  const selfSeat = () => seats[0];
  const isBotSeat = (no) => bots.has(seatByNo(no)?.member_id);

  function publicState() {
    return buildPracticePublicState({
      table,
      seats,
      displayNamesByMemberId: names,
      handRow,
      callerMemberId: PRACTICE_SELF_ID,
      nowMs: now()
    });
  }

  function ok() {
    return { ok: true, status: 200, table: publicState(), pendingCashout: false, timedOut: false, timedOutSeatNo: null, satOut: false };
  }

  function emitState() {
    if (destroyed) return;
    const st = publicState();
    stateListeners.forEach((fn) => fn(st));
  }

  function emitEvent(evt) {
    if (destroyed) return;
    eventListeners.forEach((fn) => fn(evt));
  }

  function clearTimer() {
    if (timerId !== null) timers.clear(timerId);
    timerId = null;
  }

  function later(ms, fn) {
    clearTimer();
    timerId = timers.set(() => {
      timerId = null;
      if (!destroyed) fn();
    }, ms);
  }

  function stampTurn(state) {
    const actor = state.actingSeat;
    if (clockOn && state.status === "playing" && actor !== null && actor !== undefined) {
      state.turnStartedAt = now();
      state.turnDeadlineAt = now() + PRACTICE_TURN_TIMEOUT_MS;
    } else {
      state.turnStartedAt = null;
      state.turnDeadlineAt = null;
    }
  }

  function syncSeatStacks(state) {
    for (const p of state.seats) {
      const row = seatByNo(p.seat);
      if (row) row.stack = Math.trunc(Number(p.stack));
    }
  }

  /** Moves the hand to `nextState`, checking chip conservation after every action. */
  function transition(nextState, actionMeta) {
    const prev = handRow.state;
    nextState.actionSeq = Number(prev.actionSeq ?? 0) + 1;
    const turnAdvanced =
      nextState.status !== "playing" ||
      nextState.actingSeat !== prev.actingSeat ||
      nextState.street !== prev.street ||
      !prev.turnDeadlineAt;
    if (turnAdvanced) stampTurn(nextState);
    else {
      nextState.turnStartedAt = prev.turnStartedAt ?? null;
      nextState.turnDeadlineAt = prev.turnDeadlineAt ?? null;
    }
    const cons = checkChipConservation(nextState);
    if (!cons.conserved) throw new Error(`ERR_CHIP_CONSERVATION: delta ${cons.delta}`);
    handRow = { ...handRow, state: nextState };
    syncSeatStacks(nextState);
    table.status = nextState.status === "complete" ? "open" : "playing";
    if (actionMeta) emitEvent({ type: "action", handId: handRow.id, ...actionMeta, street: prev.street });
    if (nextState.status === "complete") {
      emitEvent({ type: "hand-complete", handId: handRow.id, table: publicState() });
    }
    emitState();
    scheduleNext();
  }

  function canDealNow() {
    const active = seats.filter((s) => s.status === "active" && (s.stack > 0 || isBotSeat(s.seat_no)));
    return active.length >= 2;
  }

  function playerBusted() {
    const me = selfSeat();
    return me.status === "active" && me.stack <= 0;
  }

  function scheduleNext() {
    clearTimer();
    if (destroyed) return;
    const state = handRow?.state;
    if (state && state.status === "playing") {
      const actor = state.actingSeat;
      if (actor === null || actor === undefined) return;
      if (isBotSeat(actor)) {
        const [lo, hi] = botDelayMs;
        later(lo + rng() * Math.max(0, hi - lo), () => botAct(actor));
      } else if (clockOn && Number.isFinite(Number(state.turnDeadlineAt))) {
        later(Math.max(0, Number(state.turnDeadlineAt) - now()) + 50, () => tick());
      }
      return;
    }
    if (playerBusted()) {
      const key = handRow?.id || "start";
      if (bustNotifiedHandId !== key) {
        bustNotifiedHandId = key;
        emitEvent({ type: "player-busted" });
      }
      return;
    }
    if (!autoDeal || !canDealNow()) return;
    const pause = !handRow ? firstDealMs : state?.showdownResult ? showdownPauseMs : dealPauseMs;
    later(pause, () => { startHand(); });
  }

  function botAct(seatNo) {
    const state = handRow?.state;
    if (!state || state.status !== "playing" || state.actingSeat !== seatNo) return;
    const styleId = bots.get(seatByNo(seatNo).member_id);
    const decision = decideBotAction(buildBotView(state, seatNo), styleId, rng, { samples: botSamples });
    const before = state.seats.find((p) => p.seat === seatNo);
    let next;
    try {
      next = apply(state, seatNo, decision.type === "raise" ? { type: "raise", amount: decision.amount } : { type: decision.type });
    } catch (_err) {
      // Defensive only: decisions are already mapped onto legalActions.
      next = apply(state, seatNo, { type: state.currentBet > (before?.bet || 0) ? "fold" : "check" });
    }
    const last = next.actions.slice(state.actions.length).find((a) => a.seat === seatNo);
    transition(next, {
      seat: seatNo,
      isSelf: false,
      name: names.get(seatByNo(seatNo).member_id),
      style: styleId,
      action: last?.type || decision.type,
      amount: last?.amount ?? 0,
      allIn: Boolean(last?.allIn || next.seats.find((p) => p.seat === seatNo)?.allIn),
      facedBet: before ? Math.max(0, state.currentBet - before.bet) : 0,
      reason: decision.reason
    });
  }

  function startHand() {
    if (destroyed) return fail(410, "ERR_TABLE_CLOSED", "This practice session has ended.");
    if (handRow?.state?.status === "playing") return fail(409, "ERR_HAND_IN_PROGRESS", "A hand is already in progress.");
    if (playerBusted()) return fail(400, "ERR_INSUFFICIENT_CHIPS", "You are out of practice chips. Rebuy to keep playing.");
    // Busted bots rebuy for free before the deal.
    for (const s of seats) {
      if (isBotSeat(s.seat_no) && s.stack <= 0) {
        s.stack = config.startingStack;
        emitEvent({ type: "bot-rebuy", seat: s.seat_no, name: names.get(s.member_id), amount: config.startingStack });
      }
    }
    const input = seats.map((s) => ({ seat: s.seat_no, id: s.member_id, name: names.get(s.member_id), stack: s.stack, status: s.status }));
    if (input.filter((s) => s.status === "active" && s.stack > 0).length < 2) {
      return fail(400, "ERR_NOT_ENOUGH_PLAYERS", "At least two players with chips are needed.");
    }
    dealer = (dealer + 1) % seats.length;
    const state = newHand(input, dealer, { sb: stakes.sb, bb: stakes.bb }, rng);
    dealer = state.dealerSeat;
    handNo += 1;
    state.actionSeq = 0;
    stampTurn(state);
    handRow = { id: `${table.id}-h${handNo}`, hand_no: handNo, state };
    syncSeatStacks(state);
    table.status = state.status === "complete" ? "open" : "playing";
    emitEvent({ type: "hand-start", handId: handRow.id, handNo });
    if (state.status === "complete") emitEvent({ type: "hand-complete", handId: handRow.id, table: publicState() });
    emitState();
    scheduleNext();
    return ok();
  }

  function act({ intent, handId, actionSeq, amount } = {}) {
    if (destroyed) return fail(410, "ERR_TABLE_CLOSED", "This practice session has ended.");
    const state = handRow?.state;
    if (!state || state.status !== "playing") return fail(409, "ERR_NO_ACTIVE_HAND", "No hand is running.");
    if (handId && handId !== handRow.id) return fail(409, "ERR_STALE_HAND", "That hand is over.");
    if (actionSeq !== undefined && actionSeq !== null && Number(actionSeq) !== Number(state.actionSeq ?? 0)) {
      return fail(409, "ERR_STALE_ACTION_SEQ", "The hand moved on. Try again.");
    }
    if (state.actingSeat !== 0) return fail(409, "ERR_NOT_YOUR_TURN", "It is not your turn yet.");
    const type = String(intent || "").toLowerCase();
    const action = type === "raise" || type === "bet" ? { type: "raise", amount: Math.trunc(Number(amount)) } : { type };
    const before = state.seats.find((p) => p.seat === 0);
    let next;
    try {
      next = apply(state, 0, action);
    } catch (err) {
      return fail(400, err.code || "ERR_ILLEGAL_ACTION", err.message || "That action is not allowed now.");
    }
    selfSeat().consecutive_timeouts = 0;
    const last = next.actions.slice(state.actions.length).find((a) => a.seat === 0);
    transition(next, {
      seat: 0,
      isSelf: true,
      name: playerName,
      action: last?.type || type,
      amount: last?.amount ?? 0,
      allIn: Boolean(last?.allIn),
      facedBet: before ? Math.max(0, state.currentBet - before.bet) : 0
    });
    return ok();
  }

  /** Enforces an expired 30s clock on the player's turn (only when the clock is on). */
  function tick() {
    const state = handRow?.state;
    if (!state || state.status !== "playing" || state.actingSeat !== 0) return { ...ok(), timedOut: false };
    const deadline = Number(state.turnDeadlineAt);
    if (!clockOn || !Number.isFinite(deadline) || now() < deadline) return { ...ok(), timedOut: false };
    const me = selfSeat();
    me.consecutive_timeouts += 1;
    const sitOut = me.consecutive_timeouts >= MAX_CONSECUTIVE_TIMEOUTS || me.status === "sitout";
    if (sitOut) me.status = "sitout";
    const next = apply(state, 0, { type: "timeout", fold: sitOut });
    const last = next.actions.slice(state.actions.length).find((a) => a.seat === 0);
    transition(next, { seat: 0, isSelf: true, name: playerName, action: last?.type || "timeout-fold", amount: 0, timeout: true, facedBet: 0 });
    return { ...ok(), timedOut: true, timedOutSeatNo: 0, satOut: sitOut };
  }

  function setSeatStatus(intent) {
    const me = selfSeat();
    me.status = intent === "sit-out" ? "sitout" : "active";
    if (me.status === "active") me.consecutive_timeouts = 0;
    emitState();
    if (!handRow || handRow.state.status !== "playing") scheduleNext();
    return ok();
  }

  /** Free rebuy for the player once they are out of chips (practice chips only). */
  function rebuy() {
    const me = selfSeat();
    const inHand = handRow?.state?.status === "playing" && handRow.state.seats.some((p) => p.seat === 0 && !p.folded);
    if (me.stack > 0 || inHand) return fail(400, "ERR_INVALID_ARGS", "You still have chips.");
    me.stack = config.startingStack;
    me.status = "active";
    me.consecutive_timeouts = 0;
    bustNotifiedHandId = null;
    emitEvent({ type: "player-rebuy", amount: config.startingStack });
    emitState();
    scheduleNext();
    return ok();
  }

  function setClock(on) {
    clockOn = Boolean(on);
    const state = handRow?.state;
    if (state && state.status === "playing") {
      stampTurn(state);
      emitState();
      scheduleNext();
    }
  }

  return {
    config: { ...config, stakesId: stakes.id },
    code: PRACTICE_TABLE_CODE,
    selfId: PRACTICE_SELF_ID,
    getState: publicState,
    stateResult: ok,
    getOwnHoleCards(handId) {
      if (!handRow || handRow.id !== handId) return null;
      const me = handRow.state.seats.find((p) => p.seat === 0);
      return me ? [...me.holeCards] : null;
    },
    botStyles() {
      return seats.filter((s) => bots.has(s.member_id)).map((s) => ({ seatNo: s.seat_no, name: names.get(s.member_id), style: bots.get(s.member_id) }));
    },
    startHand,
    act,
    tick,
    setSeatStatus,
    rebuy,
    setClock,
    isClockOn: () => clockOn,
    isPlayerBusted: playerBusted,
    /** Runs the next scheduled step: deals the first hand when nothing is running. */
    begin() { scheduleNext(); },
    subscribe(fn) {
      stateListeners.add(fn);
      return () => stateListeners.delete(fn);
    },
    onEvent(fn) {
      eventListeners.add(fn);
      return () => eventListeners.delete(fn);
    },
    /** Internal state for tests: the full hand state (includes hidden cards; never sent to the page UI). */
    _debugHandState: () => handRow?.state || null,
    destroy() {
      destroyed = true;
      clearTimer();
      stateListeners.clear();
      eventListeners.clear();
    },
    isDestroyed: () => destroyed
  };
}
