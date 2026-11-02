// Pure DOM rendering builders for the 2–6 player oval felt table (`#view-table`).
// Separated from `table-view.js` to keep each UI module well under 600 lines.

import { formatChips } from "../lib/format.js";
import { partitionTableSeats, describeHandStatus } from "../lib/table-helpers.js";
import {
  createCard,
  createCardBack,
  createPill,
  createChipAmount
} from "./components.js";

function buildRoleBadges(seat, hand) {
  const pills = [];
  if (!hand) return pills;
  if (hand.sbSeat === seat.seatNo) pills.push(createPill("SB"));
  if (hand.bbSeat === seat.seatNo) pills.push(createPill("BB"));
  return pills;
}

function buildSeatStatusPill(seat, hand, remainingSeconds = null) {
  if (seat.status === "sitout" && (!hand || hand.status !== "playing" || seat.folded)) {
    return createPill("Sitting out", "danger");
  }
  if (!hand) {
    return createPill("Ready");
  }
  if (hand.status === "complete") {
    const won = Number(hand.payouts?.[seat.seatNo] || 0);
    if (won > 0) return createPill(`Won +${formatChips(won)}`, "chip");
    if (seat.folded) return createPill("Folded");
    return createPill("Complete");
  }
  if (seat.folded) return createPill("Folded", "danger");
  if (seat.allIn) return createPill("All-in", "chip");
  if (hand.actingSeat === seat.seatNo) {
    const hasTimer = remainingSeconds !== null && remainingSeconds !== undefined;
    const label = seat.isSelf
      ? hasTimer
        ? `Your turn · ${remainingSeconds}s`
        : "Your turn"
      : hasTimer
        ? `Acting · ${remainingSeconds}s`
        : "Thinking…";
    const variant = hasTimer && remainingSeconds <= 8 ? "danger" : "brand";
    return createPill(label, variant);
  }
  return createPill("In hand");
}

