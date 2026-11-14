// Table motion: deal, fold, chip and pot movement.
//
// Rules (see docs/poker/STYLE_GUIDE.md, "Motion"):
// - The renderer always builds the final state first. Every card and chip is visible and in place in its resting style;
//   animations only run FROM an offset (Web Animations API, `translate`/`rotate`/`scale`/`opacity`, never layout).
// - What moves is decided by diffing the previous and the next table snapshot (`diffSnapshots`, pure and tested).
//   The first snapshot of a table (page load, reconnect, joining a hand in progress) never animates.
// - Nothing here blocks a state update or the action controls. If animations are unsupported, reduced, hidden or
//   interrupted, `settle()` cancels everything and the resting state is what the player sees.

import { createChipStacks } from "./components.js";

const EASE = "cubic-bezier(0.16, 1, 0.3, 1)"; // same curve as --ease-out
const DEAL_STAGGER_MS = 100;
const DEAL_MS = 320;
const BOARD_STAGGER_MS = 110;
const FLIP_MS = 180;
const FOLD_MS = 300;
const CHIP_MS = 320;
const PAYOUT_MS = 400;
const SETTLE_SLACK_MS = 200;

/* ---------------------------------------------------------------- pure part (tested in node) */

/** Reduces a public table state to what the motion diff needs. */
export function makeSnapshot(table, { selfCardsKnown = false } = {}) {
  const hand = table?.hand || null;
  const seats = Array.isArray(table?.seats) ? table.seats : [];
  const bets = {};
  const folded = {};
  const revealed = {};
  let selfSeatNo = null;
  seats.forEach((s) => {
    bets[s.seatNo] = Number(s.bet || 0);
    folded[s.seatNo] = Boolean(s.folded);
    revealed[s.seatNo] = !s.isSelf && Array.isArray(s.revealedCards) && s.revealedCards.length === 2;
    if (s.isSelf) selfSeatNo = s.seatNo;
  });
  const payouts = {};
  if (hand?.payouts && typeof hand.payouts === "object") {
    Object.entries(hand.payouts).forEach(([seatNo, amount]) => {
      if (Number(amount) > 0) payouts[seatNo] = Number(amount);
    });
  }
  return {
    code: table?.code || null,
    handId: hand?.id || null,
    status: hand?.status || null,
    dealerSeat: hand && Number.isFinite(Number(hand.dealerSeat)) ? Number(hand.dealerSeat) : null,
    boardCount: Array.isArray(hand?.board) ? hand.board.length : 0,
    pot: hand ? Number(hand.pot || 0) : 0,
    bets,
    folded,
    revealed,
    payouts,
    selfSeatNo,
    selfCardsKnown: Boolean(selfCardsKnown)
  };
}

/**
 * Compares two snapshots and says what to animate. Returns an object with any of:
 * `deal`, `board {from,to}`, `folds [seatNo]`, `bets [{seatNo, amount}]`, `sweep [{seatNo, amount}]`,
 * `payouts [{seatNo, amount}]`, `reveal [seatNo]`, `flipSelf`. Empty when nothing should move.
 * No previous snapshot (first render, other table) means no events: a hand already in progress never replays.
 */
