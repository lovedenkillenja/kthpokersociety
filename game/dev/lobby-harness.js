// Design harness for the shell and lobby views. Mock data only, no network.
// Loads the REAL markup from ../index.html and the REAL ../app.js; the data modules are swapped by the import map.
// Variants: ?variant=seated (wallet 0, 500 chips at DEMO1 and DEMO2) or ?variant=wallet (1,250 chips, nothing seated).
// Views: #lobby, #leaderboard, #profile. Add ?bar=0 to hide the switcher.

const params = new URLSearchParams(location.search);
const variant = params.get("variant") === "wallet" ? "wallet" : "seated";
const VIEWS = ["lobby", "leaderboard", "profile"];

function buildSwitcher() {
  const bar = document.getElementById("harness-bar");
  if (params.get("bar") === "0") { bar.hidden = true; return; }
  ["seated", "wallet"].forEach((v) => {
    VIEWS.forEach((view) => {
      const a = document.createElement("a");
      a.href = `?variant=${v}#${view}`;
      a.textContent = `${v} · ${view}`;
      if (v === variant && (location.hash || "#lobby") === `#${view}`) a.setAttribute("aria-current", "page");
      bar.appendChild(a);
    });
  });
}

async function loadRealMarkup() {
  const res = await fetch("../index.html", { cache: "no-store" });
  if (!res.ok) throw new Error(`Could not load ../index.html (${res.status})`);
  const doc = new DOMParser().parseFromString(await res.text(), "text/html");
  doc.querySelectorAll("script").forEach((el) => el.remove());
  const root = document.getElementById("harness-root");
  root.style.display = "contents";
  root.replaceChildren(...Array.from(doc.body.childNodes).map((n) => document.adoptNode(n)));
}

async function main() {
  buildSwitcher();
  await loadRealMarkup();
  const { setMockVariant } = await import("./lobby-supabase-stub.js");
  setMockVariant(variant);
  await import("../app.js");
}

main().catch((err) => {
  console.error(err);
  const box = document.createElement("div");
  box.className = "harness-error";
  box.textContent = `Harness failed: ${err.message}`;
  document.body.appendChild(box);
});
