// Table sound engine: small, quiet, synthesized with the Web Audio API (no audio files, no downloads, no libraries).
//
// Design (see docs/poker/STYLE_GUIDE.md, "Sound"):
// - Every sound is built from short filtered noise bursts and tuned resonant partials with real envelopes.
//   Pitch, gain and timing vary a little on every play, and each event is panned by where on the table it happens.
// - Chain: voices -> panner -> bus -> gentle compressor -> soft clipper (hard ceiling about -12.5 dBFS) -> master gain.
// - The pure part (`planSoundCues`) turns the same state diff that drives the animations (`diffSnapshots`) into a list
//   of cues with times, so sound and motion stay in sync and nothing plays on first render, reconnect or plain re-render.
// - Off by default; the AudioContext is only created or resumed on a user gesture; muted while the tab is hidden.

import { dealOrder, TIMING, winTimeline } from "./table-motion.js";

const STORAGE_KEY = "kth_poker_sound";
const VOLUME_KEY = "kth_poker_volume";
const VOLUME_GAIN = Object.freeze({ low: 0.5, normal: 1 });
const PAN_LIMIT = 0.65;
const MAX_CUES_PER_BATCH = 16;
const MAX_CUES_PER_SECOND = 24;

export const CUE_NAMES = Object.freeze(["deal", "flip", "bet", "sweep", "check", "fold", "turn", "tick", "win"]);
const PRIORITY = Object.freeze({ turn: 3, win: 3, tick: 2, sweep: 1, flip: 1, check: 1, fold: 1, bet: 1, deal: 0 });

/* ---------------------------------------------------------------- pure part (tested in node) */

/** How many ceramic clicks a bet makes: 2 for a small bet up to 5 for a big one. */
export function clickCountForBet(amount, bb = 20) {
  const n = Number(amount) / Math.max(1, Number(bb) || 20);
  if (!(n > 0)) return 2;
  if (n <= 1.5) return 2;
  if (n <= 4) return 3;
  if (n <= 10) return 4;
  return 5;
}

/** Stereo position for a seat from its x position on the table (0..100 %), kept gentle. */
export function panForX(xPercent) {
  const x = Number(xPercent);
  if (!Number.isFinite(x)) return 0;
  return Math.max(-PAN_LIMIT, Math.min(PAN_LIMIT, ((x - 50) / 50) * PAN_LIMIT));
}

/** 5 and 10 seconds left: a soft tick, once each per turn (the caller supplies the dedupe key). */
export function timerWarningCue(remainingSeconds, isOwnTurn) {
  if (!isOwnTurn) return null;
  return remainingSeconds === 10 || remainingSeconds === 5 ? { cue: "tick", at: 0, pan: 0, gain: remainingSeconds === 5 ? 1 : 0.8, prio: PRIORITY.tick } : null;
}

/**
 * Maps diff events to cues: `[{ cue, at (seconds from now), pan, gain, ...params }]`, sorted by time.
 * `events` is the result of `diffSnapshots`; `ctx` is table context:
 * `{ seatNos, selfSeatNo, seatPans: {seatNo: -1..1}, bb, allInSeats: [seatNo], win }` where `win` is `computeWinSpec(...)`.
 * Times line up with the animation constants in table-motion.js (`TIMING`, `winTimeline`).
 */
