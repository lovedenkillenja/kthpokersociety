import test from "node:test";
import assert from "node:assert/strict";
import {
  shapeOpenTableRows, selectOpenTables, openTableStatusLabel, countHiddenFullTables,
  formatOpenTablesSummary, openTableActionLabel
} from "../lib/open-tables.js";

const NOW = Date.parse("2026-11-14T12:00:00Z");
const ago = (min) => new Date(NOW - min * 60000).toISOString();
const table = (id, o = {}) => ({
  id, code: id.toUpperCase().padEnd(5, "X"), status: "open", sb: 5, bb: 10, min_buyin: 200, max_buyin: 1000,
  max_seats: 6, created_at: ago(10), last_activity_at: ago(1), ...o
});
const seat = (table_id, n, o = {}) => ({ table_id, seat_no: n, member_id: `m${table_id}${n}`, stack: 500, status: "active", ...o });

test("shape: counts active and sitout seats, ignores left", () => {
  const rows = shapeOpenTableRows([table("a")], [seat("a", 0), seat("a", 1, { status: "sitout" }), seat("a", 2, { status: "left" })]);
  assert.equal(rows[0].seated, 2);
  assert.equal(rows[0].freeSeats, 4);
  assert.equal(rows[0].stakesLabel, "5/10");
  assert.equal(rows[0].buyInRange, "200–1,000 chips");
  assert.equal(rows[0].isFull, false);
});

test("shape: status labels and closed tables dropped", () => {
  assert.equal(openTableStatusLabel("open"), "Waiting for players");
  assert.equal(openTableStatusLabel("playing"), "Hand in progress");
  const rows = shapeOpenTableRows([table("a", { status: "closed" }), table("b", { status: "playing" }), { id: "c" }], []);
  assert.deepEqual(rows.map((r) => r.statusLabel), ["Hand in progress"]);
});

test("shape: isMine and full", () => {
  const seats = [0, 1].map((n) => seat("a", n, { member_id: n === 0 ? "me" : "x" }));
  const rows = shapeOpenTableRows([table("a", { max_seats: 2 })], seats, "me");
  assert.equal(rows[0].isMine, true);
  assert.equal(rows[0].isFull, true);
  assert.equal(shapeOpenTableRows([table("a")], seats, "other")[0].isMine, false);
});

test("shape: tolerates bad input", () => {
  assert.deepEqual(shapeOpenTableRows(null, null), []);
  assert.equal(shapeOpenTableRows([table("a", { sb: null })], [])[0].stakesLabel, "");
});

test("select: full tables hidden unless toggled, mine always shown", () => {
  const seats = [0, 1].map((n) => seat("f", n)).concat([seat("m", 0, { member_id: "me" }), seat("m", 1)]);
  const rows = shapeOpenTableRows([table("f", { max_seats: 2 }), table("m", { max_seats: 2 })], seats, "me");
  assert.deepEqual(selectOpenTables(rows, { now: NOW }).map((r) => r.tableId), ["m"]);
  assert.equal(selectOpenTables(rows, { showFull: true, now: NOW }).length, 2);
  assert.equal(countHiddenFullTables(rows), 1);
});

test("select: idle empty tables hidden after 30 minutes, kept when seated", () => {
  const rows = shapeOpenTableRows(
    [table("old", { last_activity_at: ago(31) }), table("new", { last_activity_at: ago(29) }), table("busy", { last_activity_at: ago(120) })],
    [seat("busy", 0)]
  );
  assert.deepEqual(selectOpenTables(rows, { now: NOW }).map((r) => r.tableId).sort(), ["busy", "new"]);
});

test("select: players first, then stakes, then newest", () => {
  const rows = shapeOpenTableRows(
    [
      table("empty", { bb: 2 }),
      table("hiBb", { bb: 20 }),
      table("loNew", { bb: 10, created_at: ago(1) }),
      table("loOld", { bb: 10, created_at: ago(50) }),
      table("full", { bb: 2, max_seats: 1 })
    ],
    [seat("hiBb", 0), seat("loNew", 0), seat("loOld", 0), seat("full", 0)]
  );
  assert.deepEqual(selectOpenTables(rows, { showFull: true, now: NOW }).map((r) => r.tableId), ["loNew", "loOld", "hiBb", "empty", "full"]);
});

test("labels", () => {
  assert.equal(formatOpenTablesSummary([]), "No open tables right now.");
  assert.equal(formatOpenTablesSummary([1]), "1 open table.");
  assert.equal(formatOpenTablesSummary([1, 2]), "2 open tables.");
  const [r] = shapeOpenTableRows([table("a")], [seat("a", 0, { member_id: "me" })], "me");
  assert.match(openTableActionLabel(r), /^Return to table/);
  assert.match(openTableActionLabel({ ...r, isMine: false }), /^Sit down at table/);
});
