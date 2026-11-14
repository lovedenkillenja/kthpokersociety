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

// Desktop felt cap: roughly 2:1, never edge to edge on wide screens
export const DESKTOP_FELT_MAX_W = 1000;
export const DESKTOP_FELT_MAX_H = 570;

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
    // A composed table, not a stretched one: the felt is capped (between 1.75:1 and 2.05:1, at most 1000px wide) and centred.
    const padX = clamp(Math.round(sw * 0.04), 24, 64);
    const padY = clamp(Math.round(sh * 0.04), 16, 32);
    let actualFeltH = Math.min(sh - padY * 2, DESKTOP_FELT_MAX_H);
    const actualFeltW = Math.min(DESKTOP_FELT_MAX_W, sw - padX * 2, Math.round(actualFeltH * 2.05));
    actualFeltH = Math.min(actualFeltH, Math.round(actualFeltW / 1.75));

    // Cards and seat plaques scale with the felt (1 = a 1000x570 felt)
    const unit = clamp(Math.min(actualFeltH / 570, actualFeltW / 1000), 0.6, 1);
    const boardCardW = clamp(Math.round(72 * unit), 44, 76);
    const boardCardH = Math.round(boardCardW * 1.4);
    const selfCardW = clamp(Math.round(74 * unit), Math.max(46, boardCardW), 80);
    const selfCardH = Math.round(selfCardW * 1.4);
    const oppCardW = clamp(Math.round(38 * unit), 26, 42);
    const oppCardH = Math.round(oppCardW * 1.4);

    // Seat plaque width: wide enough for a 12-character name at desktop type sizes
    const seatColW = clamp(Math.round(actualFeltW * 0.2), 160, 200);

    return {
      mode,
      feltW: actualFeltW,
      feltH: actualFeltH,
      feltPadX: clamp(Math.round(22 * unit), 14, 24),
      feltPadY: clamp(Math.round(16 * unit), 10, 18),
      feltRadius: Math.round(actualFeltH / 2),
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
    const selfCardW = clamp(Math.round(41 * unit), Math.max(36, boardCardW), 54);
    const selfCardH = Math.round(selfCardW * 1.38);
    const oppCardW = clamp(Math.round(19 * unit), 17, 26);
    const oppCardH = Math.round(oppCardW * 1.38);

    const minCenterW = boardCardW * 5 + 24;
    const maxSideCol = Math.floor((actualFeltW - minCenterW - 20) / 2);
    const seatColW = clamp(Math.round(actualFeltW * 0.17), 112, Math.max(112, Math.min(150, maxSideCol)));

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

  // Mobile portrait (and scroll-fallback): a tall stadium-shaped felt that fills the stage.
  // Seats sit along the edges (see getSeatSlots), the pot and the board sit in the middle.
  const actualFeltW = Math.min(620, Math.max(290, sw - 12));
  const actualFeltH = mode === "scroll-fallback" ? Math.max(430, sh) : Math.max(380, sh - 8);

  const boardCardW = clamp(
    Math.min(Math.round(actualFeltW * 0.125), Math.round(actualFeltH * 0.082)),
    36,
    58
  );
  const boardCardH = Math.round(boardCardW * 1.4);
  const selfCardW = clamp(Math.min(Math.round(actualFeltW * 0.14), Math.round(actualFeltH * 0.085)), Math.max(38, boardCardW), 64);
  const selfCardH = Math.round(selfCardW * 1.4);

  return {
    mode,
    feltW: actualFeltW,
    feltH: actualFeltH,
    feltPadX: actualFeltW < 370 ? 8 : 12,
    feltPadY: actualFeltH < 520 ? 8 : 12,
    feltRadius: Math.round(actualFeltW / 2),
    seatColW: clamp(Math.round(actualFeltW * 0.32), 108, 150),
    boardCardW,
    boardCardH,
    selfCardW,
    selfCardH,
    oppCardW: 22,
    oppCardH: 30
  };
}