export function createSeatBox(
  seat,
  hand,
  {
    isSelf = false,
    compact = false,
    myHoleCards = null,
    lastHoleCardsHandId = null,
    remainingSeconds = null
  } = {}
) {
  const wrap = document.createElement("div");
  wrap.className = `table-seat-card${compact ? " table-seat-card--compact" : ""}${
    hand?.status === "playing" && hand?.actingSeat === seat.seatNo ? " table-seat-card--turn" : ""
  }${seat.folded || seat.status === "sitout" ? " table-seat-card--folded" : ""}`;

  const cardsRow = document.createElement("div");
  cardsRow.className = "table-seat-cards";

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
    cardsRow.append(createCard(revealed[0]), createCard(revealed[1]));
  } else if (isSeatInHand && !seat.folded) {
    cardsRow.append(createCardBack(), createCardBack());
  }

  const evalName = hand?.showdown?.hands?.[seat.seatNo]?.name || "";

  let betBadge = null;
  if (hand && Number(seat.bet) > 0) {
    betBadge = document.createElement("div");
    betBadge.className = "table-bet-pill tabular";
    betBadge.appendChild(createChipAmount(seat.bet, { showDisc: true, suffix: "" }));
    betBadge.lastChild.textContent = `Bet ${formatChips(seat.bet)}`;
  }

  const plaque = document.createElement("div");
  plaque.className = "table-seat-plaque";

  const topRow = document.createElement("div");
  topRow.className = "table-seat-plaque__top";

  const nameGroup = document.createElement("div");
  nameGroup.className = "table-seat-plaque__name";

  if (hand && hand.dealerSeat === seat.seatNo) {
    const dealerBtn = document.createElement("span");
    dealerBtn.className = "seat__dealer";
    dealerBtn.title = "Dealer button";
    dealerBtn.setAttribute("aria-label", "Dealer button");
    dealerBtn.textContent = "D";
    nameGroup.appendChild(dealerBtn);
  }

  const strong = document.createElement("strong");
  strong.textContent = seat.displayName || `Seat ${seat.seatNo + 1}`;
  nameGroup.appendChild(strong);

  if (isSelf) nameGroup.appendChild(createPill("You", "brand"));
  buildRoleBadges(seat, hand).forEach((b) => nameGroup.appendChild(b));

  topRow.append(nameGroup, buildSeatStatusPill(seat, hand, remainingSeconds));

  const bottomRow = document.createElement("div");
  bottomRow.className = "table-seat-plaque__bottom";
  bottomRow.appendChild(createChipAmount(seat.stack, { showDisc: true, suffix: "chips" }));

  if (evalName) bottomRow.appendChild(createPill(evalName, "chip"));

  plaque.append(topRow, bottomRow);

  if (isSelf) {
    if (betBadge) wrap.appendChild(betBadge);
    if (cardsRow.childNodes.length > 0) wrap.appendChild(cardsRow);
    wrap.appendChild(plaque);
  } else {
    wrap.appendChild(plaque);
    if (cardsRow.childNodes.length > 0) wrap.appendChild(cardsRow);
    if (betBadge) wrap.appendChild(betBadge);
  }

  return wrap;
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

  // 1. Opponent seats (1 to 5 opponents arranged clockwise around the upper felt)
  els.opponentArea.replaceChildren();
  els.opponentArea.dataset.count = String(opponentSeats.length);

  if (opponentSeats.length > 0) {
    const useCompact = opponentSeats.length >= 2;
    opponentSeats.forEach((oppSeat) => {
      els.opponentArea.appendChild(
        createSeatBox(oppSeat, hand, {
          isSelf: false,
          compact: useCompact,
          myHoleCards,
          lastHoleCardsHandId,
          remainingSeconds
        })
      );
    });
  } else {
    const emptyBox = document.createElement("div");
    emptyBox.className = "table-seat-empty";
    const title = document.createElement("strong");
    title.textContent = "Waiting for players";
    const sub = document.createElement("span");
    sub.textContent = `Share room code ${currentTable.code} (up to ${currentTable.maxSeats || 6} seats)`;
    emptyBox.append(title, sub);
    els.opponentArea.appendChild(emptyBox);
  }

  // 2. Self seat (always bottom centre)
  els.selfArea.replaceChildren();
  if (selfSeat) {
    els.sitDownForm.hidden = true;
    els.selfArea.appendChild(
      createSeatBox(selfSeat, hand, {
        isSelf: true,
        compact: false,
        myHoleCards,
        lastHoleCardsHandId,
        remainingSeconds
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
  els.potAmount.textContent = `${formatChips(pot)} chips`;

  els.sidePotsRow.replaceChildren();
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

  // 4. Community Board
  els.boardRow.replaceChildren();
  const board = Array.isArray(hand?.board) ? hand.board : [];
  for (let i = 0; i < 5; i += 1) {
    if (board[i]) {
      els.boardRow.appendChild(createCard(board[i]));
    } else {
      const slot = document.createElement("div");
      slot.className = "card-slot-empty";
      slot.setAttribute("aria-hidden", "true");
      els.boardRow.appendChild(slot);
    }
  }

  const status = describeHandStatus(currentTable);
  els.statusHeadline.textContent = status.headline;
  els.statusDetail.textContent = status.detail;

  const activeWithChips = seats.filter(
    (s) => s.status === "active" && Number(s.stack) > 0
  );
  const handPlaying = hand && hand.status === "playing";
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

  if (els.sitInBtn) {
    const showSitIn = Boolean(selfSeat && selfSeat.status === "sitout" && currentTable.status !== "closed");
    els.sitInBtn.hidden = !showSitIn;
    els.sitInBtn.disabled = actionBusy;
  }

  if (els.closeTableBtn) {
    const canClose = Boolean(
      currentTable.isHost &&
        seats.length === 0 &&
        !handPlaying &&
        currentTable.status !== "closed"
    );
    els.closeTableBtn.hidden = !canClose;
    els.closeTableBtn.disabled = actionBusy;
  }
}
