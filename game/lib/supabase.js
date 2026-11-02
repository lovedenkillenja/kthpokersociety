// Supabase client wrapper for KTH Poker Society.
// Handles member authentication, profile management (`chip_profiles`),
// read-only chip balance/ledger queries (`chip_balances`, `chip_ledger`),
// and server RPCs (`claim_daily_chips`, `get_leaderboard`).
// Never writes to `chip_ledger` from the browser.

import { SUPABASE_URL, SUPABASE_KEY, GAME_CONFIG } from "../config.js";
import { deriveDefaultDisplayName, interpretDailyClaimResult } from "./format.js";

let clientInstance = null;

/**
 * Returns the shared Supabase client instance.
 */
export function getSupabaseClient() {
  if (clientInstance) return clientInstance;
  const globalSb = typeof window !== "undefined" ? window.supabase : null;
  if (!globalSb || typeof globalSb.createClient !== "function") {
    return null;
  }
  try {
    clientInstance = globalSb.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    });
  } catch (_err) {
    clientInstance = null;
  }
  return clientInstance;
}

/**
 * Fetches the member record from `public.members` for the signed-in user.
 */
export async function fetchMemberRecord(user) {
  if (!user) return null;
  const sb = getSupabaseClient();
  const meta = user.user_metadata || {};
  const fallback = {
    id: user.id,
    full_name: meta.full_name || user.email || "KTH Member",
    email: user.email || "",
    program: meta.program || "",
    study_year: meta.study_year || "",
    created_at: user.created_at || new Date().toISOString()
  };
  if (!sb) return fallback;

  try {
    const { data, error } = await sb
      .from("members")
      .select("id, full_name, email, program, study_year, created_at")
      .eq("id", user.id)
      .maybeSingle();
    if (!error && data) {
      return {
        id: data.id,
        full_name: data.full_name || fallback.full_name,
        email: data.email || fallback.email,
        program: data.program || "",
        study_year: data.study_year || "",
        created_at: data.created_at || fallback.created_at
      };
    }
  } catch (_err) {
    // Fall back to auth user metadata if query fails
  }
  return fallback;
}

/**
 * Loads the member's `chip_profiles` row, creating a default row if none exists yet.
 */
export async function ensureChipProfile(user, member) {
  const sb = getSupabaseClient();
  const defaultName = deriveDefaultDisplayName(member?.full_name, user?.email);
  const fallbackProfile = {
    member_id: user.id,
    display_name: defaultName,
    show_on_leaderboard: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  if (!sb || !user) return fallbackProfile;

  const { data: existing, error: selectErr } = await sb
    .from("chip_profiles")
    .select("member_id, display_name, show_on_leaderboard, created_at, updated_at")
    .eq("member_id", user.id)
    .maybeSingle();

  if (!selectErr && existing) {
    return existing;
  }

  // Create initial chip profile for this member
  const { data: inserted, error: insertErr } = await sb
    .from("chip_profiles")
    .upsert(
      {
        member_id: user.id,
        display_name: defaultName,
        show_on_leaderboard: true
      },
      { onConflict: "member_id" }
    )
    .select("member_id, display_name, show_on_leaderboard, created_at, updated_at")
    .maybeSingle();

  if (!insertErr && inserted) {
    return inserted;
  }
  return fallbackProfile;
}

/**
 * Updates the signed-in member's `chip_profiles` display name and leaderboard opt-in.
 */
export async function saveChipProfile(userId, { displayName, showOnLeaderboard }) {
  const sb = getSupabaseClient();
  if (!sb) {
    return { data: null, error: new Error("Failed to fetch") };
  }
  return sb
    .from("chip_profiles")
    .upsert(
      {
        member_id: userId,
        display_name: displayName,
        show_on_leaderboard: Boolean(showOnLeaderboard),
        updated_at: new Date().toISOString()
      },
      { onConflict: "member_id" }
    )
    .select("member_id, display_name, show_on_leaderboard, created_at, updated_at")
    .single();
}

/**
 * Reads the signed-in member's chip balance from the `public.chip_balances` view.
 */
export async function fetchChipBalance(userId) {
  const sb = getSupabaseClient();
  if (!sb || !userId) return 0;
  const { data, error } = await sb
    .from("chip_balances")
    .select("balance")
    .eq("member_id", userId)
    .maybeSingle();

  if (error || !data) return 0;
  const n = Number(data.balance);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/**
 * Reads the signed-in member's recent `chip_ledger` entries (newest first).
 */
export async function fetchRecentLedger(userId, limit = GAME_CONFIG.recentLedgerLimit) {
  const sb = getSupabaseClient();
  if (!sb || !userId) return [];
  const { data, error } = await sb
    .from("chip_ledger")
    .select("id, delta, reason, source, ref, created_at")
    .eq("member_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error || !Array.isArray(data)) return [];
  return data;
}

/**
 * Calls the server-side `claim_daily_chips()` RPC and refreshes the member's balance and ledger.
 */
export async function claimDailyChipsForMember(userId, previousBalance) {
  const sb = getSupabaseClient();
  if (!sb || !userId) {
    return {
      status: "error",
      delta: 0,
      balance: previousBalance ?? 0,
      ledger: [],
      message: "Connection lost. Check your internet connection and try again."
    };
  }

  const { data: rpcData, error: rpcError } = await sb.rpc("claim_daily_chips");
  const [nextBalance, ledger] = await Promise.all([
    fetchChipBalance(userId),
    fetchRecentLedger(userId)
  ]);

  const interpreted = interpretDailyClaimResult({
    rpcData,
    rpcError,
    previousBalance,
    nextBalance
  });

  return {
    ...interpreted,
    balance: nextBalance,
    ledger
  };
}

/**
 * Calls `get_leaderboard(p_limit)` to fetch opted-in members ranked by chip balance.
 */
export async function fetchLeaderboard(limit = GAME_CONFIG.leaderboardLimit) {
  const sb = getSupabaseClient();
  if (!sb) {
    return { rows: [], error: new Error("Failed to fetch") };
  }
  const { data, error } = await sb.rpc("get_leaderboard", { p_limit: limit });
  if (error) {
    return { rows: [], error };
  }
  return { rows: Array.isArray(data) ? data : [], error: null };
}