export function planSoundCues(events, ctx = {}) {
  const cues = [];
  if (!events || typeof events !== "object") return cues;
  const pans = ctx.seatPans || {};
  const panOf = (seatNo) => (Number.isFinite(pans[seatNo]) ? pans[seatNo] : 0);
  const bb = Number(ctx.bb) > 0 ? Number(ctx.bb) : 20;
  const allIn = new Set(ctx.allInSeats || []);
  const add = (cue, at, pan = 0, extra = {}) => cues.push({ cue, at: Math.max(0, at), pan, gain: 1, prio: PRIORITY[cue] ?? 1, ...extra });
  const ms = (n) => n / 1000;

  if (events.deal) {
    const seatNos = Array.isArray(ctx.dealtSeats) && ctx.dealtSeats.length ? ctx.dealtSeats : ctx.seatNos || [];
    const order = dealOrder(seatNos, events.deal.dealerSeat);
    let i = 0;
    for (let round = 0; round < 2; round += 1) {
      order.forEach((seatNo) => {
        if (i < 12) add("deal", ms(i * TIMING.DEAL_STAGGER_MS), panOf(seatNo), { land: ms(TIMING.DEAL_MS) * 0.85, gain: 0.9 });
        i += 1;
      });
    }
  }

  if (events.board) {
    for (let i = events.board.from; i < events.board.to; i += 1) {
      add("flip", ms((i - events.board.from) * TIMING.BOARD_STAGGER_MS + TIMING.DEAL_MS * 0.9), 0);
    }
  }

  (events.folds || []).forEach((seatNo, k) => add("fold", ms(k * 60), panOf(seatNo)));
  (events.checks || []).forEach((seatNo, k) => add("check", ms(k * 60), panOf(seatNo)));

  const commits = Array.isArray(events.commits) ? events.commits : [];
  commits.slice(0, 6).forEach(({ seatNo, delta }, k) => {
    const cascade = (allIn.has(seatNo) && delta >= bb * 4) || delta >= bb * 10;
    add("bet", ms(60 + k * 70), panOf(seatNo), { count: clickCountForBet(delta, bb), cascade });
  });

  if (events.sweep && events.sweep.length) add("sweep", ms(TIMING.CHIP_MS * 0.6), 0, { gain: 0.9 });

  if (events.payouts && events.payouts.length) {
    const win = ctx.win || null;
    const tl = winTimeline(events, win ? win.kind : "showdown");
    if (win && win.kind === "showdown") {
      (events.reveal || []).slice(0, 3).forEach((seatNo, k) => add("flip", ms(tl.reveal + 40 + k * 70), panOf(seatNo), { gain: 0.8 }));
    }
    const selfWon = Boolean(win?.selfWins) || (ctx.selfSeatNo !== null && ctx.selfSeatNo !== undefined && events.payouts.some((p) => p.seatNo === ctx.selfSeatNo));
    if (selfWon) {
      add("win", ms(tl.payout + 60), panOf(ctx.selfSeatNo), { big: Boolean(win?.big) });
    } else {
      // Someone else wins: only the soft pot slide, no jingle
      events.payouts.slice(0, 2).forEach(({ seatNo }, k) => add("sweep", ms(tl.payout + 60 + k * 90), panOf(seatNo), { gain: 0.75 }));
    }
  }

  return cues.sort((a, b) => a.at - b.at);
}

/* ---------------------------------------------------------------- synthesis */

let rnd = Math.random;
/** Test hook: replace the random source (for deterministic renders). */
export function setRandomSource(fn) { rnd = typeof fn === "function" ? fn : Math.random; }
const between = (a, b) => a + rnd() * (b - a);
const vary = (amount) => 1 + (rnd() - 0.5) * 2 * amount;

const noiseBuffers = new WeakMap();
function noiseBuffer(ctx) {
  let buf = noiseBuffers.get(ctx);
  if (!buf) {
    const len = Math.floor(ctx.sampleRate * 1.2);
    buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i += 1) data[i] = Math.random() * 2 - 1;
    noiseBuffers.set(ctx, buf);
  }
  return buf;
}

/** Attack/decay envelope that starts and ends at (almost) zero, so nothing clicks. */
function envelope(param, t, peak, attack, decay) {
  param.setValueAtTime(0.0001, t);
  param.linearRampToValueAtTime(Math.max(0.0002, peak), t + attack);
  param.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

/** A short filtered noise burst. `f1` sweeps the filter from `f0` over the burst. */
function noise(ctx, out, t, { type = "bandpass", f0 = 2000, f1 = f0, q = 1, peak = 0.05, attack = 0.004, decay = 0.05 }) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.Q.value = q;
  filter.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) filter.frequency.exponentialRampToValueAtTime(f1, t + attack + decay);
  const g = ctx.createGain();
  envelope(g.gain, t, peak, attack, decay);
  src.connect(filter);
  filter.connect(g);
  g.connect(out);
  src.start(t, Math.random() * 0.8);
  src.stop(t + attack + decay + 0.03);
}

