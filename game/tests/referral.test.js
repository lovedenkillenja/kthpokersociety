import test from "node:test";
import assert from "node:assert/strict";
import {
  isValidReferralCode,
  normalizeReferralCode,
  buildReferralUrl,
  extractReferralCodeFromUrl,
  stripReferralParamFromUrl,
  getStoredReferralCode,
  setStoredReferralCode,
  clearStoredReferralCode,
  formatReferralStats
} from "../lib/referral.js";
import { REFERRAL_CONFIG } from "../config.js";

test("isValidReferralCode validates 8-character codes from unambiguous alphabet", () => {
  // Valid codes: 8 chars, 23456789ABCDEFGHJKLMNPQRSTUVWXYZ
  assert.equal(isValidReferralCode("23456789"), true);
  assert.equal(isValidReferralCode("ABCDEFGH"), true);
  assert.equal(isValidReferralCode("JKLMNPQR"), true);
  assert.equal(isValidReferralCode("STUVWXYZ"), true);
  assert.equal(isValidReferralCode("kth9268x"), true); // lowercase normalized

  // Invalid: contains ambiguous characters (0, O, 1, I)
  assert.equal(isValidReferralCode("ABCD0EFG"), false); // 0
  assert.equal(isValidReferralCode("ABCDOEFG"), false); // O
  assert.equal(isValidReferralCode("ABCD1EFG"), false); // 1
  assert.equal(isValidReferralCode("ABCDIEFG"), false); // I

  // Invalid lengths
  assert.equal(isValidReferralCode(""), false);
  assert.equal(isValidReferralCode("ABCDEFG"), false); // 7 chars
  assert.equal(isValidReferralCode("ABCDEFGHI"), false); // 9 chars

  // Invalid characters (symbols, punctuation, spaces)
  assert.equal(isValidReferralCode("ABCD-EFG"), false);
  assert.equal(isValidReferralCode("ABCD EFG"), false);
  assert.equal(isValidReferralCode("ABCD!EFG"), false);

  // Non-string inputs
  assert.equal(isValidReferralCode(null), false);
  assert.equal(isValidReferralCode(undefined), false);
  assert.equal(isValidReferralCode(12345678), false);
  assert.equal(isValidReferralCode({}), false);
});

test("normalizeReferralCode trims and uppercases valid codes", () => {
  assert.equal(normalizeReferralCode("  kth9268x  "), "KTH9268X");
  assert.equal(normalizeReferralCode("23456789"), "23456789");
  assert.equal(normalizeReferralCode("invalid"), null);
  assert.equal(normalizeReferralCode(""), null);
});

test("buildReferralUrl constructs valid invite URLs across production and branch deploys", () => {
  // Production origin
  const prodUrl = buildReferralUrl("KTH9268X", "https://kthpokersociety.se");
  assert.equal(prodUrl, "https://kthpokersociety.se/game/?ref=KTH9268X");

  // Trailing slash handling
  const trailingSlash = buildReferralUrl("KTH9268X", "https://kthpokersociety.se/");
  assert.equal(trailingSlash, "https://kthpokersociety.se/game/?ref=KTH9268X");

  // Netlify branch deploy origin
  const branchUrl = buildReferralUrl("23456789", "https://poker-game--kthpokersociety-v3.netlify.app");
  assert.equal(branchUrl, "https://poker-game--kthpokersociety-v3.netlify.app/game/?ref=23456789");

  // Invalid code falls back to base URL without ?ref
  const invalidUrl = buildReferralUrl("BADCODE", "https://kthpokersociety.se");
  assert.equal(invalidUrl, "https://kthpokersociety.se/game/");
});

test("extractReferralCodeFromUrl parses and validates ?ref parameter", () => {
  assert.equal(
    extractReferralCodeFromUrl("https://kthpokersociety.se/game/?ref=KTH9268X"),
    "KTH9268X"
  );
  assert.equal(
    extractReferralCodeFromUrl("https://kthpokersociety.se/game/?ref=kth9268x"),
    "KTH9268X"
  );
  assert.equal(
    extractReferralCodeFromUrl("https://kthpokersociety.se/game/?foo=1&ref=23456789&bar=2#table"),
    "23456789"
  );
  assert.equal(
    extractReferralCodeFromUrl("?ref=KTH9268X"),
    "KTH9268X"
  );

  // Ambiguous characters or invalid format return null
  assert.equal(extractReferralCodeFromUrl("https://kthpokersociety.se/game/?ref=ABCD0EFG"), null);
  assert.equal(extractReferralCodeFromUrl("https://kthpokersociety.se/game/?ref=SHORT"), null);
  assert.equal(extractReferralCodeFromUrl("https://kthpokersociety.se/game/"), null);
  assert.equal(extractReferralCodeFromUrl(""), null);
});

test("stripReferralParamFromUrl cleanly removes ref query param and invokes replaceState", () => {
  let replacedUrl = null;
  const mockHistory = {
    replaceState: (_state, _title, url) => {
      replacedUrl = url;
    }
  };

  const stripped1 = stripReferralParamFromUrl(
    "https://kthpokersociety.se/game/?ref=KTH9268X",
    mockHistory
  );
  assert.equal(stripped1, "https://kthpokersociety.se/game/");
  assert.equal(replacedUrl, "/game/");

  // Preserves other parameters and hash
  const stripped2 = stripReferralParamFromUrl(
    "https://kthpokersociety.se/game/?foo=bar&ref=KTH9268X#lobby",
    mockHistory
  );
  assert.equal(stripped2, "https://kthpokersociety.se/game/?foo=bar#lobby");
  assert.equal(replacedUrl, "/game/?foo=bar#lobby");
});

test("getStoredReferralCode, setStoredReferralCode, and clearStoredReferralCode work with localStorage", () => {
  const store = new Map();
  const mockStorage = {
    getItem: (key) => store.get(key) || null,
    setItem: (key, val) => store.set(key, String(val)),
    removeItem: (key) => store.delete(key)
  };

  assert.equal(getStoredReferralCode(mockStorage), null);

  assert.equal(setStoredReferralCode("kth9268x", mockStorage), true);
  assert.equal(getStoredReferralCode(mockStorage), "KTH9268X");

  // Invalid code is rejected by setter
  assert.equal(setStoredReferralCode("invalid0", mockStorage), false);
  assert.equal(getStoredReferralCode(mockStorage), "KTH9268X"); // unchanged

  clearStoredReferralCode(mockStorage);
  assert.equal(getStoredReferralCode(mockStorage), null);

  // Storage throwing exception does not crash
  const failingStorage = {
    getItem: () => { throw new Error("SecurityError: Access denied"); },
    setItem: () => { throw new Error("QuotaExceededError"); },
    removeItem: () => { throw new Error("SecurityError"); }
  };
  assert.equal(getStoredReferralCode(failingStorage), null);
  assert.equal(setStoredReferralCode("KTH2026X", failingStorage), false);
  assert.doesNotThrow(() => clearStoredReferralCode(failingStorage));
});

test("formatReferralStats formats invited count, capped rewarded count, and chip sum", () => {
  const stats = formatReferralStats({
    invitedCount: 7,
    rewardedCount: 5,
    totalEarned: 1250
  });

  assert.deepEqual(stats, {
    invitedLabel: "7",
    rewardedLabel: `5 / ${REFERRAL_CONFIG.maxRewarded}`,
    earnedLabel: "1,250"
  });

  const empty = formatReferralStats({});
  assert.deepEqual(empty, {
    invitedLabel: "0",
    rewardedLabel: `0 / ${REFERRAL_CONFIG.maxRewarded}`,
    earnedLabel: "0"
  });
});
