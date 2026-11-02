import test from "node:test";
import assert from "node:assert/strict";
import { createDeck, createSeededRng } from "../engine/index.js";
import {
  handleTableRequest,
  handleActRequest
} from "../../supabase/functions/_shared/handlers.js";

function buildFixedDeck(prefixCards) {
  const full = createDeck();
  const used = new Set(prefixCards);
  return [...prefixCards, ...full.filter((c) => !used.has(c))];
}

/**
 * In-memory mock store implementing the exact M3a database schema, constraints,
 * `sit_down`/`leave_seat` transactions, and the `chip_conservation.sql` check.
 */
function createMockStore() {
  const usersByJwt = new Map([
    ["jwt-alice", { id: "11111111-1111-1111-1111-111111111111", email: "alice@kth.se" }],
    ["jwt-bob", { id: "22222222-2222-2222-2222-222222222222", email: "bob@kth.se" }],
    ["jwt-carol", { id: "33333333-3333-3333-3333-333333333333", email: "carol@kth.se" }]
  ]);

  const displayNames = new Map([
    ["11111111-1111-1111-1111-111111111111", "Alice K."],
    ["22222222-2222-2222-2222-222222222222", "Bob L."],
    ["33333333-3333-3333-3333-333333333333", "Carol M."]
  ]);

  // Initial welcome chips (+1000 each)
  const chipLedger = [
    { member_id: "11111111-1111-1111-1111-111111111111", delta: 1000, source: "welcome", ref: "welcome:1" },
    { member_id: "22222222-2222-2222-2222-222222222222", delta: 1000, source: "welcome", ref: "welcome:2" },
    { member_id: "33333333-3333-3333-3333-333333333333", delta: 1000, source: "welcome", ref: "welcome:3" }
  ];

  const tables = new Map();
  const tableSeats = [];
  const hands = [];
  const holeCards = [];
  const handActions = [];
  const broadcasts = [];
  let seq = 1;

  function memberBalance(memberId) {
    return chipLedger
      .filter((r) => r.member_id === memberId)
      .reduce((sum, r) => sum + r.delta, 0);
  }

  /**
   * Mirrors `supabase/checks/chip_conservation.sql`.
   * Returns 0 when `net_game_ledger + active_seat_stacks + active_hand_pots === 0`.
   */
  function checkConservationDiscrepancy() {
    const netGameLedger = chipLedger
      .filter((r) => r.source === "game")
      .reduce((sum, r) => sum + r.delta, 0);
    const activeSeatStacks = tableSeats
      .filter((s) => s.status === "active" || s.status === "sitout")
      .reduce((sum, s) => sum + s.stack, 0);
    const activeHandPots = hands
      .filter((h) => h.ended_at === null)
      .reduce((sum, h) => sum + h.pot, 0);

    return netGameLedger + activeSeatStacks + activeHandPots;
  }

  return {
    chipLedger,
    tables,
    tableSeats,
    hands,
    holeCards,
    handActions,
    broadcasts,
    memberBalance,
    checkConservationDiscrepancy,

    async verifyUserJwt(jwt) {
      return usersByJwt.get(jwt) || null;
    },

    async createTable({ code, hostId, sb, bb, minBuyIn, maxBuyIn, maxSeats }) {
      for (const t of tables.values()) {
        if (t.code === code) throw new Error("duplicate code");
      }
      const table = {
        id: `00000000-0000-0000-0000-${String(seq++).padStart(12, "0")}`,
        code,
        host_id: hostId,
        sb,
        bb,
        min_buyin: minBuyIn,
        max_buyin: maxBuyIn,
        max_seats: maxSeats,
        status: "open",
        created_at: new Date().toISOString()
      };
      tables.set(table.id, table);
      return { ...table };
    },

    async getTableContext(tableIdOrCode) {
      const ref = String(tableIdOrCode || "");
      let table = tables.get(ref);
      if (!table) {
        for (const t of tables.values()) {
          if (t.code === ref.toUpperCase()) {
            table = t;
            break;
          }
        }
      }
      if (!table) return null;

      const seats = tableSeats
        .filter((s) => s.table_id === table.id)
        .map((s) => ({ ...s }))
        .sort((a, b) => a.seat_no - b.seat_no);

      const tableHands = hands
        .filter((h) => h.table_id === table.id)
        .sort((a, b) => b.hand_no - a.hand_no);

      const latestHand = tableHands[0] ? structuredClone(tableHands[0]) : null;
      return {
        table: { ...table },
        seats,
        hand: latestHand,
        lastHandNo: latestHand ? latestHand.hand_no : 0,
        displayNamesByMemberId: displayNames
      };
    },

    async sitDown({ tableId, memberId, seatNo, buyIn }) {
      const table = tables.get(tableId);
      if (!table) throw new Error("ERR_TABLE_NOT_FOUND: table does not exist");
      if (table.status === "closed") throw new Error("ERR_TABLE_CLOSED: table is closed");
      if (seatNo < 0 || seatNo >= table.max_seats) throw new Error("ERR_INVALID_SEAT: invalid seat");
      if (buyIn < table.min_buyin || buyIn > table.max_buyin) {
        throw new Error("ERR_INVALID_BUYIN: invalid buy-in");
      }

      const alreadySeated = tableSeats.find(
        (s) => s.table_id === tableId && s.member_id === memberId && s.status !== "left"
      );
      if (alreadySeated) throw new Error("ERR_ALREADY_SEATED: already seated");

      const seatOccupied = tableSeats.find(
        (s) => s.table_id === tableId && s.seat_no === seatNo && s.status !== "left"
      );
      if (seatOccupied) throw new Error("ERR_SEAT_TAKEN: seat taken");

      const bal = memberBalance(memberId);
      if (bal < buyIn) throw new Error("ERR_INSUFFICIENT_CHIPS: insufficient chips");

      chipLedger.push({
        member_id: memberId,
        delta: -buyIn,
        source: "game",
        ref: `buyin:${tableId}:${seatNo}:${seq++}`
      });

      const existingIdx = tableSeats.findIndex(
        (s) => s.table_id === tableId && s.seat_no === seatNo
      );
      const seatRow = {
        table_id: tableId,
        seat_no: seatNo,
        member_id: memberId,
        stack: buyIn,
        status: "active",
        joined_at: new Date().toISOString(),
        left_at: null
      };
      if (existingIdx >= 0) {
        tableSeats[existingIdx] = seatRow;
      } else {
        tableSeats.push(seatRow);
      }
      return { ...seatRow };
    },

    async leaveSeat({ tableId, memberId }) {
      const activeHand = hands.find((h) => h.table_id === tableId && h.ended_at === null);
      if (activeHand) {
        throw new Error("ERR_HAND_IN_PROGRESS: active hand must be settled before cashing out seat");
      }

      const seatRow = tableSeats.find(
        (s) => s.table_id === tableId && s.member_id === memberId && s.status !== "left"
      );
      if (!seatRow) throw new Error("ERR_NOT_SEATED: not seated");

      if (seatRow.stack > 0) {
        chipLedger.push({
          member_id: memberId,
          delta: seatRow.stack,
          source: "game",
          ref: `cashout:${tableId}:${seatRow.seat_no}:${seq++}`
        });
      }
      seatRow.stack = 0;
      seatRow.status = "left";
      seatRow.left_at = new Date().toISOString();
      return { ...seatRow };
    },

    async updateSeatStatus(tableId, seatNo, status) {
      const seatRow = tableSeats.find((s) => s.table_id === tableId && s.seat_no === seatNo);
      if (seatRow) seatRow.status = status;
    },

    async syncSeatStacks(tableId, seatStacks) {
      for (const { seatNo, stack } of seatStacks) {
        const seatRow = tableSeats.find((s) => s.table_id === tableId && s.seat_no === seatNo);
        if (seatRow) seatRow.stack = stack;
      }
    },

    async updateTableStatus(tableId, status) {
      const table = tables.get(tableId);
      if (table) table.status = status;
    },

    async insertHand({ tableId, handNo, dealerSeat, board, pot, state, showdown, endedAt }) {
      const row = {
        id: `hand-${seq++}`,
        table_id: tableId,
        hand_no: handNo,
        dealer_seat: dealerSeat,
        board: [...board],
        pot,
        state: structuredClone(state),
        showdown: showdown ? structuredClone(showdown) : null,
        started_at: new Date().toISOString(),
        ended_at: endedAt
      };
      hands.push(row);
      return structuredClone(row);
    },

    async updateHand({ handId, expectedActionSeq, board, pot, state, showdown, endedAt }) {
      const row = hands.find((h) => h.id === handId && h.ended_at === null);
      if (!row) return null;
      if (Number(row.state?.actionSeq ?? 0) !== Number(expectedActionSeq)) {
        return null;
      }
      row.board = [...board];
      row.pot = pot;
      row.state = structuredClone(state);
      row.showdown = showdown ? structuredClone(showdown) : null;
      row.ended_at = endedAt;
      return structuredClone(row);
    },

    async insertHoleCards(rows) {
      holeCards.push(...structuredClone(rows));
    },

    async insertHandActions(rows) {
      handActions.push(...structuredClone(rows));
    },

    async broadcastTableState(tableCode, publicState) {
      broadcasts.push({ tableCode, publicState: structuredClone(publicState) });
    }
  };
}

