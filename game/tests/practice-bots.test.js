import test from "node:test";
import assert from "node:assert/strict";
import { newHand, apply, legalActions, checkChipConservation, createSeededRng } from "../engine/index.js";
import { buildBotView, decideBotAction, sanitizeAction, positionOf, BOT_STYLE_IDS } from "../lib/practice-bots.js";

function seatsFor(n, rng) {
  return Array.from({ length: n }, (_, i) => ({ seat: i, id: `p${i}`, stack: 200 + Math.floor(rng() * 1800), status: "active" }));
}

test("a bot's view holds only public information and its own hole cards", () => {
  const rng = createSeededRng(9);
  const state = newHand(seatsFor(4, rng), 0, { sb: 5, bb: 10 }, rng);
  const seat = state.actingSeat;
  const view = buildBotView(state, seat);
  const json = JSON.stringify(view);
  assert.equal("deck" in view, false);
  const own = state.seats.find((p) => p.seat === seat).holeCards;
  assert.deepEqual(view.holeCards, own);
  for (const p of state.seats) {
    if (p.seat === seat) continue;
    for (const card of p.holeCards) assert.equal(json.includes(`"${card}"`), false, `leaked ${card}`);
  }
  for (const card of state.deck.slice(state.deckCursor)) assert.equal(json.includes(`"${card}"`), false, `leaked deck card ${card}`);
});

test("sanitizeAction never folds when checking is free and clamps raise sizes", () => {
  const legalCheck = { canFold: true, canCheck: true, canCall: false, callAmount: 0, canRaise: true, minRaiseTo: 10, maxRaiseTo: 500, actions: ["fold", "check", "raise", "all-in"] };
  assert.deepEqual(sanitizeAction({ type: "fold" }, legalCheck), { type: "check" });
  assert.deepEqual(sanitizeAction({ type: "raise", amount: 5 }, legalCheck), { type: "raise", amount: 10 });
  assert.deepEqual(sanitizeAction({ type: "raise", amount: 9999 }, legalCheck), { type: "raise", amount: 500 });
  const legalNoRaise = { canFold: true, canCheck: false, canCall: true, callAmount: 40, canRaise: false, minRaiseTo: null, maxRaiseTo: null, actions: ["fold", "call", "all-in"] };
  assert.deepEqual(sanitizeAction({ type: "raise", amount: 100 }, legalNoRaise), { type: "call" });
});

test("positions: dealer is late, blinds are blinds", () => {
  const rng = createSeededRng(2);
  const state = newHand(seatsFor(6, rng), 3, { sb: 5, bb: 10 }, rng);
  const at = (seat) => positionOf(buildBotView(state, seat));
  assert.equal(at(state.dealerSeat), "late");
  assert.equal(at(state.sbSeat), "blinds");
  assert.equal(at(state.bbSeat), "blinds");
  assert.equal(at((state.bbSeat + 1) % 6), "early");
});

test("styles differ: tight folds more preflop than loose over the same deals", () => {
  const folds = {};
  for (const styleId of BOT_STYLE_IDS) {
    let n = 0;
    for (let i = 0; i < 300; i += 1) {
      const rng = createSeededRng(1000 + i);
      const state = newHand(seatsFor(6, rng), 0, { sb: 5, bb: 10 }, rng);
      const d = decideBotAction(buildBotView(state, state.actingSeat), styleId, createSeededRng(i), { samples: 50 });
      if (d.type === "fold") n += 1;
    }
    folds[styleId] = n;
  }
  assert.ok(folds.tight > folds.balanced && folds.balanced > folds.loose, JSON.stringify(folds));
});

test("bots play hundreds of seeded hands with only legal actions and chips conserved after every action", () => {
  let hands = 0;
  let actions = 0;
  for (let h = 0; h < 160; h += 1) {
    const rng = createSeededRng(5000 + h);
    const n = 2 + (h % 5);
    let state = newHand(seatsFor(n, rng), h % n, { sb: 5, bb: 10 }, rng);
    const styles = Array.from({ length: n }, (_, i) => BOT_STYLE_IDS[(i + h) % 3]);
    let guard = 0;
    while (state.status === "playing") {
      const seat = state.actingSeat;
      const legal = legalActions(state, seat);
      const d = decideBotAction(buildBotView(state, seat), styles[seat], rng, { samples: 40 });
      assert.ok(legal.actions.includes(d.type), `illegal ${d.type} (${legal.actions})`);
      if (d.type === "raise") assert.ok(d.amount >= legal.minRaiseTo && d.amount <= legal.maxRaiseTo);
      if (legal.canCheck) assert.notEqual(d.type, "fold");
      state = apply(state, seat, d.type === "raise" ? { type: "raise", amount: d.amount } : { type: d.type });
      actions += 1;
      assert.ok(checkChipConservation(state).conserved, "chips conserved");
      guard += 1;
      assert.ok(guard < 200, "hand terminates");
    }
    hands += 1;
  }
  assert.equal(hands, 160);
  assert.ok(actions > 500);
});

test("decisions are deterministic for a seeded rng", () => {
  const make = () => {
    const rng = createSeededRng(77);
    let state = newHand(seatsFor(3, rng), 0, { sb: 5, bb: 10 }, rng);
    const log = [];
    while (state.status === "playing") {
      const d = decideBotAction(buildBotView(state, state.actingSeat), "balanced", rng, { samples: 60 });
      log.push(`${state.actingSeat}:${d.type}:${d.amount ?? ""}`);
      state = apply(state, state.actingSeat, d.type === "raise" ? { type: "raise", amount: d.amount } : { type: d.type });
    }
    return log.join(",");
  };
  assert.equal(make(), make());
});
