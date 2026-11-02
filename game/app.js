// KTH Poker Society – Game entry module (sign-in, profile, chip balance, daily claim, leaderboard, and M4 table).

import {
  getSupabaseClient, fetchMemberRecord, ensureChipProfile, saveChipProfile,
  fetchChipBalance, fetchRecentLedger, claimDailyChipsForMember, fetchLeaderboard
} from "./lib/supabase.js";
import {
  formatChips, hasClaimedToday, validateDisplayName, normalizeLeaderboardRows, friendlyAuthError
} from "./lib/format.js";
import { normalizeRoomCode, validateBuyIn } from "./lib/table-helpers.js";
import { createTable, joinTable, setUnauthorizedHandler } from "./lib/poker-api.js";
import {
  createCard, createCardBack, createLeaderboardRow, createLedgerRow, createEmptyState, showToast
} from "./ui/components.js";
import { createAuthDialogController } from "./ui/auth-dialog.js";
import { createTableViewController } from "./ui/table-view.js";
import { createTutorialDialogController } from "./ui/tutorial-dialog.js";

const VALID_VIEWS = new Set(["lobby", "table", "leaderboard", "profile"]);
const state = {
  user: null, member: null, chipProfile: null, balance: 0,
  ledger: [], leaderboard: [], claimedToday: false, activeView: "lobby", hydrating: false
};

const byId = (id) => document.getElementById(id);
const els = {
  viewNav: byId("view-nav"), viewNavBtns: Array.from(document.querySelectorAll("[data-view-btn]")),
  headerAuthBtn: byId("header-auth-btn"), brandLink: byId("brand-link"),
  viewGuest: byId("view-guest"), viewLobby: byId("view-lobby"),
  viewTable: byId("view-table"), viewLeaderboard: byId("view-leaderboard"), viewProfile: byId("view-profile"),
  navTableBtn: byId("nav-table-btn"), tableActionBar: byId("table-action-bar"),
  activeTableBanner: byId("active-table-banner"), activeTableBannerTitle: byId("active-table-banner-title"),
  returnTableBtn: byId("return-table-btn"), createTableForm: byId("create-table-form"),
  createTableMaxSeats: byId("create-table-max-seats"), createTableBuyIn: byId("create-table-buyin"),
  createTableError: byId("create-table-error"), createTableBtn: byId("create-table-btn"),
  joinTableForm: byId("join-table-form"), joinTableCode: byId("join-table-code"),
  joinTableBuyIn: byId("join-table-buyin"), joinTableError: byId("join-table-error"),
  joinTableBtn: byId("join-table-btn"), guestCardShowcase: byId("guest-card-showcase"),
  guestLoginBtn: byId("guest-login-btn"), guestSignupBtn: byId("guest-signup-btn"),
  lobbyMemberPill: byId("lobby-member-pill"), balanceValue: byId("balance-value"),
  claimDailyBtn: byId("claim-daily-btn"), claimDailyHint: byId("claim-daily-hint"),
  ledgerCountPill: byId("ledger-count-pill"), ledgerContainer: byId("ledger-container"),
  ledgerList: byId("ledger-list"), refreshLeaderboardBtn: byId("refresh-leaderboard-btn"),
  leaderboardOptoutBanner: byId("leaderboard-optout-banner"), leaderboardContainer: byId("leaderboard-container"),
  leaderboardList: byId("leaderboard-list"), profileForm: byId("profile-form"),
  profileDisplayName: byId("profile-display-name"), profileLeaderboardOptin: byId("profile-leaderboard-optin"),
  profileError: byId("profile-error"), profileSaveBtn: byId("profile-save-btn"),
  profileLogoutBtn: byId("profile-logout-btn"), accountFullName: byId("account-full-name"),
  accountEmail: byId("account-email"), accountProgram: byId("account-program"), accountSince: byId("account-since")
};

let authDialog = null;
let tableController = null;

function renderGuestCards() {
  if (!els.guestCardShowcase) return;
  els.guestCardShowcase.replaceChildren(
    createCard("As"), createCard("Kh"), createCard("Qd"), createCard("Jc"), createCardBack()
  );
}

