// Lobby block "Open tables": rows with stakes, players, status and buy-in range, a "Sit down"
// button that expands an inline buy-in field, and the empty state. Display only: the join itself
// runs through the callbacks app.js passes in (same flow and validation as "Join by room code").

import { formatChips } from "../lib/format.js";
import { openTableActionLabel } from "../lib/open-tables.js";

let expandedCode = null;
let lastSignature = "";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function suggestedBuyIn(row, balance) {
  // The table's minimum, clamped to the wallet but never below the minimum: a short wallet still
  // shows the minimum so the normal validation message explains the shortfall.
  const min = row.minBuyIn || 1;
  return Math.min(row.maxBuyIn || min, Math.max(min, Math.min(min, balance)));
}

function createRow(row, balance) {
  const li = el("li", "open-table");
  li.dataset.tableCode = row.code;

  const main = el("div", "open-table__main");
  const stakes = el("div", "open-table__stakes tabular", row.stakesLabel || "Custom");
  stakes.append(el("span", "open-table__unit", " blinds"));
  const players = el("div", "open-table__players tabular");
  players.append(el("span", "open-table__count", `${row.seated} / ${row.maxSeats}`), el("span", "open-table__unit", " players"));
  const pill = el("span", `pill open-table__status${row.status === "playing" ? " pill--chip" : ""}`, row.statusLabel);
  const meta = el("div", "open-table__meta field-hint tabular");
  const parts = [`Room ${row.code}`];
  if (row.buyInRange) parts.push(`Buy-in ${row.buyInRange}`);
  if (row.isMine) parts.push("You are seated here");
  meta.textContent = parts.join(" · ");
  main.append(stakes, players, pill, meta);

  const btn = el("button", "btn btn--primary btn--compact open-table__action", row.isMine ? "Return to table" : "Sit down");
  btn.type = "button";
  btn.dataset.openTableAction = row.isMine ? "return" : "sit";
  btn.dataset.tableCode = row.code;
  btn.setAttribute("aria-label", openTableActionLabel(row));
  li.append(main, btn);

  if (!row.isMine && expandedCode === row.code) {
    btn.setAttribute("aria-expanded", "true");
    li.append(createBuyInForm(row, balance));
  } else if (!row.isMine) {
    btn.setAttribute("aria-expanded", "false");
  }
  return li;
}

function createBuyInForm(row, balance) {
  const form = el("form", "open-table__form");
  form.noValidate = true;
  form.dataset.tableCode = row.code;
  const field = el("div", "field");
  const id = `open-buyin-${row.code}`;
  const label = el("label", null, `Your buy-in (${formatChips(row.minBuyIn)}–${formatChips(row.maxBuyIn)} chips)`);
  label.htmlFor = id;
  const input = el("input", "tabular");
  input.id = id;
  input.type = "number";
  input.inputMode = "numeric";
  input.min = String(row.minBuyIn);
  input.max = String(row.maxBuyIn);
  input.step = String(row.bb || 1);
  input.value = String(suggestedBuyIn(row, balance));
  input.required = true;
  const errId = `open-buyin-error-${row.code}`;
  input.setAttribute("aria-describedby", errId);
  field.append(label, input);

  const err = el("p", "form-error");
  err.id = errId;
  err.setAttribute("role", "alert");

  const actions = el("div", "open-table__form-actions");
  const confirm = el("button", "btn btn--primary", "Join table");
  confirm.type = "submit";
  const cancel = el("button", "btn btn--ghost", "Cancel");
  cancel.type = "button";
  cancel.dataset.openTableCancel = row.code;
  actions.append(confirm, cancel);
  form.append(field, err, actions);
  return form;
}

/**
 * Renders the list. `visibleRows` are already filtered and sorted. Skips the DOM work when nothing
 * changed since the last render, so an automatic refresh never moves focus or closes a buy-in field.
 */
