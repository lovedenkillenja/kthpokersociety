import test from "node:test";
import assert from "node:assert/strict";
import { createSeededRng } from "../engine/index.js";
import { createSupabaseStore } from "../../supabase/functions/_shared/supabase-store.js";
import {
  handleTableRequest,
  handleActRequest
} from "../../supabase/functions/_shared/handlers.js";

/**
 * Stateful mock of `supabaseAdmin` that records all `.rpc(...)` and `.from(...)` calls
 * and executes `start_hand_tx`, `apply_hand_tx`, `sit_down`, and `leave_seat` atomically.
 */
function createMockSupabaseAdmin() {
  const rpcCalls = [];
  const tableWrites = [];

  const users = new Map([
    ["jwt-alice", { id: "11111111-1111-1111-1111-111111111111", email: "alice@kth.se" }],
    ["jwt-bob", { id: "22222222-2222-2222-2222-222222222222", email: "bob@kth.se" }]
  ]);

  const chipProfiles = [
    { member_id: "11111111-1111-1111-1111-111111111111", display_name: "Alice K." },
    { member_id: "22222222-2222-2222-2222-222222222222", display_name: "Bob L." }
  ];

  const chipLedger = [
    { member_id: "11111111-1111-1111-1111-111111111111", delta: 3000, source: "welcome", ref: "w1" },
    { member_id: "22222222-2222-2222-2222-222222222222", delta: 3000, source: "welcome", ref: "w2" }
  ];

  const pokerTables = [];
  const tableSeats = [];
  const hands = [];
  const holeCards = [];
  const handActions = [];
  let seq = 1;

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
      rows.push({ check_name: "global_chip_conservation_mismatch" });
    }
    for (const u of users.values()) {
      const bal = chipLedger
        .filter((r) => r.member_id === u.id)
        .reduce((s, r) => s + r.delta, 0);
      if (bal < 0) rows.push({ check_name: "negative_member_balance" });
    }
    for (const s of tableSeats) {
      if (s.status === "left" && s.stack !== 0) {
        rows.push({ check_name: "left_seat_has_chips" });
      }
    }
    for (const t of pokerTables) {
      if (
        t.status === "closed" &&
        (tableSeats.some(
          (s) => s.table_id === t.id && (s.status === "active" || s.status === "sitout" || s.stack > 0)
        ) ||
          hands.some((h) => h.table_id === t.id && h.ended_at === null))
      ) {
        rows.push({ check_name: "closed_table_has_active_chips" });
      }
    }
    return rows;
  }

  const admin = {
    rpcCalls,
    tableWrites,
    pokerTables,
    tableSeats,
    hands,
    holeCards,
    handActions,
    chipLedger,
    checkChipConservationSql,

    auth: {
      async getUser(jwt) {
        const user = users.get(jwt) || null;
        return { data: { user }, error: user ? null : new Error("Invalid JWT") };
      }
    },

    channel() {
      return {
        async send() {}
      };
    },

    async removeChannel() {},

    from(tableName) {
      const filters = [];
      let isCountHead = false;
      let orderCol = null;
      let orderAsc = true;
      let rowLimit = null;

      const builder = {
        select(_cols, opts) {
          if (opts?.count === "exact" && opts?.head) {
            isCountHead = true;
          }
          return builder;
        },
        eq(col, val) {
          filters.push((r) => r[col] === val);
          return builder;
        },
        in(col, vals) {
          const set = new Set(vals);
          filters.push((r) => set.has(r[col]));
          return builder;
        },
        order(col, opts) {
          orderCol = col;
          orderAsc = opts?.ascending !== false;
          return builder;
        },
        limit(n) {
          rowLimit = n;
          return builder;
        },
        insert(payload) {
          tableWrites.push({ table: tableName, op: "insert", payload });
          if (tableName !== "poker_tables") {
            throw new Error(`Direct insert on ${tableName} is forbidden; use atomic RPC`);
          }
          const openForHost = pokerTables.filter(
            (t) => t.host_id === payload.host_id && (t.status === "open" || t.status === "playing")
          ).length;
          if (openForHost >= 3) {
            return {
              select: () => ({
                single: async () => ({
                  data: null,
                  error: new Error("ERR_TOO_MANY_OPEN_TABLES: host already has 3 open tables (max 3)")
                })
              })
            };
          }
          if (pokerTables.some((t) => t.code === payload.code)) {
            return {
              select: () => ({
                single: async () => ({ data: null, error: new Error("duplicate key") })
              })
            };
          }
          const row = {
            id: `00000000-0000-0000-0000-${String(seq++).padStart(12, "0")}`,
            ...payload,
            created_at: new Date().toISOString()
          };
          pokerTables.push(row);
          return {
            select: () => ({
              single: async () => ({ data: { ...row }, error: null })
            })
          };
        },
        update() {
          tableWrites.push({ table: tableName, op: "update" });
          throw new Error(`Direct update on ${tableName} is forbidden; use atomic RPC`);
        },
        async maybeSingle() {
          const rows = executeSelect();
          return { data: rows[0] ? structuredClone(rows[0]) : null, error: null };
        },
        then(resolve, reject) {
          try {
            if (isCountHead) {
              const rows = executeSelect();
              return Promise.resolve({ count: rows.length, error: null }).then(resolve, reject);
            }
            const rows = executeSelect();
            return Promise.resolve({ data: structuredClone(rows), error: null }).then(resolve, reject);
          } catch (err) {
            return Promise.reject(err).then(resolve, reject);
          }
        }
      };

      function executeSelect() {
        const source =
          tableName === "poker_tables"
            ? pokerTables
            : tableName === "table_seats"
              ? tableSeats
              : tableName === "hands"
                ? hands
                : tableName === "chip_profiles"
                  ? chipProfiles
                  : [];
        let rows = source.filter((r) => filters.every((fn) => fn(r)));
        if (orderCol) {
          rows = [...rows].sort((a, b) =>
            orderAsc ? (a[orderCol] > b[orderCol] ? 1 : -1) : a[orderCol] < b[orderCol] ? 1 : -1
          );
        }
        if (rowLimit !== null) {
          rows = rows.slice(0, rowLimit);
        }
        return rows;
      }

      return builder;
    },

    async rpc(fnName, args) {
      rpcCalls.push({ fnName, args: structuredClone(args) });

      if (fnName === "sit_down") {
        const table = pokerTables.find((t) => t.id === args.p_table_id);
        if (!table) return { data: null, error: new Error("ERR_TABLE_NOT_FOUND") };
        chipLedger.push({
          member_id: args.p_member_id,
          delta: -args.p_buyin,
          source: "game",
          ref: `buyin:${seq++}`
        });
        const seat = {
          table_id: args.p_table_id,
          seat_no: args.p_seat_no,
          member_id: args.p_member_id,
          stack: args.p_buyin,
          status: "active"
        };
        tableSeats.push(seat);
        return { data: { ...seat }, error: null };
      }

      if (fnName === "leave_seat") {
        if (hands.some((h) => h.table_id === args.p_table_id && h.ended_at === null)) {
          return { data: null, error: new Error("ERR_HAND_IN_PROGRESS") };
        }
        const seat = tableSeats.find(
          (s) => s.table_id === args.p_table_id && s.member_id === args.p_member_id && s.status !== "left"
        );
        if (!seat) return { data: null, error: new Error("ERR_NOT_SEATED") };
        if (seat.stack > 0) {
          chipLedger.push({
            member_id: args.p_member_id,
            delta: seat.stack,
            source: "game",
            ref: `cashout:${seq++}`
          });
        }
        seat.stack = 0;
        seat.status = "left";
        return { data: { ...seat }, error: null };
      }

      if (fnName === "start_hand_tx") {
        const table = pokerTables.find((t) => t.id === args.p_table_id);
        if (!table) return { data: null, error: new Error("ERR_TABLE_NOT_FOUND") };
        if (hands.some((h) => h.table_id === args.p_table_id && h.ended_at === null)) {
          return { data: null, error: new Error("ERR_HAND_IN_PROGRESS: hand already active") };
        }
        if (Number(args.p_state?.actionSeq ?? 0) !== 0) {
          return { data: null, error: new Error("ERR_STALE_ACTION_SEQ: expected initial actionSeq 0") };
        }

        const seatsBefore = tableSeats
          .filter((s) => s.table_id === args.p_table_id && s.status !== "left")
          .reduce((sum, s) => sum + s.stack, 0);

        const handRow = {
          id: `00000000-0000-0000-0000-${String(seq++).padStart(12, "0")}`,
          table_id: args.p_table_id,
          hand_no: args.p_hand_no,
          dealer_seat: args.p_dealer_seat,
          board: [...(args.p_board || [])],
          pot: args.p_pot,
          state: structuredClone(args.p_state),
          showdown: args.p_showdown ? structuredClone(args.p_showdown) : null,
          started_at: new Date().toISOString(),
          ended_at: args.p_ended_at
        };

        // Apply atomic updates in memory
        for (const st of args.p_seat_stacks || []) {
          const seatNo = st.seatNo ?? st.seat_no;
          const seat = tableSeats.find(
            (s) => s.table_id === args.p_table_id && s.seat_no === seatNo && s.status !== "left"
          );
          if (!seat) return { data: null, error: new Error("ERR_NOT_SEATED") };
          seat.stack = st.stack;
          if (st.status) seat.status = st.status;
        }

        const seatsAfter = tableSeats
          .filter((s) => s.table_id === args.p_table_id && s.status !== "left")
          .reduce((sum, s) => sum + s.stack, 0);
        const potAfter = args.p_ended_at === null ? args.p_pot : 0;
        if (seatsAfter + potAfter !== seatsBefore) {
          return { data: null, error: new Error("ERR_CHIP_CONSERVATION") };
        }

        hands.push(handRow);
        for (const hc of args.p_hole_cards || []) {
          holeCards.push({
            hand_id: handRow.id,
            member_id: hc.member_id ?? hc.memberId,
            cards: [...hc.cards]
          });
        }
        for (const act of args.p_actions || []) {
          handActions.push({
            hand_id: handRow.id,
            seat_no: act.seat_no ?? act.seatNo,
            action: act.action,
            amount: act.amount ?? 0
          });
        }
        table.status = args.p_table_status || (args.p_ended_at ? "open" : "playing");
        return { data: structuredClone(handRow), error: null };
      }

      if (fnName === "apply_hand_tx") {
        const handRow = hands.find((h) => h.id === args.p_hand_id);
        if (!handRow) return { data: null, error: new Error("ERR_HAND_NOT_FOUND") };
        if (handRow.ended_at !== null) return { data: null, error: new Error("ERR_NO_ACTIVE_HAND") };
        const currentSeq = Number(handRow.state?.actionSeq ?? 0);
        if (currentSeq !== Number(args.p_expected_action_seq)) {
          return {
            data: null,
            error: new Error(
              `ERR_STALE_ACTION_SEQ: expected actionSeq ${args.p_expected_action_seq}, got ${currentSeq}`
            )
          };
        }

        const table = pokerTables.find((t) => t.id === handRow.table_id);
        const seatsSnapshot = structuredClone(tableSeats);
        const chipsBefore =
          tableSeats
            .filter((s) => s.table_id === handRow.table_id && s.status !== "left")
            .reduce((sum, s) => sum + s.stack, 0) + handRow.pot;

        for (const st of args.p_seat_stacks || []) {
          const seatNo = st.seatNo ?? st.seat_no;
          const seat = tableSeats.find(
            (s) => s.table_id === handRow.table_id && s.seat_no === seatNo && s.status !== "left"
          );
          if (!seat || st.stack < 0) {
            tableSeats.splice(0, tableSeats.length, ...seatsSnapshot);
            return { data: null, error: new Error("ERR_NOT_SEATED") };
          }
          seat.stack = st.stack;
          if (st.status) seat.status = st.status;
        }

        const seatsAfter = tableSeats
          .filter((s) => s.table_id === handRow.table_id && s.status !== "left")
          .reduce((sum, s) => sum + s.stack, 0);
        const potAfter = args.p_ended_at === null ? args.p_pot : 0;

        if (seatsAfter + potAfter !== chipsBefore) {
          // Roll back seat changes on conservation failure
          tableSeats.splice(0, tableSeats.length, ...seatsSnapshot);
          return { data: null, error: new Error("ERR_CHIP_CONSERVATION: conservation mismatch") };
        }

        handRow.board = [...(args.p_board || [])];
        handRow.pot = args.p_pot;
        handRow.state = structuredClone(args.p_state);
        handRow.showdown = args.p_showdown ? structuredClone(args.p_showdown) : null;
        handRow.ended_at = args.p_ended_at;

        for (const hc of args.p_hole_cards || []) {
          holeCards.push({
            hand_id: handRow.id,
            member_id: hc.member_id ?? hc.memberId,
            cards: [...hc.cards]
          });
        }
        for (const act of args.p_actions || []) {
          handActions.push({
            hand_id: handRow.id,
            seat_no: act.seat_no ?? act.seatNo,
            action: act.action,
            amount: act.amount ?? 0
          });
        }
        if (table) {
          table.status = args.p_table_status || (args.p_ended_at ? "open" : "playing");
        }
        return { data: structuredClone(handRow), error: null };
      }

      throw new Error(`Unexpected RPC ${fnName}`);
    }
  };

  return admin;
}