export function diffSnapshots(prev, next, { dealtHandId = null } = {}) {
  const ev = {};
  if (!prev || !next || prev.code !== next.code || !next.handId) return ev;
  const newHand = prev.handId !== next.handId;
  if (newHand) ev.deal = { dealerSeat: next.dealerSeat };

  if (!newHand && next.boardCount > prev.boardCount) ev.board = { from: prev.boardCount, to: next.boardCount };

  if (!newHand) {
    const folds = Object.keys(next.folded)
      .filter((s) => next.folded[s] && prev.folded[s] === false)
      .map(Number);
    if (folds.length) ev.folds = folds;
  }

  const bets = [];
  Object.keys(next.bets).forEach((s) => {
    const before = newHand ? 0 : Number(prev.bets[s] || 0);
    if (next.bets[s] > before && next.status !== "complete") bets.push({ seatNo: Number(s), amount: next.bets[s] });
  });
  if (bets.length) ev.bets = bets;

  if (!newHand) {
    const sum = (o) => Object.values(o).reduce((n, v) => n + v, 0);
    const completing = prev.status !== "complete" && next.status === "complete";
    if (sum(prev.bets) > 0 && sum(next.bets) === 0) {
      ev.sweep = Object.keys(prev.bets)
        .filter((s) => prev.bets[s] > 0)
        .map((s) => ({ seatNo: Number(s), amount: prev.bets[s] }));
    } else if (completing && sum(next.bets) > 0) {
      // The hand ended with bets still shown in front of the seats: they join the pot before it is paid out
      ev.sweep = Object.keys(next.bets)
        .filter((s) => next.bets[s] > 0)
        .map((s) => ({ seatNo: Number(s), amount: next.bets[s] }));
    }
    if (completing) {
      const payouts = Object.keys(next.payouts).map((s) => ({ seatNo: Number(s), amount: next.payouts[s] }));
      if (payouts.length) ev.payouts = payouts;
    }
    const reveal = Object.keys(next.revealed)
      .filter((s) => next.revealed[s] && prev.revealed[s] === false)
      .map(Number);
    if (reveal.length) ev.reveal = reveal;
    if (!prev.selfCardsKnown && next.selfCardsKnown && dealtHandId === next.handId) ev.flipSelf = true;
  }
  return ev;
}

/** Seats in dealing order: clockwise by seat number, starting with the seat after the dealer. */
export function dealOrder(seatNos, dealerSeat) {
  const sorted = [...seatNos].sort((a, b) => a - b);
  if (!Number.isFinite(dealerSeat)) return sorted;
  const after = sorted.filter((s) => s > dealerSeat);
  const upTo = sorted.filter((s) => s <= dealerSeat);
  return [...after, ...upTo];
}

/* ---------------------------------------------------------------- DOM part */

let prevSnap = null;
let dealtHandId = null;
let runs = []; // { until, replay, start(elapsedMs) } so a re-render mid-animation resumes instead of snapping
let live = new Set(); // running animations created by this module
let settleTimer = null;
let visibilityWired = false;

function motionAllowed() {
  try {
    if (typeof document === "undefined" || typeof Element === "undefined" || !Element.prototype.animate) return false;
    if (document.hidden) return false;
    if (globalThis.matchMedia && globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
    return Boolean(globalThis.CSS?.supports?.("translate", "1px"));
  } catch (_err) {
    return false;
  }
}

/** Cancels every running animation, removes ghosts and temporary classes: the DOM is left in its resting state. */
export function settle() {
  if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
  live.forEach((a) => { try { a.cancel(); } catch (_err) { /* ignore */ } });
  live.clear();
  runs = [];
  if (typeof document !== "undefined") {
    document.querySelectorAll(".motion-ghost").forEach((g) => g.remove());
    document.querySelectorAll(".card-flip-cover").forEach((c) => c.remove());
  }
}

function scheduleSettle(ms) {
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = setTimeout(settle, ms + SETTLE_SLACK_MS);
}

function wireVisibility() {
  if (visibilityWired || typeof document === "undefined") return;
  visibilityWired = true;
  document.addEventListener("visibilitychange", () => { if (document.hidden) settle(); });
}

const centre = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });

function track(a) {
  live.add(a);
  const drop = () => live.delete(a);
  a.addEventListener("finish", drop);
  a.addEventListener("cancel", drop);
  return a;
}

/**
 * Slides an element from an offset (in px, relative to its resting place) to rest. Resting style stays the visible one.
 * A face-up card that is dealt shows a back-pattern cover while it flies; the cover is itself animated (opacity 1 while
 * flying, CSS default 0 otherwise), so it vanishes by itself when the animation ends, is cancelled or is finished.
 * Nothing here relies on an event handler having run.
 */