export function renderOpenTablesPanel(els, visibleRows, { balance = 0, hiddenFullCount = 0, showFull = false, loading = false } = {}, handlers = {}) {
  if (!els.openTablesBox) return;
  const rows = Array.isArray(visibleRows) ? visibleRows : [];
  if (expandedCode && !rows.some((r) => r.code === expandedCode && !r.isMine)) expandedCode = null;

  const signature = JSON.stringify([rows, balance, hiddenFullCount, showFull, loading, expandedCode]);
  if (signature === lastSignature) return;
  lastSignature = signature;

  const empty = rows.length === 0;
  if (els.openTablesEmpty) els.openTablesEmpty.hidden = !empty || loading;
  if (els.openTablesLoading) els.openTablesLoading.hidden = !(empty && loading);
  if (els.openTablesList) {
    els.openTablesList.hidden = empty;
    els.openTablesList.replaceChildren(...rows.map((r) => createRow(r, balance)));
  }
  if (els.openTablesToggleWrap) els.openTablesToggleWrap.hidden = hiddenFullCount === 0 && !showFull;
  if (els.openTablesToggleCount) els.openTablesToggleCount.textContent = hiddenFullCount ? ` (${hiddenFullCount})` : "";
}

export function setOpenTablesStatus(els, text) {
  if (els.openTablesStatus) els.openTablesStatus.textContent = text;
}

export function setOpenTablesError(els, text) {
  if (els.openTablesError) els.openTablesError.textContent = text || "";
}

export function setOpenTablesBusy(els, busy) {
  if (!els.openTablesRefresh) return;
  if (busy) els.openTablesRefresh.setAttribute("aria-busy", "true");
  else els.openTablesRefresh.removeAttribute("aria-busy");
}

/**
 * Wires delegated events. Handlers:
 *   onSit(code, rawBuyIn) -> Promise<{ ok, error }>   (error is shown under the field)
 *   onReturn(code), onRefresh(), onToggleFull(checked), onCreate(), rerender()
 */
export function wireOpenTablesPanel(els, handlers) {
  els.openTablesList?.addEventListener("click", async (e) => {
    const target = e.target instanceof Element ? e.target : null;
    const action = target?.closest("[data-open-table-action]");
    if (action && !action.disabled) {
      const code = action.dataset.tableCode;
      if (action.dataset.openTableAction === "return") {
        action.disabled = true;
        action.setAttribute("aria-busy", "true");
        try { await handlers.onReturn(code); } finally {
          action.disabled = false;
          action.removeAttribute("aria-busy");
        }
        return;
      }
      expandedCode = expandedCode === code ? null : code;
      handlers.rerender();
      if (expandedCode) els.openTablesList.querySelector(`#open-buyin-${code}`)?.focus();
      return;
    }
    const cancel = target?.closest("[data-open-table-cancel]");
    if (cancel) {
      const code = cancel.dataset.openTableCancel;
      expandedCode = null;
      handlers.rerender();
      els.openTablesList.querySelector(`[data-open-table-action][data-table-code="${code}"]`)?.focus();
    }
  });

  els.openTablesList?.addEventListener("submit", async (e) => {
    const form = e.target instanceof Element ? e.target.closest("form[data-table-code]") : null;
    if (!form) return;
    e.preventDefault();
    const input = form.querySelector("input");
    const err = form.querySelector(".form-error");
    const submit = form.querySelector('button[type="submit"]');
    if (err) err.textContent = "";
    submit.disabled = true;
    submit.setAttribute("aria-busy", "true");
    let res;
    try { res = await handlers.onSit(form.dataset.tableCode, input.value); } finally {
      submit.disabled = false;
      submit.removeAttribute("aria-busy");
    }
    if (res && !res.ok) {
      if (err) err.textContent = res.error || "Could not join table.";
      input.focus();
    }
  });

  els.openTablesRefresh?.addEventListener("click", () => handlers.onRefresh());
  els.openTablesShowFull?.addEventListener("change", () => handlers.onToggleFull(els.openTablesShowFull.checked));
  els.openTablesCreateBtn?.addEventListener("click", () => handlers.onCreate());
}