// Seat positions as [x%, y%] of the felt box, clockwise from the bottom-centre slot 0 (the player's own seat).
// "portrait" is the tall stadium on phones; "wide" is the phone-landscape oval; "desktop" is the capped ~2:1 oval,
// where slot 0 is only nominal (the own seat is anchored to the bottom edge with CSS) and the side seats sit further
// in so the larger plaques stay clear of the rail.
const SEAT_SLOTS = {
  portrait: {
    2: [[50, 87], [50, 11]],
    3: [[50, 87], [24, 23], [76, 23]],
    4: [[50, 87], [22, 67], [50, 8], [78, 67]],
    5: [[50, 87], [22, 68], [22, 22], [78, 22], [78, 68]],
    6: [[50, 87], [22, 68], [22, 22], [50, 8], [78, 22], [78, 68]]
  },
  desktop: {
    2: [[50, 90], [50, 14]],
    3: [[50, 90], [17, 40], [83, 40]],
    4: [[50, 90], [17, 52], [50, 14], [83, 52]],
    5: [[50, 90], [18, 62], [27, 19], [73, 19], [82, 62]],
    6: [[50, 90], [18, 62], [18, 30], [50, 14], [82, 30], [82, 62]]
  },
  wide: {
    2: [[50, 88], [50, 13]],
    3: [[50, 88], [17, 38], [83, 38]],
    4: [[50, 88], [14, 52], [50, 13], [86, 52]],
    5: [[50, 88], [14, 64], [30, 15], [70, 15], [86, 64]],
    6: [[50, 88], [13, 66], [20, 27], [50, 13], [80, 27], [87, 66]]
  }
};

/** Number of seat positions drawn around the felt (2..6). */
export function clampSeatTotal(maxSeats) {
  return clamp(Math.round(Number(maxSeats) || 6), 2, 6);
}

/**
 * Returns the [x%, y%] positions for `total` seats in the given shape ("portrait" | "wide" | "desktop").
 * Index 0 is always the bottom-centre seat; indexes then run clockwise (bottom-left first).
 */
export function getSeatSlots(total, shape = "portrait") {
  const set = SEAT_SLOTS[shape] || SEAT_SLOTS.portrait;
  return set[clampSeatTotal(total)];
}

/**
 * Side of a seat on which its bet chip sits, so the chip lands between the seat and the pot:
 * seats on the left of the felt put it to their right, seats on the right to their left,
 * top-centre seats below themselves and bottom-centre seats above themselves.
 * @param {number[]} slotPos [x%, y%] of the seat (portrait and wide positions agree on the side)
 * @returns {"right"|"left"|"down"|"up"}
 */
export function betDirection(slotPos) {
  const [x, y] = slotPos;
  if (x < 38) return "right";
  if (x > 62) return "left";
  return y < 50 ? "down" : "up";
}

/**
 * Assigns every occupied seat a slot index (0 = bottom centre) and lists the slots left open.
 * - Seated player: own seat is slot 0; others follow clockwise by seat number relative to the player.
 * - Observer: nobody sits at slot 0 (the buy-in form lives there); occupied seats fill slots 1.. in seat order.
 * Slots that cannot be placed relatively (unexpected seat numbers) fall back to the next free slot.
 * @returns {{ total: number, slotBySeat: Map<number, number>, openSlots: number[] }}
 */
export function assignSeatSlots({ seatNos = [], selfSeatNo = null, maxSeats = 6 } = {}) {
  const total = clampSeatTotal(maxSeats);
  const slotBySeat = new Map();
  const used = new Set();
  const sorted = [...seatNos].map(Number).sort((a, b) => a - b);
  const hasSelf = selfSeatNo !== null && selfSeatNo !== undefined && sorted.includes(Number(selfSeatNo));

  if (hasSelf) {
    const me = Number(selfSeatNo);
    sorted.forEach((no) => {
      const rel = (((no - me) % total) + total) % total;
      if (no >= 0 && no < total && !used.has(rel)) {
        slotBySeat.set(no, rel);
        used.add(rel);
      }
    });
  } else {
    used.add(0);
  }
  sorted.forEach((no) => {
    if (slotBySeat.has(no)) return;
    let slot = 1;
    while (slot < total && used.has(slot)) slot += 1;
    if (slot < total) {
      slotBySeat.set(no, slot);
      used.add(slot);
    }
  });

  const openSlots = [];
  for (let i = 1; i < total; i += 1) if (!used.has(i)) openSlots.push(i);
  return { total, slotBySeat, openSlots };
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