function flyIn(el, dx, dy, { delay = 0, duration = DEAL_MS, elapsed = 0, flip = false, rotate = -10, scale = 0.6 } = {}) {
  const anims = [
    el.animate(
      [
        { translate: `${dx}px ${dy}px`, rotate: `${rotate}deg`, scale: String(scale), opacity: 0 },
        { opacity: 1, offset: 0.25 },
        { translate: "0px 0px", rotate: "0deg", scale: "1", opacity: 1 }
      ],
      { duration, delay, easing: EASE, fill: "backwards" }
    )
  ];
  if (flip) {
    el.classList.add("playing-card--covered");
    const cover = document.createElement("span");
    cover.className = "card-flip-cover";
    cover.setAttribute("aria-hidden", "true");
    el.appendChild(cover);
    anims.push(cover.animate([{ opacity: 1 }, { opacity: 1 }], { duration, delay, fill: "backwards" }));
    anims.push(el.animate([{ scale: "0.04 1" }, { scale: "1 1" }], { duration: FLIP_MS, delay: delay + duration, easing: EASE }));
  }
  anims.forEach((a) => { track(a); if (elapsed > 0) a.currentTime = elapsed; });
  return anims;
}

function flipOnly(el, { delay = 0, elapsed = 0 } = {}) {
  const a = track(el.animate([{ scale: "0.04 1" }, { scale: "1 1" }], { duration: FLIP_MS + 40, delay, easing: EASE }));
  if (elapsed > 0) a.currentTime = elapsed;
}

function ensureLayer(felt) {
  let layer = felt.querySelector(":scope > .table-motion-layer");
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "table-motion-layer";
    layer.setAttribute("aria-hidden", "true");
    felt.appendChild(layer);
  }
  return layer;
}

/**
 * Call BEFORE the renderer replaces the seats: remembers where cards and bets were, so folded cards and swept bets
 * can leave from the right place. Returns null when there is nothing to animate (first render, reduced motion, ...).
 */
export function captureBefore(els) {
  if (!prevSnap || !motionAllowed()) return null;
  const felt = els.opponentArea?.closest(".poker-felt");
  if (!felt) return null;
  const cards = new Map();
  const bets = new Map();
  felt.querySelectorAll(".table-seat-card[data-seat-no]").forEach((seat) => {
    const n = Number(seat.dataset.seatNo);
    const row = seat.querySelector(".table-seat-cards");
    if (row) cards.set(n, { clone: row.cloneNode(true), rect: row.getBoundingClientRect() });
    const bet = seat.querySelector(".table-bet");
    if (bet) bets.set(n, bet.getBoundingClientRect());
  });
  return { cards, bets };
}

/**
 * Call AFTER the renderer has built the final DOM. Diffs against the previous snapshot, starts the matching
 * animations and resumes any still-running ones on the freshly built elements. Never throws.
 */
export function animateTable(els, snap, before) {
  const prev = prevSnap;
  prevSnap = snap;
  try {
    wireVisibility();
    const felt = els.opponentArea?.closest(".poker-felt");
    if (!felt || !snap) return;
    const events = diffSnapshots(prev, snap, { dealtHandId });
    if (events.deal) dealtHandId = snap.handId;
    if (!motionAllowed()) { settle(); return; }

    const now = performance.now();
    // Resume animations that were running before this re-render (the elements were rebuilt)
    runs = runs.filter((r) => r.until > now);
    runs.forEach((r) => { if (r.replay) r.start(now - r.t0); });

    const fresh = buildRuns(felt, events, before);
    fresh.forEach((r) => { r.t0 = now; r.start(0); runs.push(r); });
    const horizon = runs.reduce((m, r) => Math.max(m, r.until), now);
    if (runs.length) scheduleSettle(horizon - now);
  } catch (err) {
    settle();
    if (typeof console !== "undefined") console.warn("table motion skipped:", err);
  }
}

