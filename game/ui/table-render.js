// Pure DOM rendering builders for the 2–6 player oval felt table (`#view-table`).
// Separated from `table-view.js` to keep each UI module well under 600 lines.

import { formatChips } from "../lib/format.js";
import {
  partitionTableSeats,
  layoutOpponentSeatsForGrid,
  describeHandStatus,
  summarizeShowdown
} from "../lib/table-helpers.js";
import { extractInitials } from "../lib/table-layout.js";
import {
  createCard,
  createCardBack,
  createPill,
  createChipAmount
} from "./components.js";

// Tracks last-seen hand/board/bet state so deal & chip animations only fire on real transitions
const animState = {
  handId: null,
  boardCount: 0,
  selfHoleHandId: null,
  pot: 0,
  betsBySeat: new Map()
};

function buildRoleBadges(seat, hand) {
  const pills = [];
  if (!hand) return pills;
  if (hand.sbSeat === seat.seatNo) pills.push(createPill("SB"));
  if (hand.bbSeat === seat.seatNo) pills.push(createPill("BB"));
  return pills;
}

export function formatTurnStatusLabel(isSelf, remainingSeconds) {
  const hasTimer = remainingSeconds !== null && remainingSeconds !== undefined;
  const urgent = hasTimer && remainingSeconds <= 8;
  const prefix = urgent ? "⚠ " : "● ";
  if (isSelf) {
    return hasTimer ? `${prefix}Your turn · ${remainingSeconds}s` : "● Your turn";
  }
  return hasTimer ? `${prefix}${remainingSeconds}s` : "● Acting";
}

function buildSeatStatusPill(seat, hand, remainingSeconds = null) {
  if (seat.status === "sitout" && (!hand || hand.status !== "playing" || seat.folded)) {
    return createPill("⏸ Sit out", "danger");
  }
  if (!hand) {
    return createPill("Ready");
  }
  if (hand.status === "complete") {
    const won = Number(hand.payouts?.[seat.seatNo] || 0);
    if (won > 0) return createPill(`★ +${formatChips(won)}`, "chip");
    if (seat.folded) return createPill("Folded");
    return createPill("Showdown");
  }
  if (seat.folded) return createPill("Folded", "danger");
  if (seat.allIn) return createPill("▲ All-in", "chip");
  if (hand.actingSeat === seat.seatNo) {
    const hasTimer = remainingSeconds !== null && remainingSeconds !== undefined;
    const variant = hasTimer && remainingSeconds <= 8 ? "danger" : "brand";
    const pill = createPill(formatTurnStatusLabel(seat.isSelf, remainingSeconds), variant);
    pill.dataset.turnTimerPill = "true";
    pill.dataset.isSelf = seat.isSelf ? "true" : "false";
    return pill;
  }
  return createPill("In hand");
}

/**
 * Updates the active seat's countdown pill and progress bar in-place without rebuilding the felt DOM.
 */
export function updateTurnTimerInPlace(rootEl, remainingSeconds, totalSeconds = 30) {
  if (!rootEl) return;
  const pill = rootEl.querySelector("[data-turn-timer-pill='true']");
  if (pill) {
    const isSelf = pill.dataset.isSelf === "true";
    pill.textContent = formatTurnStatusLabel(isSelf, remainingSeconds);
    const urgent = remainingSeconds !== null && remainingSeconds <= 8;
    pill.className = `pill tabular ${urgent ? "pill--danger" : "pill--brand"}`;
  }
  const barFill = rootEl.querySelector("[data-turn-timer-bar='true']");
  if (barFill) {
    const sec = Math.max(0, Number(remainingSeconds ?? 0));
    const pct = Math.min(100, Math.max(0, Math.round((sec / totalSeconds) * 100)));
    barFill.style.width = `${pct}%`;
    barFill.classList.toggle("seat-timer-bar__fill--urgent", sec <= 8);
    const barTrack = barFill.parentElement;
    if (barTrack) barTrack.setAttribute("aria-valuenow", String(sec));
  }
}

