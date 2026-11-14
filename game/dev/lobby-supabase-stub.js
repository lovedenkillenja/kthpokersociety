// Offline stand-in for game/lib/supabase.js, used only by the lobby design harness through an import map.
// Same export names as the real module; returns fixed mock data and never touches the network.

let variant = "seated";
export function setMockVariant(v) { variant = v === "wallet" ? "wallet" : "seated"; }

const USER = { id: "mock-self", email: "alex@example.test", created_at: "2026-09-01T10:00:00Z", user_metadata: {} };
const NOW = Date.parse("2026-11-14T09:30:00Z");
const hoursAgo = (h) => new Date(NOW - h * 3600_000).toISOString();

const client = {
  auth: {
    onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
    async getSession() { return { data: { session: { user: USER } } }; },
    async signOut() { return { error: null }; }
  }
};

export function getSupabaseClient() { return client; }

export async function fetchMemberRecord() {
  return { id: USER.id, full_name: "Alex Example", email: USER.email, program: "CDATE", study_year: 2, created_at: "2026-09-01T10:00:00Z" };
}
export async function ensureChipProfile() {
  return { member_id: USER.id, display_name: "Alex", show_on_leaderboard: true };
}
export async function saveChipProfile(_id, { displayName, showOnLeaderboard }) {
  return { data: { member_id: USER.id, display_name: displayName, show_on_leaderboard: showOnLeaderboard }, error: null };
}
export async function fetchChipBalance() { return variant === "wallet" ? 1250 : 0; }
export async function fetchMySeatedTables() {
  if (variant !== "seated") return { seats: [], tables: [], error: null };
  return {
    seats: [
      { table_id: "t1", seat_no: 0, member_id: USER.id, stack: 500, status: "active" },
      { table_id: "t2", seat_no: 2, member_id: USER.id, stack: 500, status: "sitout" }
    ],
    tables: [
      { id: "t1", code: "DEMO1", status: "playing", sb: 5, bb: 10 },
      { id: "t2", code: "DEMO2", status: "waiting", sb: 1, bb: 2 }
    ],
    error: null
  };
}
export async function fetchRecentLedger() {
  return [
    { id: 1, delta: -500, reason: "Buy-in at table DEMO2", source: "table", created_at: hoursAgo(2) },
    { id: 2, delta: -500, reason: "Buy-in at table DEMO1", source: "table", created_at: hoursAgo(5) },
    { id: 3, delta: 1000, reason: "Welcome stack", source: "welcome", created_at: hoursAgo(72) }
  ];
}
export async function fetchLeaderboard() {
  const names = ["Sam", "Robin", "Kim", "Alex", "Noa", "Jules", "Ari", "Dana"];
  const balances = [4820, 3910, 3250, 2740, 2105, 1760, 1300, 980];
  return { rows: names.map((n, i) => ({ rank: i + 1, display_name: n, balance: balances[i] })), error: null };
}
export async function fetchMyReferral() {
  return { code: "K7M4PQ2X", invitedCount: 3, rewardedCount: 2, totalEarned: 500, error: null };
}
export async function redeemReferralCode() { return { status: "error", error: null }; }
export async function claimReferralRewards() { return { chipsPaid: 0, error: null }; }
