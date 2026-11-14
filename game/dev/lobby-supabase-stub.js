// Offline stand-in for game/lib/supabase.js, used only by the lobby design harness through an import map.
// Same export names as the real module; returns fixed mock data and never touches the network.

let variant = "seated";
let noTables = false;
export function setMockVariant(v, opts = {}) { variant = v === "wallet" ? "wallet" : "seated"; noTables = Boolean(opts.noTables); }

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
// Open tables (?tables=none gives an empty list). Mix: waiting 1/6, playing 4/6, full 6/6, own table, other stakes, one idle-empty (hidden).
export async function fetchOpenTables() {
  if (noTables) return { tables: [], seats: [], error: null };
  const mk = (id, code, status, sb, bb, maxSeats, minAgo) => ({
    id, code, status, sb, bb, min_buyin: bb * 20, max_buyin: bb * 100, max_seats: maxSeats,
    created_at: new Date(NOW - (minAgo + 5) * 60000).toISOString(), last_activity_at: new Date(NOW - minAgo * 60000).toISOString()
  });
  const seat = (t, n, member = `other-${t}-${n}`, status = "active") => ({ table_id: t, member_id: member, status, seat_no: n });
  const tables = [
    mk("o1", "WAIT1", "open", 5, 10, 6, 2),
    mk("o2", "PLAY4", "playing", 5, 10, 6, 1),
    mk("o3", "FULL6", "playing", 10, 20, 6, 3),
    mk("o4", "MICRO", "open", 1, 2, 4, 4),
    mk("o5", "IDLE0", "open", 1, 2, 6, 90),
    ...(variant === "seated" ? [mk("t1", "DEMO1", "playing", 5, 10, 6, 1)] : [])
  ];
  const seats = [
    seat("o1", 0),
    ...[0, 1, 2, 3].map((n) => seat("o2", n)),
    ...[0, 1, 2, 3, 4, 5].map((n) => seat("o3", n)),
    seat("o4", 0), seat("o4", 1, "x", "sitout"),
    ...(variant === "seated" ? [seat("t1", 0, USER.id), seat("t1", 1)] : [])
  ];
  return { tables, seats, error: null };
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