export function createSeatBox(
  seat,
  hand,
  {
    isSelf = false,
    compact = false,
    fullRow = false,
    gridPosition = "",
    myHoleCards = null,
    lastHoleCardsHandId = null,
    remainingSeconds = null,
    animateHoleCards = false,
    animateBet = false
  } = {}
) {
  const isTurn = Boolean(hand?.status === "playing" && hand?.actingSeat === seat.seatNo);
  const isWinner = Boolean(
    hand?.status === "complete" && Number(hand?.payouts?.[seat.seatNo] || 0) > 0
  );
  const isSitout = seat.status === "sitout";
  const isFolded = Boolean(seat.folded);

  const wrap = document.createElement("div");
  wrap.className = [
    "table-seat-card",
    isSelf ? "table-seat-card--self" : "table-seat-card--opp",
    compact ? "table-seat-card--compact" : "",
    fullRow ? "table-seat-card--fullrow" : "",
    isTurn ? "table-seat-card--turn" : "",
    isWinner ? "table-seat-card--winner" : "",
    isFolded ? "table-seat-card--folded" : "",
    isSitout ? "table-seat-card--sitout" : ""
  ]
    .filter(Boolean)
    .join(" ");
  wrap.dataset.seatNo = String(seat.seatNo);
  if (gridPosition) wrap.dataset.gridPos = gridPosition;

  const cardsRow = document.createElement("div");
  cardsRow.className = isSelf ? "table-seat-cards table-seat-cards--self" : "table-seat-cards table-seat-cards--opp";

  const revealed =
    Array.isArray(seat.revealedCards) && seat.revealedCards.length === 2
      ? seat.revealedCards
      : isSelf &&
          Array.isArray(myHoleCards) &&
          myHoleCards.length === 2 &&
          hand?.id === lastHoleCardsHandId
        ? myHoleCards
        : null;

  const isSeatInHand =
    hand &&
    (!seat.folded || hand.status === "playing") &&
    (isSelf || seat.status === "active" || Number(seat.totalCommitted) > 0 || revealed);

  if (hand && revealed) {
    const c1 = createCard(revealed[0]);
    const c2 = createCard(revealed[1]);
    if (!isSelf) {
      c1.classList.add("playing-card--opp-reveal");
      c2.classList.add("playing-card--opp-reveal");
    }
    if (animateHoleCards) {
      c1.classList.add("playing-card--deal");
      c2.classList.add("playing-card--deal", "playing-card--deal-2");
    }
    cardsRow.append(c1, c2);
  } else if (isSeatInHand && !seat.folded) {
    const b1 = createCardBack();
    const b2 = createCardBack();
    if (animateHoleCards) {
      b1.classList.add("playing-card--deal");
      b2.classList.add("playing-card--deal", "playing-card--deal-2");
    }
    cardsRow.append(b1, b2);
  }

  const evalName = hand?.showdown?.hands?.[seat.seatNo]?.name || "";

  let betBadge = null;
  if (hand && Number(seat.bet) > 0) {
    betBadge = document.createElement("span");
    betBadge.className = `table-bet-pill tabular${animateBet ? " chip-move-anim" : ""}`;
    betBadge.textContent = `Bet ${formatChips(seat.bet)}`;
  }

  const plaque = document.createElement("div");
  plaque.className = "table-seat-plaque";

  const topRow = document.createElement("div");
  topRow.className = "table-seat-plaque__top";

  const nameGroup = document.createElement("div");
  nameGroup.className = "table-seat-plaque__name";

  const avatar = document.createElement("span");
  avatar.className = "seat-avatar";
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = extractInitials(seat.displayName || `S${seat.seatNo + 1}`);
  nameGroup.appendChild(avatar);

  if (hand && hand.dealerSeat === seat.seatNo) {
    const dealerBtn = document.createElement("span");
    dealerBtn.className = "seat__dealer";
    dealerBtn.title = "Dealer button";
    dealerBtn.setAttribute("aria-label", "Dealer button");
    dealerBtn.textContent = "D";
    nameGroup.appendChild(dealerBtn);
  }

  const strong = document.createElement("strong");
  strong.textContent = isSelf
    ? `${seat.displayName || "You"} (You)`
    : seat.displayName || `Seat ${seat.seatNo + 1}`;
  nameGroup.appendChild(strong);
  if (!isSelf) buildRoleBadges(seat, hand).forEach((b) => nameGroup.appendChild(b));

  topRow.append(nameGroup, buildSeatStatusPill(seat, hand, remainingSeconds));

  const bottomRow = document.createElement("div");
  bottomRow.className = "table-seat-plaque__bottom";

  const leftMeta = document.createElement("div");
  leftMeta.className = "table-seat-plaque__meta";
  leftMeta.appendChild(
    createChipAmount(seat.stack, { showDisc: true, suffix: "" })
  );
  if (isSelf) buildRoleBadges(seat, hand).forEach((b) => leftMeta.appendChild(b));
  if (betBadge) leftMeta.appendChild(betBadge);
  if (evalName) leftMeta.appendChild(createPill(evalName, "chip"));

  bottomRow.appendChild(leftMeta);

  // Opponent hole cards sit inline inside the pod so seat rows stay ultra-compact and never overlap
  if (!isSelf && cardsRow.childNodes.length > 0) {
    bottomRow.appendChild(cardsRow);
  }

  plaque.append(topRow, bottomRow);

  if (isTurn && remainingSeconds !== null && remainingSeconds !== undefined) {
    const totalSec = Math.max(1, Math.round(Number(hand?.turnTimeoutMs || 30_000) / 1000));
    const sec = Math.max(0, Number(remainingSeconds));
    const pct = Math.min(100, Math.max(0, Math.round((sec / totalSec) * 100)));

    const barTrack = document.createElement("div");
    barTrack.className = "seat-timer-bar";
    barTrack.setAttribute("role", "progressbar");
    barTrack.setAttribute("aria-label", "Turn time remaining");
    barTrack.setAttribute("aria-valuemin", "0");
    barTrack.setAttribute("aria-valuemax", String(totalSec));
    barTrack.setAttribute("aria-valuenow", String(sec));

    const barFill = document.createElement("div");
    barFill.className = `seat-timer-bar__fill${sec <= 8 ? " seat-timer-bar__fill--urgent" : ""}`;
    barFill.dataset.turnTimerBar = "true";
    barFill.style.width = `${pct}%`;

    barTrack.appendChild(barFill);
    plaque.appendChild(barTrack);
  }

  if (isSelf) {
    if (cardsRow.childNodes.length > 0) wrap.appendChild(cardsRow);
    wrap.appendChild(plaque);
  } else {
    wrap.appendChild(plaque);
  }

  return wrap;
}

