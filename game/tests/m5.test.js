import test from "node:test";
import assert from "node:assert/strict";
import { createDeck, createSeededRng } from "../engine/index.js";
import { createSupabaseStore } from "../../supabase/functions/_shared/supabase-store.js";
import {
  ACTION_TIMEOUT_MS,
  IDLE_TABLE_TIMEOUT_MS,
  handleTableRequest,
  handleActRequest
} from "../../supabase/functions/_shared/handlers.js";

function buildFixedDeck(prefixCards) {
  const full = createDeck();
  const used = new Set(prefixCards);
  return [...prefixCards, ...full.filter((c) => !used.has(c))];
}

function createM5MockSupabaseAdmin() {
  const rpcCalls = [];
  const users = new Map([
    ["jwt-alice", { id: "11111111-1111-1111-1111-111111111111", email: "alice@kth.se" }],
    ["jwt-bob", { id: "22222222-2222-2222-2222-222222222222", email: "bob@kth.se" }],
    ["jwt-carol", { id: "33333333-3333-3333-3333-333333333333", email: "carol@kth.se" }],
    ["jwt-dave", { id: "44444444-4444-4444-4444-444444444444", email: "dave@kth.se" }]
  ]);

  const chipProfiles = [
    { member_id: "11111111-1111-1111-1111-111111111111", display_name: "Alice K." },
    { member_id: "22222222-2222-2222-2222-222222222222", display_name: "Bob L." },
    { member_id: "33333333-3333-3333-3333-333333333333", display_name: "Carol M." },
    { member_id: "44444444-4444-4444-4444-444444444444", display_name: "Dave N." }
  ];

  const chipLedger = [
    { member_id: "11111111-1111-1111-1111-111111111111", delta: 4000, source: "welcome", ref: "w1" },
    { member_id: "22222222-2222-2222-2222-222222222222", delta: 4000, source: "welcome", ref: "w2" },
    { member_id: "33333333-3333-3333-3333-333333333333", delta: 4000, source: "welcome", ref: "w3" },
    { member_id: "44444444-4444-4444-4444-444444444444", delta: 4000, source: "welcome", ref: "w4" }
  ];

  const pokerTables = [];
  const tableSeats = [];
  const hands = [];
  const holeCards = [];
  const handActions = [];
  let seq = 1;
  let currentClockMs = 1_000_000;

  function setClock(ms) {
    currentClockMs = ms;
  }

  function checkChipConservationSql() {
    const netGameLedger = chipLedger
      .filter((r) => r.source === "game")
      .reduce((s, r) => s + r.delta, 0);
    const activeSeatStacks = tableSeats
      .filter((s) => s.status === "active" || s.status === "sitout")
      .reduce((s, r) => s + r.stack, 0);
    const activeHandPots = hands
      .filter((h) => h.ended_at === null)
      .reduce((s, h) => s + h.pot, 0);

    const rows = [];
    if (netGameLedger + activeSeatStacks + activeHandPots !== 0) {
      rows.push({
        check_name: "global_chip_conservation_mismatch",
        discrepancy: netGameLedger + activeSeatStacks + activeHandPots
      });
    }
    return rows;
  }

  return {
    rpcCalls, pokerTables, tableSeats, hands, holeCards, handActions, chipLedger,
    setClock, getClock: () => currentClockMs, checkChipConservationSql,
    auth: {
      async getUser(jwt) {
        const user = users.get(jwt) || null;
        return { data: { user }, error: user ? null : new Error("Invalid JWT") };
      }
    },
    channel() { return { async send() {} }; },
    async removeChannel() {},
    from(tableName) {
      const filters = [];
      let isCountHead = false, orderCol = null, orderAsc = true, rowLimit = null;
      const executeSelect = () => {
        const src = tableName === "poker_tables" ? pokerTables
          : tableName === "table_seats" ? tableSeats
          : tableName === "hands" ? hands
          : tableName === "chip_profiles" ? chipProfiles : [];
        let rows = src.filter((r) => filters.every((fn) => fn(r)));
        if (orderCol) {
          rows = [...rows].sort((a, b) =>
            orderAsc ? (a[orderCol] > b[orderCol] ? 1 : -1) : a[orderCol] < b[orderCol] ? 1 : -1
          );
        }
        return rowLimit !== null ? rows.slice(0, rowLimit) : rows;
      };
      const builder = {
        select(_c, opts) { if (opts?.count === "exact" && opts?.head) isCountHead = true; return builder; },
        eq(col, val) { filters.push((r) => r[col] === val); return builder; },
        in(col, vals) { const s = new Set(vals); filters.push((r) => s.has(r[col])); return builder; },
        order(col, opts) { orderCol = col; orderAsc = opts?.ascending !== false; return builder; },
        limit(n) { rowLimit = n; return builder; },
        insert(payload) {
          const openForHost = pokerTables.filter(
            (t) => t.host_id === payload.host_id && (t.status === "open" || t.status === "playing")
          ).length;
          if (openForHost >= 3) {
            return {
              select: () => ({
                single: async () => ({
                  data: null, error: new Error("ERR_TOO_MANY_OPEN_TABLES: host already has 3 open tables")
                })
              })
            };
          }
          const nowIso = new Date(currentClockMs).toISOString();
          const row = {
            id: `00000000-0000-0000-0000-${String(seq++).padStart(12, "0")}`,
            ...payload, created_at: nowIso, last_activity_at: nowIso, closed_at: null
          };
          pokerTables.push(row);
          return { select: () => ({ single: async () => ({ data: { ...row }, error: null }) }) };
        },
        async maybeSingle() {
          const rows = executeSelect();
          return { data: rows[0] ? structuredClone(rows[0]) : null, error: null };
        },
        then(resolve, reject) {
          const rows = executeSelect();
          return Promise.resolve(
            isCountHead ? { count: rows.length, error: null } : { data: structuredClone(rows), error: null }
          ).then(resolve, reject);
        }
      };
      return builder;
    },

    async rpc(fnName, args) {
      rpcCalls.push({ fnName, args: structuredClone(args) });
      const nowIso = new Date(currentClockMs).toISOString();

      if (fnName === "close_idle_tables") {
        const nowMs = new Date(args.p_now || nowIso).getTime();
        let closedCount = 0;
        for (const t of pokerTables) {
          if (t.status !== "open" && t.status !== "playing") continue;
          const lastActMs = new Date(t.last_activity_at || t.created_at).getTime();
          const hasSeated = tableSeats.some(
            (s) => s.table_id === t.id && (s.status === "active" || s.status === "sitout" || s.stack > 0)
          );
          const hasOpenHand = hands.some((h) => h.table_id === t.id && h.ended_at === null);
          if (!hasSeated && !hasOpenHand && nowMs - lastActMs >= IDLE_TABLE_TIMEOUT_MS) {
            t.status = "closed";
            t.closed_at = new Date(nowMs).toISOString();
            closedCount += 1;
          }
        }
        return { data: closedCount, error: null };
      }

      if (fnName === "close_table") {
        const table = pokerTables.find((t) => t.id === args.p_table_id);
        if (!table) return { data: null, error: new Error("ERR_TABLE_NOT_FOUND") };
        if (table.host_id !== args.p_host_id) {
          return { data: null, error: new Error("ERR_NOT_HOST: only host can close") };
        }
        if (hands.some((h) => h.table_id === table.id && h.ended_at === null)) {
          return { data: null, error: new Error("ERR_HAND_IN_PROGRESS") };
        }
        if (
          tableSeats.some(
            (s) => s.table_id === table.id && (s.status === "active" || s.status === "sitout" || s.stack > 0)
          )
        ) {
          return { data: null, error: new Error("ERR_TABLE_NOT_EMPTY") };
        }
        table.status = "closed";
        table.closed_at = nowIso;
        table.last_activity_at = nowIso;
        return { data: { ...table }, error: null };
      }

      if (fnName === "set_seat_status") {
        const table = pokerTables.find((t) => t.id === args.p_table_id);
        if (!table) return { data: null, error: new Error("ERR_TABLE_NOT_FOUND") };
        const seat = tableSeats.find(
          (s) => s.table_id === args.p_table_id && s.member_id === args.p_member_id && s.status !== "left"
        );
        if (!seat) return { data: null, error: new Error("ERR_NOT_SEATED") };
        seat.status = args.p_status;
        if (args.p_status === "active") {
          seat.consecutive_timeouts = 0;
        }
        table.last_activity_at = nowIso;
        return { data: { ...seat }, error: null };
      }

      if (fnName === "sit_down") {
        const table = pokerTables.find((t) => t.id === args.p_table_id);
        if (!table) return { data: null, error: new Error("ERR_TABLE_NOT_FOUND") };
        if (table.status === "closed") return { data: null, error: new Error("ERR_TABLE_CLOSED") };
        chipLedger.push({
          member_id: args.p_member_id, delta: -args.p_buyin, source: "game", ref: `buyin:${seq++}`
        });
        const seat = {
          table_id: args.p_table_id, seat_no: args.p_seat_no, member_id: args.p_member_id,
          stack: args.p_buyin, status: "active", consecutive_timeouts: 0, joined_at: nowIso, left_at: null
        };
        const existingIdx = tableSeats.findIndex(
          (s) => s.table_id === args.p_table_id && s.seat_no === args.p_seat_no
        );
        if (existingIdx >= 0) tableSeats[existingIdx] = seat;
        else tableSeats.push(seat);
        table.last_activity_at = nowIso;
        return { data: { ...seat }, error: null };
      }

      if (fnName === "leave_seat") {
        const table = pokerTables.find((t) => t.id === args.p_table_id);
        const seat = tableSeats.find(
          (s) => s.table_id === args.p_table_id && s.member_id === args.p_member_id && s.status !== "left"
        );
        if (!seat) return { data: null, error: new Error("ERR_NOT_SEATED") };
        if (seat.stack > 0) {
          chipLedger.push({
            member_id: args.p_member_id, delta: seat.stack, source: "game", ref: `cashout:${seq++}`
          });
        }
        Object.assign(seat, { stack: 0, status: "left", consecutive_timeouts: 0, left_at: nowIso });
        if (table) table.last_activity_at = nowIso;
        return { data: { ...seat }, error: null };
      }

      if (fnName === "start_hand_tx") {
        const table = pokerTables.find((t) => t.id === args.p_table_id);
        const handRow = {
          id: `00000000-0000-0000-0000-${String(seq++).padStart(12, "0")}`,
          table_id: args.p_table_id, hand_no: args.p_hand_no, dealer_seat: args.p_dealer_seat,
          board: [...(args.p_board || [])], pot: args.p_pot, state: structuredClone(args.p_state),
          showdown: args.p_showdown ? structuredClone(args.p_showdown) : null,
          started_at: nowIso, ended_at: args.p_ended_at
        };
        for (const st of args.p_seat_stacks || []) {
          const seatNo = st.seatNo ?? st.seat_no;
          const seat = tableSeats.find(
            (s) => s.table_id === args.p_table_id && s.seat_no === seatNo && s.status !== "left"
          );
          seat.stack = st.stack;
          if (st.status) seat.status = st.status;
          if (st.consecutiveTimeouts !== undefined) seat.consecutive_timeouts = st.consecutiveTimeouts;
        }
        hands.push(handRow);
        for (const hc of args.p_hole_cards || []) {
          holeCards.push({ hand_id: handRow.id, member_id: hc.member_id, cards: [...hc.cards] });
        }
        for (const act of args.p_actions || []) {
          handActions.push({
            hand_id: handRow.id, seat_no: act.seat_no, action: act.action, amount: act.amount ?? 0
          });
        }
        table.status = args.p_table_status || "playing";
        table.last_activity_at = nowIso;
        return { data: structuredClone(handRow), error: null };
      }

      if (fnName === "apply_hand_tx") {
        const handRow = hands.find((h) => h.id === args.p_hand_id);
        if (!handRow) return { data: null, error: new Error("ERR_HAND_NOT_FOUND") };
        if (Number(handRow.state?.actionSeq ?? 0) !== Number(args.p_expected_action_seq)) {
          return { data: null, error: new Error("ERR_STALE_ACTION_SEQ") };
        }
        const table = pokerTables.find((t) => t.id === handRow.table_id);
        for (const st of args.p_seat_stacks || []) {
          const seatNo = st.seatNo ?? st.seat_no;
          const seat = tableSeats.find(
            (s) => s.table_id === handRow.table_id && s.seat_no === seatNo && s.status !== "left"
          );
          seat.stack = st.stack;
          if (st.status) seat.status = st.status;
          if (st.consecutiveTimeouts !== undefined) seat.consecutive_timeouts = st.consecutiveTimeouts;
        }
        Object.assign(handRow, {
          board: [...(args.p_board || [])], pot: args.p_pot, state: structuredClone(args.p_state),
          showdown: args.p_showdown ? structuredClone(args.p_showdown) : null, ended_at: args.p_ended_at
        });
        for (const act of args.p_actions || []) {
          handActions.push({
            hand_id: handRow.id, seat_no: act.seat_no, action: act.action, amount: act.amount ?? 0
          });
        }
        if (table) {
          table.status = args.p_table_status || (args.p_ended_at ? "open" : "playing");
          table.last_activity_at = nowIso;
        }
        return { data: structuredClone(handRow), error: null };
      }

      throw new Error(`Unexpected RPC ${fnName}`);
    }
  };
}

