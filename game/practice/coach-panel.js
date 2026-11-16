// Coach panel for practice mode: a collapsible strip above the action bar on phones,
// a side panel next to the table from 1024px. Text comes from game/lib/practice-coach.js.

const EXPANDED_KEY = "kth_practice_coach_expanded";

function readExpanded() {
  try { return localStorage.getItem(EXPANDED_KEY) === "1"; } catch (_err) { return false; }
}
function writeExpanded(on) {
  try { localStorage.setItem(EXPANDED_KEY, on ? "1" : "0"); } catch (_err) { /* ignore */ }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function createCoachPanel() {
  const root = el("section", "coach");
  root.id = "practice-coach";
  root.setAttribute("aria-label", "Coach");
  root.hidden = true;

  const toggle = el("button", "coach__toggle");
  toggle.type = "button";
  toggle.setAttribute("aria-controls", "practice-coach-body");
  const title = el("span", "coach__title", "Coach");
  const headline = el("span", "coach__headline tabular", "Waiting for your turn");
  const chev = el("span", "coach__chev");
  chev.setAttribute("aria-hidden", "true");
  toggle.append(title, headline, chev);

  const body = el("div", "coach__body");
  body.id = "practice-coach-body";
  const lines = el("div", "coach__lines");
  lines.setAttribute("aria-live", "polite");
  const equity = el("p", "coach__equity tabular");
  const odds = el("p", "coach__odds tabular");
  const verdict = el("p", "coach__verdict");
  const outs = el("p", "coach__outs tabular");
  lines.append(equity, odds, verdict, outs);

  const why = el("details", "coach__why");
  const whySummary = el("summary", "", "Why?");
  const whyList = el("ul", "coach__why-list");
  why.append(whySummary, whyList);

  const review = el("p", "coach__review");
  review.hidden = true;
  const reviewLabel = el("strong", "", "Last hand: ");
  const reviewText = el("span", "");
  review.append(reviewLabel, reviewText);

  const note = el("p", "coach__note", "Numbers are estimates against random hands, not promises. Good decisions pay in the long run.");

  body.append(lines, why, review, note);
  root.append(toggle, body);

  let expanded = readExpanded();
  let sideMode = false;

  function syncExpanded() {
    const open = sideMode || expanded;
    root.classList.toggle("coach--open", open);
    root.classList.toggle("coach--side", sideMode);
    body.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.disabled = sideMode;
  }

  toggle.addEventListener("click", () => {
    if (sideMode) return;
    expanded = !expanded;
    writeExpanded(expanded);
    syncExpanded();
  });

  function setLine(node, text) {
    node.textContent = text || "";
    node.hidden = !text;
  }

  function setWhy(items) {
    whyList.replaceChildren(...(items || []).map((t) => el("li", "", t)));
    why.hidden = !items || items.length === 0;
  }

  syncExpanded();

  return {
    element: root,
    setEnabled(on) {
      root.hidden = !on;
    },
    setSideMode(on) {
      sideMode = Boolean(on);
      syncExpanded();
    },
    /** Shows the advice for the player's turn (`buildCoachAdvice` result). */
    showTurn(advice) {
      root.classList.add("coach--turn");
      headline.textContent = advice.summary;
      setLine(equity, advice.equityText);
      setLine(odds, advice.potOddsText);
      setLine(verdict, advice.verdict.kind === "pending" ? "" : advice.verdict.text);
      verdict.dataset.kind = advice.verdict.kind;
      setLine(outs, advice.outsText);
      setWhy(advice.why);
    },
    showWaiting(text = "Waiting for your turn") {
      root.classList.remove("coach--turn");
      headline.textContent = text;
      setLine(equity, "The coach shows the numbers when it is your turn.");
      setLine(odds, "");
      setLine(verdict, "");
      setLine(outs, "");
      setWhy([]);
      why.open = false;
    },
    showReview(text) {
      reviewText.textContent = text || "";
      review.hidden = !text;
    }
  };
}
