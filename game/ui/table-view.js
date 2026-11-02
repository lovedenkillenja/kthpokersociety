// M4 Heads-Up Table View controller (`#view-table`).
// Coordinates Realtime broadcast subscriptions, `"state"` fallback polling,
// `hole_cards` RLS queries, and the thumb-reachable fixed action bar.

import { formatChips } from "../lib/format.js";
import {
  normalizeIncomingTableState,
  partitionTableSeats,
  computeRaisePresets
} from "../lib/table-helpers.js";
import {
  fetchTableState,
  joinTable,
  leaveTable,
  startHand,
  sendHandAction,
  fetchOwnHoleCards,
  subscribeToTableChannel
} from "../lib/poker-api.js";
import { showToast } from "./components.js";
import { renderTableFelt } from "./table-render.js";

export function createTableViewController({
  getUser,
  getDisplayName,
  getBalance,
  onChipsChanged,
  onExitToLobby
}) {
  let currentTable = null;
  let knownSelfSeatNo = null;
  let myHoleCards = null;
  let lastHoleCardsHandId = null;
  let lastAnnouncedTurnKey = "";
  let channelSub = null;
  let subscribedCode = null;
  let actionBusy = false;
  let currentRaiseTo = 0;
  let lastHandSeqKey = "";

  const els = {
    codeBadge: document.getElementById("table-code-badge"),
    copyCodeBtn: document.getElementById("table-copy-code-btn"),
    blindsPill: document.getElementById("table-blinds-pill"),
    connPill: document.getElementById("table-conn-pill"),
    refreshBtn: document.getElementById("table-refresh-btn"),
    leaveBtn: document.getElementById("table-leave-btn"),

    opponentArea: document.getElementById("table-opponent-seat"),
    potAmount: document.getElementById("table-pot-amount"),
    sidePotsRow: document.getElementById("table-side-pots"),
    boardRow: document.getElementById("table-board-row"),
    statusHeadline: document.getElementById("table-status-headline"),
    statusDetail: document.getElementById("table-status-detail"),
    dealBtnWrap: document.getElementById("table-deal-wrap"),
    dealBtn: document.getElementById("table-deal-btn"),
    selfArea: document.getElementById("table-self-seat"),

    sitDownForm: document.getElementById("table-sitdown-form"),
    sitDownBuyInInput: document.getElementById("table-sitdown-buyin"),
    sitDownBtn: document.getElementById("table-sitdown-btn"),

    actionBar: document.getElementById("table-action-bar"),
    waitingStrip: document.getElementById("action-waiting-strip"),
    waitingText: document.getElementById("action-waiting-text"),
    controlsWrap: document.getElementById("action-controls-wrap"),
    raisePanel: document.getElementById("action-raise-panel"),
    presetMinBtn: document.getElementById("preset-min-btn"),
    presetHalfBtn: document.getElementById("preset-half-btn"),
    presetPotBtn: document.getElementById("preset-pot-btn"),
    presetAllInBtn: document.getElementById("preset-allin-btn"),
    raiseSlider: document.getElementById("action-raise-slider"),
    raiseInput: document.getElementById("action-raise-input"),
    foldBtn: document.getElementById("action-fold-btn"),
    checkCallBtn: document.getElementById("action-check-call-btn"),
    raiseBtn: document.getElementById("action-raise-btn")
  };

  function announce(message) {
    const live = document.getElementById("live-announcer");
    if (live && message) live.textContent = message;
  }

  function ensureChannelSubscription(code) {
    const clean = String(code || "").toUpperCase().trim();
    if (!clean) return;
    if (subscribedCode === clean && channelSub) return;

    if (channelSub) {
      channelSub.unsubscribe();
      channelSub = null;
    }
    subscribedCode = clean;

    channelSub = subscribeToTableChannel(clean, {
      onState(incoming) {
        applyTableState(incoming);
      },
      onConnectionChange(status) {
        if (!els.connPill) return;
        if (status === "SUBSCRIBED") {
          els.connPill.textContent = "Live";
          els.connPill.className = "pill pill--brand";
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          els.connPill.textContent = "Syncing…";
          els.connPill.className = "pill";
        }
      }
    });
  }

  async function syncHoleCardsIfNeeded(table) {
    const user = getUser();
    const handId = table?.hand?.id || null;
    if (!user || !handId) {
      myHoleCards = null;
      lastHoleCardsHandId = null;
      return;
    }
    if (lastHoleCardsHandId === handId && Array.isArray(myHoleCards) && myHoleCards.length === 2) {
      return;
    }

    const cards = await fetchOwnHoleCards(handId, user.id);
    if (cards && cards.length === 2 && currentTable?.hand?.id === handId) {
      myHoleCards = cards;
      lastHoleCardsHandId = handId;
      renderTableFelt({
        els,
        currentTable,
        myHoleCards,
        lastHoleCardsHandId,
        getBalance,
        actionBusy
      });
    }
  }

  function applyTableState(rawTable) {
    if (!rawTable) return;
    const normalized = normalizeIncomingTableState(rawTable, {
      knownSelfSeatNo,
      currentDisplayName: getDisplayName()
    });
    if (!normalized) return;

    if (normalized.selfSeatNo !== null && normalized.selfSeatNo !== undefined) {
      knownSelfSeatNo = normalized.selfSeatNo;
    }
    currentTable = normalized;

    try {
      sessionStorage.setItem("kth_poker_active_table", normalized.code);
    } catch (_err) {
      // Ignore storage quota errors
    }

    ensureChannelSubscription(normalized.code);
    render();
    syncHoleCardsIfNeeded(normalized);
  }

  function updateRaiseButtonLabel(legal) {
    if (!legal?.canRaise) return;
    const val = Math.min(
      legal.maxRaiseTo,
      Math.max(legal.minRaiseTo, Math.trunc(Number(currentRaiseTo || legal.minRaiseTo)))
    );
    currentRaiseTo = val;
    const isAllIn = val >= legal.maxRaiseTo;
    const isOpeningBet = Number(currentTable?.hand?.currentBet || 0) === 0;
    const verb = isAllIn ? "All-in" : isOpeningBet ? "Bet" : "Raise to";
    els.raiseBtn.textContent = `${verb} ${formatChips(val)}`;
  }

  function renderActionBar() {
    if (!currentTable) {
      els.actionBar.hidden = true;
      return;
    }

    const { selfSeat, opponentSeat } = partitionTableSeats(currentTable);
    const hand = currentTable.hand || null;

    if (!selfSeat || !hand || hand.status !== "playing") {
      els.actionBar.hidden = true;
      return;
    }

    els.actionBar.hidden = false;
    const isMyTurn = hand.actingSeat === selfSeat.seatNo;
    const legal = hand.legalActions || null;

    if (!isMyTurn || !legal) {
      els.waitingStrip.hidden = false;
      els.controlsWrap.hidden = true;
      const oppName = opponentSeat?.displayName || "opponent";
      els.waitingText.textContent = `Waiting for ${oppName} to act…`;
      return;
    }

    const turnKey = `${hand.id}:${hand.actionSeq}:${selfSeat.seatNo}`;
    if (lastAnnouncedTurnKey !== turnKey) {
      lastAnnouncedTurnKey = turnKey;
      announce(`Your turn. Pot is ${formatChips(hand.pot)} chips.`);
      try {
        if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
          navigator.vibrate(35);
        }
      } catch (_err) {
        // Ignore if vibration blocked
      }
    }

    els.waitingStrip.hidden = true;
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
      if (lastHandSeqKey !== seqKey) {
        lastHandSeqKey = seqKey;
        currentRaiseTo = legal.minRaiseTo;
      } else {
        currentRaiseTo = Math.min(legal.maxRaiseTo, Math.max(legal.minRaiseTo, currentRaiseTo));
      }

      els.raiseSlider.min = String(legal.minRaiseTo);
      els.raiseSlider.max = String(legal.maxRaiseTo);
      els.raiseSlider.step = String(Math.max(1, Math.min(10, currentTable.sb || 10)));
      els.raiseSlider.value = String(currentRaiseTo);

      els.raiseInput.min = String(legal.minRaiseTo);
      els.raiseInput.max = String(legal.maxRaiseTo);
      els.raiseInput.value = String(currentRaiseTo);

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
    els.codeBadge.textContent = `Room ${currentTable.code}`;
    els.blindsPill.textContent = `${formatChips(currentTable.sb)} / ${formatChips(currentTable.bb)} blinds`;

    renderTableFelt({
      els,
      currentTable,
      myHoleCards,
      lastHoleCardsHandId,
      getBalance,
      actionBusy
    });
    renderActionBar();
  }

  async function performAction(intent, amount = undefined) {
    if (!currentTable?.hand || actionBusy) return;
    actionBusy = true;
    renderActionBar();

    const hand = currentTable.hand;
    const res = await sendHandAction({
      table: currentTable.code,
      intent,
      handId: hand.id,
      actionSeq: hand.actionSeq,
      amount
    });

    actionBusy = false;

    if (!res.ok) {
      showToast(res.error || "Action failed.", { variant: "error" });
      if (
        res.code === "ERR_STALE_ACTION_SEQ" ||
        res.code === "ERR_STALE_HAND" ||
        res.status === 409
      ) {
        const fresh = await fetchTableState(currentTable.code);
        if (fresh.ok && fresh.table) applyTableState(fresh.table);
      } else {
        renderActionBar();
      }
      return;
    }

    if (res.table) applyTableState(res.table);
  }

  function applyPreset(kind) {
    const hand = currentTable?.hand;
    const { selfSeat } = partitionTableSeats(currentTable);
    const legal = hand?.legalActions;
    if (!hand || !selfSeat || !legal?.canRaise) return;

    const presets = computeRaisePresets({
      pot: hand.pot,
      currentBet: hand.currentBet,
      myBet: selfSeat.bet,
      minRaiseTo: legal.minRaiseTo,
      maxRaiseTo: legal.maxRaiseTo
    });

    currentRaiseTo = presets[kind] ?? legal.minRaiseTo;
    els.raiseSlider.value = String(currentRaiseTo);
    els.raiseInput.value = String(currentRaiseTo);
    updateRaiseButtonLabel(legal);
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

    els.refreshBtn?.addEventListener("click", async () => {
      if (!currentTable?.code) return;
      els.refreshBtn.setAttribute("aria-busy", "true");
      const res = await fetchTableState(currentTable.code);
      els.refreshBtn.removeAttribute("aria-busy");
      if (res.ok && res.table) {
        applyTableState(res.table);
        showToast("Table synced.");
      } else if (res.error) {
        showToast(res.error, { variant: "error" });
      }
    });

    els.leaveBtn?.addEventListener("click", async () => {
      if (!currentTable?.code || actionBusy) return;
      const { selfSeat } = partitionTableSeats(currentTable);
      if (!selfSeat) {
        cleanup();
        onExitToLobby();
        return;
      }

      actionBusy = true;
      els.leaveBtn.setAttribute("aria-busy", "true");
      const res = await leaveTable(currentTable.code);
      actionBusy = false;
      els.leaveBtn.removeAttribute("aria-busy");

      if (!res.ok) {
        showToast(res.error || "Could not leave table.", { variant: "error" });
        return;
      }

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

      if (!res.ok) {
        showToast(res.error || "Could not deal hand.", { variant: "error" });
        return;
      }
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

      if (!res.ok) {
        showToast(res.error || "Could not sit down.", { variant: "error" });
        return;
      }
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

    els.raiseSlider?.addEventListener("input", () => {
      const legal = currentTable?.hand?.legalActions;
      if (!legal?.canRaise) return;
      currentRaiseTo = Number(els.raiseSlider.value);
      els.raiseInput.value = String(currentRaiseTo);
      updateRaiseButtonLabel(legal);
    });

    els.raiseInput?.addEventListener("input", () => {
      const legal = currentTable?.hand?.legalActions;
      if (!legal?.canRaise) return;
      const val = Number(els.raiseInput.value);
      if (Number.isFinite(val)) {
        currentRaiseTo = val;
        els.raiseSlider.value = String(
          Math.min(legal.maxRaiseTo, Math.max(legal.minRaiseTo, Math.trunc(val)))
        );
        updateRaiseButtonLabel(legal);
      }
    });

    els.foldBtn?.addEventListener("click", () => performAction("fold"));
    els.checkCallBtn?.addEventListener("click", () => {
      performAction(els.checkCallBtn.dataset.intent || "check");
    });
    els.raiseBtn?.addEventListener("click", () => {
      if ((els.raiseBtn.dataset.intent || "raise") === "all-in") {
        performAction("all-in");
      } else {
        performAction("raise", currentRaiseTo);
      }
    });

    window.addEventListener("keydown", (e) => {
      if (!currentTable || els.actionBar.hidden || els.controlsWrap.hidden) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;

      const key = e.key.toLowerCase();
      if (key === "f" && !els.foldBtn.disabled) {
        e.preventDefault();
        els.foldBtn.click();
      } else if (key === "c" && !els.checkCallBtn.disabled) {
        e.preventDefault();
        els.checkCallBtn.click();
      } else if (key === "r" && !els.raiseBtn.hidden && !els.raiseBtn.disabled) {
        e.preventDefault();
        els.raiseBtn.click();
      }
    });
  }

  function cleanup() {
    if (channelSub) {
      channelSub.unsubscribe();
      channelSub = null;
    }
    subscribedCode = null;
    currentTable = null;
    knownSelfSeatNo = null;
    myHoleCards = null;
    lastHoleCardsHandId = null;
    els.actionBar.hidden = true;
    try {
      sessionStorage.removeItem("kth_poker_active_table");
    } catch (_err) {
      // Ignore
    }
  }

  wireEvents();

  return {
    openWithTable(tableState) {
      knownSelfSeatNo = null;
      applyTableState(tableState);
    },
    async openByCode(code) {
      const res = await fetchTableState(code);
      if (res.ok && res.table) {
        applyTableState(res.table);
        return true;
      }
      return false;
    },
    getActiveTable() {
      return currentTable;
    },
    cleanup
  };
}