export function renderHandHistoryList(listEl, panelEl, historyEntries = [], emptyEl = null, openBtnEl = null) {
  const count = Array.isArray(historyEntries) ? historyEntries.length : 0;
  if (openBtnEl) {
    openBtnEl.textContent = count > 0 ? `Recent hands (${count})` : "Recent hands";
  }
  if (!listEl) return;
  if (count === 0) {
    listEl.hidden = true;
    listEl.replaceChildren();
    if (emptyEl) emptyEl.hidden = false;
    return;
  }
  if (emptyEl) emptyEl.hidden = true;
  listEl.hidden = false;
  listEl.replaceChildren();

  historyEntries.forEach((item) => {
    const li = document.createElement("li");
    li.className = "hand-history-row";

    const top = document.createElement("div");
    top.className = "hand-history-row__top";
    const title = document.createElement("strong");
    title.textContent = `Hand #${item.handNo} · ${item.headline}`;
    const potPill = createPill(`Pot ${formatChips(item.pot)}`, "chip");
    top.append(title, potPill);

    const sub = document.createElement("div");
    sub.className = "hand-history-row__sub";
    const detailSpan = document.createElement("span");
    detailSpan.textContent = item.detail || "";
    sub.appendChild(detailSpan);

    if (Array.isArray(item.board) && item.board.length > 0) {
      const boardWrap = document.createElement("div");
      boardWrap.className = "hand-history-row__board";
      item.board.forEach((c) => {
        const cardEl = createCard(c);
        cardEl.classList.add("playing-card--mini");
        boardWrap.appendChild(cardEl);
      });
      sub.appendChild(boardWrap);
    }

    li.append(top, sub);
    listEl.appendChild(li);
  });
}

