// Client API and Realtime subscription manager for the deployed `table` and `act` Edge Functions
// and `public.hole_cards` RLS queries.

import { SUPABASE_URL, SUPABASE_KEY } from "../config.js";
import { getSupabaseClient } from "./supabase.js";
import { friendlyTableError } from "./table-helpers.js";

const holeCardsCache = new Map();
let unauthorizedHandler = null;

/**
 * Registers a callback invoked whenever an Edge Function call fails with 401 / ERR_UNAUTHORIZED.
 */
export function setUnauthorizedHandler(fn) {
  unauthorizedHandler = typeof fn === "function" ? fn : null;
}

/**
 * Retrieves the current user's JWT access token from the active Supabase session,
 * attempting a one-time refresh if the session is missing or near expiry.
 */
async function getAccessToken({ forceRefresh = false } = {}) {
  const sb = getSupabaseClient();
  if (!sb) return null;
  if (!forceRefresh) {
    const { data } = await sb.auth.getSession();
    if (data?.session?.access_token) {
      return data.session.access_token;
    }
  }
  if (typeof sb.auth.refreshSession === "function") {
    try {
      const { data: refreshed } = await sb.auth.refreshSession();
      if (refreshed?.session?.access_token) {
        return refreshed.session.access_token;
      }
    } catch (_err) {
      // Fall through
    }
  }
  return null;
}

/**
 * Invokes a deployed Supabase Edge Function (`table` or `act`) with the signed-in member's JWT.
 * Returns `{ ok, status, code, error, table, pendingCashout }`.
 */
async function callEdgeFunction(fnName, payload, { isRetry = false } = {}) {
  const token = await getAccessToken({ forceRefresh: isRetry });
  if (!token) {
    const errMsg = friendlyTableError({ status: 401, code: "ERR_UNAUTHORIZED" });
    if (unauthorizedHandler) unauthorizedHandler(errMsg);
    return {
      ok: false,
      status: 401,
      code: "ERR_UNAUTHORIZED",
      error: errMsg
    };
  }

  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/${fnName}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(payload || {})
    });

    if (response.status === 401 && !isRetry) {
      return callEdgeFunction(fnName, payload, { isRetry: true });
    }

    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.ok === false) {
      const code = body?.code || (response.status === 401 ? "ERR_UNAUTHORIZED" : "ERR_REQUEST_FAILED");
      const rawError = body?.error || body?.message || "";
      const friendly = friendlyTableError({
        code,
        status: response.status,
        error: rawError
      });
      if (response.status === 401 || code === "ERR_UNAUTHORIZED") {
        if (unauthorizedHandler) unauthorizedHandler(friendly);
      }
      return {
        ok: false,
        status: response.status,
        code,
        error: friendly
      };
    }

    return {
      ok: true,
      status: response.status,
      table: body.table || null,
      pendingCashout: Boolean(body.pendingCashout),
      timedOut: Boolean(body.timedOut),
      timedOutSeatNo: body.timedOutSeatNo ?? null,
      satOut: Boolean(body.satOut)
    };
  } catch (_err) {
    return {
      ok: false,
      status: 0,
      code: "ERR_NETWORK",
      error: friendlyTableError({ status: 0, code: "ERR_NETWORK" })
    };
  }
}

/**
 * Creates a new poker table via the `table` Edge Function (`intent: "create"`).
 */
export async function createTable({
  sb = 5,
  bb = 10,
  minBuyIn = 200,
  maxBuyIn = 1000,
  maxSeats = 6,
  buyIn = 500,
  seat = 0
} = {}) {
  return callEdgeFunction("table", {
    intent: "create",
    sb,
    bb,
    minBuyIn,
    maxBuyIn,
    maxSeats,
    buyIn,
    seat
  });
}

/**
 * Joins an existing table by 5-character code (`intent: "join"`).
 * If the member is already seated at the table (`ERR_ALREADY_SEATED`), automatically
 * falls back to `fetchTableState(code)` so reconnecting by code works seamlessly.
 */
export async function joinTable({ code, buyIn, seat } = {}) {
  const cleanCode = String(code || "").toUpperCase().trim();
  const payload = {
    intent: "join",
    table: cleanCode,
    buyIn
  };
  if (seat !== undefined && seat !== null) {
    payload.seat = seat;
  }

  const res = await callEdgeFunction("table", payload);
  if (!res.ok && res.code === "ERR_ALREADY_SEATED") {
    return fetchTableState(cleanCode);
  }
  return res;
}

/**
 * Fetches the current public state of a table (`intent: "state"`).
 */
export async function fetchTableState(codeOrId) {
  return callEdgeFunction("table", {
    intent: "state",
    table: String(codeOrId || "").toUpperCase().trim()
  });
}

/**
 * Leaves a table and cashes out the player's stack back to `chip_ledger` (`intent: "leave"`).
 */
export async function leaveTable(codeOrId) {
  return callEdgeFunction("table", {
    intent: "leave",
    table: String(codeOrId || "").toUpperCase().trim()
  });
}

/**
 * Closes an empty table (`intent: "close"`), callable only by the table host.
 */
export async function closeTable(codeOrId) {
  return callEdgeFunction("table", {
    intent: "close",
    table: String(codeOrId || "").toUpperCase().trim()
  });
}

/**
 * Toggles a seated player's status between `"sit-in"` (`active`) and `"sit-out"` (`sitout`).
 */
