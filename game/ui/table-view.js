// M4+M5+M6+M6.1 Table View controller (`#view-table`).
// Coordinates 2–6 player state, 30s action timer, raise bottom sheet, sit-in/sit-out,
// host table close, hand history, and `hole_cards` RLS queries alongside `table-shell-ui.js`.

import { formatChips } from "../lib/format.js";
import {
  normalizeIncomingTableState, partitionTableSeats, computeRaisePresets,
  computeRemainingTurnSeconds, describeHandStatus, buildHandHistoryEntry
} from "../lib/table-helpers.js";
import {
  fetchTableState, joinTable, leaveTable, closeTable, setTableSeatStatus,
  tickTable, startHand, sendHandAction, fetchOwnHoleCards, subscribeToTableChannel
} from "../lib/poker-api.js";
import { showToast } from "./components.js";
import { renderTableFelt, updateTurnTimerInPlace, renderHandHistoryList } from "./table-render.js";
import { createTableShellUI } from "./table-shell-ui.js";
import { isSoundEnabled, toggleSoundEnabled, playTableCue } from "./tutorial-dialog.js";

export function createTableViewController({
  getUser, getDisplayName, getBalance, onChipsChanged, onExitToLobby, onNavigateView, onOpenAuth
}) {
  let currentTable = null, knownSelfSeatNo = null, myHoleCards = null, lastHoleCardsHandId = null;
  let lastAnnouncedTurnKey = "", lastTenSecWarnKey = "", lastAnnouncedWinHandId = "";
  let channelSub = null, subscribedCode = null, actionBusy = false, raiseSheetOpen = false;
  let currentRaiseTo = 0, lastHandSeqKey = "", serverClockSkewMs = 0, countdownInterval = null;
  let lastRenderedSecond = null, lastTickAttemptAt = 0, tickInFlight = false;
  const handHistory = [];

  const byId = (id) => document.getElementById(id);
  const els = {
    viewTable: byId("view-table"), stage: byId("table-stage"), lobbyBtn: byId("table-lobby-btn"),
    codeBadge: byId("table-code-badge"), copyCodeBtn: byId("table-copy-code-btn"),
    blindsPill: byId("table-blinds-pill"), connPill: byId("table-conn-pill"),
    historyOpenBtn: byId("table-history-open-btn"), fullscreenBtn: byId("table-fullscreen-btn"),
    drawerBtn: byId("table-drawer-btn"), drawerDialog: byId("table-drawer-dialog"),
    soundBtn: byId("table-sound-btn"), refreshBtn: byId("table-refresh-btn"),
    sitOutToggleBtn: byId("table-sitout-toggle-btn"), closeTableBtn: byId("table-close-btn"),
    leaveBtn: byId("table-leave-btn"), connBanner: byId("table-conn-banner"),
    connBannerText: byId("table-conn-banner-text"), connBannerBtn: byId("table-conn-banner-btn"),
    opponentArea: byId("table-opponent-seat"), potAmount: byId("table-pot-amount"),
    sidePotsRow: byId("table-side-pots"), boardRow: byId("table-board-row"),
    statusHeadline: byId("table-status-headline"), statusDetail: byId("table-status-detail"),
    dealBtnWrap: byId("table-deal-wrap"), dealBtn: byId("table-deal-btn"),
    sitOutBanner: byId("table-sitout-banner"), sitInBtn: byId("table-sitin-btn"),
    selfArea: byId("table-self-seat"), sitDownForm: byId("table-sitdown-form"),
    sitDownBuyInInput: byId("table-sitdown-buyin"), sitDownBtn: byId("table-sitdown-btn"),
    historyPanel: byId("table-history-panel"), historyEmpty: byId("table-history-empty"),
    historyList: byId("table-history-list"), actionBar: byId("table-action-bar"),
    idleRow: byId("action-idle-row"), waitingText: byId("action-waiting-text"),
    timerPill: byId("action-timer-pill"), controlsWrap: byId("action-controls-wrap"),
    raisePanel: byId("action-raise-panel"), raiseCloseBtn: byId("raise-sheet-close-btn"),
    raiseConfirmBtn: byId("action-raise-confirm-btn"), presetMinBtn: byId("preset-min-btn"),
    presetHalfBtn: byId("preset-half-btn"), presetPotBtn: byId("preset-pot-btn"),
    presetAllInBtn: byId("preset-allin-btn"), stepDownBtn: byId("raise-step-down-btn"),
    stepUpBtn: byId("raise-step-up-btn"), raiseSlider: byId("action-raise-slider"),
    raiseInput: byId("action-raise-input"), foldBtn: byId("action-fold-btn"),
    checkCallBtn: byId("action-check-call-btn"), raiseBtn: byId("action-raise-btn")
  };

  const shellUI = createTableShellUI({
    els, getTable: () => currentTable, onExitToLobby, onNavigateView, onOpenAuth,
    onReconnect: async () => {
      if (!currentTable?.code) return;
      const res = await fetchTableState(currentTable.code);
      if (res.ok && res.table) { applyTableState(res.table); showToast("Reconnected to table."); }
    }
  });

  function announce(msg) { const live = byId("live-announcer"); if (live && msg) live.textContent = msg; }
  function closeRaiseSheet() {
    raiseSheetOpen = false;
    if (els.raisePanel) els.raisePanel.hidden = true;
    if (els.raiseBtn) els.raiseBtn.setAttribute("aria-expanded", "false");
  }
  function getRemainingSeconds() { return computeRemainingTurnSeconds(currentTable?.hand, Date.now(), serverClockSkewMs); }

  async function maybeTriggerServerTimeoutTick() {
    if (!currentTable?.code || currentTable?.hand?.status !== "playing" || tickInFlight) return;
    const now = Date.now();
    if (now - lastTickAttemptAt < 2500) return;
    lastTickAttemptAt = now;
    tickInFlight = true;
    try {
      const res = await tickTable(currentTable.code);
      if (res.ok && res.table) applyTableState(res.table);
    } finally {
      tickInFlight = false;
    }
  }

  function ensureCountdownLoop() {
    if (countdownInterval) return;
    countdownInterval = window.setInterval(() => {
      if (currentTable?.hand?.status !== "playing") { lastRenderedSecond = null; return; }
      const sec = getRemainingSeconds();
      if (sec !== lastRenderedSecond) {
        lastRenderedSecond = sec;
        const totalSec = Math.max(1, Math.round(Number(currentTable.hand.turnTimeoutMs || 30_000) / 1000));
        updateTurnTimerInPlace(els.viewTable, sec, totalSec);
        renderActionBar(sec);
      }
      if (sec !== null && sec <= 0) maybeTriggerServerTimeoutTick();
    }, 350);
  }

  function ensureChannelSubscription(code) {
    const clean = String(code || "").toUpperCase().trim();
    if (!clean || (subscribedCode === clean && channelSub)) return;
    if (channelSub) channelSub.unsubscribe();
    subscribedCode = clean;

    channelSub = subscribeToTableChannel(clean, {
      onState(incoming) { applyTableState(incoming); },
      onConnectionChange(status) {
        if (status === "SUBSCRIBED" || status === "ONLINE") shellUI.updateConnectionBanner("ONLINE");
        else if (status === "OFFLINE" || status === "UNAUTHORIZED") shellUI.updateConnectionBanner(status);
      }
    });
  }

  async function syncHoleCardsIfNeeded(table) {
    const user = getUser();
    const handId = table?.hand?.id || null;
    if (!user || !handId) { myHoleCards = null; lastHoleCardsHandId = null; return; }
    if (lastHoleCardsHandId === handId && Array.isArray(myHoleCards) && myHoleCards.length === 2) return;

    const cards = await fetchOwnHoleCards(handId, user.id);
    if (cards && cards.length === 2 && currentTable?.hand?.id === handId) {
      myHoleCards = cards;
      lastHoleCardsHandId = handId;
      renderTableFelt({
        els, currentTable, myHoleCards, lastHoleCardsHandId, getBalance, actionBusy,
        remainingSeconds: getRemainingSeconds()
      });
    }
  }

  function recordCompletedHandIfNeeded(table) {
    const entry = buildHandHistoryEntry(table);
    if (!entry) return;
    const existingIdx = handHistory.findIndex((h) => h.handId === entry.handId);
    if (existingIdx >= 0) handHistory[existingIdx] = entry;
    else {
      handHistory.unshift(entry);
      if (handHistory.length > 10) handHistory.length = 10;
    }
    renderHandHistoryList(els.historyList, els.historyPanel, handHistory, els.historyEmpty, els.historyOpenBtn);

    if (lastAnnouncedWinHandId !== entry.handId) {
      lastAnnouncedWinHandId = entry.handId;
      const status = describeHandStatus(table);
      announce(`${status.headline}. ${status.detail}`);
      if (entry.winnerRows.some((w) => w.isSelf)) playTableCue("win");
    }
  }

  function applyTableState(rawTable) {
    if (!rawTable) return;
    const normalized = normalizeIncomingTableState(rawTable, {
      knownSelfSeatNo, currentDisplayName: getDisplayName()
    });
    if (!normalized) return;

    if (normalized.selfSeatNo !== null && normalized.selfSeatNo !== undefined) {
      knownSelfSeatNo = normalized.selfSeatNo;
    }
    if (Number.isFinite(Number(normalized.hand?.serverNow))) {
      serverClockSkewMs = Number(normalized.hand.serverNow) - Date.now();
    }
    currentTable = normalized;
    try { sessionStorage.setItem("kth_poker_active_table", normalized.code); } catch (_err) { /* ignore */ }

    shellUI.updateConnectionBanner("ONLINE");
    ensureChannelSubscription(normalized.code);
    ensureCountdownLoop();
    render();
    recordCompletedHandIfNeeded(normalized);
    syncHoleCardsIfNeeded(normalized);
  }

  function updateRaiseButtonLabel(legal) {
    if (!legal?.canRaise) return;
    const val = Math.min(
      legal.maxRaiseTo,
      Math.max(legal.minRaiseTo, Math.trunc(Number(currentRaiseTo || legal.minRaiseTo)))
    );
    const isAllIn = val >= legal.maxRaiseTo;
    const isOpeningBet = Number(currentTable?.hand?.currentBet || 0) === 0;
    const verb = isAllIn ? "All-in" : isOpeningBet ? "Bet" : "Raise to";
    const fullLabel = `${verb} ${formatChips(val)}`;
    if (els.raiseConfirmBtn) {
      els.raiseConfirmBtn.textContent = fullLabel;
      els.raiseConfirmBtn.disabled = actionBusy;
    }
    els.raiseBtn.textContent = raiseSheetOpen ? fullLabel : isOpeningBet ? "Bet…" : "Raise…";
  }

  function renderActionBar(remainingSeconds = null) {
    if (!currentTable || !els.actionBar) return;
    els.actionBar.hidden = false;

    const { selfSeat } = partitionTableSeats(currentTable);
    const hand = currentTable.hand || null;
    const handPlaying = Boolean(hand && hand.status === "playing");

    if (!selfSeat || !handPlaying) {
      closeRaiseSheet();
      els.controlsWrap.hidden = true;
      if (els.idleRow) els.idleRow.hidden = false;
      if (els.timerPill) els.timerPill.hidden = true;
      els.actionBar.classList.remove("action-bar--my-turn", "action-bar--urgent");

      if (currentTable.status === "closed") els.waitingText.textContent = "Table closed";
      else if (!selfSeat) els.waitingText.textContent = "Observing — buy in above to take a seat";
      else if (selfSeat.status === "sitout") els.waitingText.textContent = "Paused — tap Sit back in";
      else {
        const activeCount = (currentTable.seats || []).filter((s) => s.status === "active" && s.stack > 0).length;
        els.waitingText.textContent =
          activeCount >= 2 ? "Ready for next hand" : `Waiting for players · Code ${currentTable.code}`;
      }
      return;
    }

    const isMyTurn = hand.actingSeat === selfSeat.seatNo;
    const legal = hand.legalActions || null;
    const actingSeat = (currentTable.seats || []).find((s) => s.seatNo === hand.actingSeat);
    const urgent = remainingSeconds !== null && remainingSeconds <= 8;

    els.actionBar.classList.toggle("action-bar--my-turn", isMyTurn);
    els.actionBar.classList.toggle("action-bar--urgent", Boolean(isMyTurn && urgent));

    if (els.timerPill) {
      if (remainingSeconds !== null && remainingSeconds !== undefined) {
        els.timerPill.hidden = false;
        els.timerPill.textContent = urgent ? `⚠ ${remainingSeconds}s` : `${remainingSeconds}s`;
        els.timerPill.className = `pill tabular ${urgent ? "pill--danger" : "pill--brand"}`;
      } else {
        els.timerPill.hidden = true;
      }
    }

    if (!isMyTurn || !legal) {
      closeRaiseSheet();
      els.controlsWrap.hidden = true;
      if (els.idleRow) els.idleRow.hidden = selfSeat.status !== "sitout";
      const actorName = actingSeat?.displayName || `Seat ${(hand.actingSeat ?? 0) + 1}`;
      els.waitingText.textContent =
        selfSeat.status === "sitout" ? "Sitting out this hand" : `Waiting for ${actorName}…`;
      return;
    }

    if (els.idleRow) els.idleRow.hidden = true;
    els.waitingText.textContent = urgent ? `Your turn · ${remainingSeconds}s` : "Your turn";

    const turnKey = `${hand.id}:${hand.actionSeq}:${selfSeat.seatNo}`;
    if (lastAnnouncedTurnKey !== turnKey) {
      lastAnnouncedTurnKey = turnKey;
      announce(`Your turn. Pot is ${formatChips(hand.pot)} chips. 30 seconds to act.`);
      playTableCue("turn");
      try {
        if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") navigator.vibrate(35);
      } catch (_err) { /* ignore */ }
    }

    if (remainingSeconds === 8 && lastTenSecWarnKey !== turnKey) {
      lastTenSecWarnKey = turnKey;
      announce("8 seconds remaining to act.");
    }

    els.controlsWrap.hidden = false;
    els.foldBtn.disabled = actionBusy || !legal.canFold;

    if (legal.canCheck) {
      els.checkCallBtn.textContent = "Check";
      els.checkCallBtn.dataset.intent = "check";
      els.checkCallBtn.disabled = actionBusy;
    } else if (legal.canCall) {
      const isCallAllIn = legal.callAmount >= selfSeat.stack;
      els.checkCallBtn.textContent = isCallAllIn
        ? `All-in ${formatChips(legal.callAmount)}`
        : `Call ${formatChips(legal.callAmount)}`;
      els.checkCallBtn.dataset.intent = "call";
      els.checkCallBtn.disabled = actionBusy;
    } else {
      els.checkCallBtn.textContent = "Check";
      els.checkCallBtn.disabled = true;
    }

    if (legal.canRaise && legal.minRaiseTo !== null && legal.maxRaiseTo !== null) {
      els.raiseBtn.hidden = false;
      els.raiseBtn.disabled = actionBusy;
      els.raiseBtn.dataset.intent = "raise";

      const seqKey = `${hand.id}:${hand.actionSeq}`;
      const stepSize = Math.max(1, currentTable.bb || 20);
      if (lastHandSeqKey !== seqKey) {
        lastHandSeqKey = seqKey;
        closeRaiseSheet();
        currentRaiseTo = legal.minRaiseTo;
        els.raiseSlider.min = String(legal.minRaiseTo);
        els.raiseSlider.max = String(legal.maxRaiseTo);
        els.raiseSlider.step = String(Math.max(1, Math.min(10, currentTable.sb || 10)));
        els.raiseSlider.value = String(currentRaiseTo);
        els.raiseInput.min = String(legal.minRaiseTo);
        els.raiseInput.max = String(legal.maxRaiseTo);
        els.raiseInput.step = String(stepSize);
        els.raiseInput.value = String(currentRaiseTo);
      }
      els.raisePanel.hidden = !raiseSheetOpen;
      els.raiseBtn.setAttribute("aria-expanded", String(raiseSheetOpen));
      updateRaiseButtonLabel(legal);
    } else if (Array.isArray(legal.actions) && legal.actions.includes("all-in") && selfSeat.stack > 0) {
      closeRaiseSheet();
      els.raiseBtn.hidden = false;
      els.raiseBtn.disabled = actionBusy;
      els.raiseBtn.dataset.intent = "all-in";
      els.raiseBtn.textContent = `All-in ${formatChips(selfSeat.stack)}`;
    } else {
      closeRaiseSheet();
      els.raiseBtn.hidden = true;
    }
  }

  function render() {
    if (!currentTable) return;
    shellUI.syncLayoutMetrics();
    const remainingSeconds = getRemainingSeconds();
    els.codeBadge.textContent = currentTable.code;
    els.blindsPill.textContent = `${formatChips(currentTable.sb)}/${formatChips(currentTable.bb)} · ${currentTable.maxSeats || 6}-max`;

    renderTableFelt({
      els, currentTable, myHoleCards, lastHoleCardsHandId, getBalance, actionBusy, remainingSeconds
    });
    renderActionBar(remainingSeconds);
  }

  async function performAction(intent, amount = undefined) {
    if (!currentTable?.hand || actionBusy) return;
    closeRaiseSheet();
    actionBusy = true;
    renderActionBar(getRemainingSeconds());

    const hand = currentTable.hand;
    const res = await sendHandAction({
      table: currentTable.code, intent, handId: hand.id, actionSeq: hand.actionSeq, amount
    });
    actionBusy = false;

    if (!res.ok) {
      showToast(res.error || "Action failed.", { variant: "error" });
      if (res.code === "ERR_STALE_ACTION_SEQ" || res.code === "ERR_STALE_HAND" || res.status === 409) {
        const fresh = await fetchTableState(currentTable.code);
        if (fresh.ok && fresh.table) applyTableState(fresh.table);
      } else {
        renderActionBar(getRemainingSeconds());
      }
      return;
    }
    if (res.table) applyTableState(res.table);
  }

  function setClampedRaise(targetVal) {
    const legal = currentTable?.hand?.legalActions;
    if (!legal?.canRaise) return;
    const clamped = Math.min(
      legal.maxRaiseTo,
      Math.max(legal.minRaiseTo, Math.trunc(Number(targetVal || legal.minRaiseTo)))
    );
    currentRaiseTo = clamped;
    els.raiseSlider.value = String(clamped);
    els.raiseInput.value = String(clamped);
    updateRaiseButtonLabel(legal);
  }

  function submitCurrentRaise() {
    const legal = currentTable?.hand?.legalActions;
    if (!legal?.canRaise) return;
    const amt = Math.min(
      legal.maxRaiseTo,
      Math.max(legal.minRaiseTo, Math.trunc(Number(currentRaiseTo || legal.minRaiseTo)))
    );
    performAction("raise", amt);
  }

  function openRaiseSheet() {
    const legal = currentTable?.hand?.legalActions;
    if (!legal?.canRaise) return;
    raiseSheetOpen = true;
    els.raisePanel.hidden = false;
    els.raiseBtn.setAttribute("aria-expanded", "true");
    updateRaiseButtonLabel(legal);
  }

  function applyPreset(kind) {
    const hand = currentTable?.hand;
    const { selfSeat } = partitionTableSeats(currentTable);
    const legal = hand?.legalActions;
    if (!hand || !selfSeat || !legal?.canRaise) return;
    if (!raiseSheetOpen) openRaiseSheet();
    const presets = computeRaisePresets({
      pot: hand.pot, currentBet: hand.currentBet, myBet: selfSeat.bet,
      minRaiseTo: legal.minRaiseTo, maxRaiseTo: legal.maxRaiseTo
    });
    setClampedRaise(presets[kind] ?? legal.minRaiseTo);
  }

  async function toggleSitStatus(targetIntent = null) {
    if (!currentTable?.code || actionBusy) return;
    const { selfSeat } = partitionTableSeats(currentTable);
    if (!selfSeat) return;

    const intent = targetIntent || (selfSeat.status === "sitout" ? "sit-in" : "sit-out");
    actionBusy = true;
    const res = await setTableSeatStatus(currentTable.code, intent);
    actionBusy = false;

    if (!res.ok) {
      showToast(res.error || "Could not update seat status.", { variant: "error" });
      return;
    }
    if (res.table) applyTableState(res.table);
    showToast(intent === "sit-in" ? "Active for next hand." : "Sitting out next hand.");
  }

  function cleanup() {
    if (countdownInterval) { window.clearInterval(countdownInterval); countdownInterval = null; }
    if (channelSub) { channelSub.unsubscribe(); channelSub = null; }
    subscribedCode = null;
    currentTable = null;
    knownSelfSeatNo = null;
    myHoleCards = null;
    lastHoleCardsHandId = null;
    closeRaiseSheet();
    handHistory.length = 0;
    renderHandHistoryList(els.historyList, els.historyPanel, handHistory, els.historyEmpty, els.historyOpenBtn);
    try { sessionStorage.removeItem("kth_poker_active_table"); } catch (_err) { /* ignore */ }
  }

  function wireEvents() {
    shellUI.wireShellEvents({ onCleanupAndLobby: () => { cleanup(); onExitToLobby(); } });

    els.copyCodeBtn?.addEventListener("click", async () => {
      if (!currentTable?.code) return;
      try {
        await navigator.clipboard.writeText(currentTable.code);
        showToast(`Copied room code ${currentTable.code}`);
      } catch (_err) {
        showToast(`Room code: ${currentTable.code}`);
      }
    });

    els.soundBtn?.addEventListener("click", () => {
      const on = toggleSoundEnabled();
      els.soundBtn.textContent = on ? "Sound: On" : "Sound: Off";
      els.soundBtn.setAttribute("aria-pressed", String(on));
    });

    els.refreshBtn?.addEventListener("click", async () => {
      if (!currentTable?.code) return;
      const res = await fetchTableState(currentTable.code);
      if (res.ok && res.table) { applyTableState(res.table); showToast("Table synced."); shellUI.closeDrawer(); }
      else if (res.error) showToast(res.error, { variant: "error" });
    });

    els.closeTableBtn?.addEventListener("click", async () => {
      if (!currentTable?.code || actionBusy) return;
      actionBusy = true;
      const res = await closeTable(currentTable.code);
      actionBusy = false;
      if (!res.ok) { showToast(res.error || "Could not close table.", { variant: "error" }); return; }
      shellUI.closeDrawer();
      cleanup();
      showToast("Table closed.");
      onExitToLobby();
    });

    els.sitInBtn?.addEventListener("click", () => toggleSitStatus("sit-in"));
    els.sitOutToggleBtn?.addEventListener("click", () => { shellUI.closeDrawer(); toggleSitStatus(); });

    els.leaveBtn?.addEventListener("click", async () => {
      if (!currentTable?.code || actionBusy) return;
      const { selfSeat } = partitionTableSeats(currentTable);
      if (!selfSeat) { cleanup(); onExitToLobby(); return; }
      actionBusy = true;
      const res = await leaveTable(currentTable.code);
      actionBusy = false;
      if (!res.ok) { showToast(res.error || "Could not leave table.", { variant: "error" }); return; }
      cleanup();
      await onChipsChanged();
      showToast(res.pendingCashout ? "Folded; chips return after hand." : "Left table & cashed out.");
      onExitToLobby();
    });

    els.dealBtn?.addEventListener("click", async () => {
      if (!currentTable?.code || actionBusy) return;
      actionBusy = true;
      els.dealBtn.disabled = true;
      const res = await startHand(currentTable.code);
      actionBusy = false;
      if (!res.ok) { els.dealBtn.disabled = false; showToast(res.error || "Could not deal hand.", { variant: "error" }); return; }
      playTableCue("deal");
      if (res.table) applyTableState(res.table);
    });

    els.sitDownForm?.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!currentTable?.code || actionBusy) return;
      const buyIn = Math.trunc(Number(els.sitDownBuyInInput.value));
      actionBusy = true;
      const res = await joinTable({ code: currentTable.code, buyIn });
      actionBusy = false;
      if (!res.ok) { showToast(res.error || "Could not sit down.", { variant: "error" }); return; }
      if (res.table) {
        applyTableState(res.table);
        await onChipsChanged();
        showToast(`Sat down with ${formatChips(buyIn)} chips.`);
      }
    });

    els.raiseCloseBtn?.addEventListener("click", () => { closeRaiseSheet(); renderActionBar(getRemainingSeconds()); });
    els.raiseConfirmBtn?.addEventListener("click", () => submitCurrentRaise());
    els.presetMinBtn?.addEventListener("click", () => applyPreset("min"));
    els.presetHalfBtn?.addEventListener("click", () => applyPreset("halfPot"));
    els.presetPotBtn?.addEventListener("click", () => applyPreset("pot"));
    els.presetAllInBtn?.addEventListener("click", () => applyPreset("allIn"));
    els.stepDownBtn?.addEventListener("click", () => setClampedRaise((currentRaiseTo || 0) - Math.max(1, currentTable?.bb || 20)));
    els.stepUpBtn?.addEventListener("click", () => setClampedRaise((currentRaiseTo || 0) + Math.max(1, currentTable?.bb || 20)));
    els.raiseSlider?.addEventListener("input", () => setClampedRaise(Number(els.raiseSlider.value)));
    els.raiseInput?.addEventListener("input", () => {
      const legal = currentTable?.hand?.legalActions;
      const val = Number(els.raiseInput.value);
      if (legal?.canRaise && Number.isFinite(val) && val > 0) {
        currentRaiseTo = Math.min(legal.maxRaiseTo, Math.max(legal.minRaiseTo, Math.trunc(val)));
        els.raiseSlider.value = String(currentRaiseTo);
        updateRaiseButtonLabel(legal);
      }
    });
    els.raiseInput?.addEventListener("blur", () => setClampedRaise(Number(els.raiseInput.value)));

    els.foldBtn?.addEventListener("click", () => performAction("fold"));
    els.checkCallBtn?.addEventListener("click", () => performAction(els.checkCallBtn.dataset.intent || "check"));
    els.raiseBtn?.addEventListener("click", () => {
      if ((els.raiseBtn.dataset.intent || "raise") === "all-in") performAction("all-in");
      else if (!raiseSheetOpen) openRaiseSheet();
      else submitCurrentRaise();
    });

    window.addEventListener("keydown", (e) => {
      if (!currentTable || els.viewTable?.hidden || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape" && raiseSheetOpen) { e.preventDefault(); closeRaiseSheet(); renderActionBar(getRemainingSeconds()); return; }
      const tag = (e.target?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || document.querySelector("dialog[open]")) {
        if (e.key === "Enter" && raiseSheetOpen && e.target === els.raiseInput) { e.preventDefault(); submitCurrentRaise(); }
        return;
      }
      const key = e.key.toLowerCase();
      if (key === "d" && !els.dealBtnWrap?.hidden && !els.dealBtn?.disabled) { e.preventDefault(); els.dealBtn.click(); return; }
      if (els.controlsWrap.hidden) return;
      if (key === "f" && !els.foldBtn.disabled) { e.preventDefault(); els.foldBtn.click(); }
      else if (key === "c" && !els.checkCallBtn.disabled) { e.preventDefault(); els.checkCallBtn.click(); }
      else if (key === "r" && !els.raiseBtn.hidden && !els.raiseBtn.disabled) { e.preventDefault(); els.raiseBtn.click(); }
      else if (key === "enter" && raiseSheetOpen) { e.preventDefault(); submitCurrentRaise(); }
      else if (key === "1") applyPreset("min");
      else if (key === "2") applyPreset("halfPot");
      else if (key === "3") applyPreset("pot");
      else if (key === "4") applyPreset("allIn");
    });
  }

  wireEvents();
  if (els.soundBtn) els.soundBtn.textContent = isSoundEnabled() ? "Sound: On" : "Sound: Off";

  return {
    openWithTable(tableState) {
      knownSelfSeatNo = null;
      applyTableState(tableState);
      window.requestAnimationFrame(() => shellUI.syncLayoutMetrics());
    },
    async openByCode(code) {
      const res = await fetchTableState(code);
      if (res.ok && res.table) { applyTableState(res.table); return { ok: true, table: res.table }; }
      return { ok: false, error: res.error, code: res.code };
    },
    notifyUnauthorized() { shellUI.updateConnectionBanner("UNAUTHORIZED"); },
    getActiveTable() { return currentTable; },
    syncLayoutMetrics: shellUI.syncLayoutMetrics,
    cleanup
  };
}