/** A tuned resonant partial: sine (or other) with an envelope; `fEnd` bends the pitch. */
function tone(ctx, out, t, { f = 440, fEnd = f, type = "sine", peak = 0.05, attack = 0.004, decay = 0.1 }) {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(f, t);
  if (fEnd !== f) osc.frequency.exponentialRampToValueAtTime(fEnd, t + attack + decay);
  const g = ctx.createGain();
  envelope(g.gain, t, peak, attack, decay);
  osc.connect(g);
  g.connect(out);
  osc.start(t);
  osc.stop(t + attack + decay + 0.03);
}

/** One ceramic chip click: a bright filtered tick, two inharmonic ringing partials and a short body. */
function chipClick(ctx, out, t, p, g = 1) {
  noise(ctx, out, t, { f0: 3800 * p, q: 5, peak: 0.075 * g, attack: 0.001, decay: 0.022 });
  tone(ctx, out, t, { f: 2650 * p, peak: 0.032 * g, attack: 0.001, decay: 0.055 });
  tone(ctx, out, t, { f: 4130 * p, peak: 0.016 * g, attack: 0.001, decay: 0.03 });
  tone(ctx, out, t, { f: 920 * p, fEnd: 760 * p, peak: 0.028 * g, attack: 0.001, decay: 0.04 });
}

function swish(ctx, out, t, { dur, f0, f1, peak, q = 0.9 }) {
  noise(ctx, out, t, { f0, f1, q, peak, attack: dur * 0.35, decay: dur * 0.65 });
}

function tap(ctx, out, t, p, g = 1) {
  noise(ctx, out, t, { type: "lowpass", f0: 1500 * p, q: 0.7, peak: 0.07 * g, attack: 0.001, decay: 0.02 });
  tone(ctx, out, t, { f: 190 * p, fEnd: 115 * p, peak: 0.05 * g, attack: 0.001, decay: 0.05 });
}

/** A warm bell-ish note: fundamental plus a faint octave and a faint twelfth, soft attack, long gentle decay. */
function warmNote(ctx, out, t, f, { peak = 0.06, decay = 0.5 } = {}) {
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 3200;
  lp.connect(out);
  tone(ctx, lp, t, { f, peak, attack: 0.012, decay });
  tone(ctx, lp, t, { f: f * 2, peak: peak * 0.26, attack: 0.012, decay: decay * 0.6 });
  tone(ctx, lp, t, { f: f * 3.01, peak: peak * 0.08, attack: 0.012, decay: decay * 0.35 });
}

function rattle(ctx, out, t, p, { count = 7, span = 0.28, g = 0.5 } = {}) {
  for (let i = 0; i < count; i += 1) {
    const at = t + (i / count) * span * between(0.85, 1.1) + between(0, 0.012);
    chipClick(ctx, out, at, p * between(0.9, 1.12), g * (1 - (i / count) * 0.55) * between(0.7, 1));
  }
  swish(ctx, out, t, { dur: span * 0.9, f0: 1500 * p, f1: 800 * p, peak: 0.028 * g * 2, q: 0.8 });
}

