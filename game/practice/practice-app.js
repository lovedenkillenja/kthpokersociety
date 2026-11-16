// Practice mode page: setup screen, the REAL table view (markup from ../index.html, real controller and
// renderer) driven by the in-browser practice server, and the optional coach.
// Practice chips are not society chips: no login, no Supabase, no chip ledger, no network calls.

import { STAKES_PRESETS, DEFAULT_STAKES_ID, getStakesPreset } from "../lib/stakes.js";
import { formatChips } from "../lib/format.js";
import { createPracticeServer, PRACTICE_SELF_ID, MAX_PRACTICE_BOTS } from "../lib/practice-server.js";
import { runEquityInSlices, DEFAULT_EQUITY_SAMPLES } from "../lib/equity.js";
import { buildCoachAdvice, buildHandReview } from "../lib/practice-coach.js";
import { setPracticeServer } from "./practice-api.js";
import { createCoachPanel } from "./coach-panel.js";

const COACH_KEY = "kth_practice_coach";
const ACTIVE_TABLE_KEY = "kth_poker_active_table";
const PLAYER_NAME = "Player";
const SIDE_PANEL_QUERY = "(min-width: 1024px)";

const byId = (id) => document.getElementById(id);
const els = {
  setup: byId("practice-setup"),
  form: byId("practice-setup-form"),
  botsOptions: byId("practice-bots-options"),
  stakesOptions: byId("practice-stakes-options"),
  stack: byId("practice-stack"),
  stackHint: byId("practice-stack-hint"),
  coachCheck: byId("practice-coach-check"),
  clockCheck: byId("practice-clock-check"),
  setupError: byId("practice-setup-error"),
  startBtn: byId("practice-start-btn"),
  play: byId("practice-play"),
  tableSlot: byId("practice-table-slot"),
  side: byId("practice-side"),
  coachBtn: byId("practice-coach-btn"),
  newBtn: byId("practice-new-btn"),
  bustDialog: byId("practice-bust-dialog"),
  rebuyBtn: byId("practice-rebuy-btn"),
  bustNewBtn: byId("practice-bust-new-btn"),
  announcer: byId("practice-announcer")
};

// The real table view remembers the active room in sessionStorage; keep whatever the society lobby had there.
let savedActiveTable = null;
try { savedActiveTable = sessionStorage.getItem(ACTIVE_TABLE_KEY); } catch (_err) { /* ignore */ }
function restoreActiveTable() {
  try {
    if (savedActiveTable) sessionStorage.setItem(ACTIVE_TABLE_KEY, savedActiveTable);
    else sessionStorage.removeItem(ACTIVE_TABLE_KEY);
  } catch (_err) { /* ignore */ }
}

function readCoachPref() {
  try { return localStorage.getItem(COACH_KEY) === "1"; } catch (_err) { return false; }
}
function writeCoachPref(on) {
  try { localStorage.setItem(COACH_KEY, on ? "1" : "0"); } catch (_err) { /* ignore */ }
}

let coachOn = readCoachPref();
let server = null;
let controller = null;
let showToast = () => {};
let markupReady = null;
let equityJob = null;
let advice = null; // { key, street, pot, toCall, opponents, equity, samples }
let decisions = [];
let clockBtn = null;
const coach = createCoachPanel();

function announce(text) {
  if (!els.announcer || !text) return;
  els.announcer.textContent = "";
  window.setTimeout(() => { els.announcer.textContent = text; }, 30);
}

// ---------- Setup screen ----------

function radioOption(name, value, title, sub, checked) {
  const label = document.createElement("label");
  label.className = "stakes-option";
  const input = document.createElement("input");
  input.type = "radio";
  input.name = name;
  input.value = value;
  input.checked = checked;
  const nameEl = document.createElement("span");
  nameEl.className = "stakes-option__name";
  nameEl.textContent = title;
  const subEl = document.createElement("span");
  subEl.className = "stakes-option__blinds tabular";
  subEl.textContent = sub;
  label.append(input, nameEl, subEl);
  return label;
}

function selectedStakes() {
  const v = els.form.querySelector("input[name='stakes']:checked")?.value;
  return getStakesPreset(v || DEFAULT_STAKES_ID);
}