test("M5: 4-player table with side pots at showdown and clockwise dealer rotation", async () => {
  const admin = createM5MockSupabaseAdmin();
  const store = createSupabaseStore(admin);
  const now = () => admin.getClock();

  // Alice creates a 6-seat table with 400 chips at seat 0
  const cRes = await handleTableRequest({
    store,
    jwt: "jwt-alice",
    payload: { intent: "create", sb: 10, bb: 20, maxSeats: 6, buyIn: 400, seat: 0 },
    rng: createSeededRng(10),
    now
  });
  const code = cRes.body.table.code;

  // Bob (600), Carol (1000), Dave (1000) join seats 1, 2, 3
  await handleTableRequest({ store, jwt: "jwt-bob", payload: { intent: "join", table: code, buyIn: 600 }, now });
  await handleTableRequest({ store, jwt: "jwt-carol", payload: { intent: "join", table: code, buyIn: 1000 }, now });
  await handleTableRequest({ store, jwt: "jwt-dave", payload: { intent: "join", table: code, buyIn: 1000 }, now });

  // Hand #1: Alice (400) has AA, Bob (600) has KK, Carol (1000) has QQ, Dave (1000) folds
  const deck1 = buildFixedDeck([
    "Ad", "Ac", // Seat 0 (Alice, 400): Quad Aces -> wins Main Pot (3 * 400 + 20 dead = 1200)
    "Kd", "Kc", // Seat 1 (Bob, 600): Kings full -> wins Side Pot 1 (2 * 200 = 400)
    "Qd", "Qc", // Seat 2 (Carol, 1000): Queens -> gets 400 uncalled back
    "7d", "2c", // Seat 3 (Dave, 1000): folds UTG
    "Ah", "As", "Kh", "3c", "4d"
  ]);

  let res = await handleActRequest({
    store,
    jwt: "jwt-alice",
    payload: { table: code, intent: "start" },
    rng: deck1,
    now
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.table.hand.dealerSeat, 0);
  assert.equal(res.body.table.hand.sbSeat, 1);
  assert.equal(res.body.table.hand.bbSeat, 2);
  assert.equal(res.body.table.hand.actingSeat, 3, "UTG (Seat 3) acts first in 4-player hand");

  // Dave (seat 3) folds; Alice (seat 0, 400), Bob (seat 1, 600), Carol (seat 2, 1000) go all-in
  await handleActRequest({ store, jwt: "jwt-dave", payload: { table: code, intent: "fold" }, now });
  await handleActRequest({ store, jwt: "jwt-alice", payload: { table: code, intent: "all-in" }, now });
  await handleActRequest({ store, jwt: "jwt-bob", payload: { table: code, intent: "all-in" }, now });
  res = await handleActRequest({ store, jwt: "jwt-carol", payload: { table: code, intent: "all-in" }, now });

  assert.equal(res.body.table.hand.status, "complete");
  assert.equal(res.body.table.hand.showdown.pots.length, 2, "Main Pot + Side Pot 1");
  assert.equal(res.body.table.hand.showdown.pots[0].amount, 1200);
  assert.equal(res.body.table.hand.showdown.pots[1].amount, 400);
  assert.equal(res.body.table.seats[0].stack, 1200, "Alice triples up to 1200");
  assert.equal(res.body.table.seats[1].stack, 400, "Bob wins 400 side pot");
  assert.equal(res.body.table.seats[2].stack, 400, "Carol retains 400 uncalled");
  assert.equal(res.body.table.seats[3].stack, 1000);
  assert.deepEqual(admin.checkChipConservationSql(), []);

  // Hand #2: Dealer rotates clockwise to Seat 1 (Bob); SB=2 (Carol), BB=3 (Dave), UTG=0 (Alice)
  const res2 = await handleActRequest({
    store,
    jwt: "jwt-bob",
    payload: { table: code, intent: "start" },
    rng: createSeededRng(102),
    now
  });
  assert.equal(res2.status, 200);
  assert.equal(res2.body.table.hand.dealerSeat, 1);
  assert.equal(res2.body.table.hand.sbSeat, 2);
  assert.equal(res2.body.table.hand.bbSeat, 3);
  assert.equal(res2.body.table.hand.actingSeat, 0);
  assert.deepEqual(admin.checkChipConservationSql(), []);
});

test("M5: 30s action timer, atomic timeout-fold, 2x timeout sit-out, skipping sitout on deal, and sit-in", async () => {
  const admin = createM5MockSupabaseAdmin();
  const store = createSupabaseStore(admin);
  const now = () => admin.getClock();

  const cRes = await handleTableRequest({
    store,
    jwt: "jwt-alice",
    payload: { intent: "create", sb: 10, bb: 20, maxSeats: 6, buyIn: 500, seat: 0 },
    rng: createSeededRng(20),
    now
  });
  const code = cRes.body.table.code;
  await handleTableRequest({ store, jwt: "jwt-bob", payload: { intent: "join", table: code, buyIn: 500, seat: 1 }, now });
  await handleTableRequest({ store, jwt: "jwt-carol", payload: { intent: "join", table: code, buyIn: 500, seat: 2 }, now });

  // Start Hand #1 at t = 1_000_000 (Dealer=0 Alice, SB=1 Bob, BB=2 Carol, UTG=0 Alice acts first)
  admin.setClock(1_000_000);
  let res = await handleActRequest({
    store,
    jwt: "jwt-alice",
    payload: { table: code, intent: "start" },
    rng: createSeededRng(21),
    now
  });
  assert.equal(res.body.table.hand.actingSeat, 0);
  assert.equal(res.body.table.hand.turnDeadlineAt, 1_000_000 + ACTION_TIMEOUT_MS);

  // Tick at +15s (before 30s deadline) -> no timeout
  admin.setClock(1_015_000);
  let tickRes = await handleActRequest({
    store,
    jwt: "jwt-bob",
    payload: { table: code, intent: "tick" },
    now
  });
  assert.equal(tickRes.body.timedOut, false);
  assert.equal(tickRes.body.table.hand.actingSeat, 0);

  // Tick at +31s -> Alice (Seat 0) times out facing 20 BB -> folded, logged as `timeout-fold`, consecutive_timeouts = 1
  admin.setClock(1_031_000);
  tickRes = await handleActRequest({
    store,
    jwt: "jwt-bob",
    payload: { table: code, intent: "tick" },
    now
  });
  assert.equal(tickRes.body.timedOut, true);
  assert.equal(tickRes.body.timedOutSeatNo, 0);
  assert.equal(tickRes.body.satOut, false);
  assert.equal(tickRes.body.table.seats[0].folded, true);
  assert.equal(tickRes.body.table.seats[0].consecutiveTimeouts, 1);
  assert.equal(tickRes.body.table.hand.actingSeat, 1, "Turn advances to Bob (SB)");
  assert.equal(
    admin.handActions.some((a) => a.seat_no === 0 && a.action === "timeout-fold"),
    true,
    "hand_actions must record timeout-fold"
  );

  // Bob (Seat 1, SB) calls 20 -> now Carol (Seat 2, BB) has a free check option (`canCheck: true`)
  await handleActRequest({ store, jwt: "jwt-bob", payload: { table: code, intent: "call" }, now });

  // Carol times out at +62s -> since checking is free, server checks for Carol and advances to Flop!
  admin.setClock(1_062_000);
  tickRes = await handleActRequest({
    store,
    jwt: "jwt-bob",
    payload: { table: code, intent: "tick" },
    now
  });
  assert.equal(tickRes.body.timedOut, true);
  assert.equal(tickRes.body.timedOutSeatNo, 2);
  assert.equal(tickRes.body.table.seats[2].folded, false, "Free check on timeout must not fold");
  assert.equal(tickRes.body.table.hand.street, "flop");
  const carolActions = admin.handActions.filter((a) => a.seat_no === 2).map((a) => a.action);
  assert.equal(carolActions.includes("check"), true, "A timed-out free check is stored as `check`");
  assert.equal(carolActions.includes("timeout-fold"), false, "A timed-out check must not be stored as `timeout-fold`");

  // Bob folds on flop to finish Hand #1 quickly
  await handleActRequest({ store, jwt: "jwt-bob", payload: { table: code, intent: "fold" }, now });

  // Start Hand #2 (Dealer=1 Bob, SB=2 Carol, BB=0 Alice, UTG=1 Bob acts first)
  admin.setClock(2_000_000);
  await handleActRequest({
    store,
    jwt: "jwt-bob",
    payload: { table: code, intent: "start" },
    rng: createSeededRng(22),
    now
  });
  // Bob folds, Carol calls 20 -> now Alice (Seat 0, BB, who already has consecutiveTimeouts = 1) is on the clock
  await handleActRequest({ store, jwt: "jwt-bob", payload: { table: code, intent: "fold" }, now });
  await handleActRequest({ store, jwt: "jwt-carol", payload: { table: code, intent: "call" }, now });

  // Alice times out a 2nd time in a row -> consecutiveTimeouts reaches 2 and Alice is set to `sitout`.
  // Although checking is free for her (BB option), the seat is folded because it is being sat out,
  // which leaves Carol alone and ends Hand #2.
  admin.setClock(2_035_000);
  tickRes = await handleActRequest({
    store,
    jwt: "jwt-carol",
    payload: { table: code, intent: "tick" },
    now
  });
  assert.equal(tickRes.body.timedOut, true);
  assert.equal(tickRes.body.timedOutSeatNo, 0);
  assert.equal(tickRes.body.satOut, true);
  assert.equal(tickRes.body.table.seats[0].status, "sitout");
  assert.equal(tickRes.body.table.seats[0].consecutiveTimeouts, 2);
  assert.equal(tickRes.body.table.seats[0].folded, true, "A seat sat out by a timeout is folded even if it could check");
  assert.equal(tickRes.body.table.hand.status, "complete", "Hand #2 ends: only Carol is left");
  assert.equal(tickRes.body.table.hand.payouts[2], 40);
  assert.deepEqual(admin.checkChipConservationSql(), []);

  // Start Hand #3 -> Alice (Seat 0, sitout) is skipped; only Bob (Seat 1) and Carol (Seat 2) are dealt in!
  const h3Res = await handleActRequest({
    store,
    jwt: "jwt-bob",
    payload: { table: code, intent: "start" },
    rng: createSeededRng(23),
    now
  });
  assert.equal(h3Res.status, 200);
  const hand3HoleCards = admin.holeCards.filter((hc) => hc.hand_id === h3Res.body.table.hand.id);
  assert.equal(hand3HoleCards.length, 2, "Only 2 active players dealt hole cards; sitout player skipped");
  assert.equal(
    hand3HoleCards.some((hc) => hc.member_id === "11111111-1111-1111-1111-111111111111"),
    false
  );

  // Alice sits back in (`sit-in`) -> status becomes `active` and consecutiveTimeouts resets to 0
  const sitInRes = await handleTableRequest({
    store,
    jwt: "jwt-alice",
    payload: { table: code, intent: "sit-in" },
    now
  });
  assert.equal(sitInRes.status, 200);
  assert.equal(sitInRes.body.table.seats[0].status, "active");
  assert.equal(sitInRes.body.table.seats[0].consecutiveTimeouts, 0);
  assert.deepEqual(admin.checkChipConservationSql(), []);
});

// Allowed values of the `hand_actions.action` check constraint (supabase/migrations/20261102012000_poker_tables.sql)
const HAND_ACTION_LABELS = new Set([
  "post-sb", "post-bb", "fold", "check", "call", "bet", "raise", "all-in", "timeout-fold", "showdown", "win"
]);

test("M5: a sitout seat still in the hand can act, and is folded (not auto-checked) when it times out", async () => {
  const admin = createM5MockSupabaseAdmin();
  const store = createSupabaseStore(admin);
  const now = () => admin.getClock();
  const ALICE = "11111111-1111-1111-1111-111111111111";
  const BOB = "22222222-2222-2222-2222-222222222222";

  const cRes = await handleTableRequest({
    store, jwt: "jwt-alice",
    payload: { intent: "create", sb: 10, bb: 20, maxSeats: 6, buyIn: 500, seat: 0 },
    rng: createSeededRng(30), now
  });
  const code = cRes.body.table.code;
  await handleTableRequest({ store, jwt: "jwt-bob", payload: { intent: "join", table: code, buyIn: 500, seat: 1 }, now });

  // Heads-up: dealer seat 0 (Alice) posts SB and acts first; Bob is BB
  admin.setClock(5_000_000);
  let res = await handleActRequest({ store, jwt: "jwt-alice", payload: { table: code, intent: "start" }, rng: createSeededRng(31), now });
  assert.equal(res.body.table.hand.actingSeat, 0);
  res = await handleActRequest({ store, jwt: "jwt-alice", payload: { table: code, intent: "call" }, now });
  assert.equal(res.status, 200);
  assert.equal(res.body.table.hand.actingSeat, 1);

  // Bob ends up `sitout` while still dealt into the running hand (as happened under the old timeout rule)
  admin.tableSeats.find((s) => s.member_id === BOB).status = "sitout";

  // (b) The server still accepts Bob's action in this hand, and the public state marks him as in the hand
  const stateRes = await handleTableRequest({ store, jwt: "jwt-bob", payload: { table: code, intent: "state" }, now });
  const bobSeat = stateRes.body.table.seats.find((s) => s.seatNo === 1);
  assert.equal(bobSeat.status, "sitout");
  assert.equal(bobSeat.inHand, true);
  assert.equal(stateRes.body.table.hand.legalActions.canCheck, true);
  res = await handleActRequest({ store, jwt: "jwt-bob", payload: { table: code, intent: "check" }, now });
  assert.equal(res.status, 200, "A sitout seat that is still in the hand may act");
  assert.equal(res.body.table.hand.street, "flop");

  // Flop: Bob (non-dealer) acts first. He is still `sitout`, so his timeout folds although a check is free.
  const flopDeadline = res.body.table.hand.turnDeadlineAt;
  assert.equal(res.body.table.hand.actingSeat, 1);
  admin.setClock(flopDeadline + 1);
  const tickRes = await handleActRequest({ store, jwt: "jwt-alice", payload: { table: code, intent: "tick" }, now });
  assert.equal(tickRes.body.timedOut, true);
  assert.equal(tickRes.body.timedOutSeatNo, 1);
  assert.equal(tickRes.body.satOut, true);
  assert.equal(tickRes.body.table.seats.find((s) => s.seatNo === 1).folded, true);
  assert.equal(tickRes.body.table.hand.status, "complete", "Only Alice is left, so the hand ends at once");
  assert.equal(tickRes.body.table.hand.payouts[0], 40);
  assert.equal(admin.tableSeats.find((s) => s.member_id === ALICE).stack, 520);
  assert.equal(admin.tableSeats.find((s) => s.member_id === BOB).stack, 480);
  assert.deepEqual(admin.checkChipConservationSql(), []);

  const handId = tickRes.body.table.hand.id;
  const bobActions = admin.handActions.filter((a) => a.hand_id === handId && a.seat_no === 1).map((a) => a.action);
  assert.deepEqual(bobActions, ["post-bb", "check", "timeout-fold"]);
  for (const a of admin.handActions) {
    assert.equal(HAND_ACTION_LABELS.has(a.action), true, `hand_actions.action "${a.action}" violates the DB check constraint`);
  }
});

test("M5: two absent players do not auto-check a whole board: the second consecutive timeout folds and ends the hand", async () => {
  const admin = createM5MockSupabaseAdmin();
  const store = createSupabaseStore(admin);
  const now = () => admin.getClock();

  const cRes = await handleTableRequest({
    store, jwt: "jwt-alice",
    payload: { intent: "create", sb: 10, bb: 20, maxSeats: 6, buyIn: 500, seat: 0 },
    rng: createSeededRng(40), now
  });
  const code = cRes.body.table.code;
  await handleTableRequest({ store, jwt: "jwt-bob", payload: { intent: "join", table: code, buyIn: 500, seat: 1 }, now });

  admin.setClock(7_000_000);
  let res = await handleActRequest({ store, jwt: "jwt-alice", payload: { table: code, intent: "start" }, rng: createSeededRng(41), now });
  // Alice (SB, first to act) calls; from here on nobody acts and only clients' ticks move the hand
  res = await handleActRequest({ store, jwt: "jwt-alice", payload: { table: code, intent: "call" }, now });

  let table = res.body.table;
  let ticks = 0;
  while (table.hand.status === "playing" && ticks < 10) {
    admin.setClock(table.hand.turnDeadlineAt + 1);
    const t = await handleActRequest({ store, jwt: "jwt-alice", payload: { table: code, intent: "tick" }, now });
    assert.equal(t.body.timedOut, true);
    table = t.body.table;
    ticks += 1;
    assert.deepEqual(admin.checkChipConservationSql(), []);
  }
  // Bob's BB option times out as a check (timeout 1); on the flop Bob acts first and his 2nd timeout folds him
  assert.equal(table.hand.status, "complete");
  assert.equal(ticks, 2, "The hand ends at the first sit-out instead of running to the river");
  assert.equal(table.hand.board.length, 3);
  const bob = table.seats.find((s) => s.seatNo === 1);
  assert.equal(bob.status, "sitout");
  assert.equal(bob.folded, true);
  assert.equal(table.seats.find((s) => s.seatNo === 0).status, "active");
  assert.equal(table.hand.payouts[0], 40);
  for (const a of admin.handActions) {
    assert.equal(HAND_ACTION_LABELS.has(a.action), true, `hand_actions.action "${a.action}" violates the DB check constraint`);
  }
});

test("M5: 30-minute idle empty table auto-cleanup and host close-table intent", async () => {
  const admin = createM5MockSupabaseAdmin();
  const store = createSupabaseStore(admin);
  const now = () => admin.getClock();
  const rng = createSeededRng(77);

  admin.setClock(10_000_000);

  // Alice creates 3 empty tables
  const codes = [];
  for (let i = 0; i < 3; i += 1) {
    const res = await handleTableRequest({
      store,
      jwt: "jwt-alice",
      payload: { intent: "create", sb: 10, bb: 20 },
      rng,
      now
    });
    assert.equal(res.status, 200);
    codes.push(res.body.table.code);
  }

  // At +10 minutes, Alice is still blocked from creating a 4th table
  admin.setClock(10_000_000 + 10 * 60 * 1000);
  const blockedRes = await handleTableRequest({
    store, jwt: "jwt-alice", payload: { intent: "create", sb: 10, bb: 20 }, rng, now
  });
  assert.equal(blockedRes.status, 400);
  assert.equal(blockedRes.body.code, "ERR_TOO_MANY_OPEN_TABLES");

  // Non-host (Bob) cannot close Alice's table
  const nonHostClose = await handleTableRequest({
    store, jwt: "jwt-bob", payload: { intent: "close", table: codes[0] }, now
  });
  assert.equal(nonHostClose.status, 403);
  assert.equal(nonHostClose.body.code, "ERR_NOT_HOST");

  // If Bob sits down at codes[0], Alice cannot close codes[0] while it is occupied
  await handleTableRequest({
    store, jwt: "jwt-bob", payload: { intent: "join", table: codes[0], buyIn: 500 }, now
  });
  const occupiedClose = await handleTableRequest({
    store, jwt: "jwt-alice", payload: { intent: "close", table: codes[0] }, now
  });
  assert.equal(occupiedClose.status, 409);
  assert.equal(occupiedClose.body.code, "ERR_TABLE_NOT_EMPTY");

  // Host (Alice) explicitly closes empty table codes[1] via `intent: "close"`
  const hostClose = await handleTableRequest({
    store, jwt: "jwt-alice", payload: { intent: "close", table: codes[1] }, now
  });
  assert.equal(hostClose.status, 200);
  assert.equal(hostClose.body.table.status, "closed");

  // Advance clock past 30 minutes of inactivity on empty table codes[2]
  // Note: codes[0] has Bob seated so it must NOT be auto-closed!
  admin.setClock(10_000_000 + 31 * 60 * 1000);

  // Alice creates a new table -> auto-cleanup closes idle empty table codes[2], while keeping occupied codes[0] open
  const newTableRes = await handleTableRequest({
    store,
    jwt: "jwt-alice",
    payload: { intent: "create", sb: 10, bb: 20 },
    rng,
    now
  });
  assert.equal(newTableRes.status, 200);
  assert.equal(admin.pokerTables.find((t) => t.code === codes[2]).status, "closed");
  assert.equal(admin.pokerTables.find((t) => t.code === codes[0]).status, "open");
  assert.deepEqual(admin.checkChipConservationSql(), []);
});