const RENDERERS = {
  deal(ctx, out, t, c) {
    const land = c.land || 0.27;
    swish(ctx, out, t + Math.max(0, land - 0.2), { dur: 0.12, f0: 2300 * c.pitch, f1: 4800 * c.pitch, peak: 0.045 * c.gain });
    tap(ctx, out, t + land, c.pitch, c.gain);
  },
  flip(ctx, out, t, c) {
    swish(ctx, out, t, { dur: 0.08, f0: 3000 * c.pitch, f1: 6000 * c.pitch, peak: 0.04 * c.gain });
    tap(ctx, out, t + 0.07, c.pitch * 1.1, c.gain * 0.95);
  },
  bet(ctx, out, t, c) {
    const n = c.cascade ? Math.round(between(8, 10)) : c.count || 3;
    let at = t;
    for (let i = 0; i < n; i += 1) {
      const fall = c.cascade ? 1 - (i / n) * 0.5 : 1;
      chipClick(ctx, out, at, c.pitch * between(0.92, 1.1), c.gain * fall * between(0.75, 1));
      at += c.cascade ? between(0.028, 0.05) * (1 + i * 0.04) : between(0.045, 0.075);
    }
    if (c.cascade) noise(ctx, out, t, { type: "bandpass", f0: 1200 * c.pitch, q: 0.7, peak: 0.03 * c.gain, attack: 0.05, decay: 0.3 });
  },
  sweep(ctx, out, t, c) {
    rattle(ctx, out, t, c.pitch, { count: 7, span: 0.28, g: 0.55 * c.gain });
  },
  check(ctx, out, t, c) {
    [0, between(0.1, 0.125)].forEach((dt, i) => {
      const at = t + dt;
      const g = c.gain * (i ? 0.85 : 1);
      tone(ctx, out, at, { f: 160 * c.pitch, fEnd: 95 * c.pitch, peak: 0.075 * g, attack: 0.002, decay: 0.09 });
      noise(ctx, out, at, { type: "lowpass", f0: 700 * c.pitch, q: 0.7, peak: 0.035 * g, attack: 0.001, decay: 0.03 });
    });
  },
  fold(ctx, out, t, c) {
    noise(ctx, out, t, { f0: 1900 * c.pitch, f1: 900 * c.pitch, q: 0.7, peak: 0.045 * c.gain, attack: 0.05, decay: 0.12 });
    noise(ctx, out, t + 0.1, { type: "lowpass", f0: 900 * c.pitch, q: 0.7, peak: 0.02 * c.gain, attack: 0.002, decay: 0.04 });
  },
  turn(ctx, out, t, c) {
    // Two warm notes, a fifth apart, quiet
    warmNote(ctx, out, t, 523.25 * c.pitch, { peak: 0.034 * c.gain, decay: 0.45 });
    warmNote(ctx, out, t + 0.14, 783.99 * c.pitch, { peak: 0.032 * c.gain, decay: 0.55 });
  },
  tick(ctx, out, t, c) {
    noise(ctx, out, t, { f0: 2200 * c.pitch, q: 3, peak: 0.075 * c.gain, attack: 0.001, decay: 0.02 });
    tone(ctx, out, t, { f: 1250 * c.pitch, peak: 0.03 * c.gain, attack: 0.001, decay: 0.03 });
  },
  win(ctx, out, t, c) {
    rattle(ctx, out, t, c.pitch, { count: c.big ? 9 : 7, span: c.big ? 0.34 : 0.28, g: 0.5 * c.gain });
    const f = 523.25 * c.pitch; // C5 E5 G5, a rising major figure
    const start = t + 0.12;
    const notes = c.big ? [1, 1.25, 1.5, 2] : [1, 1.25, 1.5];
    notes.forEach((m, i) => {
      const last = i === notes.length - 1;
      warmNote(ctx, out, start + i * 0.125, f * m, { peak: 0.045 * c.gain, decay: last ? (c.big ? 0.6 : 0.5) : 0.3 });
    });
    if (c.big) tone(ctx, out, start, { f: f / 2, peak: 0.03 * c.gain, attack: 0.04, decay: 0.7 });
  }
};

