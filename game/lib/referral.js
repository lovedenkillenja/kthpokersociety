// Pure helpers and utilities for referral codes, links, storage, and stats.
// Follows SPEC.md & STYLE_GUIDE.md. Play money only – no cash value.

import { REFERRAL_CONFIG } from "../config.js";

/**
 * Validates whether a referral code is an 8-character string from the allowed alphabet (no 0/O/1/I).
 *
 * @param {string} code
 * @returns {boolean}
 */
export function isValidReferralCode(code) {
  if (typeof code !== "string") return false;
  const trimmed = code.trim().toUpperCase();
  if (trimmed.length !== REFERRAL_CONFIG.codeLength) return false;
  return REFERRAL_CONFIG.alphabetRegex.test(trimmed);
}

/**
 * Normalizes a referral code: trimmed, uppercase. Returns null if invalid.
 *
 * @param {string} code
 * @returns {string|null}
 */
export function normalizeReferralCode(code) {
  if (!isValidReferralCode(code)) return null;
  return code.trim().toUpperCase();
}

/**
 * Builds the canonical referral URL for a given referral code and origin.
 *
 * @param {string} code
 * @param {string} [origin]
 * @returns {string}
 */
export function buildReferralUrl(code, origin) {
  const norm = normalizeReferralCode(code);
  const baseOrigin = origin || (typeof window !== "undefined" ? window.location.origin : "https://kthpokersociety.se");
  // Clean base URL ending in /game/
  const cleanBase = baseOrigin.replace(/\/+$/, "");
  const path = cleanBase.endsWith("/game") ? cleanBase : `${cleanBase}/game`;
  if (!norm) return `${path}/`;
  return `${path}/?ref=${encodeURIComponent(norm)}`;
}

/**
 * Extracts and validates ?ref=CODE from a URL string or search string.
 *
 * @param {string} searchOrUrl
 * @returns {string|null}
 */
export function extractReferralCodeFromUrl(searchOrUrl) {
  if (!searchOrUrl || typeof searchOrUrl !== "string") return null;

  try {
    let search = searchOrUrl;
    if (searchOrUrl.includes("?")) {
      const parts = searchOrUrl.split("?");
      search = parts[1] ? `?${parts[1].split("#")[0]}` : "";
    } else if (searchOrUrl.startsWith("#")) {
      return null;
    } else if (!searchOrUrl.startsWith("?")) {
      search = `?${searchOrUrl}`;
    }

    const params = new URLSearchParams(search);
    const raw = params.get("ref");
    return normalizeReferralCode(raw);
  } catch (_err) {
    return null;
  }
}

/**
 * Strips the 'ref' query parameter from the current URL without triggering a page reload.
 *
 * @param {string} [currentHref]
 * @param {History} [historyObj]
 * @returns {string} The cleaned URL string.
 */
export function stripReferralParamFromUrl(currentHref, historyObj) {
  const href = currentHref || (typeof window !== "undefined" ? window.location.href : "");
  if (!href) return "";

  try {
    const url = new URL(href, "https://kthpokersociety.se");
    if (!url.searchParams.has("ref")) return url.toString();

    url.searchParams.delete("ref");
    const cleanUrl = url.search ? `${url.pathname}${url.search}${url.hash}` : `${url.pathname}${url.hash}`;

    const hist = historyObj || (typeof window !== "undefined" ? window.history : null);
    if (hist && typeof hist.replaceState === "function") {
      hist.replaceState({}, (typeof document !== "undefined" ? document.title : ""), cleanUrl);
    }
    return url.toString();
  } catch (_err) {
    return href;
  }
}

/**
 * Retrieves the stored referral code from localStorage (if any, valid only).
 *
 * @param {Storage} [storage]
 * @returns {string|null}
 */
export function getStoredReferralCode(storage) {
  const store = storage || (typeof window !== "undefined" ? window.localStorage : null);
  if (!store) return null;
  try {
    const val = store.getItem(REFERRAL_CONFIG.storageKey);
    return normalizeReferralCode(val);
  } catch (_err) {
    return null;
  }
}

/**
 * Saves a valid referral code into localStorage.
 *
 * @param {string} code
 * @param {Storage} [storage]
 * @returns {boolean} True if successfully stored.
 */
export function setStoredReferralCode(code, storage) {
  const norm = normalizeReferralCode(code);
  if (!norm) return false;
  const store = storage || (typeof window !== "undefined" ? window.localStorage : null);
  if (!store) return false;
  try {
    store.setItem(REFERRAL_CONFIG.storageKey, norm);
    return true;
  } catch (_err) {
    return false;
  }
}

/**
 * Removes the stored referral code from localStorage.
 *
 * @param {Storage} [storage]
 */
export function clearStoredReferralCode(storage) {
  const store = storage || (typeof window !== "undefined" ? window.localStorage : null);
  if (!store) return;
  try {
    store.removeItem(REFERRAL_CONFIG.storageKey);
  } catch (_err) {
    // Ignore storage quota or access errors
  }
}

/**
 * Copies a referral link to clipboard with native Clipboard API and document.execCommand fallback.
 *
 * @param {string} text
 * @param {Clipboard} [clipboardObj]
 * @returns {Promise<boolean>}
 */
export async function copyToClipboard(text, clipboardObj) {
  if (!text) return false;

  const clip = clipboardObj || (typeof navigator !== "undefined" ? navigator.clipboard : null);
  if (clip && typeof clip.writeText === "function") {
    try {
      await clip.writeText(text);
      return true;
    } catch (_err) {
      // Fall through to legacy execCommand fallback
    }
  }

  if (typeof document !== "undefined") {
    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "absolute";
      textarea.style.left = "-9999px";
      textarea.style.top = "0";
      document.body.appendChild(textarea);
      textarea.select();
      textarea.setSelectionRange(0, text.length);
      const success = document.execCommand("copy");
      document.body.removeChild(textarea);
      return Boolean(success);
    } catch (_err) {
      return false;
    }
  }

  return false;
}

/**
 * Formats referral statistics for display.
 *
 * @param {object} stats
 * @param {number} [stats.invitedCount]
 * @param {number} [stats.rewardedCount]
 * @param {number} [stats.totalEarned]
 * @returns {{ invitedLabel: string, rewardedLabel: string, earnedLabel: string }}
 */
export function formatReferralStats(stats = {}) {
  const invited = Number.isFinite(stats.invitedCount) ? Math.max(0, Math.trunc(stats.invitedCount)) : 0;
  const rewarded = Number.isFinite(stats.rewardedCount) ? Math.max(0, Math.trunc(stats.rewardedCount)) : 0;
  const earned = Number.isFinite(stats.totalEarned) ? Math.max(0, Math.trunc(stats.totalEarned)) : 0;

  return {
    invitedLabel: `${invited}`,
    rewardedLabel: `${rewarded} / ${REFERRAL_CONFIG.maxRewarded}`,
    earnedLabel: earned.toLocaleString("en-US")
  };
}
