// Reusable UI primitives per docs/poker/STYLE_GUIDE.md.
// Uses safe DOM construction (`textContent`) so user display names can never inject HTML.

import { formatChips, formatDelta, formatLedgerSource } from "../lib/format.js";

const SUIT_META = Object.freeze({
  s: { symbol: "♠", label: "spades", red: false },
  c: { symbol: "♣", label: "clubs", red: false },
  h: { symbol: "♥", label: "hearts", red: true },
  d: { symbol: "♦", label: "diamonds", red: true }
});

/**
 * Creates a Button element (`primary`, `ghost`, or `danger`).
 */
export function createButton({
  label,
  variant = "primary",
  type = "button",
  fullWidth = false,
  disabled = false,
  onClick = null
}) {
  const btn = document.createElement("button");
  btn.type = type;
  btn.className = `btn btn--${variant}${fullWidth ? " btn--full" : ""}`;
  btn.textContent = label;
  btn.disabled = Boolean(disabled);
  if (typeof onClick === "function") {
    btn.addEventListener("click", onClick);
  }
  return btn;
}

/**
 * Creates a Pill badge (`default`, `brand`, `chip`, `danger`).
 */
export function createPill(text, variant = "default") {
  const span = document.createElement("span");
  span.className = variant && variant !== "default" ? `pill pill--${variant}` : "pill";
  span.textContent = text;
  return span;
}

/**
 * Creates a ChipAmount display with a flat chip disc and tabular numerals.
 */
export function createChipAmount(amount, { showDisc = true, suffix = "chips" } = {}) {
  const wrap = document.createElement("span");
  wrap.className = "chip-amount tabular";

  if (showDisc) {
    const disc = document.createElement("span");
    disc.className = "chip-disc";
    disc.setAttribute("aria-hidden", "true");
    wrap.appendChild(disc);
  }

  const num = document.createElement("span");
  num.textContent = suffix ? `${formatChips(amount)} ${suffix}` : formatChips(amount);
  wrap.appendChild(num);
  return wrap;
}

/**
 * Creates a CSS/SVG playing card (`As`, `Kh`, `Td`, `9c`).
 */
export function createCard(cardCode = "As") {
  const code = String(cardCode || "As").trim();
  const suitKey = code.slice(-1).toLowerCase();
  const rankRaw = code.slice(0, -1).toUpperCase();
  const rank = rankRaw === "T" ? "10" : rankRaw || "A";
  const suit = SUIT_META[suitKey] || SUIT_META.s;

  const card = document.createElement("div");
  card.className = `playing-card${suit.red ? " playing-card--red" : ""}`;
  card.setAttribute("role", "img");
  card.setAttribute("aria-label", `${rank} of ${suit.label}`);

  const rankEl = document.createElement("span");
  rankEl.className = "playing-card__rank";
  rankEl.setAttribute("aria-hidden", "true");
  rankEl.textContent = rank;

  const suitEl = document.createElement("span");
  suitEl.className = "playing-card__suit";
  suitEl.setAttribute("aria-hidden", "true");
  suitEl.textContent = suit.symbol;

  card.append(rankEl, suitEl);
  return card;
}

/**
 * Creates a face-down card back (`--brand` with diagonal line pattern).
 */
export function createCardBack() {
  const card = document.createElement("div");
  card.className = "playing-card playing-card--back";
  card.setAttribute("role", "img");
  card.setAttribute("aria-label", "Face-down playing card");
  return card;
}

/**
 * Creates a Seat badge (used around the oval felt table in M4+).
 */
export function createSeat({ displayName, stack = 0, status = "", isDealer = false }) {
  const el = document.createElement("div");
  el.className = "seat";

  if (isDealer) {
    const d = document.createElement("span");
    d.className = "seat__dealer";
    d.title = "Dealer button";
    d.textContent = "D";
    el.appendChild(d);
  }

  const name = document.createElement("strong");
  name.textContent = displayName || "Empty seat";
  el.appendChild(name);

  el.appendChild(createChipAmount(stack, { showDisc: false, suffix: "" }));

  if (status) {
    el.appendChild(createPill(status));
  }
  return el;
}

