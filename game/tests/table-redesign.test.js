import test from "node:test";
import assert from "node:assert/strict";

import { getSeatSlots, assignSeatSlots, betDirection, clampSeatTotal } from "../lib/table-layout.js";
import { getDisplayPots } from "../lib/table-helpers.js";

test("getSeatSlots: own seat is bottom centre and every table size has distinct in-bounds positions", () => {
  for (const shape of ["portrait", "wide"]) {
    for (let total = 2; total <= 6; total += 1) {
      const slots = getSeatSlots(total, shape);
      assert.equal(slots.length, total, `${shape} ${total}`);
      assert.equal(slots[0][0], 50, "slot 0 is horizontally centred");
      assert.ok(slots[0][1] >= 85, "slot 0 is at the bottom");
      const keys = new Set(slots.map((p) => p.join(",")));
      assert.equal(keys.size, total, "positions are distinct");
      slots.forEach(([x, y]) => assert.ok(x >= 8 && x <= 92 && y >= 5 && y <= 95, `${shape} ${total} in bounds`));
    }
  }
  assert.equal(clampSeatTotal(undefined), 6);
  assert.equal(clampSeatTotal(1), 2);
  assert.equal(clampSeatTotal(9), 6);
});

test("getSeatSlots: seats after the player run clockwise (left side first, then top, then right)", () => {
  const six = getSeatSlots(6, "wide");
  assert.ok(six[1][0] < 50 && six[2][0] < 50, "slots 1-2 are on the left");
  assert.equal(six[3][0], 50, "slot 3 is the top centre");
  assert.ok(six[4][0] > 50 && six[5][0] > 50, "slots 4-5 are on the right");
});

test("assignSeatSlots places a seated player at slot 0 and lists the open slots", () => {
  const a = assignSeatSlots({ seatNos: [0, 1, 3], selfSeatNo: 1, maxSeats: 6 });
  assert.equal(a.slotBySeat.get(1), 0);
  assert.equal(a.slotBySeat.get(3), 2);
  assert.equal(a.slotBySeat.get(0), 5);
  assert.deepEqual(a.openSlots, [1, 3, 4]);
  assert.equal(a.total, 6);
});

test("assignSeatSlots keeps slot 0 free for the buy-in form when the viewer is not seated", () => {
  const a = assignSeatSlots({ seatNos: [2, 4], selfSeatNo: null, maxSeats: 4 });
  assert.equal(a.slotBySeat.size, 2);
  assert.ok([...a.slotBySeat.values()].every((s) => s >= 1 && s <= 3));
  assert.equal(a.openSlots.length, 1);
  assert.ok(!a.openSlots.includes(0));
});

test("assignSeatSlots never loses a seat or reuses a slot (2-6 max, any self seat)", () => {
  for (let total = 2; total <= 6; total += 1) {
    for (let self = 0; self < total; self += 1) {
      const all = Array.from({ length: total }, (_, i) => i);
      const a = assignSeatSlots({ seatNos: all, selfSeatNo: self, maxSeats: total });
      assert.equal(a.slotBySeat.get(self), 0);
      assert.equal(new Set(a.slotBySeat.values()).size, total);
      assert.equal(a.openSlots.length, 0);
    }
  }
});

test("betDirection puts the chip on the side of the seat that faces the pot", () => {
  assert.equal(betDirection([22, 70]), "right");
  assert.equal(betDirection([78, 22]), "left");
  assert.equal(betDirection([50, 8]), "down");
  assert.equal(betDirection([50, 87]), "up");
});

test("getDisplayPots only shows a breakdown for real side pots", () => {
  const seats = [{ seatNo: 0, allIn: false }, { seatNo: 1, allIn: false }, { seatNo: 2, allIn: false }];
  // plain bet levels preflop, nobody all-in: no breakdown
  const preflop = {
    status: "playing",
    pots: [
      { amount: 30, eligibleSeats: [0, 1, 2] },
      { amount: 20, eligibleSeats: [1, 2] }
    ]
  };
  assert.deepEqual(getDisplayPots(preflop, seats), []);
  // somebody all-in and the pots have different eligible players: show them
  const allIn = [{ seatNo: 0, allIn: true }, ...seats.slice(1)];
  assert.equal(getDisplayPots(preflop, allIn).length, 2);
  // a single pot, or empty slices, never need a breakdown
  assert.deepEqual(getDisplayPots({ status: "playing", pots: [{ amount: 90, eligibleSeats: [0, 1, 2] }] }, allIn), []);
  assert.deepEqual(
    getDisplayPots({ status: "playing", pots: [{ amount: 90, eligibleSeats: [0, 1] }, { amount: 0, eligibleSeats: [1] }] }, allIn),
    []
  );
  // identical eligibility is one pot
  assert.deepEqual(
    getDisplayPots({ status: "complete", pots: [{ amount: 60, eligibleSeats: [0, 1] }, { amount: 40, eligibleSeats: [1, 0] }] }, seats),
    []
  );
  // completed hand with real side pots shows without needing an all-in flag
  assert.equal(
    getDisplayPots({ status: "complete", showdown: { pots: [{ amount: 60, eligibleSeats: [0, 1, 2] }, { amount: 40, eligibleSeats: [1, 2] }] } }, seats).length,
    2
  );
  assert.deepEqual(getDisplayPots(null, seats), []);
});
