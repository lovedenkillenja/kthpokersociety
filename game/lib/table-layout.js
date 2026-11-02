// Pure layout, sizing, fullscreen capability, and avatar helpers for M6.1 fit-to-screen table UI.
// Zero DOM dependencies unless a `doc` object is passed in, so every helper is testable with `node --test`.

function clamp(val, min, max) {
  return Math.min(max, Math.max(min, val));
}

/**
 * Extracts 1–2 uppercase initials from a player's display name for compact mobile seat chips.
 */
export function extractInitials(displayName = "") {
  const cleaned = String(displayName || "").trim();
  if (!cleaned) return "P";
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0] || ""}${parts[1][0] || ""}`.toUpperCase();
  }
  return cleaned.slice(0, 2).toUpperCase();
}

/**
 * Classifies the active viewport into one of the M6.1 table layout modes:
 * - `"scroll-fallback"`: extreme tiny height (`< 320px`), allows page scroll instead of clipping
 * - `"mobile-landscape"`: `width > height` and `height <= 500px` (`@media (orientation: landscape) and (max-height: 500px)`)
 * - `"desktop"`: `width >= 961px` (`1024x768`, `1280x720`, `1440x900`, `1920x1080`, etc.)
 * - `"mobile-portrait"`: `width <= 960px` and not short landscape (`375x667`, `390x844`, portrait tablets)
 */
export function detectTableLayoutMode({ viewportWidth = 375, viewportHeight = 667 } = {}) {
  const w = Math.max(1, Number(viewportWidth || 375));
  const h = Math.max(1, Number(viewportHeight || 667));
  if (h < 320) return "scroll-fallback";
  if (w > h && h <= 500) return "mobile-landscape";
  if (w >= 961) return "desktop";
  return "mobile-portrait";
}

/**
 * Computes container-relative pixel metrics (applied as CSS custom properties on `#view-table`)
 * so the felt, seats, community cards, and player hole cards fill the available stage cleanly
 * without overflowing or scrolling across desktop, mobile portrait, and mobile landscape.
 */