test("Full M3b lifecycle: create, join, start hand, bet to showdown, leave, and chip conservation at every step", async () => {
  const store = createMockStore();

  // 1. Alice creates a table and buys in for 500 at seat 0
  const createRes = await handleTableRequest({
    store,
    jwt: "jwt-alice",
    payload: { intent: "create", sb: 10, bb: 20, buyIn: 500, seat: 0 },
    rng: createSeededRng(10)
  });
  assert.equal(createRes.status, 200);
  const tableCode = createRes.body.table.code;
  assert.equal(tableCode.length, 5);
  assert.equal(store.memberBalance("11111111-1111-1111-1111-111111111111"), 500);
  assert.equal(store.checkConservationDiscrepancy(), 0);

  // 2. Bob joins the table with 500 at seat 1
  const joinRes = await handleTableRequest({
    store,
    jwt: "jwt-bob",
    payload: { intent: "join", table: tableCode, buyIn: 500 }
  });
  assert.equal(joinRes.status, 200);
  assert.equal(joinRes.body.table.seats.length, 2);
  assert.equal(joinRes.body.table.seats[0].displayName, "Alice K.");
  assert.equal(joinRes.body.table.seats[1].displayName, "Bob L.");
  assert.equal(store.checkConservationDiscrepancy(), 0);

  // 3. Alice starts a hand with a deterministic deck (Alice has Aces, Bob has Kings)
  const fixedDeck = buildFixedDeck([
    "As", "Ah", // Alice (seat 0, Dealer/SB)
    "Ks", "Kh", // Bob (seat 1, BB)
    "2c", "7d", "9s", // Flop
    "3h", // Turn
    "4d"  // River
  ]);

  const startRes = await handleActRequest({
    store,
    jwt: "jwt-alice",
    payload: { table: tableCode, intent: "start" },
    rng: fixedDeck
  });
  assert.equal(startRes.status, 200);
  assert.equal(store.checkConservationDiscrepancy(), 0, "Conservation must hold after blinds posted");

  // Verify hole cards were written to `hole_cards` and stripped from public state
  assert.equal(store.holeCards.length, 2);
  assert.deepEqual(store.holeCards[0].cards, ["As", "Ah"]);
  assert.deepEqual(store.holeCards[1].cards, ["Ks", "Kh"]);
  assert.equal("deck" in startRes.body.table.hand, false);
  assert.equal(startRes.body.table.seats[0].revealedCards, null);
  assert.equal(startRes.body.table.seats[1].revealedCards, null);

  // 4. Preflop: Alice (seat 0, SB) raises to 60; Bob (seat 1, BB) calls 60
  let actRes = await handleActRequest({
    store,
    jwt: "jwt-alice",
    payload: { table: tableCode, intent: "raise", amount: 60 }
  });
  assert.equal(actRes.status, 200);
  assert.equal(store.checkConservationDiscrepancy(), 0, "Conservation must hold mid-street after raise");

  actRes = await handleActRequest({
    store,
    jwt: "jwt-bob",
    payload: { table: tableCode, intent: "call" }
  });
  assert.equal(actRes.status, 200);
  assert.equal(actRes.body.table.hand.street, "flop");
  assert.equal(actRes.body.table.hand.pot, 120);
  assert.equal(store.checkConservationDiscrepancy(), 0);

  // 5. Check down flop, turn, river (Bob acts first postflop)
  for (const expectedStreet of ["flop", "turn", "river"]) {
    assert.equal(actRes.body.table.hand.street, expectedStreet);
    actRes = await handleActRequest({ store, jwt: "jwt-bob", payload: { table: tableCode, intent: "check" } });
    assert.equal(store.checkConservationDiscrepancy(), 0);
    actRes = await handleActRequest({ store, jwt: "jwt-alice", payload: { table: tableCode, intent: "check" } });
    assert.equal(store.checkConservationDiscrepancy(), 0);
  }

  // Hand is now complete at showdown; Alice wins 120 pot (stack = 560, Bob = 440)
  assert.equal(actRes.body.table.hand.status, "complete");
  assert.deepEqual(actRes.body.table.hand.winners, [0]);
  assert.equal(actRes.body.table.seats[0].stack, 560);
  assert.equal(actRes.body.table.seats[1].stack, 440);
  assert.equal(store.checkConservationDiscrepancy(), 0);

  // 6. Both players leave and cash out to `chip_ledger`
  const leaveAlice = await handleTableRequest({
    store,
    jwt: "jwt-alice",
    payload: { intent: "leave", table: tableCode }
  });
  assert.equal(leaveAlice.status, 200);
  assert.equal(store.memberBalance("11111111-1111-1111-1111-111111111111"), 1060);
  assert.equal(store.checkConservationDiscrepancy(), 0);

  const leaveBob = await handleTableRequest({
    store,
    jwt: "jwt-bob",
    payload: { intent: "leave", table: tableCode }
  });
  assert.equal(leaveBob.status, 200);
  assert.equal(store.memberBalance("22222222-2222-2222-2222-222222222222"), 940);
  assert.equal(store.checkConservationDiscrepancy(), 0);
});

