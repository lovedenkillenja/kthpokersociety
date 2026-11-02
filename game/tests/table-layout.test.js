import test from "node:test";
import assert from "node:assert/strict";

import {
  extractInitials,
  detectTableLayoutMode,
  computeTableLayoutVars,
  isFullscreenSupported,
  getFullscreenElement,
  shouldShowAndroidRotateHint
} from "../lib/table-layout.js";

test("detectTableLayoutMode classifies desktop, mobile-portrait, mobile-landscape, and <320px fallback", () => {
  assert.equal(detectTableLayoutMode({ viewportWidth: 1920, viewportHeight: 1080 }), "desktop");
  assert.equal(detectTableLayoutMode({ viewportWidth: 1440, viewportHeight: 900 }), "desktop");
  assert.equal(detectTableLayoutMode({ viewportWidth: 1280, viewportHeight: 720 }), "desktop");
  assert.equal(detectTableLayoutMode({ viewportWidth: 1024, viewportHeight: 768 }), "desktop");

  assert.equal(detectTableLayoutMode({ viewportWidth: 390, viewportHeight: 844 }), "mobile-portrait");
  assert.equal(detectTableLayoutMode({ viewportWidth: 375, viewportHeight: 667 }), "mobile-portrait");

  assert.equal(detectTableLayoutMode({ viewportWidth: 844, viewportHeight: 390 }), "mobile-landscape");
  assert.equal(detectTableLayoutMode({ viewportWidth: 667, viewportHeight: 375 }), "mobile-landscape");
  assert.equal(detectTableLayoutMode({ viewportWidth: 932, viewportHeight: 430 }), "mobile-landscape");

  assert.equal(detectTableLayoutMode({ viewportWidth: 480, viewportHeight: 310 }), "scroll-fallback");
});

test("computeTableLayoutVars fits felt, 5 board cards, and seat columns within stage across all 8 required viewports", () => {
  const viewports = [
    { vw: 1920, vh: 1080, sw: 1920, sh: 944 },
    { vw: 1440, vh: 900, sw: 1440, sh: 764 },
    { vw: 1280, vh: 720, sw: 1280, sh: 586 },
    { vw: 1024, vh: 768, sw: 1024, sh: 634 },
    { vw: 390, vh: 844, sw: 390, sh: 702 },
    { vw: 375, vh: 667, sw: 375, sh: 525 },
    { vw: 844, vh: 390, sw: 704, sh: 344 },
    { vw: 667, vh: 375, sw: 527, sh: 329 }
  ];

  for (const vp of viewports) {
    for (const seatCount of [2, 4, 6]) {
      const m = computeTableLayoutVars({
        stageWidth: vp.sw,
        stageHeight: vp.sh,
        viewportWidth: vp.vw,
        viewportHeight: vp.vh,
        seatCount
      });

      assert.ok(m.feltW <= vp.sw, `feltW (${m.feltW}) > sw (${vp.sw}) at ${vp.vw}x${vp.vh}`);
      assert.ok(m.feltH <= vp.sh, `feltH (${m.feltH}) > sh (${vp.sh}) at ${vp.vw}x${vp.vh}`);
      assert.ok(m.boardCardW >= 32 && m.boardCardH >= 44);
      assert.ok(m.selfCardW >= m.boardCardW);

      if (m.mode === "desktop" || m.mode === "mobile-landscape") {
        const innerW = m.feltW - m.feltPadX * 2;
        const centerColW = innerW - m.seatColW * 2;
        assert.ok(
          centerColW >= m.boardCardW * 5 + 16,
          `centerColW (${centerColW}) too narrow for 5 board cards (${m.boardCardW * 5}) at ${vp.vw}x${vp.vh}`
        );
      } else {
        const innerW = m.feltW - m.feltPadX * 2;
        assert.ok(innerW >= m.boardCardW * 5 + 16);
      }
    }
  }

  // Verify desktop cards scale larger on 1920x1080 than 1280x720
  const m720 = computeTableLayoutVars({ stageWidth: 1280, stageHeight: 586, viewportWidth: 1280, viewportHeight: 720 });
  const m1080 = computeTableLayoutVars({ stageWidth: 1920, stageHeight: 944, viewportWidth: 1920, viewportHeight: 1080 });
  assert.ok(m1080.boardCardW > m720.boardCardW);
  assert.ok(m1080.feltW > m720.feltW);
});

test("Fullscreen capability detection, webkit fallback, and one-time Android portrait rotate hint", () => {
  assert.equal(isFullscreenSupported(null), false);
  // iPhone Safari: no requestFullscreen on documentElement
  assert.equal(isFullscreenSupported({ fullscreenEnabled: false, documentElement: {} }), false);
  // Standard Fullscreen API
  const stdDoc = { fullscreenEnabled: true, documentElement: { requestFullscreen() {} } };
  assert.equal(isFullscreenSupported(stdDoc), true);
  // WebKit-prefixed Fullscreen API
  const wkEl = { webkitRequestFullscreen() {} };
  const wkDoc = { webkitFullscreenEnabled: true, webkitFullscreenElement: wkEl, documentElement: wkEl };
  assert.equal(isFullscreenSupported(wkDoc), true);
  assert.equal(getFullscreenElement(wkDoc), wkEl);

  assert.equal(
    shouldShowAndroidRotateHint({
      userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/125.0",
      width: 390,
      height: 844,
      alreadyShown: false
    }),
    true
  );
  // Suppress if already shown once, in landscape, or not Android
  assert.equal(
    shouldShowAndroidRotateHint({
      userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/125.0",
      width: 390,
      height: 844,
      alreadyShown: true
    }),
    false
  );
  assert.equal(
    shouldShowAndroidRotateHint({
      userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/125.0",
      width: 844,
      height: 390,
      alreadyShown: false
    }),
    false
  );
  assert.equal(
    shouldShowAndroidRotateHint({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)",
      width: 768,
      height: 1024,
      alreadyShown: false
    }),
    false
  );

  assert.equal(extractInitials("Alice Lindqvist"), "AL");
  assert.equal(extractInitials("kth"), "KT");
  assert.equal(extractInitials(""), "P");
});