export function renderTableFelt({
  els,
  currentTable,
  myHoleCards,
  lastHoleCardsHandId,
  getBalance,
  actionBusy,
  remainingSeconds = null
}) {
  if (!currentTable) return;
  const { selfSeat, opponentSeats } = partitionTableSeats(currentTable);
  const hand = currentTable.hand || null;
  const seats = Array.isArray(currentTable.seats) ? currentTable.seats : [];

  const handId = hand?.id || null;
  const isNewHand = Boolean(handId && handId !== animState.handId);
  const prevBoardCount = isNewHand ? 0 : animState.boardCount;
  const board = Array.isArray(hand?.board) ? hand.board : [];
  const animateSelfHole = Boolean(
    handId &&
      Array.isArray(myHoleCards) &&
      myHoleCards.length === 2 &&
      lastHoleCardsHandId === handId &&
      animState.selfHoleHandId !== handId
  );

  // 1. Opponent seats (1 to 5 opponents arranged clockwise around the oval felt)
  els.opponentArea.replaceChildren();
  els.opponentArea.dataset.count = String(opponentSeats.length);

  if (opponentSeats.length > 0) {
    const useCompact = opponentSeats.length >= 2;
    const gridSlots = layoutOpponentSeatsForGrid(opponentSeats);
    gridSlots.forEach(({ seat: oppSeat, position, fullRow }) => {
      const prevBet = isNewHand ? 0 : Number(animState.betsBySeat.get(oppSeat.seatNo) || 0);
      const animateBet = Number(oppSeat.bet || 0) > prevBet;
      els.opponentArea.appendChild(
        createSeatBox(oppSeat, hand, {
          isSelf: false,
          compact: useCompact,
          fullRow,
          gridPosition: position,
          myHoleCards,
          lastHoleCardsHandId,
          remainingSeconds,
          animateHoleCards: isNewHand || Boolean(hand?.status === "complete" && oppSeat.revealedCards),
          animateBet
        })
      );
    });
  } else {
    const emptyBox = document.createElement("div");
    emptyBox.className = "table-seat-empty";
    emptyBox.dataset.gridPos = "top-center";
    const title = document.createElement("strong");
    title.textContent = "Waiting for players to join";
    const sub = document.createElement("span");
    sub.textContent = `Share code ${currentTable.code} (${currentTable.maxSeats || 6}-max).`;
    emptyBox.append(title, sub);
    els.opponentArea.appendChild(emptyBox);
  }

  // 2. Self seat (always bottom centre, side-by-side with hole cards)
  els.selfArea.replaceChildren();
  if (selfSeat) {
    els.sitDownForm.hidden = true;
    const prevSelfBet = isNewHand ? 0 : Number(animState.betsBySeat.get(selfSeat.seatNo) || 0);
    const animateSelfBet = Number(selfSeat.bet || 0) > prevSelfBet;
    els.selfArea.appendChild(
      createSeatBox(selfSeat, hand, {
        isSelf: true,
        compact: false,
        gridPosition: "self",
        myHoleCards,
        lastHoleCardsHandId,
        remainingSeconds,
        animateHoleCards: isNewHand || animateSelfHole,
        animateBet: animateSelfBet
      })
    );
  } else {
    els.sitDownForm.hidden = currentTable.status === "closed";
    const minB = currentTable.minBuyIn || 400;
    const maxB = currentTable.maxBuyIn || 2000;
    els.sitDownBuyInInput.min = String(minB);
    els.sitDownBuyInInput.max = String(maxB);
    if (!els.sitDownBuyInInput.value) {
      const suggested = Math.min(maxB, Math.max(minB, Math.min(getBalance() || 500, 500)));
      els.sitDownBuyInInput.value = String(suggested);
    }
  }

  // 3. Pot & Side Pots (during play and at showdown)
  const pot = hand ? Number(hand.pot || 0) : 0;
  const potIncreased = hand && (!isNewHand ? pot > animState.pot : pot > 0);
  els.potAmount.textContent = `Pot: ${formatChips(pot)} chips`;
  if (els.potAmount.parentElement) {
    els.potAmount.parentElement.classList.toggle("chip-move-anim", Boolean(potIncreased));
  }

  els.sidePotsRow.replaceChildren();
  const showdownSummary = summarizeShowdown(currentTable);
  const potsList = hand?.showdown?.pots?.length > 1 ? hand.showdown.pots : hand?.pots || [];
  if (hand && Array.isArray(potsList) && potsList.length > 1) {
    potsList.forEach((p, idx) => {
      const prefix = idx === 0 ? "Main" : `Side ${idx}`;
      let winnerSuffix = "";
      if (Array.isArray(p.winners) && p.winners.length > 0) {
        const names = p.winners.map((sNo) => {
          const s = seats.find((item) => item.seatNo === sNo);
          return s?.isSelf ? "You" : s?.displayName || `S${sNo + 1}`;
        });
        winnerSuffix = ` → ${names.join("/")}`;
      }
      els.sidePotsRow.appendChild(
        createPill(`${prefix}: ${formatChips(p.amount)}${winnerSuffix}`, "chip")
      );
    });
    els.sidePotsRow.hidden = false;
  } else {
    els.sidePotsRow.hidden = true;
  }

  // 4. Community Board (animate newly dealt cards, respecting prefers-reduced-motion)
  els.boardRow.replaceChildren();
  for (let i = 0; i < 5; i += 1) {
    if (board[i]) {
      const cardEl = createCard(board[i]);
      if (i >= prevBoardCount) {
        cardEl.classList.add("playing-card--deal");
        const stepIdx = Math.min(2, Math.max(0, i - prevBoardCount));
        if (stepIdx === 1) cardEl.classList.add("playing-card--deal-2");
        if (stepIdx === 2) cardEl.classList.add("playing-card--deal-3");
      }
      els.boardRow.appendChild(cardEl);
    } else {
      const slot = document.createElement("div");
      slot.className = "card-slot-empty";
      slot.setAttribute("aria-hidden", "true");
      els.boardRow.appendChild(slot);
    }
  }

  // 5. Status / Showdown Banner
  const status = describeHandStatus(currentTable);
  els.statusHeadline.textContent = status.headline;
  els.statusDetail.textContent = status.detail ? ` · ${status.detail}` : "";
  const statusBanner = els.statusHeadline.parentElement;
  if (statusBanner) {
    statusBanner.classList.toggle("table-status-banner--turn", Boolean(status.isMyTurn));
    statusBanner.classList.toggle("table-status-banner--showdown", Boolean(showdownSummary));
  }

  // 6. Deal / Sit-in / Sit-out / Close Table controls (docked in action bar + drawer)
  const activeWithChips = seats.filter((s) => s.status === "active" && Number(s.stack) > 0);
  const handPlaying = Boolean(hand && hand.status === "playing");
  const canDeal =
    activeWithChips.length >= 2 &&
    !handPlaying &&
    Boolean(selfSeat && selfSeat.status === "active") &&
    currentTable.status !== "closed";

  els.dealBtnWrap.hidden = !canDeal;
  if (canDeal) {
    els.dealBtn.textContent = hand ? `Deal hand #${Number(hand.handNo || 0) + 1}` : "Deal hand #1";
    els.dealBtn.disabled = actionBusy;
  }

  const isSelfSitout = Boolean(selfSeat && selfSeat.status === "sitout" && currentTable.status !== "closed");
  if (els.sitOutBanner) els.sitOutBanner.hidden = !isSelfSitout;
  if (els.sitInBtn) {
    els.sitInBtn.hidden = !isSelfSitout;
    els.sitInBtn.disabled = actionBusy;
  }
  if (els.sitOutToggleBtn) {
    const canToggleSit = Boolean(selfSeat && currentTable.status !== "closed");
    els.sitOutToggleBtn.hidden = !canToggleSit;
    els.sitOutToggleBtn.disabled = actionBusy;
    els.sitOutToggleBtn.textContent = isSelfSitout ? "Sit back in" : "Sit out";
  }

  if (els.closeTableBtn) {
    const canClose = Boolean(
      currentTable.isHost && seats.length === 0 && !handPlaying && currentTable.status !== "closed"
    );
    els.closeTableBtn.hidden = !canClose;
    els.closeTableBtn.disabled = actionBusy;
  }

  // Update animation state snapshot
  animState.handId = handId;
  animState.boardCount = board.length;
  if (animateSelfHole) animState.selfHoleHandId = handId;
  animState.pot = pot;
  animState.betsBySeat.clear();
  seats.forEach((s) => animState.betsBySeat.set(s.seatNo, Number(s.bet || 0)));
}
