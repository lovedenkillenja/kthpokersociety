import test from "node:test";
import assert from "node:assert/strict";
import { createSeededRng } from "../engine/index.js";
import { handleTableRequest } from "../../supabase/functions/_shared/handlers.js";
import { validateBuyIn } from "../lib/table-helpers.js";
import { shapeSeatedTableRows } from "../lib/seated-tables.js";
import {
  STAKES_PRESETS,
  STAKES_DB_LIMITS,
  DEFAULT_STAKES_ID,
  getStakesPreset,
  findPresetForTable,
  formatStakesLabel,
  formatBuyInFieldLabel,
  defaultBuyInFor,
  joinRangeMessage,
  stakesSummaryCopy
} from "../lib/stakes.js";

test("presets are internally consistent and within the database limits", () => {
  assert.equal(STAKES_PRESETS.length, 3);
  for (const p of STAKES_PRESETS) {
    for (const n of [p.sb, p.bb, p.minBuyIn, p.maxBuyIn]) assert.ok(Number.isInteger(n) && n > 0, p.id);
    assert.equal(p.bb, 2 * p.sb, p.id);
    assert.equal(p.minBuyIn, 20 * p.bb, p.id);
    assert.equal(p.maxBuyIn, 100 * p.bb, p.id);
    assert.ok(p.sb <= STAKES_DB_LIMITS.maxSb && p.bb <= STAKES_DB_LIMITS.maxBb, p.id);
    assert.ok(p.maxBuyIn <= STAKES_DB_LIMITS.maxBuyIn, p.id);
  }
  assert.deepEqual(
    STAKES_PRESETS.map((p) => [p.sb, p.bb, p.minBuyIn, p.maxBuyIn]),
    [[1, 2, 40, 200], [5, 10, 200, 1000], [10, 20, 400, 2000]]
  );
});

test("default preset is Low 5/10 and unknown ids fall back to it", () => {
  assert.equal(DEFAULT_STAKES_ID, "low");
  assert.equal(getStakesPreset("low").bb, 10);
  assert.equal(getStakesPreset("nonsense").id, "low");
  assert.equal(getStakesPreset(undefined).id, "low");
  assert.equal(getStakesPreset("MICRO").id, "micro");
  assert.equal(findPresetForTable({ sb: 10, bb: 20, minBuyIn: 400, maxBuyIn: 2000 }).id, "standard");
  assert.equal(findPresetForTable({ sb: 10, bb: 20, minBuyIn: 100, maxBuyIn: 2000 }), null);
});

test("labels are formatted for the lobby", () => {
  assert.equal(formatStakesLabel(getStakesPreset("low")), "5 / 10 blinds · Buy-in 200–1,000 chips");
  assert.equal(formatStakesLabel(getStakesPreset("standard")), "10 / 20 blinds · Buy-in 400–2,000 chips");
  assert.equal(formatBuyInFieldLabel(getStakesPreset("micro")), "Your buy-in (40–200 chips)");
  assert.equal(stakesSummaryCopy(), "Micro 1/2, Low 5/10 or Standard 10/20");
});

test("default buy-in is 50 big blinds, clamped to the range and the balance", () => {
  const micro = getStakesPreset("micro");
  const low = getStakesPreset("low");
  const standard = getStakesPreset("standard");
  assert.equal(defaultBuyInFor(low, 1000), 500);
  assert.equal(defaultBuyInFor(micro, 1000), 100);
  assert.equal(defaultBuyInFor(standard, 1000), 1000);
  assert.equal(defaultBuyInFor(standard, 700), 700);
  assert.equal(defaultBuyInFor(standard, 100), 400); // below the minimum: validation explains it
  assert.equal(defaultBuyInFor(low, 230), 230);
  assert.equal(defaultBuyInFor(low), 500);
});

test("buy-in validation follows each preset", () => {
  for (const p of STAKES_PRESETS) {
    const opts = { minBuyIn: p.minBuyIn, maxBuyIn: p.maxBuyIn, balance: 5000 };
    assert.equal(validateBuyIn(p.minBuyIn, opts).valid, true, `${p.id} min`);
    assert.equal(validateBuyIn(p.maxBuyIn, opts).valid, true, `${p.id} max`);
    assert.equal(validateBuyIn(p.minBuyIn - 1, opts).valid, false, `${p.id} below`);
    assert.equal(validateBuyIn(p.maxBuyIn + 1, opts).valid, false, `${p.id} above`);
  }
  const low = getStakesPreset("low");
  assert.equal(validateBuyIn(250, { minBuyIn: low.minBuyIn, maxBuyIn: low.maxBuyIn, balance: 1000 }).valid, true);
  assert.match(validateBuyIn(150, { minBuyIn: 200, maxBuyIn: 1000, balance: 1000 }).error, /between 200 and 1,000/);
  assert.equal(validateBuyIn(300, { minBuyIn: 200, maxBuyIn: 1000, balance: 250 }).valid, false);
});