function buildRuns(felt, events, before) {
  const out = [];
  const layer = ensureLayer(felt);
  const seatEl = (n) => felt.querySelector(`.table-seat-card[data-seat-no="${n}"]`);
  const lr = () => layer.getBoundingClientRect();
  const feltCentre = () => centre(felt.getBoundingClientRect());
  const potCentre = () => {
    const box = felt.querySelector(".table-pot-box:not([hidden])");
    return box ? centre(box.getBoundingClientRect()) : feltCentre();
  };
  const hasDeal = Boolean(events.deal);

  // Ghosts are decorative copies that fly across the felt and remove themselves (settle() also removes them).
  const ghostFlight = (el, from, to, { delay, duration, rotate = 0, fadeAt = 0.6 }) => {
    const base = lr();
    el.classList.add("motion-ghost");
    layer.appendChild(el);
    const r = el.getBoundingClientRect();
    const off = (p) => ({ x: p.x - r.width / 2, y: p.y - r.height / 2 });
    const a0 = off(from);
    const a1 = off(to);
    const t = (p) => `${p.x - base.left}px ${p.y - base.top}px`;
    const anim = track(
      el.animate(
        [
          { translate: t(a0), rotate: "0deg", opacity: 1 },
          { opacity: 1, offset: fadeAt },
          { translate: t(a1), rotate: `${rotate}deg`, opacity: 0 }
        ],
        { duration, delay, easing: EASE, fill: "both" }
      )
    );
    anim.addEventListener("finish", () => el.remove());
    anim.addEventListener("cancel", () => el.remove());
  };

  if (hasDeal) {
    const dealerSeat = events.deal.dealerSeat;
    out.push({
      kind: "deal",
      replay: true,
      until: performance.now() + 14 * DEAL_STAGGER_MS + DEAL_MS + FLIP_MS + 150,
      start(elapsed) {
        const rows = [...felt.querySelectorAll(".table-seat-card[data-seat-no] .table-seat-cards")];
        const bySeat = new Map(rows.map((row) => [Number(row.closest(".table-seat-card").dataset.seatNo), row]));
        const order = dealOrder([...bySeat.keys()], dealerSeat);
        const btn = felt.querySelector(".table-dealer");
        const src = btn ? centre(btn.getBoundingClientRect()) : feltCentre();
        for (let round = 0; round < 2; round += 1) {
          order.forEach((seatNo, i) => {
            const card = bySeat.get(seatNo)?.children[round];
            if (!card) return;
            const c = centre(card.getBoundingClientRect());
            flyIn(card, src.x - c.x, src.y - c.y, {
              delay: (round * order.length + i) * DEAL_STAGGER_MS,
              elapsed,
              flip: !card.classList.contains("playing-card--back"),
              rotate: round ? 8 : -8
            });
          });
        }
      }
    });
    // Blinds are posted with the deal: the run's `until` above is the upper bound for a full table
  }

  if (events.board) {
    const { from, to } = events.board;
    out.push({
      kind: "board",
      replay: true,
      until: performance.now() + (to - from) * BOARD_STAGGER_MS + DEAL_MS + FLIP_MS + 100,
      start(elapsed) {
        const row = felt.querySelector(".table-board-row");
        if (!row) return;
        const rc = centre(row.getBoundingClientRect());
        for (let i = from; i < to; i += 1) {
          const card = row.children[i];
          if (!card || card.classList.contains("card-slot-empty")) continue;
          const c = centre(card.getBoundingClientRect());
          flyIn(card, rc.x - c.x, rc.y - c.y - 24, {
            delay: (i - from) * BOARD_STAGGER_MS,
            elapsed,
            flip: true,
            rotate: 0,
            scale: 0.7
          });
        }
      }
    });
  }

  if (events.bets) {
    events.bets.forEach(({ seatNo }) => {
      out.push({
        kind: "bet",
        replay: true,
        until: performance.now() + CHIP_MS + 100,
        start(elapsed) {
          const seat = seatEl(seatNo);
          const bet = seat?.querySelector(".table-bet");
          const plaque = seat?.querySelector(".table-seat-plaque");
          if (!bet || !plaque) return;
          const b = centre(bet.getBoundingClientRect());
          const p = centre(plaque.getBoundingClientRect());
          const a = track(
            bet.animate(
              [
                { translate: `${p.x - b.x}px ${p.y - b.y}px`, opacity: 0 },
                { opacity: 1, offset: 0.3 },
                { translate: "0px 0px", opacity: 1 }
              ],
              { duration: CHIP_MS, easing: EASE, fill: "backwards" }
            )
          );
          if (elapsed > 0) a.currentTime = elapsed;
        }
      });
    });
  }

  if (events.reveal) {
    events.reveal.forEach((seatNo) => {
      out.push({
        kind: "reveal",
        replay: true,
        until: performance.now() + FLIP_MS + 140,
        start(elapsed) {
          seatEl(seatNo)?.querySelectorAll(".table-seat-cards .playing-card").forEach((c) => flipOnly(c, { elapsed }));
        }
      });
    });
  }

  if (events.flipSelf && !runs.some((r) => r.kind === "deal")) {
    out.push({
      kind: "flip-self",
      replay: true,
      until: performance.now() + FLIP_MS + 100,
      start(elapsed) {
        felt.querySelectorAll(".table-seat-card--self .table-seat-cards .playing-card").forEach((c, i) => {
          flipOnly(c, { delay: i * 60, elapsed });
        });
      }
    });
  }

  if (events.folds && before) {
    events.folds.forEach((seatNo) => {
      const cap = before.cards.get(seatNo);
      if (!cap) return;
      out.push({
        kind: "fold",
        replay: false,
        until: performance.now() + FOLD_MS + 100,
        start() {
          const ghost = cap.clone;
          const from = centre(cap.rect);
          const fc = feltCentre();
          const to = { x: from.x + (fc.x - from.x) * 0.5, y: from.y + (fc.y - from.y) * 0.5 };
          ghost.style.width = `${cap.rect.width}px`;
          ghost.style.height = `${cap.rect.height}px`;
          ghost.style.marginBottom = "0";
          ghostFlight(ghost, from, to, { delay: 0, duration: FOLD_MS, rotate: seatNo % 2 ? 16 : -16, fadeAt: 0.2 });
        }
      });
    });
  }

  if (events.sweep && before) {
    events.sweep.forEach(({ seatNo, amount }, i) => {
      out.push({
        kind: "sweep",
        replay: false,
        until: performance.now() + CHIP_MS + i * 40 + 100,
        start() {
          const rect = before.bets.get(seatNo) || seatEl(seatNo)?.querySelector(".table-seat-plaque")?.getBoundingClientRect();
          if (!rect) return;
          const g = createChipStacks(amount, { maxPerStack: 4, maxStacks: 2 });
          g.style.setProperty("--chip-size", "14px");
          ghostFlight(g, centre(rect), potCentre(), { delay: i * 40, duration: CHIP_MS, fadeAt: 0.75 });
          const pot = felt.querySelector(".pot-chips");
          if (pot && i === 0) {
            track(pot.animate([{ scale: "1.14" }, { scale: "1" }], { duration: 220, delay: CHIP_MS - 60, easing: EASE }));
          }
        }
      });
    });
  }

  if (events.payouts) {
    const delay = events.sweep ? CHIP_MS + 160 : 80;
    events.payouts.forEach(({ seatNo, amount }) => {
      out.push({
        kind: "payout",
        replay: false,
        until: performance.now() + delay + PAYOUT_MS + 100,
        start() {
          const plaque = seatEl(seatNo)?.querySelector(".table-seat-plaque");
          if (!plaque) return;
          const g = createChipStacks(amount, { maxPerStack: 4, maxStacks: 2 });
          g.style.setProperty("--chip-size", "16px");
          ghostFlight(g, potCentre(), centre(plaque.getBoundingClientRect()), { delay, duration: PAYOUT_MS, fadeAt: 0.8 });
        }
      });
    });
  }
  return out;
}

/** Test/dev helper: forget everything (used when the table view is torn down). */
export function resetMotion() {
  settle();
  prevSnap = null;
  dealtHandId = null;
}
