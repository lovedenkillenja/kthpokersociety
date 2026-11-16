// Interactive "How to play & Hand rankings" guide dialog (sound lives in table-sound.js).
// Built with safe DOM construction and CSS playing cards per docs/poker/STYLE_GUIDE.md.

import { createCard, createPill, wireDialog } from "./components.js";

const HAND_RANKINGS = Object.freeze([
  {
    rank: "1. Royal Flush",
    note: "A-K-Q-J-10 of the same suit",
    cards: ["As", "Ks", "Qs", "Js", "Ts"]
  },
  {
    rank: "2. Straight Flush",
    note: "Five cards in sequence, same suit",
    cards: ["9h", "8h", "7h", "6h", "5h"]
  },
  {
    rank: "3. Four of a Kind",
    note: "Four cards of the same rank",
    cards: ["Qc", "Qd", "Qh", "Qs", "7c"]
  },
  {
    rank: "4. Full House",
    note: "Three of a kind plus a pair",
    cards: ["Kd", "Kh", "Ks", "9c", "9d"]
  },
  {
    rank: "5. Flush",
    note: "Any five cards of the same suit",
    cards: ["Ad", "Jd", "8d", "6d", "2d"]
  },
  {
    rank: "6. Straight",
    note: "Five cards in sequence (A can be high or low)",
    cards: ["9s", "8c", "7d", "6h", "5s"]
  },
  {
    rank: "7. Three of a Kind",
    note: "Three cards of the same rank",
    cards: ["8c", "8h", "8s", "Kd", "4c"]
  },
  {
    rank: "8. Two Pair",
    note: "Two different pairs plus a fifth card",
    cards: ["Jh", "Js", "4c", "4d", "Ac"]
  },
  {
    rank: "9. One Pair",
    note: "Two cards of the same rank",
    cards: ["Ah", "As", "Tc", "7d", "3s"]
  },
  {
    rank: "10. High Card",
    note: "Highest card plays when no pair or better is made",
    cards: ["As", "Qd", "9c", "6h", "3d"]
  }
]);

// Sound moved to ./table-sound.js (synthesized Web Audio engine). These names stay exported so existing imports keep working.
export { isSoundEnabled, toggleSoundEnabled, playTableCue } from "./table-sound.js";

export function createTutorialDialogController() {
  const dialog = document.getElementById("tutorial-dialog");
  const rankingsList = document.getElementById("tutorial-rankings-list");

  if (rankingsList && rankingsList.childNodes.length === 0) {
    HAND_RANKINGS.forEach((item) => {
      const li = document.createElement("li");
      li.className = "tutorial-rank-row";

      const meta = document.createElement("div");
      meta.className = "tutorial-rank-meta";
      const title = document.createElement("strong");
      title.textContent = item.rank;
      const note = document.createElement("span");
      note.className = "field-hint";
      note.textContent = item.note;
      meta.append(title, note);

      const cardsWrap = document.createElement("div");
      cardsWrap.className = "tutorial-mini-cards";
      item.cards.forEach((code) => {
        const cardEl = createCard(code);
        cardEl.classList.add("playing-card--mini");
        cardsWrap.appendChild(cardEl);
      });

      li.append(meta, cardsWrap);
      rankingsList.appendChild(li);
    });
  }

  wireDialog(dialog);

  function open() {
    if (!dialog) return;
    if (!dialog.open) {
      if (typeof dialog.showModal === "function") {
        dialog.showModal();
      } else {
        dialog.setAttribute("open", "");
      }
    }
  }

  function close() {
    if (dialog?.open) dialog.close();
  }

  document.querySelectorAll("[data-open-tutorial]").forEach((btn) => {
    btn.addEventListener("click", open);
  });

  window.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target?.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;
    if (e.key === "?") {
      e.preventDefault();
      if (dialog?.open) close();
      else open();
    }
  });

  return { open, close, createPill };
}