function syncStackField() {
  const stakes = selectedStakes();
  els.stack.min = String(stakes.minBuyIn);
  els.stack.max = String(stakes.maxBuyIn);
  els.stack.step = String(stakes.bb);
  els.stack.value = String(stakes.maxBuyIn);
  els.stackHint.textContent = `${formatChips(stakes.minBuyIn)}–${formatChips(stakes.maxBuyIn)} practice chips (${formatChips(stakes.maxBuyIn / stakes.bb)} big blinds at most)`;
}

function buildSetup() {
  for (let n = 1; n <= MAX_PRACTICE_BOTS; n += 1) {
    els.botsOptions.appendChild(radioOption("bots", String(n), String(n), n === 1 ? "bot" : "bots", n === 3));
  }
  STAKES_PRESETS.forEach((p) => {
    els.stakesOptions.appendChild(radioOption("stakes", p.id, p.name, `${p.sb}/${p.bb}`, p.id === DEFAULT_STAKES_ID));
  });
  els.stakesOptions.addEventListener("change", syncStackField);
  syncStackField();
  els.coachCheck.checked = coachOn;
  els.coachCheck.addEventListener("change", () => setCoach(els.coachCheck.checked));
  els.form.addEventListener("submit", (e) => {
    e.preventDefault();
    const stakes = selectedStakes();
    const stack = Math.trunc(Number(els.stack.value));
    if (!Number.isFinite(stack) || stack < stakes.minBuyIn || stack > stakes.maxBuyIn) {
      els.setupError.textContent = `Choose a starting stack between ${formatChips(stakes.minBuyIn)} and ${formatChips(stakes.maxBuyIn)} chips.`;
      els.stack.setAttribute("aria-invalid", "true");
      els.stack.focus();
      return;
    }
    els.setupError.textContent = "";
    els.stack.removeAttribute("aria-invalid");
    const botCount = Number(els.form.querySelector("input[name='bots']:checked")?.value || 3);
    startSession({ botCount, stakesId: stakes.id, startingStack: stack, useClock: els.clockCheck.checked });
  });
}

// ---------- Real table markup + controller ----------

async function loadTableMarkup() {
  // Same approach as game/dev/harness.js: take the table view from the real page so the markup cannot drift.
  const res = await fetch("../index.html", { cache: "no-store" });
  if (!res.ok) throw new Error(`Could not load the table (${res.status})`);
  const doc = new DOMParser().parseFromString(await res.text(), "text/html");
  const view = doc.getElementById("view-table");
  const drawer = doc.getElementById("table-drawer-dialog");
  const tutorial = doc.getElementById("tutorial-dialog");
  if (!view || !drawer) throw new Error("The table markup is missing.");
  view.hidden = false;
  els.tableSlot.replaceChildren(document.adoptNode(view));
  document.body.appendChild(document.adoptNode(drawer));
  if (tutorial) document.body.appendChild(document.adoptNode(tutorial));
  adaptMarkupForPractice();

  const [{ createTableViewController }, components, tutorialMod] = await Promise.all([
    import("../ui/table-view.js"),
    import("../ui/components.js"),
    import("../ui/tutorial-dialog.js")
  ]);
  showToast = components.showToast;
  if (tutorial) tutorialMod.createTutorialDialogController();
  controller = createTableViewController({
    getUser: () => ({ id: PRACTICE_SELF_ID }),
    getDisplayName: () => PLAYER_NAME,
    getBalance: () => server?.getState().seats.find((s) => s.isSelf)?.stack || 0,
    onChipsChanged: async () => {},
    onExitToLobby: goToLobby,
    onNavigateView: goToLobby,
    onOpenAuth: () => {}
  });
}

/** Small changes to this page's copy of the table markup (the shared files stay untouched). */
function adaptMarkupForPractice() {
  const copyBtn = byId("table-copy-code-btn");
  if (copyBtn) {
    copyBtn.disabled = true;
    copyBtn.title = "Practice table";
    copyBtn.classList.add("practice-code-btn");
  }
  byId("table-lobby-btn")?.setAttribute("aria-label", "Back to the lobby");
  document.querySelectorAll("#table-drawer-dialog [data-drawer-jump], #table-refresh-btn").forEach((b) => { b.hidden = true; });

  const grid = document.querySelector("#table-drawer-dialog .drawer-btn-grid");
  if (grid) {
    clockBtn = document.createElement("button");
    clockBtn.type = "button";
    clockBtn.className = "btn btn--ghost";
    clockBtn.id = "practice-clock-btn";
    clockBtn.addEventListener("click", () => {
      if (!server) return;
      server.setClock(!server.isClockOn());
      els.clockCheck.checked = server.isClockOn();
      syncClockBtn();
    });
    const newBtn = document.createElement("button");
    newBtn.type = "button";
    newBtn.className = "btn btn--ghost";
    newBtn.textContent = "New session";
    newBtn.addEventListener("click", () => {
      const dlg = byId("table-drawer-dialog");
      if (dlg?.open) dlg.close();
      newSession();
    });
    grid.append(clockBtn, newBtn);
    syncClockBtn();
  }
  // Insert the coach strip just above the action bar (moved to the side panel on wide screens).
  placeCoach();
}

