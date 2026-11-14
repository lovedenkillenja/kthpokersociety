// Pure DOM rendering builders for the 2–6 player oval felt table (`#view-table`).
// Separated from `table-view.js` to keep each UI module well under 600 lines.

import { formatChips } from "../lib/format.js";
import {
  partitionTableSeats,
  describeHandStatus,
  summarizeShowdown,
  getDisplayPots
} from "../lib/table-helpers.js";
import { assignSeatSlots, getSeatSlots, betDirection, clampSeatTotal } from "../lib/table-layout.js";
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

/** Writes the position of a seat for both table shapes (portrait stadium / phone-landscape oval / desktop oval) as CSS custom properties. */
function setSlotVars(el, slotIndex, total) {
  [["p", "portrait"], ["w", "wide"], ["d", "desktop"]].forEach(([key, shape]) => {
    const pos = getSeatSlots(total, shape)[slotIndex];
    if (!pos) return;
    el.style.setProperty(`--sx-${key}`, `${pos[0]}%`);
    el.style.setProperty(`--sy-${key}`, `${pos[1]}%`);
  });
}

/** Quiet placeholder for a seat nobody has taken yet. */
export function createEmptySeat(slotIndex, total) {
  const el = document.createElement("div");
  el.className = "table-seat-card table-seat-card--empty";
  el.dataset.slot = String(slotIndex);
  const box = document.createElement("div");
  box.className = "table-seat-empty";
  box.textContent = "Open seat";
  el.appendChild(box);
  setSlotVars(el, slotIndex, total);
  return el;
}

/** Flat chip disc + amount. Placed beside its seat, on the side facing the pot (see betDirection). */
export function createBetChip(seat, slotIndex, total, animate = false) {
  const el = document.createElement("div");
  el.className = `table-bet tabular${animate ? " chip-move-anim" : ""}`;
  const pos = getSeatSlots(total, "portrait")[slotIndex] || [50, 50];
  el.dataset.dir = betDirection(pos);
  el.dataset.row = pos[1] < 45 ? "upper" : "lower";
  // 6-max on a phone: the top-centre chip would collide with the upper side seats' chips, so it sits to the right
  if (total === 6 && slotIndex === 3) el.dataset.pdir = "right";
  el.setAttribute("role", "img");
  const who = seat.isSelf ? "Your" : `${seat.displayName || `Seat ${seat.seatNo + 1}`}'s`;
  el.setAttribute("aria-label", `${who} bet: ${formatChips(seat.bet)} chips`);
  const disc = document.createElement("span");
  disc.className = "chip-disc";
  disc.setAttribute("aria-hidden", "true");
  const amt = document.createElement("span");
  amt.className = "table-bet__amount";
  amt.textContent = formatChips(seat.bet);
  el.append(disc, amt);
  return el;
}

/** Top plaque corner for the dealer button (set in CSS, mostly outside the plaque): the pot-facing side, clear of the bet chip. */
export function dealerCorner(dir, slotIndex, total) {
  if (dir === "left") return "left";
  if (dir === "down" && total === 6 && slotIndex === 3) return "left"; // phones: this chip sits to the right
  return "right";
}

