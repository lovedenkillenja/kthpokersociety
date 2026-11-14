import test from "node:test";
import assert from "node:assert/strict";
import { chipStacks, iconDenomination, DENOMINATIONS, RIM_INSERTS } from "../lib/chips.js";

const total = (stacks) => stacks.reduce((n, s) => n + s.count, 0);

test("chipStacks: empty for zero, negative and junk", () => {
  for (const v of [0, -5, NaN, undefined, null, "x", Infinity]) assert.deepEqual(chipStacks(v), []);
});

test("chipStacks: largest denominations first", () => {
  assert.deepEqual(chipStacks(1380), [
    { denom: 1000, count: 1 },
    { denom: 100, count: 3 },
    { denom: 25, count: 3 }
  ]);
  assert.deepEqual(chipStacks(30), [{ denom: 25, count: 1 }, { denom: 5, count: 1 }]);
  assert.deepEqual(chipStacks(7), [{ denom: 5, count: 1 }, { denom: 1, count: 2 }]);
});

test("chipStacks: caps chips per stack and number of stacks", () => {
  assert.deepEqual(chipStacks(1_000_000), [{ denom: 1000, count: 5 }]);
  const mixed = chipStacks(4999);
  assert.ok(mixed.length <= 3);
  mixed.forEach((s) => assert.ok(s.count <= 5));
  assert.ok(total(chipStacks(123_456)) <= 15);
  assert.deepEqual(chipStacks(1380, { maxPerStack: 2, maxStacks: 2 }), [
    { denom: 1000, count: 1 },
    { denom: 100, count: 2 }
  ]);
});

test("chipStacks: with generous caps the stacks add up to the amount", () => {
  for (const amount of [1, 4, 5, 24, 99, 101, 640, 2500, 9999]) {
    const sum = chipStacks(amount, { maxPerStack: 99, maxStacks: 6 }).reduce((n, s) => n + s.denom * s.count, 0);
    assert.equal(sum, amount);
  }
});

test("iconDenomination: highest fitting denomination", () => {
  assert.equal(iconDenomination(0), 1);
  assert.equal(iconDenomination(4), 1);
  assert.equal(iconDenomination(5), 5);
  assert.equal(iconDenomination(99), 25);
  assert.equal(iconDenomination(100), 100);
  assert.equal(iconDenomination(1380), 1000);
  assert.equal(iconDenomination(5_000_000), 1000);
  assert.equal(iconDenomination("abc"), 1);
});

test("every denomination has a distinct rim insert count", () => {
  const counts = DENOMINATIONS.map((d) => RIM_INSERTS[d]);
  assert.ok(counts.every(Number.isInteger));
  assert.equal(new Set(counts).size, DENOMINATIONS.length);
});