test("Hostile-client defenses: forged member_id, out-of-turn action, oversize raise, action replay, and parallel race", async () => {
  const store = createMockStore();

  const createRes = await handleTableRequest({
    store,
    jwt: "jwt-alice",
    payload: { intent: "create", buyIn: 500, seat: 0 },
    rng: createSeededRng(99)
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
    rng: createSeededRng(100)
  });
  const handId = startRes.body.table.hand.id;

  // Attack 1: Forged member_id in request body (Bob tries to claim he is Alice)
  const forgedRes = await handleActRequest({
    store,
    jwt: "jwt-bob",
    payload: {
      table: tableCode,
      intent: "fold",
      member_id: "11111111-1111-1111-1111-111111111111"
    }
  });
  assert.equal(forgedRes.status, 403);
  assert.equal(forgedRes.body.code, "ERR_FORGED_MEMBER_ID");

  // Attack 2: Acting out of turn (Bob is BB, tries to act first preflop when it is Alice's turn)
  const outOfTurnRes = await handleActRequest({
    store,
    jwt: "jwt-bob",
    payload: { table: tableCode, intent: "check" }
  });
  assert.equal(outOfTurnRes.status, 400);
  assert.equal(outOfTurnRes.body.code, "ERR_NOT_YOUR_TURN");

  // Attack 3: Raising more than stack (Alice has 500 total, tries to raise to 9999)
  const overRaiseRes = await handleActRequest({
    store,
    jwt: "jwt-alice",
    payload: { table: tableCode, intent: "raise", amount: 9999 }
  });
  assert.equal(overRaiseRes.status, 400);
  assert.equal(overRaiseRes.body.code, "ERR_INVALID_RAISE_AMOUNT");

  // Attack 4: Parallel duplicate requests & actionSeq replay protection
  const [parallel1, parallel2] = await Promise.all([
    handleActRequest({
      store,
      jwt: "jwt-alice",
      payload: { table: tableCode, intent: "call", handId, actionSeq: 0 }
    }),
    handleActRequest({
      store,
      jwt: "jwt-alice",
      payload: { table: tableCode, intent: "call", handId, actionSeq: 0 }
    })
  ]);
  assert.equal(parallel1.status, 200);
  assert.equal(parallel2.status, 409);
  assert.equal(parallel2.body.code, "ERR_STALE_ACTION_SEQ");
  assert.equal(store.checkConservationDiscrepancy(), 0);
});

