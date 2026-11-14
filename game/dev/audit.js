// Layout audit for the design harness. Loads every state in an iframe of a given size and reports clipping,
// horizontal scroll, seats/bets/pot/board overlapping, truncated names and a missing play-money label.
// Usage (from the harness page, in the browser console):
//   const { runAudit } = await import("/game/dev/audit.js");
//   console.log(await runAudit([[375, 812], [1280, 800]]));

export const ALL_STATES = [
  "waiting-1", "waiting-3", "preflop-2", "preflop-6", "flop-self-to-act",
  "turn-allin-sidepots", "river-folded-self", "showdown-split", "sitout", "timer-low"
];

function measure(win) {
  const d = win.document;
  const vw = win.innerWidth;
  const vh = win.innerHeight;
  const issues = [];
  const root = d.getElementById("view-table");
  const visible = (el) => {
    for (let p = el; p && p !== d.body; p = p.parentElement) {
      const cs = win.getComputedStyle(p);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
    }
    return true;
  };
  root.querySelectorAll("*").forEach((el) => {
    if (!visible(el) || el.closest(".sr-only") || el.closest("[hidden]")) return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    if (r.right > vw + 0.5 || r.left < -0.5 || r.bottom > vh + 0.5 || r.top < -0.5) {
      issues.push(`OFF ${el.id || el.className || el.tagName} ${[r.left, r.top, r.right, r.bottom].map(Math.round)}`);
    }
  });
  const de = d.documentElement;
  if (de.scrollWidth !== de.clientWidth) issues.push(`HSCROLL ${de.scrollWidth}/${de.clientWidth}`);
  if (de.scrollHeight > de.clientHeight + 1) issues.push(`VSCROLL ${de.scrollHeight}/${de.clientHeight}`);

  const felt = d.querySelector(".poker-felt").getBoundingClientRect();
  const items = [...d.querySelectorAll(
    ".table-seat-card, .table-bet, .table-board-row, .table-pot-box:not([hidden]), .table-status-banner, .table-sitdown-inline:not([hidden])"
  )].filter(visible).map((el) => ({
    r: el.getBoundingClientRect(),
    n: `${String(el.className).split(" ").slice(0, 2).join(".")}${el.dataset.seatNo ? `#${el.dataset.seatNo}` : ""}${el.classList.contains("table-bet") ? `[${el.textContent.trim()} in seat ${el.parentElement?.dataset.seatNo}]` : ""}`
  }));
  items.forEach((a) => {
    if (a.r.left < felt.left - 0.5 || a.r.right > felt.right + 0.5 || a.r.top < felt.top - 0.5 || a.r.bottom > felt.bottom + 0.5) {
      issues.push(`OUTFELT ${a.n}`);
    }
  });
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const a = items[i].r;
      const b = items[j].r;
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ox > 2 && oy > 2) issues.push(`OVERLAP ${items[i].n} x ${items[j].n} (${Math.round(ox)}x${Math.round(oy)})`);
    }
  }
  d.querySelectorAll(".table-seat-plaque__name strong").forEach((s) => {
    if (s.scrollHeight > s.clientHeight + 1 || s.scrollWidth > s.clientWidth + 1) issues.push(`TRUNC ${s.textContent}`);
  });
  const label = [...root.querySelectorAll(".action-bar__play-money")].some((e) => {
    const r = e.getBoundingClientRect();
    return visible(e) && r.width > 0 && r.left >= 0 && r.right <= vw + 0.5;
  });
  if (!label) issues.push("NO PLAY MONEY LABEL");
  return issues;
}

export async function runAudit(sizes, states = ALL_STATES) {
  const out = [];
  for (const [w, h] of sizes) {
    for (const st of states) {
      const f = document.createElement("iframe");
      f.style.cssText = `position:fixed;left:0;top:0;border:0;width:${w}px;height:${h}px;opacity:0;pointer-events:none`;
      f.src = `/game/dev/table-harness.html?bar=0&state=${st}`;
      document.body.appendChild(f);
      await new Promise((r) => { f.onload = r; });
      await new Promise((r) => setTimeout(r, 900));
      out.push(`${w}x${h} ${st}: ${measure(f.contentWindow).join(" | ") || "ok"}`);
      f.remove();
    }
  }
  return out.join("\n");
}
