// Table motion: deal, fold, chip and pot movement.
//
// Rules (see docs/poker/STYLE_GUIDE.md, "Motion"):
// - The renderer always builds the final state first. Every card and chip is visible and in place in its resting style;
//   animations only run FROM an offset (Web Animations API, `translate`/`rotate`/`scale`/`opacity`, never layout).
// - What moves is decided by diffing the previous and the next table snapshot (`diffSnapshots`, pure and tested).
//   The first snapshot of a table (page load, reconnect, joining a hand in progress) never animates.
// - Nothing here blocks a state update or the action controls. If animations are unsupported, reduced, hidden or
//   interrupted, `settle()` cancels everything and the resting state is what the player sees.

import { createChipStacks, createChip } from "./components.js";
import { formatChips } from "../lib/format.js";
import { evaluate } from "../engine/evaluator.js";

const EASE = "cubic-bezier(0.16, 1, 0.3, 1)"; // same curve as --ease-out
const DEAL_STAGGER_MS = 100;
const DEAL_MS = 320;
const BOARD_STAGGER_MS = 110;
const FLIP_MS = 180;
const FOLD_MS = 300;
const CHIP_MS = 320;
const PAYOUT_MS = 400;
const SETTLE_SLACK_MS = 200;
const COUNT_UP_MS = 600;
const BIG_POT_BB = 20;

/** Shared with the sound planner (ui/table-sound.js) so sound and motion line up. */
export const TIMING = Object.freeze({ DEAL_STAGGER_MS, DEAL_MS, BOARD_STAGGER_MS, FLIP_MS, FOLD_MS, CHIP_MS, PAYOUT_MS });

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
  const committed = {};
  const allIn = {};
  seats.forEach((s) => {
    committed[s.seatNo] = Number(s.totalCommitted ?? s.bet ?? 0);
    allIn[s.seatNo] = Boolean(s.allIn);
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
    committed,
    allIn,
    actingSeat: hand && Number.isFinite(Number(hand.actingSeat)) && hand.actingSeat !== null ? Number(hand.actingSeat) : null,
    actionSeq: hand && Number.isFinite(Number(hand.actionSeq)) ? Number(hand.actionSeq) : null,
    selfSeatNo,
    selfCardsKnown: Boolean(selfCardsKnown)
  };
}

/**
 * Compares two snapshots and says what to animate. Returns an object with any of:
 * `deal`, `board {from,to}`, `folds [seatNo]`, `bets [{seatNo, amount}]`, `sweep [{seatNo, amount}]`,
 * `payouts [{seatNo, amount}]`, `reveal [seatNo]`, `flipSelf`, and for sound: `commits [{seatNo, delta}]` (chips put in,
 * including a call that closed the street and a blind) and `checks [seatNo]`. Empty when nothing should move.
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

  const commits = [];
  Object.keys(next.committed || {}).forEach((s) => {
    const before = newHand ? 0 : Number(prev.committed?.[s] || 0);
    const delta = next.committed[s] - before;
    if (delta > 0) commits.push({ seatNo: Number(s), delta });
  });
  if (commits.length) ev.commits = commits;

  if (!newHand && prev.status === "playing" && prev.actingSeat !== null && prev.actionSeq !== null && next.actionSeq !== null && next.actionSeq > prev.actionSeq) {
    const s = prev.actingSeat;
    const addedChips = Number(next.committed?.[s] || 0) > Number(prev.committed?.[s] || 0);
    if (!next.folded[s] && !addedChips) ev.checks = [s];
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

/* ---------------------------------------------------------------- win sequence: pure part */

const RANK_NAMES = Object.freeze({
  14: ["Ace", "Aces"], 13: ["King", "Kings"], 12: ["Queen", "Queens"], 11: ["Jack", "Jacks"], 10: ["Ten", "Tens"],
  9: ["Nine", "Nines"], 8: ["Eight", "Eights"], 7: ["Seven", "Sevens"], 6: ["Six", "Sixes"], 5: ["Five", "Fives"],
  4: ["Four", "Fours"], 3: ["Three", "Threes"], 2: ["Two", "Twos"], 1: ["Ace", "Aces"]
});
const rankOne = (v) => (RANK_NAMES[v] || ["?"])[0];
const rankMany = (v) => (RANK_NAMES[v] || ["?", "?"])[1];