export function createSeatBox(
  seat,
  hand,
  {
    isSelf = false,
    slotIndex = null,
    slotTotal = 6,
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
    isTurn ? "table-seat-card--turn" : "",
    isWinner ? "table-seat-card--winner" : "",
    isFolded ? "table-seat-card--folded" : "",
    isSitout ? "table-seat-card--sitout" : ""
  ]
    .filter(Boolean)
    .join(" ");
  wrap.dataset.seatNo = String(seat.seatNo);
  if (slotIndex !== null) {
    wrap.dataset.slot = String(slotIndex);
    setSlotVars(wrap, slotIndex, slotTotal);
  }

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

  const evalName = hand?.status === "complete" ? hand?.showdown?.hands?.[seat.seatNo]?.name || "" : "";

  const plaque = document.createElement("div");
  plaque.className = "table-seat-plaque";

  const nameRow = document.createElement("div");
  nameRow.className = "table-seat-plaque__name";
  const strong = document.createElement("strong");
  const fullName = seat.displayName || (isSelf ? "You" : `Seat ${seat.seatNo + 1}`);
  strong.textContent = fullName;
  strong.title = fullName;
  nameRow.appendChild(strong);
  if (isSelf) {
    const you = document.createElement("span");
    you.className = "seat-you-tag";
    you.textContent = "You";
    nameRow.appendChild(you);
  }

  const stackRow = document.createElement("div");
  stackRow.className = "table-seat-plaque__meta";
  stackRow.appendChild(createChipAmount(seat.stack, { showDisc: true, suffix: "" }));
  if (hand?.status !== "complete") buildRoleBadges(seat, hand).forEach((b) => stackRow.appendChild(b));

  // Routine states ("In hand", "Ready") add noise; only show a status when it tells the player something
  const statusPill = buildSeatStatusPill(seat, hand, remainingSeconds);
  if (!["In hand", "Ready"].includes(statusPill.textContent)) stackRow.appendChild(statusPill);
  plaque.append(nameRow, stackRow);

  if (evalName) {
    const hn = document.createElement("div");
    hn.className = "table-seat-handname";
    hn.textContent = evalName;
    plaque.appendChild(hn);
  }

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

  if (cardsRow.childNodes.length > 0) wrap.appendChild(cardsRow);
  wrap.appendChild(plaque);

  if (slotIndex !== null) wrap.dataset.dir = betDirection(getSeatSlots(slotTotal, "portrait")[slotIndex] || [50, 50]);
  if (hand && Number(seat.bet) > 0) wrap.appendChild(createBetChip(seat, slotIndex ?? 0, slotTotal, animateBet));

  if (hand && hand.dealerSeat === seat.seatNo) {
    const dealerBtn = document.createElement("span");
    dealerBtn.className = "seat__dealer table-dealer";
    dealerBtn.title = "Dealer button";
    dealerBtn.setAttribute("aria-label", "Dealer button");
    dealerBtn.textContent = "D";
    // Lives on the plaque corner (see table.css) so it can never sit on another seat's cards or the bet chip
    dealerBtn.dataset.corner = dealerCorner(wrap.dataset.dir, slotIndex, slotTotal);
    plaque.appendChild(dealerBtn);
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

  // 1. Seats around the felt: opponents, open seats and bets between each seat and the pot
  const slotTotal = clampSeatTotal(currentTable.maxSeats);
  const { slotBySeat, openSlots } = assignSeatSlots({
    seatNos: seats.map((s) => s.seatNo),
    selfSeatNo: selfSeat ? selfSeat.seatNo : null,
    maxSeats: slotTotal
  });
  els.opponentArea.replaceChildren();
  els.opponentArea.dataset.count = String(opponentSeats.length);
  els.opponentArea.dataset.total = String(slotTotal);

  opponentSeats.forEach((oppSeat) => {
    const slot = slotBySeat.get(oppSeat.seatNo);
    if (slot === undefined) return;
    els.opponentArea.appendChild(
      createSeatBox(oppSeat, hand, {
        isSelf: false,
        slotIndex: slot,
        slotTotal,
        myHoleCards,
        lastHoleCardsHandId,
        remainingSeconds,
        animateHoleCards: isNewHand || Boolean(hand?.status === "complete" && oppSeat.revealedCards),
        animateBet: Number(oppSeat.bet || 0) > (isNewHand ? 0 : Number(animState.betsBySeat.get(oppSeat.seatNo) || 0))
      })
    );
  });
  openSlots.forEach((slot) => els.opponentArea.appendChild(createEmptySeat(slot, slotTotal)));

  // 2. Self seat (always bottom centre, hole cards tucked behind the plaque)
  els.selfArea.replaceChildren();
  if (selfSeat) {
    els.sitDownForm.hidden = true;
    els.selfArea.appendChild(
      createSeatBox(selfSeat, hand, {
        isSelf: true,
        slotIndex: 0,
        slotTotal,
        myHoleCards,
        lastHoleCardsHandId,
        remainingSeconds,
        animateHoleCards: isNewHand || animateSelfHole,
        animateBet: Number(selfSeat.bet || 0) > (isNewHand ? 0 : Number(animState.betsBySeat.get(selfSeat.seatNo) || 0))
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

  // 3. Pot & side pots: hidden until a hand is running; breakdown only when it tells the players something
  const pot = hand ? Number(hand.pot || 0) : 0;
  const potIncreased = hand && (!isNewHand ? pot > animState.pot : pot > 0);
  els.potAmount.textContent = formatChips(pot);
  const potBox = els.potAmount.closest(".table-pot-box");
  if (potBox) potBox.hidden = !(hand && pot > 0);
  if (els.potAmount.parentElement) {
    els.potAmount.parentElement.classList.toggle("chip-move-anim", Boolean(potIncreased));
  }

  els.sidePotsRow.replaceChildren();
  const showdownSummary = summarizeShowdown(currentTable);
  const potsList = getDisplayPots(hand, seats);
  if (potsList.length > 1) {
    potsList.forEach((p, idx) => {
      const prefix = idx === 0 ? "Main" : `Side ${idx}`;
      let winnerSuffix = "";
      if (hand.status === "complete" && Array.isArray(p.winners) && p.winners.length > 0) {
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
  // The pot is already shown in the centre, so a "Pot N chips" detail would only repeat it
  const statusDetail = /^Pot [\d,.\s]+chips?$/i.test(status.detail || "") ? "" : status.detail;
  els.statusDetail.textContent = statusDetail ? ` · ${statusDetail}` : "";
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
