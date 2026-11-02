// M6.1 Table Shell UI helpers: container-fit CSS variable syncing, Fullscreen API toggle
// (with webkit fallback & one-time Android portrait rotate hint), drawer dialog, and connection banner.

import {
  computeTableLayoutVars,
  isFullscreenSupported,
  getFullscreenElement,
  shouldShowAndroidRotateHint
} from "../lib/table-layout.js";
import { showToast } from "./components.js";

export function createTableShellUI({ els, getTable, onExitToLobby, onNavigateView, onOpenAuth, onReconnect }) {
  let connState = "CONNECTING";
  let rotateHintShown = false;
  try {
    rotateHintShown = sessionStorage.getItem("kth_poker_rotate_hint_shown") === "1";
  } catch (_err) {
    // Ignore storage restriction
  }

  function syncLayoutMetrics() {
    if (!els.viewTable || els.viewTable.hidden || !els.stage) return;
    const vv = window.visualViewport;
    const vw = Math.round(vv?.width || window.innerWidth || 375);
    const vh = Math.round(vv?.height || window.innerHeight || 667);
    const rect = els.stage.getBoundingClientRect();
    const sw = Math.round(rect.width || vw);
    const sh = Math.round(rect.height || Math.max(240, vh - 120));
    const table = getTable();
    const seatCount = Math.max(2, table?.seats?.length || table?.maxSeats || 6);

    const m = computeTableLayoutVars({
      stageWidth: sw,
      stageHeight: sh,
      viewportWidth: vw,
      viewportHeight: vh,
      seatCount
    });
    const st = els.viewTable.style;
    st.setProperty("--felt-w", `${m.feltW}px`);
    st.setProperty("--felt-h", `${m.feltH}px`);
    st.setProperty("--felt-pad-x", `${m.feltPadX}px`);
    st.setProperty("--felt-pad-y", `${m.feltPadY}px`);
    st.setProperty("--felt-radius", `${m.feltRadius}px`);
    st.setProperty("--seat-col-w", `${m.seatColW}px`);
    st.setProperty("--board-card-w", `${m.boardCardW}px`);
    st.setProperty("--board-card-h", `${m.boardCardH}px`);
    st.setProperty("--self-card-w", `${m.selfCardW}px`);
    st.setProperty("--self-card-h", `${m.selfCardH}px`);
    st.setProperty("--opp-card-w", `${m.oppCardW}px`);
    st.setProperty("--opp-card-h", `${m.oppCardH}px`);
    els.viewTable.dataset.layoutMode = m.mode;
  }

  function syncFullscreenButton() {
    if (!els.fullscreenBtn) return;
    if (!isFullscreenSupported(document)) {
      els.fullscreenBtn.hidden = true;
      return;
    }
    els.fullscreenBtn.hidden = false;
    const active = Boolean(getFullscreenElement(document));
    els.fullscreenBtn.setAttribute("aria-pressed", String(active));
    els.fullscreenBtn.setAttribute("aria-label", active ? "Exit fullscreen" : "Enter fullscreen");
    els.fullscreenBtn.textContent = active ? "✕" : "⛶";
  }

  async function toggleFullscreen() {
    if (!isFullscreenSupported(document)) return;
    try {
      if (getFullscreenElement(document)) {
        if (document.exitFullscreen) await document.exitFullscreen();
        else if (document.webkitExitFullscreen) await document.webkitExitFullscreen();
      } else {
        const root = document.documentElement;
        if (root.requestFullscreen) await root.requestFullscreen();
        else if (root.webkitRequestFullscreen) await root.webkitRequestFullscreen();

        try {
          if (window.screen?.orientation && typeof window.screen.orientation.lock === "function") {
            await window.screen.orientation.lock("landscape");
          }
        } catch (_lockErr) {
          // Expected on devices/browsers disallowing orientation lock; never rely on it
        }

        if (
          shouldShowAndroidRotateHint({
            userAgent: navigator.userAgent,
            width: window.innerWidth,
            height: window.innerHeight,
            alreadyShown: rotateHintShown
          })
        ) {
          rotateHintShown = true;
          try {
            sessionStorage.setItem("kth_poker_rotate_hint_shown", "1");
          } catch (_e) {
            // Ignore
          }
          showToast("Rotate your phone for a bigger table");
        }
      }
    } catch (_err) {
      // Ignore user-cancelled fullscreen request
    }
    syncFullscreenButton();
    syncLayoutMetrics();
  }

  function setBanner(pillText, pillClass, bannerText = "", btnText = "", mode = "") {
    if (els.connPill) {
      els.connPill.textContent = pillText;
      els.connPill.className = `${pillClass} table-topbar__desktop`;
    }
    if (!els.connBanner) return;
    els.connBanner.hidden = !bannerText;
    if (bannerText) {
      els.connBannerText.textContent = bannerText;
      els.connBannerBtn.textContent = btnText;
      els.connBannerBtn.dataset.mode = mode;
    }
  }

  function updateConnectionBanner(nextStatus) {
    if (nextStatus) connState = nextStatus;
    const table = getTable();
    if (table?.status === "closed") {
      setBanner("Closed", "pill pill--danger", "Table closed. Return to lobby to join another table.", "Lobby", "lobby");
    } else if (connState === "UNAUTHORIZED") {
      setBanner("Expired", "pill pill--danger", "Session expired. Log in again to return to your seat.", "Log in", "login");
    } else if (connState === "OFFLINE") {
      setBanner("Offline", "pill pill--danger", "Connection lost. Reconnecting…", "Reconnect", "reconnect");
    } else {
      setBanner("Live", "pill pill--brand");
    }
  }

  function openDrawer() {
    if (!els.drawerDialog || els.drawerDialog.open) return;
    if (typeof els.drawerDialog.showModal === "function") els.drawerDialog.showModal();
    else els.drawerDialog.setAttribute("open", "");
  }

  function closeDrawer() {
    if (!els.drawerDialog || !els.drawerDialog.open) return;
    if (typeof els.drawerDialog.close === "function") els.drawerDialog.close();
    else els.drawerDialog.removeAttribute("open");
  }

  function wireShellEvents({ onCleanupAndLobby }) {
    syncFullscreenButton();
    document.addEventListener("fullscreenchange", () => { syncFullscreenButton(); syncLayoutMetrics(); });
    document.addEventListener("webkitfullscreenchange", () => { syncFullscreenButton(); syncLayoutMetrics(); });
    window.addEventListener("resize", syncLayoutMetrics);
    window.visualViewport?.addEventListener("resize", syncLayoutMetrics);
    if (typeof ResizeObserver === "function" && els.stage) {
      new ResizeObserver(() => syncLayoutMetrics()).observe(els.stage);
    }

    els.lobbyBtn?.addEventListener("click", () => onExitToLobby());
    els.fullscreenBtn?.addEventListener("click", () => toggleFullscreen());
    els.drawerBtn?.addEventListener("click", () => openDrawer());
    els.historyOpenBtn?.addEventListener("click", () => openDrawer());
    document.querySelectorAll("[data-close-drawer]").forEach((b) => b.addEventListener("click", () => closeDrawer()));
    els.drawerDialog?.addEventListener("click", (e) => { if (e.target === els.drawerDialog) closeDrawer(); });
    document.querySelectorAll("[data-drawer-jump]").forEach((btn) => {
      btn.addEventListener("click", () => {
        closeDrawer();
        const target = btn.getAttribute("data-drawer-jump") || "lobby";
        if (typeof onNavigateView === "function") onNavigateView(target);
        else onExitToLobby();
      });
    });

    els.connBannerBtn?.addEventListener("click", async () => {
      const mode = els.connBannerBtn.dataset.mode;
      if (mode === "lobby") onCleanupAndLobby();
      else if (mode === "login") { if (typeof onOpenAuth === "function") onOpenAuth("login"); }
      else await onReconnect();
    });
  }

  return {
    syncLayoutMetrics,
    updateConnectionBanner,
    openDrawer,
    closeDrawer,
    wireShellEvents
  };
}
