// KTH Poker Society – M1 entry module (sign-in, profile, chip balance, daily claim, leaderboard).

import {
  getSupabaseClient,
  fetchMemberRecord,
  ensureChipProfile,
  saveChipProfile,
  fetchChipBalance,
  fetchRecentLedger,
  claimDailyChipsForMember,
  fetchLeaderboard
} from "./lib/supabase.js";
import {
  formatChips,
  hasClaimedToday,
  validateDisplayName,
  normalizeLeaderboardRows,
  friendlyAuthError
} from "./lib/format.js";
import {
  createCard,
  createCardBack,
  createLeaderboardRow,
  createLedgerRow,
  createEmptyState,
  showToast
} from "./ui/components.js";
import { createAuthDialogController } from "./ui/auth-dialog.js";

const VALID_VIEWS = new Set(["lobby", "leaderboard", "profile"]);

const state = {
  user: null,
  member: null,
  chipProfile: null,
  balance: 0,
  ledger: [],
  leaderboard: [],
  claimedToday: false,
  activeView: "lobby"
};

const els = {
  viewNav: document.getElementById("view-nav"),
  viewNavBtns: Array.from(document.querySelectorAll("[data-view-btn]")),
  headerAuthBtn: document.getElementById("header-auth-btn"),
  brandLink: document.getElementById("brand-link"),

  viewGuest: document.getElementById("view-guest"),
  viewLobby: document.getElementById("view-lobby"),
  viewLeaderboard: document.getElementById("view-leaderboard"),
  viewProfile: document.getElementById("view-profile"),

  guestCardShowcase: document.getElementById("guest-card-showcase"),
  guestLoginBtn: document.getElementById("guest-login-btn"),
  guestSignupBtn: document.getElementById("guest-signup-btn"),

  lobbyMemberPill: document.getElementById("lobby-member-pill"),
  balanceValue: document.getElementById("balance-value"),
  claimDailyBtn: document.getElementById("claim-daily-btn"),
  claimDailyHint: document.getElementById("claim-daily-hint"),
  ledgerCountPill: document.getElementById("ledger-count-pill"),
  ledgerContainer: document.getElementById("ledger-container"),
  ledgerList: document.getElementById("ledger-list"),

  refreshLeaderboardBtn: document.getElementById("refresh-leaderboard-btn"),
  leaderboardOptoutBanner: document.getElementById("leaderboard-optout-banner"),
  leaderboardContainer: document.getElementById("leaderboard-container"),
  leaderboardList: document.getElementById("leaderboard-list"),

  profileForm: document.getElementById("profile-form"),
  profileDisplayName: document.getElementById("profile-display-name"),
  profileLeaderboardOptin: document.getElementById("profile-leaderboard-optin"),
  profileError: document.getElementById("profile-error"),
  profileSaveBtn: document.getElementById("profile-save-btn"),
  profileLogoutBtn: document.getElementById("profile-logout-btn"),
  accountFullName: document.getElementById("account-full-name"),
  accountEmail: document.getElementById("account-email"),
  accountProgram: document.getElementById("account-program"),
  accountSince: document.getElementById("account-since")
};

let authDialog = null;

function renderGuestCards() {
  if (!els.guestCardShowcase) return;
  els.guestCardShowcase.replaceChildren(
    createCard("As"),
    createCard("Kh"),
    createCard("Qd"),
    createCard("Jc"),
    createCardBack()
  );
}

