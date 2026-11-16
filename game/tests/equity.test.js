import test from "node:test";
import assert from "node:assert/strict";
import { createSeededRng } from "../engine/index.js";
import {
  simulateEquity,
  runEquityInSlices,
  countOuts,
  drawOddsExact,
  ruleOf2And4,
  potOdds,
  callExpectedValue,
  chenScore,
  combinations,
  unseenCards
} from "../lib/equity.js";

const close = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg}: expected ~${expected}, got ${actual}`);

test("AA vs one random hand preflop is about 85%", () => {
  const res = simulateEquity({ hole: ["As", "Ah"], opponents: 1, samples: 3000, rng: createSeededRng(7) });
  assert.equal(res.samples, 3000);
  close(res.equity, 0.852, 0.025, "AA equity");
});

test("72o vs one random hand preflop is about 35%", () => {
  const res = simulateEquity({ hole: ["7c", "2d"], opponents: 1, samples: 3000, rng: createSeededRng(11) });
  close(res.equity, 0.346, 0.03, "72o equity");
});

test("AA equity drops against more opponents (about 56% vs 4)", () => {
  const res = simulateEquity({ hole: ["Ad", "Ac"], opponents: 4, samples: 3000, rng: createSeededRng(3) });
  close(res.equity, 0.559, 0.03, "AA vs 4");
});

test("a made royal flush on the river always wins", () => {
  const res = simulateEquity({ hole: ["As", "Ks"], board: ["Qs", "Js", "Ts", "2d", "3c"], opponents: 3, samples: 200, rng: createSeededRng(1) });
  assert.equal(res.equity, 1);
});

test("same seed gives the same estimate; a tightened range lowers equity", () => {
  const a = simulateEquity({ hole: ["Kd", "Qd"], opponents: 2, samples: 500, rng: createSeededRng(42) });
  const b = simulateEquity({ hole: ["Kd", "Qd"], opponents: 2, samples: 500, rng: createSeededRng(42) });
  assert.deepEqual(a, b);
  const tight = simulateEquity({
    hole: ["Kd", "Qd"], opponents: 2, samples: 1500, rng: createSeededRng(42),
    opponentFilter: (c1, c2) => chenScore(c1, c2) >= 9
  });
  const loose = simulateEquity({ hole: ["Kd", "Qd"], opponents: 2, samples: 1500, rng: createSeededRng(42) });
  assert.ok(tight.equity < loose.equity, `tight ${tight.equity} < loose ${loose.equity}`);
});

test("runEquityInSlices reports progress and finishes with all samples", async () => {
  const progress = [];
  const done = await new Promise((resolve) => {
    runEquityInSlices(
      { hole: ["Qh", "Qs"], opponents: 1, rng: createSeededRng(5) },
      { samples: 900, sliceSize: 300, onProgress: (r) => progress.push(r.samples), onDone: resolve, schedule: (fn) => setImmediate(fn) }
    );
  });
  assert.deepEqual(progress, [300, 600]);
  assert.equal(done.samples, 900);
  close(done.equity, 0.8, 0.05, "QQ equity");
});

test("cancel stops a sliced run", async () => {
  let doneCalled = false;
  const job = runEquityInSlices(
    { hole: ["Qh", "Qs"], opponents: 1, rng: createSeededRng(5) },
    { samples: 3000, sliceSize: 100, onDone: () => { doneCalled = true; }, schedule: (fn) => setImmediate(fn) }
  );
  job.cancel();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(doneCalled, false);
});

test("flush draw on the flop: 9 outs, about 35% by the river (exact 34.97%)", () => {
  const outs = countOuts(["Ah", "7h"], ["Kh", "9h", "2c"]);
  assert.equal(outs.outs, 9);
  assert.deepEqual(outs.draws.map((d) => d.kind), ["flush"]);
  close(drawOddsExact(9, 47, 2), 0.3497, 0.0005, "exact flush by river");
  close(drawOddsExact(9, 46, 1), 9 / 46, 1e-9, "exact flush on the river");
  assert.equal(ruleOf2And4(9, 2), 0.36);
  assert.equal(ruleOf2And4(9, 1), 0.18);
});

test("open-ended straight draw has 8 outs, a gutshot 4, combo draws count overlaps once", () => {
  assert.equal(countOuts(["8c", "7d"], ["6h", "5s", "Kc"]).outs, 8);
  assert.equal(countOuts(["9c", "7d"], ["6h", "5s", "Kc"]).outs, 4);
  const combo = countOuts(["8h", "7h"], ["6h", "5h", "Kc"]); // flush draw + open-ended
  assert.equal(combo.outs, 15);
  assert.deepEqual(combo.draws.map((d) => d.kind).sort(), ["flush", "open-ended"]);
  assert.equal(countOuts(["Ac", "2d"], ["3h", "4s", "9c"]).outs, 4); // wheel gutshot (needs a 5)
});

test("pocket pair to a set: 2 outs; no draw on a made flush or on the river", () => {
  assert.equal(countOuts(["6c", "6d"], ["Kh", "9s", "2c"]).outs, 2);
  assert.equal(countOuts(["Ah", "7h"], ["Kh", "9h", "2h"]).outs, 0);
  assert.equal(countOuts(["Ah", "7h"], ["Kh", "9h", "2c", "3d", "4s"]).outs, 0);
});

test("pot odds, required equity and the value of a call", () => {
  const o = potOdds(60, 180);
  assert.equal(o.requiredEquity, 0.25);
  assert.equal(o.winTotal, 240);
  assert.equal(potOdds(0, 100).requiredEquity, 0);
  assert.equal(callExpectedValue(0.25, 60, 180), 0);
  close(callExpectedValue(0.62, 60, 180), 88.8, 1e-9, "EV of call");
});

test("helpers: combinations, unseen cards and the Chen score", () => {
  assert.equal(combinations(47, 2), 1081);
  assert.equal(unseenCards(["As", "Kd"]).length, 50);
  assert.equal(chenScore("As", "Ah"), 20);
  assert.equal(chenScore("Ks", "Kd"), 16);
  assert.equal(chenScore("As", "Ks"), 12);
  assert.equal(chenScore("7c", "2d"), -1);
  assert.equal(chenScore("2c", "2d"), 5);
});
