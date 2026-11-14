// Design harness: renders the REAL table view (markup from ../index.html, real controller and renderer)
// with deterministic mock data. Select a state with `?state=<name>`; hide the switcher with `?bar=0`.
// Nothing here talks to a network: poker-api.js is replaced by an offline stub via the import map.

import { STATE_NAMES, FIXED_NOW, getMockState, getDemoSteps } from "./mock-states.js";
import { setMockHoleCards } from "./poker-api-stub.js";

const params = new URLSearchParams(location.search);
const DEMO = "demo-hand";
const stateName = [...STATE_NAMES, DEMO].includes(params.get("state")) ? params.get("state") : STATE_NAMES[0];
const STEP_MS = Number(params.get("step")) || 1200;

// Freeze the clock so turn timers are deterministic and never expire.
Date.now = () => FIXED_NOW;
// The real "your turn" cue calls navigator.vibrate, which Chrome logs as an error without a user gesture.
try { Object.defineProperty(navigator, "vibrate", { value: () => false, configurable: true }); } catch (_err) { /* ignore */ }

function buildSwitcher() {
  const bar = document.getElementById("harness-bar");
  if (params.get("bar") === "0") { bar.hidden = true; return; }
  [...STATE_NAMES, DEMO].forEach((name) => {
    const a = document.createElement("a");
    a.href = `?state=${name}`;
    a.textContent = name;
    if (name === stateName) a.setAttribute("aria-current", "page");
    bar.appendChild(a);
  });
}

async function loadTableMarkup() {
  // Extract the table view and the options drawer from the real page so the markup cannot drift.
  const res = await fetch("../index.html", { cache: "no-store" });
  if (!res.ok) throw new Error(`Could not load ../index.html (${res.status})`);
  const doc = new DOMParser().parseFromString(await res.text(), "text/html");
  const view = doc.getElementById("view-table");
  const drawer = doc.getElementById("table-drawer-dialog");
  if (!view || !drawer) throw new Error("index.html no longer has #view-table / #table-drawer-dialog");
  view.hidden = false;
  document.getElementById("main-content").replaceChildren(document.adoptNode(view));
  document.body.appendChild(document.adoptNode(drawer));
}

/** Plays one hand step by step through the real controller (about 1.2 s apart): `?state=demo-hand`, `&step=ms` to change the pace, `&auto=0` to wait for the button. */
function setupDemo(controller, setHoleCards) {
  const steps = getDemoSteps();
  const bar = document.getElementById("harness-bar");
  const label = document.createElement("span");
  label.id = "harness-step";
  label.setAttribute("role", "status");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "harness-play";
  btn.textContent = "Play sequence";
  bar.append(btn, label);
  let timer = null;
  const show = (i) => {
    setHoleCards(steps[i].holeCards);
    controller.openWithTable(steps[i].table);
    label.textContent = ` ${i + 1}/${steps.length} ${steps[i].label}`;
  };
  const play = () => {
    clearTimeout(timer);
    let i = 0;
    const next = () => {
      show(i);
      i += 1;
      if (i < steps.length) timer = setTimeout(next, STEP_MS);
    };
    next();
  };
  btn.addEventListener("click", play);
  window.__demo = { steps, show, play };
  show(0);
  if (params.get("auto") !== "0") timer = setTimeout(play, STEP_MS);
}

async function main() {
  buildSwitcher();
  document.title = `Harness: ${stateName}`;
  await loadTableMarkup();

  const mock = stateName === DEMO ? { table: null, holeCards: null } : getMockState(stateName);
  setMockHoleCards(mock.holeCards);

  // Imported after the clock freeze and markup injection; the real controller looks up its elements on creation.
  const { createTableViewController } = await import("../ui/table-view.js");
  const noop = () => {};
  const controller = createTableViewController({
    getUser: () => ({ id: "mock-self" }),
    getDisplayName: () => "Alex",
    getBalance: () => 1000,
    onChipsChanged: async () => {},
    onExitToLobby: noop,
    onNavigateView: noop,
    onOpenAuth: noop
  });
  if (stateName === DEMO) setupDemo(controller, setMockHoleCards);
  else controller.openWithTable(mock.table);
}

main().catch((err) => {
  console.error(err);
  const box = document.createElement("div");
  box.className = "harness-error";
  box.textContent = `Harness failed: ${err.message}`;
  document.getElementById("main-content").replaceChildren(box);
});