function syncClockBtn() {
  if (!clockBtn) return;
  const on = Boolean(server?.isClockOn());
  clockBtn.textContent = on ? "30s clock: On" : "30s clock: Off";
  clockBtn.setAttribute("aria-pressed", String(on));
}

const sideQuery = window.matchMedia(SIDE_PANEL_QUERY);
function placeCoach() {
  const wide = sideQuery.matches;
  const shell = byId("view-table");
  if (wide) {
    if (coach.element.parentElement !== els.side) els.side.appendChild(coach.element);
  } else if (shell) {
    const bar = byId("table-action-bar");
    if (coach.element.nextElementSibling !== bar) shell.insertBefore(coach.element, bar);
  }
  coach.setSideMode(wide);
  els.side.hidden = !(wide && coachOn);
  controller?.syncLayoutMetrics();
}
sideQuery.addEventListener("change", placeCoach);

// ---------- Coach ----------

function setCoach(on) {
  coachOn = Boolean(on);
  writeCoachPref(coachOn);
  els.coachCheck.checked = coachOn;
  els.coachBtn.textContent = coachOn ? "Coach: On" : "Coach: Off";
  els.coachBtn.setAttribute("aria-pressed", String(coachOn));
  coach.setEnabled(coachOn);
  placeCoach();
  if (coachOn && server) updateCoach(server.getState());
  if (!coachOn) cancelEquity();
}

function cancelEquity() {
  if (equityJob) equityJob.cancel();
  equityJob = null;
}

function opponentsInHand(table) {
  return (table.seats || []).filter((s) => !s.isSelf && s.inHand && !s.folded).length;
}

function renderAdvice() {
  if (!advice) return;
  coach.showTurn(
    buildCoachAdvice({
      hole: advice.hole,
      board: advice.board,
      pot: advice.pot,
      toCall: advice.toCall,
      opponents: advice.opponents,
      equity: advice.samples >= 300 ? advice.equity : null,
      samples: advice.samples,
      canRaise: advice.canRaise
    })
  );
}

function updateCoach(table) {
  if (!coachOn) return;
  const hand = table?.hand;
  const self = table?.seats?.find((s) => s.isSelf);
  const myTurn = Boolean(hand && hand.status === "playing" && self && hand.actingSeat === self.seatNo && hand.legalActions);
  if (!myTurn) {
    if (advice && hand && hand.status === "playing") advice = null;
    if (hand?.status !== "complete") coach.showWaiting(self?.folded && hand?.status === "playing" ? "You folded · waiting for the next hand" : "Waiting for your turn");
    return;
  }
  const key = `${hand.id}:${hand.actionSeq}`;
  if (advice?.key === key) return;
  const hole = server.getOwnHoleCards(hand.id);
  if (!hole) return;
  cancelEquity();
  advice = {
    key,
    street: hand.street,
    hole,
    board: [...hand.board],
    pot: hand.pot,
    toCall: hand.legalActions.callAmount || 0,
    canRaise: Boolean(hand.legalActions.canRaise),
    opponents: Math.max(1, opponentsInHand(table)),
    equity: null,
    samples: 0
  };
  renderAdvice();
  const mine = advice;
  equityJob = runEquityInSlices(
    { hole, board: mine.board, opponents: mine.opponents },
    {
      samples: DEFAULT_EQUITY_SAMPLES,
      sliceSize: 250,
      onProgress: (r) => { if (advice === mine) { mine.equity = r.equity; mine.samples = r.samples; if (r.samples >= 300 && r.samples % 750 < 250) renderAdvice(); } },
      onDone: (r) => { if (advice === mine) { mine.equity = r.equity; mine.samples = r.samples; renderAdvice(); } }
    }
  );
}

// ---------- Session ----------

const ACTION_WORDS = { fold: "folded", "timeout-fold": "folded (time ran out)", check: "checked", call: "called" };

