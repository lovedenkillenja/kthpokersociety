// Pure helpers for the lobby's "Open tables" list (no DOM, no network).
// Input is what the browser may read under RLS: `poker_tables` rows and `table_seats` rows.
// Display names are NOT readable for other members, so the list shows counts only.
// The server stays the authority: sitting down still goes through the `table` Edge Function.

import { formatChips } from "./format.js";

export const IDLE_EMPTY_TABLE_MS = 30 * 60 * 1000;
export const OPEN_TABLES_LIMIT = 30;
const SEATED = new Set(["active", "sitout"]);

function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/** "Waiting for players" / "Hand in progress" */
export function openTableStatusLabel(status) {
  return String(status || "").toLowerCase() === "playing" ? "Hand in progress" : "Waiting for players";
}

/**
 * Shapes raw rows into lobby rows. Closed tables and tables without a code are dropped.
 * Row: { tableId, code, sb, bb, stakesLabel, minBuyIn, maxBuyIn, buyInRange, seated, maxSeats,
 *        freeSeats, isFull, status, statusLabel, isMine, createdAt, lastActivityAt }
 */
export function shapeOpenTableRows(tableRows, seatRows, memberId = null) {
  const counts = new Map();
  const mine = new Set();
  (Array.isArray(seatRows) ? seatRows : []).forEach((s) => {
    if (!s || !SEATED.has(String(s.status || "").toLowerCase())) return;
    counts.set(s.table_id, (counts.get(s.table_id) || 0) + 1);
    if (memberId && s.member_id === memberId) mine.add(s.table_id);
  });

  const rows = [];
  (Array.isArray(tableRows) ? tableRows : []).forEach((t) => {
    if (!t || !t.id || !t.code) return;
    const status = String(t.status || "").toLowerCase();
    if (status !== "open" && status !== "playing") return;
    const sb = toInt(t.sb);
    const bb = toInt(t.bb);
    const maxSeats = toInt(t.max_seats) || 6;
    const seated = Math.min(counts.get(t.id) || 0, maxSeats);
    const minBuyIn = toInt(t.min_buyin);
    const maxBuyIn = toInt(t.max_buyin);
    rows.push({
      tableId: t.id,
      code: String(t.code).toUpperCase(),
      sb, bb,
      stakesLabel: sb && bb ? `${formatChips(sb)}/${formatChips(bb)}` : "",
      minBuyIn, maxBuyIn,
      buyInRange: minBuyIn && maxBuyIn ? `${formatChips(minBuyIn)}–${formatChips(maxBuyIn)} chips` : "",
      seated, maxSeats,
      freeSeats: maxSeats - seated,
      isFull: seated >= maxSeats,
      status,
      statusLabel: openTableStatusLabel(status),
      isMine: mine.has(t.id),
      createdAt: String(t.created_at || ""),
      lastActivityAt: String(t.last_activity_at || t.created_at || "")
    });
  });
  return rows;
}

function ms(iso) {
  const n = Date.parse(iso);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Filters and sorts shaped rows.
 * Own tables are always kept. Full tables only with `showFull`. Tables with nobody seated that
 * have been idle for more than 30 minutes are hidden.
 * Order: tables with players and free seats, then empty tables with free seats, then full tables;
 * inside a group by big blind (low first), then newest first.
 */
export function selectOpenTables(rows, { showFull = false, now = Date.now() } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const groupOf = (r) => (r.isFull ? 2 : r.seated > 0 ? 0 : 1);
  return list
    .filter((r) => {
      if (r.isMine) return true;
      if (r.isFull) return showFull;
      if (r.seated === 0 && now - ms(r.lastActivityAt) > IDLE_EMPTY_TABLE_MS) return false;
      return true;
    })
    .sort((a, b) => groupOf(a) - groupOf(b) || a.bb - b.bb || ms(b.createdAt) - ms(a.createdAt));
}

/** Number of full tables (not mine) the "Show full tables" toggle would reveal. */
export function countHiddenFullTables(rows) {
  return (Array.isArray(rows) ? rows : []).filter((r) => r.isFull && !r.isMine).length;
}

/** Screen-reader summary for the polite live region. */
export function formatOpenTablesSummary(visibleRows) {
  const n = Array.isArray(visibleRows) ? visibleRows.length : 0;
  if (n === 0) return "No open tables right now.";
  return n === 1 ? "1 open table." : `${n} open tables.`;
}

/** Accessible name for a row's primary button. */
export function openTableActionLabel(row) {
  const stakes = row.stakesLabel ? ` at ${row.stakesLabel} blinds` : "";
  return row.isMine
    ? `Return to table ${row.code}${stakes}`
    : `Sit down at table ${row.code}${stakes}, ${row.seated} of ${row.maxSeats} seats taken`;
}
