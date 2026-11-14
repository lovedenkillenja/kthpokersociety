// Pure helpers for "chips still seated at tables" (no DOM, no network).
// The server stays the authority: these helpers only interpret rows the
// browser read (RLS-limited SELECT) or a public table state the `table`
// Edge Function returned. Nothing here writes chips or seats.

import { formatChips } from "./format.js";

export const SEATED_STATUSES = Object.freeze(["active", "sitout"]);

function isSeatedStatus(status) {
  return SEATED_STATUSES.includes(String(status || "").toLowerCase());
}

function toChipInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/**
 * Returns the caller's own active or sit-out seat from a public table state
 * (seat marked `isSelf: true` by the server), or null.
 */
export function findSelfSeat(tableState) {
  if (!tableState || typeof tableState !== "object") return null;
  if (String(tableState.status || "").toLowerCase() === "closed") return null;
  const seats = Array.isArray(tableState.seats) ? tableState.seats : [];
  return seats.find((s) => s && s.isSelf === true && isSeatedStatus(s.status)) || null;
}

/**
 * True when the server's public state says the caller already holds an
 * active or sit-out seat at this table (so no new buy-in is needed).
 */
export function isAlreadySeatedAt(tableState) {
  return findSelfSeat(tableState) !== null;
}

/**
 * Joins the member's `table_seats` rows with `poker_tables` rows into lobby rows.
 * Keeps only active/sit-out seats of this member at tables that exist and are not closed.
 * Returns `[{ tableId, code, stack, seatStatus, tableStatus }]`, sorted by room code.
 */
export function shapeSeatedTableRows(seatRows, tableRows, memberId = null) {
  const tablesById = new Map();
  (Array.isArray(tableRows) ? tableRows : []).forEach((t) => {
    if (t && t.id) tablesById.set(t.id, t);
  });

  const byTable = new Map();
  (Array.isArray(seatRows) ? seatRows : []).forEach((s) => {
    if (!s || !isSeatedStatus(s.status)) return;
    if (memberId && s.member_id && s.member_id !== memberId) return;
    const table = tablesById.get(s.table_id);
    if (!table || !table.code) return;
    const tableStatus = String(table.status || "").toLowerCase();
    if (tableStatus === "closed") return;
    if (byTable.has(s.table_id)) return; // one seated row per table (DB enforces this too)
    byTable.set(s.table_id, {
      tableId: s.table_id,
      code: String(table.code).toUpperCase(),
      stack: toChipInt(s.stack),
      seatStatus: String(s.status).toLowerCase(),
      tableStatus
    });
  });

  return Array.from(byTable.values()).sort((a, b) => a.code.localeCompare(b.code));
}

/**
 * Sums the seated stacks of shaped rows.
 */
export function sumSeatedChips(rows) {
  return (Array.isArray(rows) ? rows : []).reduce((acc, r) => acc + toChipInt(r?.stack), 0);
}

/**
 * Finds a shaped row by room code (case-insensitive), or null.
 */
export function findSeatedRowByCode(rows, code) {
  const wanted = String(code || "").toUpperCase().trim();
  if (!wanted) return null;
  return (Array.isArray(rows) ? rows : []).find((r) => r?.code === wanted) || null;
}

/**
 * Builds the summary line "Wallet X · At tables Y".
 */
export function formatSeatedSummary(walletBalance, atTables) {
  return `Wallet ${formatChips(toChipInt(walletBalance))} · At tables ${formatChips(toChipInt(atTables))}`;
}

/**
 * Hint appended to a failed buy-in check when the member still has chips seated somewhere.
 * Returns "" when nothing is seated.
 */
export function seatedChipsHint(rows) {
  const total = sumSeatedChips(rows);
  if (!total) return "";
  const count = Array.isArray(rows) ? rows.length : 0;
  const where = count === 1 ? "1 table" : `${count} tables`;
  return `You have ${formatChips(total)} chips seated at ${where}. Use “Return to table” under “Your chips at tables” above.`;
}
