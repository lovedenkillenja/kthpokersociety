// Design harness: renders the REAL table view (markup from ../index.html, real controller and renderer)
// with deterministic mock data. Select a state with `?state=<name>`; hide the switcher with `?bar=0`.
// Nothing here talks to a network: poker-api.js is replaced by an offline stub via the import map.

import { STATE_NAMES, FIXED_NOW, getMockState } from "./mock-states.js";
import { setMockHoleCards } from "./poker-api-stub.js";

const params = new URLSearchParams(location.search);
const stateName = STATE_NAMES.includes(params.get("state")) ? params.get("state") : STATE_NAMES[0];

// Freeze the clock so turn timers are deterministic and never expire.
Date.now = () => FIXED_NOW;
// The real "your turn" cue calls navigator.vibrate, which Chrome logs as an error without a user gesture.
try { Object.defineProperty(navigator, "vibrate", { value: () => false, configurable: true }); } catch (_err) { /* ignore */ }

function buildSwitcher() {
  const bar = document.getElementById("harness-bar");
  if (params.get("bar") === "0") { bar.hidden = true; return; }
  STATE_NAMES.forEach((name) => {
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

async function main() {
  buildSwitcher();
  document.title = `Harness: ${stateName}`;
  await loadTableMarkup();

  const mock = getMockState(stateName);
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
  controller.openWithTable(mock.table);
}

main().catch((err) => {
  console.error(err);
  const box = document.createElement("div");
  box.className = "harness-error";
  box.textContent = `Harness failed: ${err.message}`;
  document.getElementById("main-content").replaceChildren(box);
});