function describeBotAction(e) {
  if (e.action === "raise") return `${e.name} ${e.allIn ? "went all-in for" : e.facedBet > 0 ? "raised to" : "bet"} ${formatChips(e.amount)}`;
  if (e.action === "call") return `${e.name} ${e.allIn ? "called all-in" : "called"} ${formatChips(e.amount)}`;
  return `${e.name} ${ACTION_WORDS[e.action] || e.action}`;
}

function handleEvent(e) {
  if (e.type === "hand-start") {
    decisions = [];
    advice = null;
  } else if (e.type === "action") {
    if (e.isSelf) {
      if (advice && advice.street === e.street && advice.samples >= 300) {
        decisions.push({ street: advice.street, action: e.action, equity: advice.equity, toCall: advice.toCall, pot: advice.pot, opponents: advice.opponents });
      }
      cancelEquity();
      advice = null;
    } else {
      announce(describeBotAction(e));
    }
  } else if (e.type === "hand-complete") {
    cancelEquity();
    advice = null;
    if (coachOn) {
      const review = buildHandReview({ decisions, table: e.table, selfSeatNo: 0 });
      coach.showReview(review.text);
      coach.showWaiting(review.decisionLine === "No decision with numbers this hand." ? review.resultLine || "Next hand soon" : review.decisionLine);
    }
    decisions = [];
  } else if (e.type === "bot-rebuy") {
    showToast(`${e.name} rebought ${formatChips(e.amount)} practice chips.`);
  } else if (e.type === "player-rebuy") {
    showToast(`Rebought ${formatChips(e.amount)} practice chips. Good luck in the long run!`);
  } else if (e.type === "player-busted") {
    window.setTimeout(() => {
      if (server?.isPlayerBusted() && !els.bustDialog.open) els.bustDialog.showModal();
    }, 1500);
  }
}

function stopSession() {
  cancelEquity();
  advice = null;
  decisions = [];
  if (server) server.destroy();
  server = null;
  setPracticeServer(null);
  controller?.cleanup();
  restoreActiveTable();
}

async function startSession(config) {
  els.startBtn.disabled = true;
  try {
    if (!markupReady) markupReady = loadTableMarkup();
    await markupReady;
  } catch (err) {
    markupReady = null;
    els.startBtn.disabled = false;
    els.setupError.textContent = `${err.message}. Reload the page to try again.`;
    return;
  }
  stopSession();
  server = createPracticeServer({ ...config, playerName: PLAYER_NAME });
  setPracticeServer(server);
  server.onEvent(handleEvent);
  server.subscribe(updateCoach);

  els.setup.hidden = true;
  els.play.hidden = false;
  document.body.dataset.activeView = "table";
  coach.showReview("");
  coach.showWaiting();
  setCoach(coachOn);
  syncClockBtn();
  controller.openWithTable(server.getState());
  els.startBtn.disabled = false;
  server.begin();
  const bots = server.botStyles().map((b) => b.name).join(", ");
  announce(`Practice table ready: you against ${bots}. The first hand deals in a moment.`);
}

function newSession() {
  if (els.bustDialog.open) els.bustDialog.close();
  stopSession();
  els.play.hidden = true;
  els.setup.hidden = false;
  delete document.body.dataset.activeView;
  els.startBtn.focus();
}

function goToLobby() {
  stopSession();
  window.location.assign("../");
}

// ---------- Wiring ----------

function wire() {
  els.coachBtn.addEventListener("click", () => setCoach(!coachOn));
  els.newBtn.addEventListener("click", newSession);
  els.bustNewBtn.addEventListener("click", newSession);
  els.rebuyBtn.addEventListener("click", () => {
    if (server) {
      const res = server.rebuy();
      if (!res.ok) showToast(res.error, { variant: "error" });
    }
    if (els.bustDialog.open) els.bustDialog.close();
  });
  // "Leave" at a practice table goes straight back to the lobby: there is nothing to cash out.
  document.addEventListener(
    "click",
    (e) => {
      if (e.target instanceof Element && e.target.closest("#table-leave-btn")) {
        e.preventDefault();
        e.stopPropagation();
        goToLobby();
      }
    },
    true
  );
  window.addEventListener("pagehide", () => {
    cancelEquity();
    if (server) server.destroy();
    restoreActiveTable();
  });
}

buildSetup();
wire();
setCoach(coachOn);