export async function setTableSeatStatus(codeOrId, intent = "sit-in") {
  return callEdgeFunction("table", {
    intent,
    table: String(codeOrId || "").toUpperCase().trim()
  });
}

/**
 * Evaluates and enforces any expired 30-second turn deadline on the server (`intent: "tick"`).
 */
export async function tickTable(codeOrId) {
  return callEdgeFunction("act", {
    intent: "tick",
    table: String(codeOrId || "").toUpperCase().trim()
  });
}

/**
 * Starts a new hand at the table via the `act` Edge Function (`intent: "start"`).
 */
export async function startHand(codeOrId) {
  return callEdgeFunction("act", {
    intent: "start",
    table: String(codeOrId || "").toUpperCase().trim()
  });
}

/**
 * Sends a betting action (`fold`, `check`, `call`, `raise`, `all-in`) to the `act` Edge Function
 * with `handId` and `actionSeq` for replay and concurrency protection.
 */
export async function sendHandAction({
  table,
  intent,
  handId,
  actionSeq,
  amount
}) {
  const payload = {
    table: String(table || "").toUpperCase().trim(),
    intent,
    handId,
    actionSeq: Number(actionSeq ?? 0)
  };
  if (amount !== undefined && amount !== null) {
    payload.amount = Math.trunc(Number(amount));
  }
  return callEdgeFunction("act", payload);
}

/**
 * Fetches the signed-in member's private hole cards for `handId` from `public.hole_cards` via RLS.
 */
export async function fetchOwnHoleCards(handId, userId) {
  if (!handId || !userId) return null;
  const cacheKey = `${handId}:${userId}`;
  if (holeCardsCache.has(cacheKey)) {
    return holeCardsCache.get(cacheKey);
  }

  const sb = getSupabaseClient();
  if (!sb) return null;

  try {
    const { data, error } = await sb
      .from("hole_cards")
      .select("hand_id, cards")
      .eq("hand_id", handId)
      .eq("member_id", userId)
      .maybeSingle();

    if (!error && Array.isArray(data?.cards) && data.cards.length === 2) {
      holeCardsCache.set(cacheKey, data.cards);
      return data.cards;
    }
  } catch (_err) {
    // Will retry on next state update
  }
  return null;
}

/**
 * Subscribes to Realtime broadcast channel `table:<code>` and pairs it with automatic
 * `"state"` intent fallback polling + tab-wakeup resync.
 */
export function subscribeToTableChannel(tableCode, { onState, onConnectionChange } = {}) {
  const code = String(tableCode || "").toUpperCase().trim();
  const sb = getSupabaseClient();
  let stopped = false;
  let channel = null;
  let pollTimer = null;
  let pollInFlight = false;

  async function triggerFallbackStateFetch() {
    if (stopped || pollInFlight) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      if (typeof onConnectionChange === "function") onConnectionChange("OFFLINE");
      return;
    }
    pollInFlight = true;
    try {
      const res = await fetchTableState(code);
      if (stopped) return;
      if (res.ok && res.table) {
        if (typeof onConnectionChange === "function") onConnectionChange("ONLINE");
        if (typeof onState === "function") onState(res.table, "poll");
      } else if (res.code === "ERR_NETWORK" || res.status === 0) {
        if (typeof onConnectionChange === "function") onConnectionChange("OFFLINE");
      } else if (res.code === "ERR_UNAUTHORIZED" || res.status === 401) {
        if (typeof onConnectionChange === "function") onConnectionChange("UNAUTHORIZED");
      }
    } finally {
      pollInFlight = false;
    }
  }

  if (sb && code) {
    channel = sb.channel(`table:${code}`);
    channel
      .on("broadcast", { event: "state" }, (msg) => {
        if (!stopped && msg?.payload && typeof onState === "function") {
          if (typeof onConnectionChange === "function") onConnectionChange("ONLINE");
          onState(msg.payload, "broadcast");
        }
      })
      .on("broadcast", { event: "table_state" }, (msg) => {
        if (!stopped && msg?.payload && typeof onState === "function") {
          if (typeof onConnectionChange === "function") onConnectionChange("ONLINE");
          onState(msg.payload, "broadcast");
        }
      })
      .subscribe((status) => {
        if (stopped) return;
        if (typeof onConnectionChange === "function") {
          onConnectionChange(status);
        }
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          triggerFallbackStateFetch();
        }
      });
  }

  // Fallback `"state"` sync every 3.5s while the tab is visible so missed mobile broadcasts recover automatically
  pollTimer = window.setInterval(() => {
    if (document.visibilityState === "visible") {
      triggerFallbackStateFetch();
    }
  }, 3500);

  function handleVisibilityChange() {
    if (!stopped && document.visibilityState === "visible") {
      triggerFallbackStateFetch();
    }
  }
  function handleOffline() {
    if (!stopped && typeof onConnectionChange === "function") {
      onConnectionChange("OFFLINE");
    }
  }
  function handleOnline() {
    if (!stopped) {
      triggerFallbackStateFetch();
    }
  }
  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("offline", handleOffline);
  window.addEventListener("online", handleOnline);

  return {
    refreshNow: triggerFallbackStateFetch,
    unsubscribe() {
      stopped = true;
      if (pollTimer) {
        window.clearInterval(pollTimer);
        pollTimer = null;
      }
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
      if (sb && channel) {
        sb.removeChannel(channel).catch(() => {});
        channel = null;
      }
    }
  };
}
