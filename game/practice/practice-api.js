// Practice stand-in for game/lib/poker-api.js, swapped in by the import map in practice/index.html.
// Same exports and result shapes as the real module, backed by the in-browser practice server
// (game/lib/practice-server.js). No network, no Supabase, no chip ledger.

let server = null;
const channelListeners = new Set();
let unsubscribeServer = null;

const noSession = () => ({ ok: false, status: 410, code: "ERR_TABLE_CLOSED", error: "Start a practice session first." });

/** Points every API call (and the table's state channel) at a practice server, or at nothing. */
export function setPracticeServer(next) {
  if (unsubscribeServer) unsubscribeServer();
  unsubscribeServer = null;
  server = next || null;
  if (server) {
    unsubscribeServer = server.subscribe((state) => {
      channelListeners.forEach((fn) => fn(state));
    });
  }
}

export function setUnauthorizedHandler() {}

export async function createTable() {
  return server ? server.stateResult() : noSession();
}

export async function joinTable() {
  return server ? server.stateResult() : noSession();
}

export async function fetchTableState() {
  return server ? server.stateResult() : noSession();
}

/** Leaving practice never cashes anything out: the page handles navigation itself. */
export async function leaveTable() {
  return { ok: true, status: 200, table: null, pendingCashout: false, timedOut: false, timedOutSeatNo: null, satOut: false };
}

export async function closeTable() {
  return { ok: false, status: 400, code: "ERR_INVALID_ARGS", error: "Practice tables close when you leave." };
}

export async function setTableSeatStatus(_code, intent = "sit-in") {
  return server ? server.setSeatStatus(intent) : noSession();
}

export async function tickTable() {
  return server ? server.tick() : noSession();
}

export async function startHand() {
  return server ? server.startHand() : noSession();
}

export async function sendHandAction({ intent, handId, actionSeq, amount } = {}) {
  return server ? server.act({ intent, handId, actionSeq, amount }) : noSession();
}

/** Same contract as the real one: two card codes for the player's own seat, or null. */
export async function fetchOwnHoleCards(handId, userId) {
  if (!server || !handId || userId !== server.selfId) return null;
  return server.getOwnHoleCards(handId);
}

export function subscribeToTableChannel(_tableCode, { onState, onConnectionChange } = {}) {
  let stopped = false;
  const listener = (state) => {
    if (!stopped && typeof onState === "function") onState(state, "broadcast");
  };
  channelListeners.add(listener);
  queueMicrotask(() => {
    if (!stopped && typeof onConnectionChange === "function") onConnectionChange("SUBSCRIBED");
  });
  return {
    refreshNow() {
      if (server) listener(server.getState());
    },
    unsubscribe() {
      stopped = true;
      channelListeners.delete(listener);
    }
  };
}