/** Builds the output chain on any BaseAudioContext. The soft clipper keeps the peak below about 0.24 (-12.4 dBFS). */
export function buildChain(ctx, volume = 1) {
  const input = ctx.createGain();
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -22;
  comp.knee.value = 12;
  comp.ratio.value = 5;
  comp.attack.value = 0.004;
  comp.release.value = 0.14;
  const shaper = ctx.createWaveShaper();
  const N = 2048;
  const curve = new Float32Array(N);
  for (let i = 0; i < N; i += 1) {
    const x = (i / (N - 1)) * 2 - 1;
    curve[i] = 0.235 * Math.tanh(x / 0.2);
  }
  shaper.curve = curve;
  shaper.oversample = "2x";
  const master = ctx.createGain();
  master.gain.value = volume;
  input.connect(comp);
  comp.connect(shaper);
  shaper.connect(master);
  master.connect(ctx.destination);
  return { input, master };
}

/** Schedules one planned cue at `t0 + cue.at`. Applies per-play variation in pitch, gain and timing, and stereo pan. */
export function scheduleCue(ctx, input, cue, t0) {
  const render = RENDERERS[cue.cue];
  if (!render) return;
  const bus = ctx.createGain();
  bus.gain.value = 1;
  let node = bus;
  if (typeof ctx.createStereoPanner === "function") {
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-PAN_LIMIT, Math.min(PAN_LIMIT, (Number(cue.pan) || 0) + between(-0.04, 0.04)));
    bus.connect(panner);
    node = panner;
  }
  node.connect(input);
  const t = t0 + (Number(cue.at) || 0) + between(-0.006, 0.01);
  render(ctx, bus, Math.max(t0, t), { ...cue, pitch: vary(0.04), gain: (Number(cue.gain) || 1) * vary(0.14) });
}

/* ---------------------------------------------------------------- live engine (browser) */

let enabled = false;
let volume = "normal";
let ac = null;
let chain = null;
let recent = [];
let lastTurnKey = null;
const listeners = new Set();
let wired = false;

function readStore(key, fallback) {
  try { return typeof window === "undefined" ? fallback : (window.localStorage?.getItem(key) ?? fallback); } catch (_err) { return fallback; }
}
function writeStore(key, value) {
  try { if (typeof window !== "undefined") window.localStorage?.setItem(key, value); } catch (_err) { /* ignore */ }
}

enabled = readStore(STORAGE_KEY, "off") === "on";
volume = readStore(VOLUME_KEY, "normal") === "low" ? "low" : "normal";

function emit() { listeners.forEach((fn) => { try { fn({ enabled, volume }); } catch (_err) { /* ignore */ } }); }
const hidden = () => typeof document !== "undefined" && document.hidden;

/** Creates or resumes the AudioContext. Only called from user gestures (toggle clicks, first tap or key press). */
export function unlockAudio() {
  if (!enabled || typeof window === "undefined") return false;
  try {
    if (!ac) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return false;
      ac = new Ctx();
      chain = buildChain(ac, VOLUME_GAIN[volume]);
    }
    if (ac.state === "suspended" && !hidden()) ac.resume().catch(() => {});
    return true;
  } catch (_err) {
    return false;
  }
}

function wire() {
  if (wired || typeof document === "undefined") return;
  wired = true;
  const gesture = () => { if (enabled) unlockAudio(); };
  ["pointerdown", "keydown", "touchend"].forEach((type) => document.addEventListener(type, gesture, { passive: true, capture: true }));
  document.addEventListener("visibilitychange", () => {
    if (!ac) return;
    if (document.hidden) ac.suspend?.().catch?.(() => {});
    else if (enabled) ac.resume?.().catch?.(() => {});
  });
}
wire();

export function isSoundEnabled() { return enabled; }
export function getVolume() { return volume; }
export function onSoundChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function setSoundEnabled(on) {
  enabled = Boolean(on);
  writeStore(STORAGE_KEY, enabled ? "on" : "off");
  if (enabled) unlockAudio();
  else if (ac?.state === "running") ac.suspend?.().catch?.(() => {});
  emit();
  return enabled;
}