test("supabase-store.js persists hands atomically via start_hand_tx and apply_hand_tx RPCs without separate table writes", async () => {
  const admin = createMockSupabaseAdmin();
  const store = createSupabaseStore(admin);

  const createRes = await handleTableRequest({
    store,
    jwt: "jwt-alice",
    payload: { intent: "create", sb: 10, bb: 20, buyIn: 500, seat: 0 },
    rng: createSeededRng(7)
  });
  assert.equal(createRes.status, 200);
  const tableCode = createRes.body.table.code;

  await handleTableRequest({
    store,
    jwt: "jwt-bob",
    payload: { intent: "join", table: tableCode, buyIn: 500, seat: 1 }
  });

  const startRes = await handleActRequest({
    store,
    jwt: "jwt-alice",
    payload: { table: tableCode, intent: "start" },
    rng: createSeededRng(11)
  });
  assert.equal(startRes.status, 200);

  // Verify `start_hand_tx` RPC was called once and bundled hands, stacks, hole_cards, actions, and table_status
  const startRpc = admin.rpcCalls.find((c) => c.fnName === "start_hand_tx");
  assert.ok(startRpc, "start_hand_tx RPC must be called");
  assert.equal(startRpc.args.p_hand_no, 1);
  assert.equal(startRpc.args.p_pot, 30);
  assert.equal(startRpc.args.p_seat_stacks.length, 2);
  assert.equal(startRpc.args.p_hole_cards.length, 2);
  assert.equal(startRpc.args.p_actions.length, 2);
  assert.equal(startRpc.args.p_table_status, "playing");
  assert.deepEqual(admin.checkChipConservationSql(), []);

  // Alice folds -> hand settles atomically via `apply_hand_tx`
  const foldRes = await handleActRequest({
    store,
    jwt: "jwt-alice",
    payload: { table: tableCode, intent: "fold" }
  });
  assert.equal(foldRes.status, 200);

  const applyRpc = admin.rpcCalls.find((c) => c.fnName === "apply_hand_tx");
  assert.ok(applyRpc, "apply_hand_tx RPC must be called");
  assert.equal(applyRpc.args.p_expected_action_seq, 0);
  assert.equal(applyRpc.args.p_table_status, "open");
  assert.ok(applyRpc.args.p_ended_at, "ended_at must be set when hand completes");
  assert.deepEqual(admin.checkChipConservationSql(), []);

  // Only `poker_tables` insert was performed directly; all hand/seat/card/action writes went through RPCs
  assert.equal(admin.tableWrites.length, 1);
  assert.equal(admin.tableWrites[0].table, "poker_tables");
});

