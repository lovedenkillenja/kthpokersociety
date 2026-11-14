import test from "node:test";
import assert from "node:assert/strict";
import { computeActionBarState, isSeatInRunningHand } from "../lib/table-helpers.js";
import { STATE_NAMES, getMockState } from "../dev/mock-states.js";

test("A sitout seat that is still in the running hand gets the action controls on its turn", () => {
  assert.ok(STATE_NAMES.includes("sitout-in-hand-to-act"));
  const { table } = getMockState("sitout-in-hand-to-act");
  const self = table.seats.find((s) => s.isSelf);
  assert.equal(self.status, "sitout");
  assert.equal(isSeatInRunningHand(self, table.hand), true);
  assert.equal(table.hand.actingSeat, self.seatNo);

  const bar = computeActionBarState(table);
  assert.equal(bar.mode, "controls");
  assert.equal(bar.showIdleRow, false, "The Sit back in row must not replace the controls");
});

test("Action bar shows controls on the viewer's turn and a waiting state otherwise", () => {
  assert.equal(computeActionBarState(getMockState("flop-self-to-act").table).mode, "controls");
  assert.equal(computeActionBarState(getMockState("preflop-2").table).mode, "controls");
  assert.equal(computeActionBarState(getMockState("timer-low").table).mode, "controls");

  const folded = computeActionBarState(getMockState("river-folded-self").table);
  assert.equal(folded.mode, "waiting");
  assert.equal(folded.showIdleRow, false);

  // Sitting out and not dealt in: waiting, with "Sit back in" reachable
  const sitout = computeActionBarState(getMockState("sitout").table);
  assert.equal(sitout.mode, "waiting");
  assert.equal(sitout.showIdleRow, true);
  assert.equal(sitout.waitingText, "Sitting out this hand");

  assert.equal(computeActionBarState(getMockState("waiting-3").table).mode, "idle");
});

test("A sitout seat in the hand waiting for another player is told it is still in this hand", () => {
  const { table } = getMockState("sitout-in-hand-to-act");
  const self = table.seats.find((s) => s.isSelf);
  const other = table.seats.find((s) => !s.isSelf);
  const waitingTable = { ...table, hand: { ...table.hand, actingSeat: other.seatNo } };
  const bar = computeActionBarState(waitingTable);
  assert.equal(bar.mode, "waiting");
  assert.equal(bar.showIdleRow, true);
  assert.match(bar.waitingText, /^Waiting for Sam…/);
  assert.match(bar.waitingText, /next hand/);
  assert.equal(isSeatInRunningHand({ ...self, folded: true }, table.hand), false);
});

test("isSeatInRunningHand falls back to commitments when the server sends no inHand flag", () => {
  const hand = { status: "playing", actingSeat: 3 };
  assert.equal(isSeatInRunningHand({ seatNo: 1, totalCommitted: 20, folded: false }, hand), true);
  assert.equal(isSeatInRunningHand({ seatNo: 3, totalCommitted: 0, folded: false }, hand), true);
  assert.equal(isSeatInRunningHand({ seatNo: 2, totalCommitted: 0, folded: false }, hand), false);
  assert.equal(isSeatInRunningHand({ seatNo: 1, totalCommitted: 20 }, { status: "complete" }), false);
});