export function computeTableLayoutVars({
  stageWidth = 375,
  stageHeight = 500,
  viewportWidth = stageWidth,
  viewportHeight = stageHeight + 140,
  seatCount = 6
} = {}) {
  const mode = detectTableLayoutMode({ viewportWidth, viewportHeight });
  const sw = Math.max(260, Math.floor(Number(stageWidth || 375)));
  const sh = Math.max(220, Math.floor(Number(stageHeight || 500)));
  const opponentsCount = clamp(Math.max(1, Number(seatCount || 6) - 1), 1, 5);

  if (mode === "desktop") {
    const padOuterX = clamp(Math.round(sw * 0.025), 16, 44);
    const padOuterY = clamp(Math.round(sh * 0.025), 10, 28);
    const maxFeltW = sw - padOuterX * 2;
    const maxFeltH = sh - padOuterY * 2;

    // Wide oval ratio ~1.72..2.05, constrained to available stage box
    const feltH = clamp(maxFeltH, 420, 900);
    const feltW = clamp(Math.min(maxFeltW, Math.round(feltH * 1.92)), 860, 1560);
    const actualFeltW = Math.min(maxFeltW, feltW);
    const actualFeltH = Math.min(maxFeltH, feltH);

    // Scale cards & seat pods proportionally to both width and height
    const unit = Math.min(actualFeltH / 540, actualFeltW / 980);
    const boardCardW = clamp(Math.round(56 * unit), 48, 82);
    const boardCardH = Math.round(boardCardW * 1.4);
    const selfCardW = clamp(Math.round(62 * unit), 52, 88);
    const selfCardH = Math.round(selfCardW * 1.4);
    const oppCardW = clamp(Math.round(34 * unit), 28, 46);
    const oppCardH = Math.round(oppCardW * 1.4);

    // Ensure center column always fits 5 board cards + gaps comfortably
    const minCenterW = boardCardW * 5 + 56;
    const maxSideCol = Math.floor((actualFeltW - minCenterW - 48) / 2);
    const seatColW = clamp(Math.round(225 * unit), 185, Math.max(185, Math.min(290, maxSideCol)));

    return {
      mode,
      feltW: actualFeltW,
      feltH: actualFeltH,
      feltPadX: clamp(Math.round(22 * unit), 14, 34),
      feltPadY: clamp(Math.round(16 * unit), 10, 26),
      feltRadius: clamp(Math.round(actualFeltH * 0.34), 96, 240),
      seatColW,
      boardCardW,
      boardCardH,
      selfCardW,
      selfCardH,
      oppCardW,
      oppCardH
    };
  }

  if (mode === "mobile-landscape") {
    const actualFeltW = Math.max(360, sw - 10);
    const actualFeltH = Math.max(240, sh - 6);
    const hScale = actualFeltH / 320;
    const wScale = actualFeltW / 530;
    const unit = Math.min(hScale, wScale);

    const boardCardW = clamp(Math.round(35 * unit), 32, 46);
    const boardCardH = Math.round(boardCardW * 1.38);
    const selfCardW = clamp(Math.round(41 * unit), 36, 54);
    const selfCardH = Math.round(selfCardW * 1.38);
    const oppCardW = clamp(Math.round(19 * unit), 17, 26);
    const oppCardH = Math.round(oppCardW * 1.38);

    const minCenterW = boardCardW * 5 + 24;
    const maxSideCol = Math.floor((actualFeltW - minCenterW - 20) / 2);
    const seatColW = clamp(Math.round(154 * wScale), 132, Math.max(132, Math.min(196, maxSideCol)));

    return {
      mode,
      feltW: actualFeltW,
      feltH: actualFeltH,
      feltPadX: 8,
      feltPadY: 6,
      feltRadius: clamp(Math.round(actualFeltH * 0.32), 54, 120),
      seatColW,
      boardCardW,
      boardCardH,
      selfCardW,
      selfCardH,
      oppCardW,
      oppCardH
    };
  }

  // Mobile portrait (and scroll-fallback)
  const actualFeltW = Math.min(620, Math.max(290, sw - 12));
  const actualFeltH = mode === "scroll-fallback" ? Math.max(430, sh) : Math.max(380, sh - 8);

  // Opponent rows in 2-col grid: 1 opp -> 1 row, 2..3 opps -> 2 rows, 4..5 opps -> 3 rows
  const oppRows = opponentsCount <= 1 ? 1 : opponentsCount <= 3 ? 2 : 3;
  // Reserve space for opponent rows (~54px each) + pot/status (~68px) + paddings (~28px)
  const fixedVerticalOverhead = oppRows * 56 + 98;
  const remainingForCards = Math.max(112, actualFeltH - fixedVerticalOverhead);

  // Split remaining vertical space between community board cards and bottom self hole cards
  const maxBoardCardH = Math.floor(remainingForCards * 0.48);
  const maxWidthBoardCardW = Math.floor((actualFeltW - 44) / 5);
  const boardCardW = clamp(Math.min(maxWidthBoardCardW, Math.round(maxBoardCardH / 1.4)), 40, 62);
  const boardCardH = Math.round(boardCardW * 1.4);

  const maxSelfCardH = Math.floor(remainingForCards * 0.52);
  const selfCardW = clamp(Math.round(maxSelfCardH / 1.4), 44, 64);
  const selfCardH = Math.round(selfCardW * 1.4);

  return {
    mode,
    feltW: actualFeltW,
    feltH: actualFeltH,
    feltPadX: actualFeltW < 370 ? 8 : 12,
    feltPadY: actualFeltH < 520 ? 8 : 12,
    feltRadius: clamp(Math.round(actualFeltW * 0.1), 28, 44),
    seatColW: Math.floor((actualFeltW - 24) / 2),
    boardCardW,
    boardCardH,
    selfCardW,
    selfCardH,
    oppCardW: 22,
    oppCardH: 30
  };
}

/**
 * Checks whether the Fullscreen API (standard or webkit-prefixed) is available on `documentElement`.
 * Returns `false` on iPhone Safari where only `<video>` supports fullscreen.
 */
export function isFullscreenSupported(doc) {
  if (!doc || !doc.documentElement) return false;
  const enabled = Boolean(doc.fullscreenEnabled || doc.webkitFullscreenEnabled);
  const el = doc.documentElement;
  const canRequest =
    typeof el.requestFullscreen === "function" ||
    typeof el.webkitRequestFullscreen === "function";
  return enabled && canRequest;
}

/**
 * Returns the current fullscreen element (standard or webkit-prefixed), or `null`.
 */
export function getFullscreenElement(doc) {
  if (!doc) return null;
  return doc.fullscreenElement || doc.webkitFullscreenElement || null;
}

/**
 * Determines whether to show the one-time Android portrait hint ("Rotate your phone for a bigger table")
 * after fullscreen succeeds.
 */
export function shouldShowAndroidRotateHint({
  userAgent = "",
  width = 0,
  height = 0,
  alreadyShown = false
} = {}) {
  if (alreadyShown) return false;
  const isAndroid = /android/i.test(String(userAgent || ""));
  const isPortrait = Number(height) > Number(width);
  return isAndroid && isPortrait;
}