function getViewFromHash() {
  const raw = window.location.hash.replace(/^#\/?/, "").trim().toLowerCase();
  return VALID_VIEWS.has(raw) ? raw : "lobby";
}

function setActiveView(viewName, { updateHash = true } = {}) {
  const target = VALID_VIEWS.has(viewName) ? viewName : "lobby";
  state.activeView = target;

  if (updateHash && window.location.hash !== `#${target}`) {
    history.replaceState(null, "", `#${target}`);
  }

  renderViews();

  if (target === "leaderboard" && state.user) {
    loadLeaderboard();
  }
}

function renderViews() {
  const isSignedIn = Boolean(state.user);

  els.viewGuest.hidden = isSignedIn;
  els.viewNav.hidden = !isSignedIn;

  els.viewLobby.hidden = !isSignedIn || state.activeView !== "lobby";
  els.viewLeaderboard.hidden = !isSignedIn || state.activeView !== "leaderboard";
  els.viewProfile.hidden = !isSignedIn || state.activeView !== "profile";

  els.viewNavBtns.forEach((btn) => {
    const v = btn.getAttribute("data-view-btn");
    if (v === state.activeView) {
      btn.setAttribute("aria-current", "page");
    } else {
      btn.removeAttribute("aria-current");
    }
  });

  if (isSignedIn) {
    const name = state.chipProfile?.display_name || "Member";
    els.headerAuthBtn.textContent = `${formatChips(state.balance)} chips`;
    els.headerAuthBtn.className = "btn btn--ghost tabular";
    els.headerAuthBtn.setAttribute("aria-label", `Signed in as ${name}. Open profile.`);
  } else {
    els.headerAuthBtn.textContent = "Log in";
    els.headerAuthBtn.className = "btn btn--primary";
    els.headerAuthBtn.removeAttribute("aria-label");
  }
}

function renderLobby() {
  if (!state.user) return;
  const displayName = state.chipProfile?.display_name || state.member?.full_name || "Member";
  els.lobbyMemberPill.textContent = displayName;
  els.balanceValue.textContent = formatChips(state.balance);

  state.claimedToday = hasClaimedToday(state.ledger);
  if (state.claimedToday) {
    els.claimDailyBtn.disabled = true;
    els.claimDailyBtn.textContent = "Daily +100 claimed today";
    els.claimDailyHint.textContent = "You have claimed today's +100 chips. Next claim opens at 00:00 Stockholm time.";
  } else {
    els.claimDailyBtn.disabled = false;
    els.claimDailyBtn.textContent = "Claim daily +100 chips";
    els.claimDailyHint.textContent = "Claim +100 play-money chips once per day (resets at 00:00 Stockholm time).";
  }

  els.ledgerCountPill.textContent = `${state.ledger.length} recent`;
  els.ledgerList.replaceChildren();

  const oldEmpty = els.ledgerContainer.querySelector(".empty-state");
  if (oldEmpty) oldEmpty.remove();

  if (state.ledger.length === 0) {
    els.ledgerList.hidden = true;
    els.ledgerContainer.appendChild(
      createEmptyState({
        title: "No chip entries yet",
        message: "Claim your daily +100 chips above to record your first entry."
      })
    );
  } else {
    els.ledgerList.hidden = false;
    state.ledger.forEach((row) => {
      els.ledgerList.appendChild(createLedgerRow(row));
    });
  }
}

function renderLeaderboard() {
  if (!state.user) return;

  const optedIn = state.chipProfile ? Boolean(state.chipProfile.show_on_leaderboard) : true;
  els.leaderboardOptoutBanner.hidden = optedIn;

  els.leaderboardList.replaceChildren();
  const oldEmpty = els.leaderboardContainer.querySelector(".empty-state");
  if (oldEmpty) oldEmpty.remove();

  if (state.leaderboard.length === 0) {
    els.leaderboardList.hidden = true;
    els.leaderboardContainer.appendChild(
      createEmptyState({
        title: "No opted-in members yet",
        message: "Opt in from your Profile to appear on the society leaderboard."
      })
    );
    return;
  }

  els.leaderboardList.hidden = false;
  state.leaderboard.forEach((entry) => {
    els.leaderboardList.appendChild(createLeaderboardRow(entry));
  });
}

function renderProfile() {
  if (!state.user) return;
  const displayName = state.chipProfile?.display_name || "";
  const optedIn = state.chipProfile ? Boolean(state.chipProfile.show_on_leaderboard) : true;

  if (document.activeElement !== els.profileDisplayName) {
    els.profileDisplayName.value = displayName;
  }
  els.profileLeaderboardOptin.checked = optedIn;

  els.accountFullName.textContent = state.member?.full_name || "—";
  els.accountEmail.textContent = state.member?.email || state.user.email || "—";

  const progParts = [
    state.member?.program,
    state.member?.study_year ? `Year ${state.member.study_year}` : ""
  ].filter(Boolean);
  els.accountProgram.textContent = progParts.length > 0 ? progParts.join(" · ") : "Not specified";

  const created = state.member?.created_at ? new Date(state.member.created_at) : null;
  els.accountSince.textContent =
    created && !Number.isNaN(created.getTime())
      ? created.toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" })
      : "Member";
}

function renderAll() {
  renderViews();
  renderLobby();
  renderLeaderboard();
  renderProfile();
}

async function loadLeaderboard() {
  if (!state.user) return;
  els.refreshLeaderboardBtn.setAttribute("aria-busy", "true");
  const { rows, error } = await fetchLeaderboard();
  els.refreshLeaderboardBtn.removeAttribute("aria-busy");

  if (error) {
    showToast(friendlyAuthError(error), { variant: "error" });
    return;
  }

  state.leaderboard = normalizeLeaderboardRows(
    rows,
    state.user.id,
    state.chipProfile?.display_name
  );
  renderLeaderboard();
}

async function hydrateAuthenticatedMember(user) {
  state.user = user;
  if (!user) {
    state.member = null;
    state.chipProfile = null;
    state.balance = 0;
    state.ledger = [];
    state.leaderboard = [];
    state.claimedToday = false;
    renderAll();
    return;
  }

  renderViews();

  const member = await fetchMemberRecord(user);
  state.member = member;

  const [chipProfile, balance, ledger, lbResult] = await Promise.all([
    ensureChipProfile(user, member),
    fetchChipBalance(user.id),
    fetchRecentLedger(user.id),
    fetchLeaderboard()
  ]);

  state.chipProfile = chipProfile;
  state.balance = balance;
  state.ledger = ledger;
  state.claimedToday = hasClaimedToday(ledger);
  state.leaderboard = normalizeLeaderboardRows(
    lbResult.rows,
    user.id,
    chipProfile?.display_name
  );

  renderAll();
}

function wireEvents() {
  authDialog = createAuthDialogController({
    onSignedIn: hydrateAuthenticatedMember
  });

  els.viewNavBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      setActiveView(btn.getAttribute("data-view-btn"));
    });
  });

  document.querySelectorAll("[data-jump-view]").forEach((btn) => {
    btn.addEventListener("click", () => {
      setActiveView(btn.getAttribute("data-jump-view"));
    });
  });

  els.brandLink.addEventListener("click", (e) => {
    if (state.user) {
      e.preventDefault();
      setActiveView("lobby");
    }
  });

  window.addEventListener("hashchange", () => {
    if (state.user) {
      setActiveView(getViewFromHash(), { updateHash: false });
    }
  });

  els.headerAuthBtn.addEventListener("click", () => {
    if (state.user) {
      setActiveView("profile");
    } else {
      authDialog.open("login");
    }
  });

  els.guestLoginBtn.addEventListener("click", () => authDialog.open("login"));
  els.guestSignupBtn.addEventListener("click", () => authDialog.open("signup"));

  els.claimDailyBtn.addEventListener("click", async () => {
    if (!state.user || state.claimedToday) return;
    els.claimDailyBtn.setAttribute("aria-busy", "true");
    els.claimDailyBtn.disabled = true;

    const result = await claimDailyChipsForMember(state.user.id, state.balance);
    els.claimDailyBtn.removeAttribute("aria-busy");

    state.balance = result.balance;
    if (Array.isArray(result.ledger) && result.ledger.length > 0) {
      state.ledger = result.ledger;
    }
    state.claimedToday =
      result.status === "claimed" ||
      result.status === "already_claimed" ||
      hasClaimedToday(state.ledger);

    renderAll();
    loadLeaderboard();

    showToast(result.message, {
      variant: result.status === "error" ? "error" : "default"
    });
  });

  els.refreshLeaderboardBtn.addEventListener("click", () => {
    loadLeaderboard();
  });

  els.profileForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!state.user) return;
    els.profileError.textContent = "";
    els.profileDisplayName.removeAttribute("aria-invalid");

    const validation = validateDisplayName(els.profileDisplayName.value);
    if (!validation.valid) {
      els.profileError.textContent = validation.error;
      els.profileDisplayName.setAttribute("aria-invalid", "true");
      els.profileDisplayName.focus();
      return;
    }

    const showOnLeaderboard = els.profileLeaderboardOptin.checked;
    els.profileSaveBtn.setAttribute("aria-busy", "true");

    const { data, error } = await saveChipProfile(state.user.id, {
      displayName: validation.value,
      showOnLeaderboard
    });

    els.profileSaveBtn.removeAttribute("aria-busy");

    if (error) {
      els.profileError.textContent = friendlyAuthError(error);
      return;
    }

    state.chipProfile = data || {
      ...state.chipProfile,
      display_name: validation.value,
      show_on_leaderboard: showOnLeaderboard
    };
    els.profileDisplayName.value = state.chipProfile.display_name;

    renderAll();
    loadLeaderboard();
    showToast("Table profile saved.");
  });

  els.profileLogoutBtn.addEventListener("click", async () => {
    const sb = getSupabaseClient();
    if (sb) {
      await sb.auth.signOut();
    }
    await hydrateAuthenticatedMember(null);
    showToast("Logged out.");
  });
}

async function init() {
  renderGuestCards();
  state.activeView = getViewFromHash();
  wireEvents();

  const sb = getSupabaseClient();
  if (!sb) {
    renderAll();
    return;
  }

  sb.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY") {
      authDialog.open("recovery");
      return;
    }
    if (event === "SIGNED_OUT") {
      hydrateAuthenticatedMember(null);
      return;
    }
    if (session?.user && (!state.user || state.user.id !== session.user.id)) {
      hydrateAuthenticatedMember(session.user);
    }
  });

  const { data } = await sb.auth.getSession();
  if (data?.session?.user) {
    await hydrateAuthenticatedMember(data.session.user);
  } else {
    renderAll();
  }
}

init();