/** Call from a click handler: the gesture lets the browser start audio. A quiet chip sound confirms "on". */
export function toggleSoundEnabled() {
  const on = setSoundEnabled(!enabled);
  if (on) playSoundCues([{ cue: "bet", at: 0, pan: 0, gain: 0.9, count: 2, prio: 1 }]);
  return on;
}

export function setVolume(level) {
  volume = level === "low" ? "low" : "normal";
  writeStore(VOLUME_KEY, volume);
  if (chain) chain.master.gain.value = VOLUME_GAIN[volume];
  emit();
  return volume;
}

/**
 * Plays planned cues now. Does nothing when sound is off, the context is not running (no user gesture yet), or the tab
 * is hidden. Throttled: a burst of state updates cannot stack dozens of sounds, and there is one "your turn" chime per key.
 */
export function playSoundCues(cues) {
  if (!enabled || !ac || !chain || hidden() || !Array.isArray(cues) || !cues.length) return false;
  try {
    if (ac.state !== "running") { unlockAudio(); return false; }
    let list = cues.filter((c) => {
      if (c.cue !== "turn") return true;
      if (c.key && c.key === lastTurnKey) return false;
      lastTurnKey = c.key || lastTurnKey;
      return true;
    });
    const now = ac.currentTime;
    recent = recent.filter((r) => now - r.t < 1);
    const room = Math.max(0, MAX_CUES_PER_SECOND - recent.reduce((n, r) => n + r.n, 0));
    const cap = Math.min(MAX_CUES_PER_BATCH, room);
    if (list.length > cap) {
      list = list.map((c, i) => ({ c, i })).sort((a, b) => (b.c.prio ?? 1) - (a.c.prio ?? 1) || a.i - b.i).slice(0, cap).sort((a, b) => a.i - b.i).map((x) => x.c);
    }
    if (!list.length) return false;
    recent.push({ t: now, n: list.length });
    const t0 = now + 0.03;
    list.forEach((c) => scheduleCue(ac, chain.input, c, t0));
    return true;
  } catch (_err) {
    return false;
  }
}

/** Plans and plays the cues for a diff. */
export function playSoundForEvents(events, ctx) {
  if (!enabled || !events || !Object.keys(events).length) return false;
  return playSoundCues(planSoundCues(events, ctx));
}

/** Keeps the old export working: `playTableCue("turn" | "win" | "deal")`. */
export function playTableCue(kind = "turn", key = null) {
  const cue = { turn: "turn", win: "win", deal: "deal", tick: "tick" }[kind] || "deal";
  return playSoundCues([{ cue, at: 0, pan: 0, gain: 1, prio: PRIORITY[cue], key, land: 0.1 }]);
}

/** Plays one cue by name (harness "Sound test" panel). */
export function previewCue(name, extra = {}) {
  if (!CUE_NAMES.includes(name)) return false;
  return playSoundCues([{ cue: name, at: 0, pan: 0, gain: 1, prio: 3, count: 3, land: 0.2, ...extra }]);
}

/**
 * Dev/test helper: renders one cue offline and reports `{ peak, durationSec, nonSilent }`.
 * Needs a browser `OfflineAudioContext`; never used in the live table.
 */
export async function measureCue(name, extra = {}, seconds = 1.6) {
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!Offline) throw new Error("OfflineAudioContext not available");
  const rate = 44100;
  const off = new Offline(2, Math.ceil(rate * seconds), rate);
  const { input } = buildChain(off, 1);
  scheduleCue(off, input, { cue: name, at: 0, pan: -0.5, gain: 1, count: 3, land: 0.2, ...extra }, 0);
  const buf = await off.startRendering();
  let peak = 0;
  let last = 0;
  for (let ch = 0; ch < buf.numberOfChannels; ch += 1) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < d.length; i += 1) {
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
      if (a > 0.001 && i > last) last = i;
    }
  }
  return { cue: name, peak, durationSec: last / rate, nonSilent: peak > 0.002 };
}
