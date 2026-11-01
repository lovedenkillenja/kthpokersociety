import test from "node:test";
import assert from "node:assert/strict";
import {
  formatChips,
  formatDelta,
  stockholmDateString,
  hasClaimedToday,
  validateDisplayName,
  deriveDefaultDisplayName,
  normalizeLeaderboardRows,
  interpretDailyClaimResult,
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

test("stockholmDateString and hasClaimedToday respect Europe/Stockholm calendar day", () => {
  // 2026-11-01T23:30:00Z is 2026-11-02 00:30 in Stockholm (CET, UTC+1)
  const nowUtc = new Date("2026-11-01T23:30:00Z");
  assert.equal(stockholmDateString(nowUtc), "2026-11-02");

  const ledgerToday = [
    { source: "daily", delta: 100, ref: "daily:2026-11-02", created_at: "2026-11-01T23:10:00Z" }
  ];
  assert.equal(hasClaimedToday(ledgerToday, nowUtc), true);

  const ledgerYesterday = [
    { source: "daily", delta: 100, ref: "daily:2026-11-01", created_at: "2026-11-01T12:00:00Z" }
  ];
  assert.equal(hasClaimedToday(ledgerYesterday, nowUtc), false);
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

test("interpretDailyClaimResult handles new claim, duplicate claim, and errors", () => {
  const claimed = interpretDailyClaimResult({
    rpcData: { claimed: true, delta: 100 },
    rpcError: null,
    previousBalance: 1000,
    nextBalance: 1100
  });
  assert.equal(claimed.status, "claimed");
  assert.equal(claimed.delta, 100);

  const dup = interpretDailyClaimResult({
    rpcData: null,
    rpcError: { code: "23505", message: "duplicate key value violates unique constraint" },
    previousBalance: 1100,
    nextBalance: 1100
  });
  assert.equal(dup.status, "already_claimed");
  assert.equal(dup.delta, 0);
});

test("friendlyAuthError provides actionable guidance", () => {
  assert.match(friendlyAuthError({ message: "Invalid login credentials" }), /Email or password is wrong/);
  assert.match(friendlyAuthError({ message: "Failed to fetch" }), /Connection lost/);
});