test("Host open-table cap: host can create at most 3 open tables; closing one allows creating another", async () => {
  const admin = createMockSupabaseAdmin();
  const store = createSupabaseStore(admin);
  const rng = createSeededRng(42);

  for (let i = 0; i < 3; i += 1) {
    const res = await handleTableRequest({
      store,
      jwt: "jwt-alice",
      payload: { intent: "create", sb: 10, bb: 20 },
      rng
    });
    assert.equal(res.status, 200, `Table ${i + 1} creation should succeed`);
  }

  // 4th open table by Alice is rejected with ERR_TOO_MANY_OPEN_TABLES
  const fourthRes = await handleTableRequest({
    store,
    jwt: "jwt-alice",
    payload: { intent: "create", sb: 10, bb: 20 },
    rng
  });
  assert.equal(fourthRes.status, 400);
  assert.equal(fourthRes.body.code, "ERR_TOO_MANY_OPEN_TABLES");

  // Bob can still create his own table
  const bobRes = await handleTableRequest({
    store,
    jwt: "jwt-bob",
    payload: { intent: "create", sb: 10, bb: 20 },
    rng
  });
  assert.equal(bobRes.status, 200);

  // Once one of Alice's tables is closed, Alice can create a new table again
  admin.pokerTables[0].status = "closed";
  const afterCloseRes = await handleTableRequest({
    store,
    jwt: "jwt-alice",
    payload: { intent: "create", sb: 10, bb: 20 },
    rng
  });
  assert.equal(afterCloseRes.status, 200);
});