test("Leaving mid-hand folds the leaving player first, settles the hand, and cashes out cleanly", async () => {
  const store = createMockStore();

  const createRes = await handleTableRequest({
    store,
    jwt: "jwt-alice",
    payload: { intent: "create", buyIn: 500, seat: 0 },
    rng: createSeededRng(55)
  });
  const tableCode = createRes.body.table.code;

  await handleTableRequest({
    store,
    jwt: "jwt-bob",
    payload: { intent: "join", table: tableCode, buyIn: 500, seat: 1 }
  });

  await handleActRequest({
    store,
    jwt: "jwt-alice",
    payload: { table: tableCode, intent: "start" },
    rng: createSeededRng(56)
  });

  // Preflop: Alice posted 10 (stack 490), Bob posted 20 (stack 480).
  // Bob leaves mid-hand (even out of turn) -> Bob is folded, Alice wins the 20 contested pot + 0 uncalled,
  // and Bob's remaining 480 stack is cashed out to `chip_ledger`.
  const leaveRes = await handleTableRequest({
    store,
    jwt: "jwt-bob",
    payload: { intent: "leave", table: tableCode }
  });
  assert.equal(leaveRes.status, 200);
  assert.equal(store.memberBalance("22222222-2222-2222-2222-222222222222"), 980);
  assert.equal(leaveRes.body.table.seats.length, 1);
  assert.equal(leaveRes.body.table.seats[0].stack, 520, "Alice wins Bob's 20 BB");
  assert.equal(store.checkConservationDiscrepancy(), 0);
});
