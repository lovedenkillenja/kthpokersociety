// Lobby block "Your chips at tables": lists tables where the member still has a seat
// (room code, seated stack, "Return to table"). Read-only display; leaving a table
// still goes through the table view's existing leave flow.

import { formatChips } from "../lib/format.js";
import { formatBlinds } from "../lib/stakes.js";
import { sumSeatedChips, formatSeatedSummary } from "../lib/seated-tables.js";

function createSeatedRow(row) {
  const li = document.createElement("li");
  li.className = "seated-tables__row";

  const info = document.createElement("div");
  const title = document.createElement("div");
  title.className = "seated-tables__code tabular";
  title.textContent = `Room ${row.code}`;
  const meta = document.createElement("div");
  meta.className = "field-hint tabular";
  const statusText = row.seatStatus === "sitout" ? "Sitting out" : "Seated";
  const blinds = row.sb && row.bb ? ` · ${formatBlinds(row.sb, row.bb)}` : "";
  meta.textContent = `${formatChips(row.stack)} chips · ${statusText}${blinds}`;
  info.append(title, meta);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn btn--primary btn--compact";
  btn.textContent = "Return to table";
  btn.dataset.returnTableCode = row.code;
  btn.setAttribute("aria-label", `Return to table ${row.code}, ${formatChips(row.stack)} chips seated`);

  li.append(info, btn);
  return li;
}

/**
 * Renders the block. Hidden when the member has no seated chips.
 */
export function renderSeatedTablesPanel(els, rows, walletBalance) {
  if (!els.seatedTablesBox) return;
  const list = Array.isArray(rows) ? rows : [];
  els.seatedTablesBox.hidden = list.length === 0;
  if (list.length === 0) {
    els.seatedTablesList?.replaceChildren();
    return;
  }
  if (els.seatedTablesSummary) {
    els.seatedTablesSummary.textContent = formatSeatedSummary(walletBalance, sumSeatedChips(list));
  }
  els.seatedTablesList?.replaceChildren(...list.map(createSeatedRow));
}

/**
 * Wires one delegated click handler for all "Return to table" buttons in the block.
 */
export function wireSeatedTablesPanel(els, onReturn) {
  els.seatedTablesList?.addEventListener("click", async (e) => {
    const btn = e.target instanceof Element ? e.target.closest("[data-return-table-code]") : null;
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    try {
      await onReturn(btn.dataset.returnTableCode);
    } finally {
      btn.disabled = false;
      btn.removeAttribute("aria-busy");
    }
  });
}
