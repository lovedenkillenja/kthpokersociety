// UI controller for the "Invite friends" referral panel and link sharing.
// Adheres to STYLE_GUIDE.md and SPEC.md. Play money only – no cash value.

import { REFERRAL_CONFIG } from "../config.js";
import { formatChips } from "../lib/format.js";
import {
  buildReferralUrl, copyToClipboard, formatReferralStats,
  extractReferralCodeFromUrl, stripReferralParamFromUrl,
  getStoredReferralCode, setStoredReferralCode, clearStoredReferralCode
} from "../lib/referral.js";
import {
  fetchMyReferral, redeemReferralCode, claimReferralRewards,
  fetchChipBalance, fetchRecentLedger
} from "../lib/supabase.js";
import { showToast } from "./components.js";

/**
 * Captures ?ref=CODE from URL on page load, validates format, stores in localStorage,
 * and strips it cleanly from the URL using window.history.replaceState.
 */
export function captureReferralCodeFromUrl() {
  if (typeof window === "undefined") return;
  const rawCode = extractReferralCodeFromUrl(window.location.search || window.location.href);
  if (rawCode) {
    setStoredReferralCode(rawCode);
    stripReferralParamFromUrl(window.location.href, window.history);
  }
}

/**
 * Checks for a stored referral code and redeems it once upon sign-in.
 * Clears the stored code regardless of result so errors do not repeat.
 *
 * @param {object} user
 * @param {Function} onBalanceUpdated
 */
export async function redeemStoredReferralOnAuth(user, onBalanceUpdated) {
  if (!user) return;
  const storedCode = getStoredReferralCode();
  if (!storedCode) return;

  // Clear code immediately regardless of outcome
  clearStoredReferralCode();

  try {
    const { status, error } = await redeemReferralCode(storedCode);
    if (!error && status === "ok") {
      showToast("Invite redeemed! Welcome to KTH Poker Society.");
      if (typeof onBalanceUpdated === "function") {
        const [nextBal, nextLedger] = await Promise.all([
          fetchChipBalance(user.id),
          fetchRecentLedger(user.id)
        ]);
        onBalanceUpdated({ balance: nextBal, ledger: nextLedger });
      }
    }
  } catch (_err) {
    // Stay silent on referral redemption errors
  }
}

/**
 * Checks and claims any deferred referral rewards when the lobby loads for a signed-in member.
 * Shows a toast if rewards were paid, and triggers balance/ledger refresh.
 *
 * @param {object} user
 * @param {Function} onRewardsClaimed
 */
export async function claimDeferredReferralRewards(user, onRewardsClaimed) {
  if (!user) return;
  try {
    const { chipsPaid, error } = await claimReferralRewards();
    if (!error && chipsPaid > 0) {
      showToast(`+${formatChips(chipsPaid)} chips: a friend joined with your link`);
      if (typeof onRewardsClaimed === "function") {
        const [nextBal, nextLedger, nextRef] = await Promise.all([
          fetchChipBalance(user.id),
          fetchRecentLedger(user.id),
          fetchMyReferral()
        ]);
        onRewardsClaimed({
          balance: nextBal,
          ledger: nextLedger,
          referral: (!nextRef.error && nextRef.code) ? nextRef : null
        });
      }
    }
  } catch (_err) {
    // Non-blocking
  }
}

/**
 * Renders the referral panel with the member's link, stats, and explanation.
 *
 * @param {object} els
 * @param {object|null} referralData
 * @param {boolean} isSignedIn
 */
export function renderReferralPanel(els, referralData, isSignedIn) {
  if (!els || !els.referralBox) return;

  if (!isSignedIn) {
    els.referralBox.hidden = true;
    return;
  }

  els.referralBox.hidden = false;
  if (els.referralExplanation) {
    els.referralExplanation.textContent = REFERRAL_CONFIG.explanationText;
  }

  if (referralData && referralData.code) {
    const link = buildReferralUrl(referralData.code);
    if (els.referralLinkInput) els.referralLinkInput.value = link;

    const stats = formatReferralStats(referralData);
    if (els.refStatInvited) els.refStatInvited.textContent = stats.invitedLabel;
    if (els.refStatRewarded) els.refStatRewarded.textContent = stats.rewardedLabel;
    if (els.refStatEarned) els.refStatEarned.textContent = stats.earnedLabel;
  }
}

/**
 * Attaches the copy-link event listener to the Copy button.
 *
 * @param {object} els
 */
export function wireReferralCopyButton(els) {
  if (!els || !els.referralCopyBtn) return;

  els.referralCopyBtn.addEventListener("click", async () => {
    const link = els.referralLinkInput?.value;
    if (!link || link === "Loading link…") return;

    const success = await copyToClipboard(link);
    if (success) {
      els.referralCopyBtn.textContent = "Copied!";
      showToast("Invite link copied to clipboard.");
      setTimeout(() => {
        if (els.referralCopyBtn) els.referralCopyBtn.textContent = "Copy link";
      }, 2000);
    }
  });
}
