import test from "node:test";
import assert from "node:assert/strict";
import {
  findSelfSeat,
  isAlreadySeatedAt,
  shapeSeatedTableRows,
  sumSeatedChips,
  findSeatedRowByCode,
  formatSeatedSummary,
  seatedChipsHint
} from "../lib/seated-tables.js";

const ME = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

test("isAlreadySeatedAt trusts the server's isSelf flag for active and sit-out seats", () => {
  const state = (status, isSelf = true, tableStatus = "open") => ({
    code: "NFVPM",
    status: tableStatus,
    seats: [
      { seatNo: 0, stack: 800, status: "active", isSelf: false },
      { seatNo: 1, stack: 500, status, isSelf }
    ]
  });
  assert.equal(isAlreadySeatedAt(state("active")), true);
  assert.equal(isAlreadySeatedAt(state("sitout")), true);
  assert.equal(isAlreadySeatedAt(state("left")), false);
  assert.equal(isAlreadySeatedAt(state("active", false)), false);
  assert.equal(isAlreadySeatedAt(state("active", true, "closed")), false);
  assert.equal(isAlreadySeatedAt(state("active", true, "playing")), true);
  assert.equal(findSelfSeat(state("active")).seatNo, 1);
});

test("isAlreadySeatedAt handles missing or malformed state", () => {
  assert.equal(isAlreadySeatedAt(null), false);
  assert.equal(isAlreadySeatedAt({}), false);
  assert.equal(isAlreadySeatedAt({ seats: "nope" }), false);
  assert.equal(isAlreadySeatedAt({ seats: [null, { isSelf: "true", status: "active" }] }), false);
});

test("shapeSeatedTableRows joins seats to tables and drops left seats, closed and unknown tables", () => {
  const seats = [
    { table_id: "t2", member_id: ME, seat_no: 0, stack: 500, status: "active" },
    { table_id: "t1", member_id: ME, seat_no: 3, stack: 500, status: "sitout" },
    { table_id: "t3", member_id: ME, seat_no: 1, stack: 900, status: "left" },
    { table_id: "t4", member_id: ME, seat_no: 1, stack: 700, status: "active" },
    { table_id: "t5", member_id: ME, seat_no: 1, stack: 300, status: "active" },
    { table_id: "t1", member_id: OTHER, seat_no: 0, stack: 999, status: "active" }
  ];
  const tables = [
    { id: "t1", code: "nfvpm", status: "open" },
    { id: "t2", code: "BRQPN", status: "playing" },
    { id: "t3", code: "LEFTX", status: "open" },
    { id: "t4", code: "CLOSD", status: "closed" }
  ];
  const rows = shapeSeatedTableRows(seats, tables, ME);
  assert.deepEqual(rows, [
    { tableId: "t2", code: "BRQPN", stack: 500, seatStatus: "active", tableStatus: "playing" },
    { tableId: "t1", code: "NFVPM", stack: 500, seatStatus: "sitout", tableStatus: "open" }
  ]);
  assert.equal(sumSeatedChips(rows), 1000);
});

test("shapeSeatedTableRows tolerates empty and bad input", () => {
  assert.deepEqual(shapeSeatedTableRows(null, null), []);
  assert.deepEqual(shapeSeatedTableRows([{ table_id: "t1", status: "active", stack: "abc" }], [{ id: "t1", code: "ABCDE", status: "open" }])[0].stack, 0);
  assert.equal(sumSeatedChips(null), 0);
  assert.equal(sumSeatedChips([{ stack: -5 }, { stack: 12.7 }, {}]), 12);
});

test("findSeatedRowByCode matches room codes case-insensitively", () => {
  const rows = [{ code: "NFVPM", stack: 500 }, { code: "BRQPN", stack: 500 }];
  assert.equal(findSeatedRowByCode(rows, " nfvpm ").code, "NFVPM");
  assert.equal(findSeatedRowByCode(rows, "ZZZZZ"), null);
  assert.equal(findSeatedRowByCode(rows, ""), null);
});

test("formatSeatedSummary and seatedChipsHint render play-money totals", () => {
  assert.equal(formatSeatedSummary(0, 1000), "Wallet 0 · At tables 1,000");
  assert.equal(formatSeatedSummary(1250, 0), "Wallet 1,250 · At tables 0");
  assert.equal(seatedChipsHint([]), "");
  assert.equal(seatedChipsHint([{ stack: 500 }]), "You have 500 chips seated at 1 table. Use “Return to table” under “Your chips at tables” above.");
  assert.equal(
    seatedChipsHint([{ stack: 500 }, { stack: 500 }]),
    "You have 1,000 chips seated at 2 tables. Use “Return to table” under “Your chips at tables” above."
  );
});

test("the Active table banner is hidden for tables already listed under Your chips at tables", async () => {
  const { shouldShowActiveTableBanner } = await import("../lib/seated-tables.js");
  const rows = [{ code: "NFVPM", stack: 500 }];
  assert.equal(shouldShowActiveTableBanner(null, rows), false);
  assert.equal(shouldShowActiveTableBanner({ code: "NFVPM" }, rows), false);
  assert.equal(shouldShowActiveTableBanner({ code: "nfvpm" }, rows), false);
  assert.equal(shouldShowActiveTableBanner({ code: "OTHER" }, rows), true);
  assert.equal(shouldShowActiveTableBanner({ code: "NFVPM" }, []), true);
  assert.equal(shouldShowActiveTableBanner({ code: "NFVPM" }, undefined), true);
});
