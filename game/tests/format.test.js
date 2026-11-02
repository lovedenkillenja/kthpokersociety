import test from "node:test";
import assert from "node:assert/strict";
import {
  formatChips,
  formatDelta,
  formatLedgerSource,
  validateDisplayName,
  deriveDefaultDisplayName,
  normalizeLeaderboardRows,
  friendlyAuthError
} from "../lib/format.js";

test("formatChips formats integer amounts without currency symbols", () => {
  assert.equal(formatChips(0), "0");
  assert.equal(formatChips(100), "100");
  assert.equal(formatChips(1000), "1,000");
  assert.equal(formatChips(123456), "123,456");
  assert.equal(formatChips("1500.9"), "1,500");
  assert.equal(formatChips(NaN), "0");
});

test("formatDelta formats positive and negative chip changes", () => {
  assert.equal(formatDelta(100), "+100");
  assert.equal(formatDelta(1000), "+1,000");
  assert.equal(formatDelta(-400), "−400");
  assert.equal(formatDelta(0), "0");
});

test("formatLedgerSource formats labels for welcome, referral, table, and legacy daily rows", () => {
  assert.equal(formatLedgerSource("welcome"), "Welcome");
  assert.equal(formatLedgerSource("referral"), "Referral");
  assert.equal(formatLedgerSource("daily"), "Daily");
  assert.equal(formatLedgerSource("game"), "Table");
  assert.equal(formatLedgerSource("event"), "Event");
  assert.equal(formatLedgerSource("admin"), "Society");
});

test("validateDisplayName enforces 1..40 chars and strips control chars", () => {
  assert.deepEqual(validateDisplayName("   "), {
    valid: false,
    value: "",
    error: "Enter a display name between 1 and 40 characters."
  });
  assert.deepEqual(validateDisplayName("  Alice   KTH \n "), {
    valid: true,
    value: "Alice KTH",
    error: ""
  });
  const tooLong = "A".repeat(41);
  const res = validateDisplayName(tooLong);
  assert.equal(res.valid, false);
  assert.equal(res.value.length, 40);
});

test("deriveDefaultDisplayName creates privacy-friendly display name", () => {
  assert.equal(deriveDefaultDisplayName("Erik Lindqvist", "erik@kth.se"), "Erik L.");
  assert.equal(deriveDefaultDisplayName("Maja", "maja@kth.se"), "Maja");
  assert.equal(deriveDefaultDisplayName("", "student@kth.se"), "student");
});

test("normalizeLeaderboardRows normalizes various RPC row shapes", () => {
  const rows = [
    { rank: 1, display_name: "Erik L.", balance: 1400, member_id: "u-1" },
    { display_name: "Maja S.", chips: 1100, member_id: "u-2" }
  ];
  const normalized = normalizeLeaderboardRows(rows, "u-2", "Maja S.");
  assert.equal(normalized.length, 2);
  assert.deepEqual(normalized[0], {
    rank: 1,
    displayName: "Erik L.",
    balance: 1400,
    memberId: "u-1",
    isCurrentUser: false
  });
  assert.deepEqual(normalized[1], {
    rank: 2,
    displayName: "Maja S.",
    balance: 1100,
    memberId: "u-2",
    isCurrentUser: true
  });
});

test("friendlyAuthError provides actionable guidance", () => {
  assert.match(friendlyAuthError({ message: "Invalid login credentials" }), /Email or password is wrong/);
  assert.match(friendlyAuthError({ message: "Failed to fetch" }), /Connection lost/);
});