/** "Straight, King high", "Pair of Kings", ... from an evaluator result (`category`, `ranks`). Empty string if unknown. */
export function describeWinningHand(ev) {
  if (!ev || !Number.isFinite(ev.category) || !Array.isArray(ev.ranks)) return "";
  const r = ev.ranks;
  switch (ev.category) {
    case 0: return `${rankOne(r[0])} high`;
    case 1: return `Pair of ${rankMany(r[0])}`;
    case 2: return `Two pair, ${rankMany(r[0])} and ${rankMany(r[1])}`;
    case 3: return `Three of a kind, ${rankMany(r[0])}`;
    case 4: return `Straight, ${rankOne(r[0])} high`;
    case 5: return `Flush, ${rankOne(r[0])} high`;
    case 6: return `Full house, ${rankMany(r[0])} over ${rankMany(r[1])}`;
    case 7: return `Four of a kind, ${rankMany(r[0])}`;
    case 8: return r[0] === 14 ? "Royal flush" : `Straight flush, ${rankOne(r[0])} high`;
    default: return "";
  }
}

/** Milliseconds from the state update to each step of the win sequence (about 2.1 s for a showdown, 1.5 s for a fold-out). */
export function winTimeline(events, kind = "showdown") {
  const base = events?.board
    ? Math.round((events.board.to - events.board.from) * BOARD_STAGGER_MS + DEAL_MS + FLIP_MS)
    : 0;
  if (kind === "fold-out") return { reveal: 0, highlight: 0, banner: base + 100, payout: base + 450, count: base + 450, glow: base + 750, end: base + 1500 };
  return { reveal: base, highlight: base + 380, banner: base + 520, payout: base + 900, count: base + 900, glow: base + 1300, end: base + 2100 };
}

/**
 * Everything the win moment needs, from public data only: winners, amounts, hand names and the five cards that make each
 * winning hand. Uses `showdown.hands` when the server sent the best five cards; otherwise evaluates the cards that were
 * actually revealed (an opponent's `revealedCards`, or your own hole cards). Never touches a card the server did not reveal.
 * Returns null unless a hand is complete with at least one winner.
 */
export function computeWinSpec(table, { myHoleCards = null, myHoleCardsHandId = null } = {}) {
  const hand = table?.hand;
  if (!hand || hand.status !== "complete") return null;
  const seats = Array.isArray(table.seats) ? table.seats : [];
  const payouts = hand.payouts && typeof hand.payouts === "object" ? hand.payouts : {};
  let winnerSeats = Array.isArray(hand.winners) ? hand.winners.map(Number) : [];
  if (!winnerSeats.length) winnerSeats = Object.keys(payouts).filter((k) => Number(payouts[k]) > 0).map(Number);
  if (!winnerSeats.length) return null;
  const board = Array.isArray(hand.board) ? hand.board : [];
  const isShowdown = Boolean(hand.showdown);
  const bb = Number(table.bb) > 0 ? Number(table.bb) : 20;
  const pot = Number(hand.pot || 0);

  const holeOf = (seat) => {
    if (Array.isArray(seat.revealedCards) && seat.revealedCards.length === 2) return seat.revealedCards;
    if (seat.isSelf && Array.isArray(myHoleCards) && myHoleCards.length === 2 && (!myHoleCardsHandId || myHoleCardsHandId === hand.id)) return myHoleCards;
    return null;
  };

  const boardWin = new Set();
  const holeWin = {};
  const winners = winnerSeats.map((seatNo) => {
    const seat = seats.find((s) => s.seatNo === seatNo) || {};
    const amount = Number(payouts[seatNo] ?? 0);
    const w = { seatNo, isSelf: Boolean(seat.isSelf), name: seat.isSelf ? "You" : seat.displayName || `Seat ${seatNo + 1}`, amount, handName: "", cards5: [] };
    if (!isShowdown) return w;
    const info = hand.showdown?.hands?.[seatNo] || null;
    const hole = holeOf(seat);
    let ev = info && Number.isFinite(info.category) && Array.isArray(info.ranks) ? info : null;
    if (hole && board.length >= 3) {
      try {
        const computed = evaluate([...hole, ...board]);
        if (!ev) ev = computed;
        w.cards5 = Array.isArray(info?.cards) && info.cards.length === 5 ? info.cards : computed.cards;
      } catch (_err) { /* leave the winner without highlighted cards */ }
    }
    w.handName = describeWinningHand(ev) || info?.name || "";
    if (hole) {
      w.cards5.forEach((code) => {
        const bi = board.indexOf(code);
        if (bi >= 0) boardWin.add(bi);
        else if (hole.includes(code)) (holeWin[seatNo] ||= []).push(code);
      });
    }
    return w;
  });

  const winLine = winners.map((w) => `${w.name} ${w.isSelf ? "win" : "wins"} ${formatChips(w.amount)}`).join(" · ");
  let headline;
  let detail;
  if (isShowdown) {
    const labels = [...new Set(winners.map((w) => w.handName).filter(Boolean))];
    headline = labels.slice(0, 2).join(" / ") || "Showdown";
    detail = winLine;
  } else {
    headline = winLine;
    detail = "Everyone else folded";
  }
  return {
    handId: hand.id,
    kind: isShowdown ? "showdown" : "fold-out",
    pot,
    big: pot > BIG_POT_BB * bb,
    split: winners.length > 1,
    selfWins: winners.some((w) => w.isSelf),
    winners,
    boardWin: [...boardWin].sort((a, b) => a - b),
    holeWin,
    headline,
    detail
  };
}

