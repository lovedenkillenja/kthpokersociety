// M4+M5+M6 Table View controller (`#view-table`).
// Coordinates 2–6 player state, 30s action timer & `tick` enforcement, sit-in/sit-out,
// host table close, connection & auth recovery, hand history, and `hole_cards` RLS queries.

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
import { isSoundEnabled, toggleSoundEnabled, playTableCue } from "./tutorial-dialog.js";

export function createTableViewController({
  getUser, getDisplayName, getBalance, onChipsChanged, onExitToLobby, onOpenAuth
}) {
  let currentTable = null, knownSelfSeatNo = null, myHoleCards = null, lastHoleCardsHandId = null;
  let lastAnnouncedTurnKey = "", lastTenSecWarnKey = "", lastAnnouncedWinHandId = "";
  let channelSub = null, subscribedCode = null, actionBusy = false;
  let currentRaiseTo = 0, lastHandSeqKey = "", serverClockSkewMs = 0, countdownInterval = null;
  let lastRenderedSecond = null, lastTickAttemptAt = 0, tickInFlight = false;
  let connState = "CONNECTING";
  const handHistory = [];

  const byId = (id) => document.getElementById(id);
  const els = {
    viewTable: byId("view-table"), codeBadge: byId("table-code-badge"),
    copyCodeBtn: byId("table-copy-code-btn"), blindsPill: byId("table-blinds-pill"),
    connPill: byId("table-conn-pill"), soundBtn: byId("table-sound-btn"),
    refreshBtn: byId("table-refresh-btn"), sitOutToggleBtn: byId("table-sitout-toggle-btn"),
    closeTableBtn: byId("table-close-btn"), leaveBtn: byId("table-leave-btn"),
    connBanner: byId("table-conn-banner"), connBannerText: byId("table-conn-banner-text"),
    connBannerBtn: byId("table-conn-banner-btn"), opponentArea: byId("table-opponent-seat"),
    potAmount: byId("table-pot-amount"), sidePotsRow: byId("table-side-pots"),
    boardRow: byId("table-board-row"), statusHeadline: byId("table-status-headline"),
    statusDetail: byId("table-status-detail"), dealBtnWrap: byId("table-deal-wrap"),
    dealBtn: byId("table-deal-btn"), sitOutBanner: byId("table-sitout-banner"),
    sitInBtn: byId("table-sitin-btn"), selfArea: byId("table-self-seat"),
    sitDownForm: byId("table-sitdown-form"), sitDownBuyInInput: byId("table-sitdown-buyin"),
    sitDownBtn: byId("table-sitdown-btn"), historyPanel: byId("table-history-panel"),
    historyList: byId("table-history-list"), actionBar: byId("table-action-bar"),
    waitingStrip: byId("action-waiting-strip"), waitingText: byId("action-waiting-text"),
    timerPill: byId("action-timer-pill"), controlsWrap: byId("action-controls-wrap"),
    raisePanel: byId("action-raise-panel"), presetMinBtn: byId("preset-min-btn"),
    presetHalfBtn: byId("preset-half-btn"), presetPotBtn: byId("preset-pot-btn"),
    presetAllInBtn: byId("preset-allin-btn"), stepDownBtn: byId("raise-step-down-btn"),
    stepUpBtn: byId("raise-step-up-btn"), raiseSlider: byId("action-raise-slider"),
    raiseInput: byId("action-raise-input"), foldBtn: byId("action-fold-btn"),
    checkCallBtn: byId("action-check-call-btn"), raiseBtn: byId("action-raise-btn")
  };

  function announce(message) {
    const live = byId("live-announcer");
    if (live && message) live.textContent = message;
  }

  function getRemainingSeconds() {
    return computeRemainingTurnSeconds(currentTable?.hand, Date.now(), serverClockSkewMs);
  }

  function setBanner(pillText, pillClass, bannerText = "", btnText = "", mode = "") {
    if (!els.connPill) return;
    els.connPill.textContent = pillText;
    els.connPill.className = pillClass;
    if (!els.connBanner) return;
    els.connBanner.hidden = !bannerText;
    if (bannerText) {
      els.connBannerText.textContent = bannerText;
      els.connBannerBtn.textContent = btnText;
      els.connBannerBtn.dataset.mode = mode;
    }
  }

  function updateConnectionBanner(nextStatus) {
    if (nextStatus) connState = nextStatus;
    if (currentTable?.status === "closed") {
      setBanner(
        "Closed", "pill pill--danger",
        "This table is closed. Return to the lobby to join or create a new table.",
        "Return to lobby", "lobby"
      );
    } else if (connState === "UNAUTHORIZED") {
      setBanner(
        "Session expired", "pill pill--danger",
        "Your session expired. Log in again to return to your seat.",
        "Log in", "login"
      );
    } else if (connState === "OFFLINE") {
      setBanner(
        "Offline", "pill pill--danger",
        "Connection lost. Reconnecting…",
        "Reconnect now", "reconnect"
      );
    } else {
      setBanner("Live", "pill pill--brand");
    }
  }

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
        if (status === "SUBSCRIBED" || status === "ONLINE") updateConnectionBanner("ONLINE");
        else if (status === "OFFLINE" || status === "UNAUTHORIZED") updateConnectionBanner(status);
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
    renderHandHistoryList(els.historyList, els.historyPanel, handHistory);

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

    updateConnectionBanner("ONLINE");
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
    els.raiseBtn.textContent = `${verb} ${formatChips(val)}`;
  }

  function renderActionBar(remainingSeconds = null) {
    if (!currentTable) {
      els.actionBar.hidden = true;
      return;
    }

    const { selfSeat } = partitionTableSeats(currentTable);
    const hand = currentTable.hand || null;
    if (!selfSeat || !hand || hand.status !== "playing") {
      els.actionBar.hidden = true;
      return;
    }

    els.actionBar.hidden = false;
    const isMyTurn = hand.actingSeat === selfSeat.seatNo;
    const legal = hand.legalActions || null;
    const actingSeat = (currentTable.seats || []).find((s) => s.seatNo === hand.actingSeat);
    const urgent = remainingSeconds !== null && remainingSeconds <= 8;

    els.actionBar.classList.toggle("action-bar--my-turn", isMyTurn);
    els.actionBar.classList.toggle("action-bar--urgent", Boolean(isMyTurn && urgent));

    if (els.timerPill) {
      if (remainingSeconds !== null && remainingSeconds !== undefined) {
        els.timerPill.hidden = false;
        els.timerPill.textContent = urgent ? `⚠ ${remainingSeconds}s left` : `${remainingSeconds}s`;
        els.timerPill.className = `pill tabular ${urgent ? "pill--danger" : "pill--brand"}`;
      } else {
        els.timerPill.hidden = true;
      }
    }

    if (!isMyTurn || !legal) {
      els.controlsWrap.hidden = true;
      const actorName = actingSeat?.displayName || `Seat ${(hand.actingSeat ?? 0) + 1}`;
      els.waitingText.textContent =
        selfSeat.status === "sitout"
          ? "Sitting out — tap Sit back in on the table to join next hand"
          : `Waiting for ${actorName} to act…`;
      return;
    }

    els.waitingText.textContent = urgent
      ? `Your turn — act within ${remainingSeconds}s`
      : "Your turn to act";

    const turnKey = `${hand.id}:${hand.actionSeq}:${selfSeat.seatNo}`;
    if (lastAnnouncedTurnKey !== turnKey) {
      lastAnnouncedTurnKey = turnKey;
      announce(`Your turn. Pot is ${formatChips(hand.pot)} chips. 30 seconds to act.`);
      playTableCue("turn");
      try {
        if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
          navigator.vibrate(35);
        }
      } catch (_err) {
        // Ignore if vibration blocked
      }
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
        ? `Call all-in ${formatChips(legal.callAmount)}`
        : `Call ${formatChips(legal.callAmount)}`;
      els.checkCallBtn.dataset.intent = "call";
      els.checkCallBtn.disabled = actionBusy;
    } else {
      els.checkCallBtn.textContent = "Check";
      els.checkCallBtn.disabled = true;
    }

    if (legal.canRaise && legal.minRaiseTo !== null && legal.maxRaiseTo !== null) {
      els.raisePanel.hidden = false;
      els.raiseBtn.hidden = false;
      els.raiseBtn.disabled = actionBusy;
      els.raiseBtn.dataset.intent = "raise";

      const seqKey = `${hand.id}:${hand.actionSeq}`;
      const stepSize = Math.max(1, currentTable.bb || 20);
      if (lastHandSeqKey !== seqKey) {
        lastHandSeqKey = seqKey;
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

      updateRaiseButtonLabel(legal);
    } else if (Array.isArray(legal.actions) && legal.actions.includes("all-in") && selfSeat.stack > 0) {
      els.raisePanel.hidden = true;
      els.raiseBtn.hidden = false;
      els.raiseBtn.disabled = actionBusy;
      els.raiseBtn.dataset.intent = "all-in";
      els.raiseBtn.textContent = `All-in ${formatChips(selfSeat.stack)}`;
    } else {
      els.raisePanel.hidden = true;
      els.raiseBtn.hidden = true;
    }
  }

  function render() {
    if (!currentTable) return;
    const remainingSeconds = getRemainingSeconds();
    els.codeBadge.textContent = `Room ${currentTable.code}`;
    els.blindsPill.textContent = `${formatChips(currentTable.sb)} / ${formatChips(currentTable.bb)} · ${currentTable.maxSeats || 6}-max`;

    renderTableFelt({
      els, currentTable, myHoleCards, lastHoleCardsHandId, getBalance, actionBusy, remainingSeconds
    });
    renderActionBar(remainingSeconds);
  }

  async function performAction(intent, amount = undefined) {
    if (!currentTable?.hand || actionBusy) return;
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

  function applyPreset(kind) {
    const hand = currentTable?.hand;
    const { selfSeat } = partitionTableSeats(currentTable);
    const legal = hand?.legalActions;
    if (!hand || !selfSeat || !legal?.canRaise) return;

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
    els.sitInBtn?.setAttribute("aria-busy", "true");
    els.sitOutToggleBtn?.setAttribute("aria-busy", "true");
    const res = await setTableSeatStatus(currentTable.code, intent);
    actionBusy = false;
    els.sitInBtn?.removeAttribute("aria-busy");
    els.sitOutToggleBtn?.removeAttribute("aria-busy");

    if (!res.ok) {
      showToast(res.error || "Could not update seat status.", { variant: "error" });
      return;
    }
    if (res.table) applyTableState(res.table);
    showToast(
      intent === "sit-in"
        ? "You are active and will be dealt into the next hand."
        : "You are sitting out and will be skipped when hands are dealt."
    );
  }

  function wireEvents() {
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

    els.connBannerBtn?.addEventListener("click", async () => {
      const mode = els.connBannerBtn.dataset.mode;
      if (mode === "lobby") { cleanup(); onExitToLobby(); }
      else if (mode === "login") { if (typeof onOpenAuth === "function") onOpenAuth("login"); }
      else if (currentTable?.code) {
        const res = await fetchTableState(currentTable.code);
        if (res.ok && res.table) { applyTableState(res.table); showToast("Reconnected to table."); }
      }
    });

    els.refreshBtn?.addEventListener("click", async () => {
      if (!currentTable?.code) return;
      els.refreshBtn.setAttribute("aria-busy", "true");
      const res = await fetchTableState(currentTable.code);
      els.refreshBtn.removeAttribute("aria-busy");
      if (res.ok && res.table) { applyTableState(res.table); showToast("Table synced."); }
      else if (res.error) showToast(res.error, { variant: "error" });
    });

    els.closeTableBtn?.addEventListener("click", async () => {
      if (!currentTable?.code || actionBusy) return;
      actionBusy = true;
      els.closeTableBtn.setAttribute("aria-busy", "true");
      const res = await closeTable(currentTable.code);
      actionBusy = false;
      els.closeTableBtn.removeAttribute("aria-busy");
      if (!res.ok) { showToast(res.error || "Could not close table.", { variant: "error" }); return; }
      cleanup();
      showToast("Table closed.");
      onExitToLobby();
    });

    els.sitInBtn?.addEventListener("click", () => toggleSitStatus("sit-in"));
    els.sitOutToggleBtn?.addEventListener("click", () => toggleSitStatus());

    els.leaveBtn?.addEventListener("click", async () => {
      if (!currentTable?.code || actionBusy) return;
      const { selfSeat } = partitionTableSeats(currentTable);
      if (!selfSeat) { cleanup(); onExitToLobby(); return; }
      actionBusy = true;
      els.leaveBtn.setAttribute("aria-busy", "true");
      const res = await leaveTable(currentTable.code);
      actionBusy = false;
      els.leaveBtn.removeAttribute("aria-busy");
      if (!res.ok) { showToast(res.error || "Could not leave table.", { variant: "error" }); return; }
      cleanup();
      await onChipsChanged();
      showToast(
        res.pendingCashout
          ? "Folded hand; your remaining chips will return when the hand finishes."
          : "Left table and cashed out chips to your balance."
      );
      onExitToLobby();
    });

    els.dealBtn?.addEventListener("click", async () => {
      if (!currentTable?.code || actionBusy) return;
      actionBusy = true;
      els.dealBtn.setAttribute("aria-busy", "true");
      const res = await startHand(currentTable.code);
      actionBusy = false;
      els.dealBtn.removeAttribute("aria-busy");
      if (!res.ok) { showToast(res.error || "Could not deal hand.", { variant: "error" }); return; }
      playTableCue("deal");
      if (res.table) applyTableState(res.table);
    });

    els.sitDownForm?.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!currentTable?.code || actionBusy) return;
      const buyIn = Math.trunc(Number(els.sitDownBuyInInput.value));
      actionBusy = true;
      els.sitDownBtn.setAttribute("aria-busy", "true");
      const res = await joinTable({ code: currentTable.code, buyIn });
      actionBusy = false;
      els.sitDownBtn.removeAttribute("aria-busy");
      if (!res.ok) { showToast(res.error || "Could not sit down.", { variant: "error" }); return; }
      if (res.table) {
        applyTableState(res.table);
        await onChipsChanged();
        showToast(`Sat down with ${formatChips(buyIn)} chips.`);
      }
    });

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
      const legal = currentTable?.hand?.legalActions;
      if ((els.raiseBtn.dataset.intent || "raise") === "all-in") performAction("all-in");
      else if (legal?.canRaise) {
        performAction("raise", Math.min(legal.maxRaiseTo, Math.max(legal.minRaiseTo, Math.trunc(Number(currentRaiseTo || legal.minRaiseTo)))));
      }
    });

    window.addEventListener("keydown", (e) => {
      if (!currentTable || els.viewTable?.hidden || e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || document.querySelector("dialog[open]")) return;
      const key = e.key.toLowerCase();
      if (key === "d" && !els.dealBtnWrap?.hidden && !els.dealBtn?.disabled) { e.preventDefault(); els.dealBtn.click(); return; }
      if (els.actionBar.hidden || els.controlsWrap.hidden) return;
      if (key === "f" && !els.foldBtn.disabled) { e.preventDefault(); els.foldBtn.click(); }
      else if (key === "c" && !els.checkCallBtn.disabled) { e.preventDefault(); els.checkCallBtn.click(); }
      else if (key === "r" && !els.raiseBtn.hidden && !els.raiseBtn.disabled) { e.preventDefault(); els.raiseBtn.click(); }
      else if (key === "1") applyPreset("min");
      else if (key === "2") applyPreset("halfPot");
      else if (key === "3") applyPreset("pot");
      else if (key === "4") applyPreset("allIn");
    });
  }

  function cleanup() {
    if (countdownInterval) { window.clearInterval(countdownInterval); countdownInterval = null; }
    if (channelSub) { channelSub.unsubscribe(); channelSub = null; }
    subscribedCode = null;
    currentTable = null;
    knownSelfSeatNo = null;
    myHoleCards = null;
    lastHoleCardsHandId = null;
    handHistory.length = 0;
    renderHandHistoryList(els.historyList, els.historyPanel, handHistory);
    els.actionBar.hidden = true;
    try { sessionStorage.removeItem("kth_poker_active_table"); } catch (_err) { /* ignore */ }
  }

  wireEvents();
  if (els.soundBtn) els.soundBtn.textContent = isSoundEnabled() ? "Sound: On" : "Sound: Off";

  return {
    openWithTable(tableState) { knownSelfSeatNo = null; applyTableState(tableState); },
    async openByCode(code) {
      const res = await fetchTableState(code);
      if (res.ok && res.table) { applyTableState(res.table); return { ok: true, table: res.table }; }
      return { ok: false, error: res.error, code: res.code };
    },
    notifyUnauthorized() { updateConnectionBanner("UNAUTHORIZED"); },
    getActiveTable() { return currentTable; },
    cleanup
  };
}