function getViewFromHash() {
  const raw = window.location.hash.replace(/^#\/?/, "").trim().toLowerCase();
  if (raw.startsWith("table")) return "table";
  return VALID_VIEWS.has(raw) ? raw : "lobby";
}

function getTableCodeFromHash() {
  const parts = window.location.hash.replace(/^#\/?/, "").trim().split("/");
  if (parts[0]?.toLowerCase() === "table" && parts[1]) {
    const check = normalizeRoomCode(parts[1]);
    return check.valid ? check.value : null;
  }
  return null;
}

async function refreshBalanceAndLedger() {
  if (!state.user) return;
  const [balance, ledger] = await Promise.all([
    fetchChipBalance(state.user.id), fetchRecentLedger(state.user.id)
  ]);
  state.balance = balance;
  state.ledger = ledger;
  state.claimedToday = hasClaimedToday(ledger);
  renderAll();
}

function setActiveView(viewName, { updateHash = true } = {}) {
  let target = VALID_VIEWS.has(viewName) ? viewName : "lobby";
  if (target === "table" && !tableController?.getActiveTable()) target = "lobby";
  state.activeView = target;

  const activeTable = tableController?.getActiveTable();
  const desiredHash = target === "table" && activeTable?.code ? `#table/${activeTable.code}` : `#${target}`;
  if (updateHash && window.location.hash !== desiredHash) {
    history.replaceState(null, "", desiredHash);
  }
  renderViews();
  if (target === "leaderboard" && state.user) loadLeaderboard();
}

function renderViews() {
  const isSignedIn = Boolean(state.user);
  const activeTable = tableController?.getActiveTable() || null;

  els.viewGuest.hidden = isSignedIn;
  els.viewNav.hidden = !isSignedIn;
  if (els.navTableBtn) {
    els.navTableBtn.hidden = !activeTable;
    if (activeTable) els.navTableBtn.textContent = `Table ${activeTable.code}`;
  }

  els.viewLobby.hidden = !isSignedIn || state.activeView !== "lobby";
  els.viewTable.hidden = !isSignedIn || state.activeView !== "table";
  els.viewLeaderboard.hidden = !isSignedIn || state.activeView !== "leaderboard";
  els.viewProfile.hidden = !isSignedIn || state.activeView !== "profile";

  if (els.tableActionBar && (!isSignedIn || state.activeView !== "table")) {
    els.tableActionBar.hidden = true;
  } else if (isSignedIn && state.activeView === "table" && activeTable) {
    tableController.openWithTable(activeTable);
  }

  if (els.activeTableBanner) {
    els.activeTableBanner.hidden = !activeTable;
    if (activeTable && els.activeTableBannerTitle) {
      els.activeTableBannerTitle.textContent = `Active table · Room ${activeTable.code}`;
    }
  }

  els.viewNavBtns.forEach((btn) => {
    if (btn.getAttribute("data-view-btn") === state.activeView) {
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
        title: state.hydrating ? "Loading chip history…" : "No chip entries yet",
        message: state.hydrating
          ? "Fetching your balance and recent transactions."
          : "Claim your daily +100 chips above to record your first entry."
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
        title: state.hydrating ? "Loading leaderboard…" : "No opted-in members yet",
        message: state.hydrating
          ? "Fetching society standings."
          : "Opt in from your Profile to appear on the society leaderboard."
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
    state.hydrating = false;
    renderAll();
    return;
  }

  state.hydrating = true;
  renderAll();

  const member = await fetchMemberRecord(user);
  state.member = member;

  const [chipProfile, balance, ledger, lbResult] = await Promise.all([
    ensureChipProfile(user, member),
    fetchChipBalance(user.id),
    fetchRecentLedger(user.id),
    fetchLeaderboard()
  ]);

  state.hydrating = false;
  state.chipProfile = chipProfile;
  state.balance = balance;
  state.ledger = ledger;
  state.claimedToday = hasClaimedToday(ledger);
  state.leaderboard = normalizeLeaderboardRows(
    lbResult.rows,
    user.id,
    chipProfile?.display_name
  );

  const hashCode = getTableCodeFromHash();
  const savedCode = (() => {
    try {
      return sessionStorage.getItem("kth_poker_active_table");
    } catch (_err) {
      return null;
    }
  })();
  const reconnectCode = hashCode || savedCode;
  if (reconnectCode && tableController) {
    const res = await tableController.openByCode(reconnectCode);
    if (res.ok && hashCode) {
      state.activeView = "table";
    } else if (!res.ok && hashCode) {
      els.joinTableCode.value = hashCode;
      els.joinTableError.textContent = res.error || "Could not open that room.";
      state.activeView = "lobby";
    }
  }

  renderAll();
}

function wireEvents() {
  createTutorialDialogController();

  authDialog = createAuthDialogController({
    onSignedIn: hydrateAuthenticatedMember
  });

  tableController = createTableViewController({
    getUser: () => state.user,
    getDisplayName: () => state.chipProfile?.display_name || state.member?.full_name || "",
    getBalance: () => state.balance,
    onChipsChanged: refreshBalanceAndLedger,
    onExitToLobby: () => setActiveView("lobby"),
    onOpenAuth: (mode = "login") => authDialog.open(mode)
  });

  setUnauthorizedHandler((msg) => {
    tableController?.notifyUnauthorized();
    showToast(msg || "Your session expired. Log in again to continue.", { variant: "error" });
  });

  els.returnTableBtn?.addEventListener("click", () => {
    setActiveView("table");
  });

  els.createTableForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!state.user) return;
    els.createTableError.textContent = "";

    const buyInCheck = validateBuyIn(els.createTableBuyIn.value, {
      minBuyIn: 400,
      maxBuyIn: 2000,
      balance: state.balance
    });
    if (!buyInCheck.valid) {
      els.createTableError.textContent = buyInCheck.error;
      return;
    }

    els.createTableBtn.setAttribute("aria-busy", "true");
    els.createTableBtn.disabled = true;

    const maxSeats = Math.min(6, Math.max(2, Math.trunc(Number(els.createTableMaxSeats?.value || 6))));
    const res = await createTable({
      sb: 10, bb: 20, minBuyIn: 400, maxBuyIn: 2000, maxSeats, buyIn: buyInCheck.value, seat: 0
    });

    els.createTableBtn.removeAttribute("aria-busy");
    els.createTableBtn.disabled = false;

    if (!res.ok || !res.table) {
      els.createTableError.textContent = res.error || "Could not create table.";
      return;
    }

    tableController.openWithTable(res.table);
    await refreshBalanceAndLedger();
    setActiveView("table");
    showToast(`Room ${res.table.code} created. Share the code with a friend!`);
  });

  els.joinTableForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!state.user) return;
    els.joinTableError.textContent = "";

    const codeCheck = normalizeRoomCode(els.joinTableCode.value);
    if (!codeCheck.valid) {
      els.joinTableError.textContent = codeCheck.error;
      els.joinTableCode.focus();
      return;
    }

    const buyInCheck = validateBuyIn(els.joinTableBuyIn.value, {
      minBuyIn: 400,
      maxBuyIn: 2000,
      balance: state.balance
    });
    if (!buyInCheck.valid) {
      els.joinTableError.textContent = buyInCheck.error;
      return;
    }

    els.joinTableBtn.setAttribute("aria-busy", "true");
    els.joinTableBtn.disabled = true;

    const res = await joinTable({
      code: codeCheck.value,
      buyIn: buyInCheck.value
    });

    els.joinTableBtn.removeAttribute("aria-busy");
    els.joinTableBtn.disabled = false;

    if (!res.ok || !res.table) {
      els.joinTableError.textContent = res.error || "Could not join table.";
      return;
    }

    tableController.openWithTable(res.table);
    await refreshBalanceAndLedger();
    setActiveView("table");
    showToast(`Joined Room ${res.table.code}.`);
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

  window.addEventListener("hashchange", async () => {
    if (!state.user) return;
    const hashCode = getTableCodeFromHash();
    if (hashCode && tableController?.getActiveTable()?.code !== hashCode) {
      const res = await tableController.openByCode(hashCode);
      if (!res.ok) {
        els.joinTableCode.value = hashCode;
        els.joinTableError.textContent = res.error || "Could not open that room.";
        showToast(res.error || "Could not open that room.", { variant: "error" });
        setActiveView("lobby", { updateHash: true });
        return;
      }
    }
    setActiveView(getViewFromHash(), { updateHash: false });
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