/* ---------------------------------------------------------------- DOM part */

let prevSnap = null;
let dealtHandId = null;
let runs = []; // { until, replay, start(elapsedMs) } so a re-render mid-animation resumes instead of snapping
let live = new Set(); // running animations created by this module
let settleTimer = null;
let visibilityWired = false;
let countUps = []; // { el, finalText, raf } stack counters of winners; the final text is restored by settle()

/** Stops every stack counter and puts the final amount back (the resting DOM is always the final state). */
function stopCountUps() {
  countUps.forEach((c) => {
    if (c.raf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(c.raf);
    c.el.textContent = c.finalText;
  });
  countUps = [];
}

/**
 * Counts a winner's stack from `from` up to the amount already in the DOM. A silent WAAPI animation is the clock, so
 * `finish()` or `cancel()` of all animations (and settle()) puts the final amount back at once, like everything else here.
 */
function countUp(el, from, to, delay, elapsed = 0, duration = COUNT_UP_MS) {
  const entry = { el, finalText: el.textContent, raf: 0 };
  countUps.push(entry);
  const clock = track(el.animate([{ opacity: 1 }, { opacity: 1 }], { duration: delay + duration }));
  if (elapsed > 0) clock.currentTime = elapsed;
  const done = () => {
    if (entry.raf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(entry.raf);
    entry.raf = 0;
    el.textContent = entry.finalText;
  };
  clock.addEventListener("finish", done);
  clock.addEventListener("cancel", done);
  const step = () => {
    const t = Number(clock.currentTime);
    if (clock.playState === "finished" || !Number.isFinite(t)) { done(); return; }
    const p = Math.min(1, Math.max(0, (t - delay) / duration));
    el.textContent = formatChips(p <= 0 ? from : Math.round(from + (to - from) * (1 - (1 - p) ** 3)));
    entry.raf = requestAnimationFrame(step);
  };
  step();
}

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
  stopCountUps();
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
 * `extra.win` is `computeWinSpec(...)` for the win sequence. Returns the diff events (also used for sound).
 */
export function animateTable(els, snap, before, extra = {}) {
  const prev = prevSnap;
  prevSnap = snap;
  let events = {};
  try {
    wireVisibility();
    const felt = els.opponentArea?.closest(".poker-felt");
    if (!felt || !snap) return events;
    events = diffSnapshots(prev, snap, { dealtHandId });
    if (events.deal) dealtHandId = snap.handId;
    if (!motionAllowed()) { settle(); return events; }

    const now = performance.now();
    // A new state update skips a win sequence still running; a plain re-render resumes it on the rebuilt elements
    if (Object.keys(events).length) {
      runs = runs.filter((r) => r.kind !== "win");
      stopCountUps();
      document.querySelectorAll(".motion-ghost[data-win]").forEach((g) => g.remove());
    }
    // Resume animations that were running before this re-render (the elements were rebuilt)
    runs = runs.filter((r) => r.until > now);
    runs.forEach((r) => { if (r.replay) r.start(now - r.t0); });

    const fresh = buildRuns(felt, events, before, extra);
    fresh.forEach((r) => { r.t0 = now; r.start(0); runs.push(r); });
    const horizon = runs.reduce((m, r) => Math.max(m, r.until), now);
    if (runs.length) scheduleSettle(horizon - now);
  } catch (err) {
    settle();
    if (typeof console !== "undefined") console.warn("table motion skipped:", err);
  }
  return events;
}

/**
 * "Your turn" cue, once per turn: the controls slide up a little and the own plaque ring flashes once.
 * Transform and opacity only; reduced motion or a hidden tab does nothing (the controls are simply there).
 */
export function cueMyTurn(els) {
  try {
    if (!motionAllowed()) return;
    if (els.actionBar) track(els.actionBar.animate([{ translate: "0px 14px", opacity: 0.55 }], { duration: 260, easing: EASE }));
    const ring = document.querySelector(".table-seat-card--self .seat-fx--ring");
    if (ring) {
      track(ring.animate([{ opacity: 0, scale: "0.97" }, { opacity: 1, scale: "1.03", offset: 0.35 }, { opacity: 0, scale: "1.07" }], { duration: 720, easing: EASE }));
    }
  } catch (_err) { /* decorative */ }
}

function buildRuns(felt, events, before, extra = {}) {
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
  const ghostFlight = (el, from, to, { delay, duration, rotate = 0, fadeAt = 0.6, elapsed = 0, win = false }) => {
    const base = lr();
    el.classList.add("motion-ghost");
    if (win) el.dataset.win = "1";
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
    if (elapsed > 0) anim.currentTime = elapsed;
    return anim;
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

  // A showdown reveals after any board cards of the same update (an all-in run-out) have been dealt
  const revealDelay = events.payouts ? winTimeline(events, extra.win?.kind).reveal : 0;
  if (events.reveal) {
    events.reveal.forEach((seatNo) => {
      out.push({
        kind: "reveal",
        replay: true,
        until: performance.now() + revealDelay + FLIP_MS + 140,
        start(elapsed) {
          seatEl(seatNo)?.querySelectorAll(".table-seat-cards .playing-card").forEach((c) => flipOnly(c, { elapsed, delay: revealDelay }));
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
          const g = createChipStacks(amount, { maxPerStack: 5, maxStacks: 3 });
          g.style.setProperty("--chip-size", "24px");
          ghostFlight(g, centre(rect), potCentre(), { delay: i * 40, duration: CHIP_MS, fadeAt: 0.75 });
          const pot = felt.querySelector(".pot-chips");
          if (pot && i === 0) {
            track(pot.animate([{ scale: "1.14" }, { scale: "1" }], { duration: 220, delay: CHIP_MS - 60, easing: EASE }));
          }
        }
      });
    });
  }

  if (events.payouts && extra.win) out.push(buildWinRun(felt, layer, events, extra.win, { seatEl, lr, potCentre, ghostFlight }));
  else if (events.payouts) {
    const delay = events.sweep ? CHIP_MS + 160 : 80;
    events.payouts.forEach(({ seatNo, amount }) => {
      out.push({
        kind: "payout",
        replay: false,
        until: performance.now() + delay + PAYOUT_MS + 100,
        start() {
          const plaque = seatEl(seatNo)?.querySelector(".table-seat-plaque");
          if (!plaque) return;
          const g = createChipStacks(amount, { maxPerStack: 5, maxStacks: 3 });
          g.style.setProperty("--chip-size", "28px");
          ghostFlight(g, potCentre(), centre(plaque.getBoundingClientRect()), { delay, duration: PAYOUT_MS, fadeAt: 0.8 });
        }
      });
    });
  }
  return out;
}

/**
 * The win moment: winning cards lift and get an outline while the rest dim, the banner fades in, the pot slides to each
 * winner whose stack counts up, then the plaque glows once. A big pot won by the player adds a few chips arcing onto
 * their stack. Everything is a decoration over a DOM that already shows the final state (marks, banner, stacks).
 */
function buildWinRun(felt, layer, events, win, { seatEl, lr, potCentre, ghostFlight }) {
  const tl = winTimeline(events, win.kind);
  return {
    kind: "win",
    replay: true,
    until: performance.now() + tl.end + 250,
    start(elapsed) {
      stopCountUps();
      layer.querySelectorAll(".motion-ghost[data-win]").forEach((g) => g.remove());
      const run = (a) => { track(a); if (elapsed > 0) a.currentTime = elapsed; return a; };
      const pieces = { duration: 260, easing: EASE, fill: "backwards" };

      // Marks on the board cards of an all-in run-out stay static: those cards are still being dealt
      if (win.kind === "showdown") {
        const scope = events.board ? [...felt.querySelectorAll(".table-seat-cards")] : [felt];
        scope.forEach((root) => {
          root.querySelectorAll(".playing-card--win").forEach((card) => {
            run(card.animate([{ translate: "0px 0px" }], { ...pieces, delay: tl.highlight }));
            try { run(card.animate([{ opacity: 0 }], { ...pieces, delay: tl.highlight, pseudoElement: "::after" })); } catch (_err) { /* older browsers: the outline simply appears */ }
          });
          root.querySelectorAll(".playing-card--dim").forEach((card) => run(card.animate([{ opacity: 1 }], { ...pieces, delay: tl.highlight })));
        });
      }

      const banner = felt.querySelector(".table-status-banner");
      if (banner) run(banner.animate([{ opacity: 0, translate: "0px 6px" }], { ...pieces, duration: 300, delay: tl.banner }));

      win.winners.forEach((w, k) => {
        const seat = seatEl(w.seatNo);
        const plaque = seat?.querySelector(".table-seat-plaque");
        if (!plaque || !(w.amount > 0)) return;
        const delay = tl.payout + k * 90;
        const g = createChipStacks(w.amount, { maxPerStack: 5, maxStacks: 3 });
        g.style.setProperty("--chip-size", "28px");
        ghostFlight(g, potCentre(), centre(plaque.getBoundingClientRect()), { delay, duration: PAYOUT_MS, fadeAt: 0.8, elapsed, win: true });

        const stack = seat.querySelector(".table-seat-plaque__meta .chip-amount > span:last-child");
        if (stack) {
          const to = Number(String(stack.textContent).replace(/[^\d]/g, ""));
          if (Number.isFinite(to)) countUp(stack, Math.max(0, to - w.amount), to, delay + PAYOUT_MS * 0.5, elapsed);
        }

        const glow = seat.querySelector(".seat-fx--glow");
        if (glow) {
          run(glow.animate([{ opacity: 0 }, { opacity: w.isSelf ? 1 : 0.7, offset: 0.3 }, { opacity: 0 }], { duration: 850, delay: tl.glow + k * 90, easing: EASE }));
        }

        if (w.isSelf && win.big) {
          // A few chips hop onto the stack: short arcs, not confetti
          const base = lr();
          const c = centre(plaque.getBoundingClientRect());
          const x0 = c.x - base.left - 9;
          const y0 = c.y - base.top - 9;
          [-34, -17, 0, 17, 34].forEach((dx, i) => {
            const chip = createChip([1000, 500, 100, 25, 100][i], "motion-ghost");
            chip.style.setProperty("--chip-size", "18px");
            chip.dataset.win = "1";
            layer.appendChild(chip);
            const apex = -38 - (i % 2) * 14;
            const a = run(chip.animate(
              [
                { translate: `${x0 + dx * 0.4}px ${y0}px`, opacity: 0, scale: "0.7" },
                { translate: `${x0 + dx}px ${y0 + apex}px`, opacity: 1, scale: "1", offset: 0.5 },
                { translate: `${x0 + dx * 0.2}px ${y0 - 2}px`, opacity: 0, scale: "0.9" }
              ],
              { duration: 520, delay: delay + PAYOUT_MS * 0.7 + i * 70, easing: EASE, fill: "both" }
            ));
            a.addEventListener("finish", () => chip.remove());
            a.addEventListener("cancel", () => chip.remove());
          });
        }
      });
    }
  };
}

/** Test/dev helper: forget everything (used when the table view is torn down). */
export function resetMotion() {
  settle();
  prevSnap = null;
  dealtHandId = null;
}