/**
 * Creates a Leaderboard row (`<li>`) with rank, display name, optional "You" pill, and tabular chip balance.
 */
export function createLeaderboardRow({ rank, displayName, balance, isCurrentUser = false }) {
  const li = document.createElement("li");
  li.className = `leaderboard-row${isCurrentUser ? " leaderboard-row--self" : ""}`;

  const rankEl = document.createElement("span");
  rankEl.className = "leaderboard-rank tabular";
  rankEl.textContent = `#${rank}`;

  const nameWrap = document.createElement("div");
  nameWrap.className = "leaderboard-name";

  const nameText = document.createElement("span");
  nameText.className = "leaderboard-name__text";
  nameText.textContent = displayName;
  nameWrap.appendChild(nameText);

  if (isCurrentUser) {
    nameWrap.appendChild(createPill("You", "brand"));
  }

  const amountEl = createChipAmount(balance, { showDisc: true, suffix: "chips" });

  li.append(rankEl, nameWrap, amountEl);
  return li;
}

/**
 * Creates a recent `chip_ledger` row (`<li>`) showing reason, source pill, date, and signed delta.
 */
export function createLedgerRow(row) {
  const li = document.createElement("li");
  li.className = "ledger-row";

  const left = document.createElement("div");
  const title = document.createElement("div");
  title.className = "ledger-row__title";
  title.textContent = row.reason || "Chip update";

  const meta = document.createElement("div");
  meta.className = "ledger-row__meta";
  meta.appendChild(createPill(formatLedgerSource(row.source)));

  if (row.created_at) {
    const timeEl = document.createElement("time");
    timeEl.dateTime = row.created_at;
    const d = new Date(row.created_at);
    timeEl.textContent = Number.isNaN(d.getTime())
      ? ""
      : d.toLocaleDateString("en-SE", {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit"
        });
    meta.appendChild(timeEl);
  }

  left.append(title, meta);

  const deltaEl = document.createElement("span");
  const deltaNum = Number(row.delta || 0);
  deltaEl.className = `ledger-row__delta tabular${deltaNum < 0 ? " ledger-row__delta--neg" : ""}`;
  deltaEl.textContent = `${formatDelta(deltaNum)} chips`;

  li.append(left, deltaEl);
  return li;
}

/**
 * Creates an Empty State box with heading, description, and optional action button.
 */
export function createEmptyState({ title, message, actionButton = null }) {
  const box = document.createElement("div");
  box.className = "empty-state";

  if (title) {
    const h3 = document.createElement("h3");
    h3.textContent = title;
    box.appendChild(h3);
  }
  if (message) {
    const p = document.createElement("p");
    p.textContent = message;
    box.appendChild(p);
  }
  if (actionButton) {
    box.appendChild(actionButton);
  }
  return box;
}

/**
 * Shows a temporary toast notification and announces it via the polite live region.
 */
export function showToast(message, { variant = "default", durationMs = 4200 } = {}) {
  const live = document.getElementById("live-announcer");
  if (live) {
    live.textContent = message;
  }

  const region = document.getElementById("toast-region");
  if (!region) return;

  const toast = document.createElement("div");
  toast.className = `toast${variant === "error" ? " toast--error" : ""}`;
  toast.setAttribute("role", "status");

  const text = document.createElement("span");
  text.textContent = message;
  toast.appendChild(text);

  region.appendChild(toast);

  window.setTimeout(() => {
    toast.remove();
  }, durationMs);
}

/**
 * Wires backdrop-click and close buttons on a native `<dialog>` element.
 */
export function wireDialog(dialogEl, onClose = null) {
  if (!dialogEl) return;
  dialogEl.addEventListener("click", (e) => {
    if (e.target === dialogEl) {
      dialogEl.close();
    }
  });
  dialogEl.querySelectorAll("[data-close-dialog]").forEach((btn) => {
    btn.addEventListener("click", () => dialogEl.close());
  });
  if (typeof onClose === "function") {
    dialogEl.addEventListener("close", onClose);
  }
}