test("join message names the table's blinds and range, and is empty inside the range", () => {
  const table = { code: "ABCDE", sb: 1, bb: 2, minBuyIn: 40, maxBuyIn: 200 };
  assert.equal(joinRangeMessage(table, 100), "");
  const msg = joinRangeMessage(table, 500);
  assert.match(msg, /Room ABCDE/);
  assert.match(msg, /1 \/ 2 blinds/);
  assert.match(msg, /40–200 chips/);
  assert.match(joinRangeMessage({ ...table, code: "" }, 5), /^This table plays/);
});

test("seated table rows carry blinds only when the table row has them", () => {
  const me = "11111111-1111-1111-1111-111111111111";
  const rows = shapeSeatedTableRows(
    [
      { table_id: "t1", member_id: me, stack: 100, status: "active" },
      { table_id: "t2", member_id: me, stack: 200, status: "active" }
    ],
    [
      { id: "t1", code: "AAAAA", status: "open", sb: 5, bb: 10 },
      { id: "t2", code: "BBBBB", status: "open" }
    ],
    me
  );
  assert.equal(rows[0].sb, 5);
  assert.equal(rows[0].bb, 10);
  assert.equal("sb" in rows[1], false);
});

// Compact fake store following how edge-functions.test.js mirrors the database rules.
function createFakeStore() {
  const users = new Map([["jwt-alice", { id: "11111111-1111-1111-1111-111111111111", email: "alice@kth.se" }]]);
  const tables = new Map();
  const seats = [];
  const ledger = [{ member_id: "11111111-1111-1111-1111-111111111111", delta: 1000 }];
  let seq = 1;
  return {
    tables,
    seats,
    ledger,
    async verifyUserJwt(jwt) { return users.get(jwt) || null; },
    async countOpenTablesByHost() { return 0; },
    async createTable({ code, hostId, sb, bb, minBuyIn, maxBuyIn, maxSeats }) {
      const t = { id: `t-${seq++}`, code, host_id: hostId, sb, bb, min_buyin: minBuyIn, max_buyin: maxBuyIn, max_seats: maxSeats, status: "open" };
      tables.set(t.id, t);
      return { ...t };
    },
    async sitDown({ tableId, memberId, seatNo, buyIn }) {
      const t = tables.get(tableId);
      if (buyIn < t.min_buyin || buyIn > t.max_buyin) throw new Error("ERR_INVALID_BUYIN: invalid buy-in");
      ledger.push({ member_id: memberId, delta: -buyIn });
      seats.push({ table_id: tableId, seat_no: seatNo, member_id: memberId, stack: buyIn, status: "active" });
    },
    async getTableContext(ref) {
      const t = tables.get(ref) || [...tables.values()].find((x) => x.code === String(ref).toUpperCase());
      if (!t) return null;
      return {
        table: { ...t },
        seats: seats.filter((s) => s.table_id === t.id).map((s) => ({ ...s })),
        hand: null,
        lastHandNo: 0,
        displayNamesByMemberId: new Map([["11111111-1111-1111-1111-111111111111", "Alice K."]])
      };
    },
    async broadcastTableState() {}
  };
}

test("create intent accepts Micro 1/2 stakes and sends the table's own range to the client", async () => {
  const store = createFakeStore();
  const res = await handleTableRequest({
    store,
    jwt: "jwt-alice",
    payload: { intent: "create", sb: 1, bb: 2, minBuyIn: 40, maxBuyIn: 200, maxSeats: 6, buyIn: 100, seat: 0 },
    rng: createSeededRng(7)
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.table.sb, 1);
  assert.equal(res.body.table.bb, 2);
  assert.equal(res.body.table.minBuyIn, 40);
  assert.equal(res.body.table.maxBuyIn, 200);
  assert.equal(store.seats[0].stack, 100);
});

test("a buy-in outside the table's own range is rejected on create and on join", async () => {
  const store = createFakeStore();
  const bad = await handleTableRequest({
    store,
    jwt: "jwt-alice",
    payload: { intent: "create", sb: 1, bb: 2, minBuyIn: 40, maxBuyIn: 200, buyIn: 500, seat: 0 },
    rng: createSeededRng(8)
  });
  assert.equal(bad.status >= 400, true);
  assert.equal(store.seats.length, 0);
  assert.equal(store.ledger.reduce((a, r) => a + r.delta, 0), 1000);

  const ok = await handleTableRequest({
    store,
    jwt: "jwt-alice",
    payload: { intent: "create", sb: 1, bb: 2, minBuyIn: 40, maxBuyIn: 200 },
    rng: createSeededRng(9)
  });
  assert.equal(ok.status, 200);
  const join = await handleTableRequest({
    store,
    jwt: "jwt-alice",
    payload: { intent: "join", table: ok.body.table.code, buyIn: 20 }
  });
  assert.equal(join.status >= 400, true);
});