test("apply_hand_tx atomic rollback: stale actionSeq or conservation error leaves DB state untouched", async () => {
  const admin = createMockSupabaseAdmin();
  const store = createSupabaseStore(admin);

  const createRes = await handleTableRequest({
    store,
    jwt: "jwt-alice",
    payload: { intent: "create", buyIn: 500, seat: 0 },
    rng: createSeededRng(1)
  });
  const tableCode = createRes.body.table.code;
  await handleTableRequest({
    store,
    jwt: "jwt-bob",
    payload: { intent: "join", table: tableCode, buyIn: 500, seat: 1 }
  });
  const startRes = await handleActRequest({
    store,
    jwt: "jwt-alice",
    payload: { table: tableCode, intent: "start" },
    rng: createSeededRng(2)
  });
  const handId = startRes.body.table.hand.id;

  // Direct call to store.applyHandTx with wrong expectedActionSeq (e.g., concurrent Edge Function worker)
  await assert.rejects(
    () =>
      store.applyHandTx({
        handId,
        expectedActionSeq: 99,
        board: [],
        pot: 40,
        state: { actionSeq: 100 },
        seatStacks: [
          { seatNo: 0, stack: 480 },
          { seatNo: 1, stack: 480 }
        ],
        actions: [{ seat_no: 0, action: "call", amount: 10 }],
        tableStatus: "playing"
      }),
    /ERR_STALE_ACTION_SEQ/
  );

  // Verify seats, hand pot, and hand actions were not modified
  assert.equal(admin.hands[0].pot, 30);
  assert.equal(admin.tableSeats[0].stack, 490);
  assert.equal(admin.tableSeats[1].stack, 480);
  assert.equal(admin.handActions.length, 2);
  assert.deepEqual(admin.checkChipConservationSql(), []);
});
