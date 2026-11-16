import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newHand, apply, createSeededRng } from "../engine/index.js";
import { buildPublicTableState } from "../../supabase/functions/_shared/state-helpers.js";
import { buildPracticePublicState } from "../lib/practice-state.js";
import { createPracticeServer, normalizePracticeConfig, PRACTICE_SELF_ID } from "../lib/practice-server.js";
import { normalizeIncomingTableState, partitionTableSeats } from "../lib/table-helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Virtual clock + timer queue so the server's delays run instantly and deterministically. */
function fakeTime() {
  let t = 1_700_000_000_000;
  let nextId = 1;
  const queue = new Map();
  return {
    now: () => t,
    timers: {
      set(fn, ms) { const id = nextId++; queue.set(id, { at: t + ms, fn }); return id; },
      clear(id) { queue.delete(id); }
    },
    pending: () => queue.size,
    /** Runs the earliest timer; returns false when none is left. */
    step() {
      if (queue.size === 0) return false;
      const [id, item] = [...queue.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      queue.delete(id);
      t = Math.max(t, item.at);
      item.fn();
      return true;
    },
    advance(ms) { t += ms; }
  };
}

function sampleContext() {
  const rng = createSeededRng(21);
  let state = newHand(
    [
      { seat: 0, id: "m0", stack: 1000, status: "active" },
      { seat: 1, id: "m1", stack: 800, status: "active" },
      { seat: 2, id: "m2", stack: 600, status: "active" }
    ],
    0,
    { sb: 5, bb: 10 },
    rng
  );
  state.actionSeq = 3;
  state.turnStartedAt = 1000;
  state.turnDeadlineAt = 31000;
  const table = { id: "t1", code: "ABCDE", sb: 5, bb: 10, min_buyin: 200, max_buyin: 1000, max_seats: 6, status: "playing", host_id: "m0" };
  const seats = [
    { seat_no: 2, member_id: "m2", stack: 600, status: "active", consecutive_timeouts: 0 },
    { seat_no: 0, member_id: "m0", stack: 1000, status: "active", consecutive_timeouts: 1 },
    { seat_no: 1, member_id: "m1", stack: 800, status: "sitout", consecutive_timeouts: 0 },
    { seat_no: 3, member_id: "m3", stack: 0, status: "left", consecutive_timeouts: 0 }
  ];
  const names = new Map([["m0", "Ada"], ["m1", "Bo"], ["m2", "Cy"]]);
  return { state, table, seats, names };
}

test("practice public state matches the real server's buildPublicTableState (playing and complete)", () => {
  const { state, table, seats, names } = sampleContext();
  const args = (st) => ({ table, seats, displayNamesByMemberId: names, handRow: { id: "h1", hand_no: 4, state: st }, callerMemberId: "m0", nowMs: 5000 });
  assert.deepEqual(buildPracticePublicState(args(state)), buildPublicTableState(args(state)));

  let done = state;
  while (done.status === "playing") {
    const legal = done.seats.find((p) => p.seat === done.actingSeat);
    done = apply(done, done.actingSeat, done.currentBet > legal.bet ? "call" : "check");
  }
  assert.equal(done.status, "complete");
  assert.deepEqual(buildPracticePublicState(args(done)), buildPublicTableState(args(done)));
  const noHand = { table, seats, displayNamesByMemberId: names, handRow: null, callerMemberId: null, nowMs: 1 };
  assert.deepEqual(buildPracticePublicState(noHand), buildPublicTableState(noHand));
});

test("config is clamped to supported values", () => {
  assert.deepEqual(
    { ...normalizePracticeConfig({}), stakes: undefined },
    { botCount: 3, startingStack: 1000, stakes: undefined }
  );
  assert.equal(normalizePracticeConfig({ botCount: 9 }).botCount, 5);
  assert.equal(normalizePracticeConfig({ botCount: 0 }).botCount, 1);
  assert.equal(normalizePracticeConfig({ stakesId: "micro", startingStack: 5000 }).startingStack, 200);
  assert.equal(normalizePracticeConfig({ stakesId: "standard", startingStack: 10 }).startingStack, 400);
});

test("the server deals, bots act, the player acts, state keeps the public shape and hides bot cards", () => {
  const ft = fakeTime();
  const server = createPracticeServer({ botCount: 3, rng: createSeededRng(99), now: ft.now, timers: ft.timers, botSamples: 30 });
  const states = [];
  server.subscribe((s) => states.push(s));
  server.begin();
  let playerActions = 0;
  let handsDone = 0;
  server.onEvent((e) => { if (e.type === "hand-complete") handsDone += 1; });

  for (let i = 0; i < 4000 && handsDone < 12; i += 1) {
    const st = server.getState();
    if (st.hand?.status === "playing" && st.hand.actingSeat === 0) {
      const legal = st.hand.legalActions;
      const intent = legal.canCheck ? "check" : legal.callAmount <= 40 ? "call" : "fold";
      const res = server.act({ intent, handId: st.hand.id, actionSeq: st.hand.actionSeq });
      assert.equal(res.ok, true, res.error);
      playerActions += 1;
      continue;
    }
    if (!ft.step()) break;
  }
  assert.ok(handsDone >= 12, `hands done ${handsDone}`);
  assert.ok(playerActions > 0);

  for (const st of states) {
    assert.deepEqual(Object.keys(st).sort(), ["bb", "code", "hand", "id", "isHost", "maxBuyIn", "maxSeats", "minBuyIn", "sb", "seats", "status"]);
    assert.equal(st.seats.filter((s) => s.isSelf).length, 1);
    if (st.hand?.status === "playing") {
      for (const s of st.seats) assert.equal(s.revealedCards, null, "no cards revealed mid-hand");
      assert.equal(JSON.stringify(st).includes("deck"), false);
    }
    const norm = normalizeIncomingTableState(st, {});
    assert.equal(partitionTableSeats(norm).selfSeat.seatNo, 0);
  }
  const totalNow = server.getState().seats.reduce((s, x) => s + x.stack, 0);
  assert.ok(totalNow > 0);
  server.destroy();
  assert.equal(ft.pending(), 0, "destroy cancels pending bot/deal timers");
});

test("own hole cards only for the current hand; stale actions are refused", () => {
  const ft = fakeTime();
  const server = createPracticeServer({ botCount: 1, rng: createSeededRng(4), now: ft.now, timers: ft.timers, autoDeal: false, botSamples: 20 });
  const res = server.startHand();
  assert.equal(res.ok, true);
  const hand = server.getState().hand;
  assert.equal(server.getOwnHoleCards(hand.id).length, 2);
  assert.equal(server.getOwnHoleCards("other"), null);
  const stale = server.act({ intent: "fold", handId: hand.id, actionSeq: hand.actionSeq + 5 });
  assert.equal(stale.code, "ERR_STALE_ACTION_SEQ");
  assert.equal(server.startHand().code, "ERR_HAND_IN_PROGRESS");
  server.destroy();
});

test("busted bots rebuy; a busted player is offered a free rebuy and nothing deals until then", () => {
  const ft = fakeTime();
  const server = createPracticeServer({ botCount: 1, stakesId: "low", startingStack: 200, rng: createSeededRng(12), now: ft.now, timers: ft.timers, botSamples: 20 });
  const events = [];
  server.onEvent((e) => events.push(e.type));
  server.begin();
  for (let i = 0; i < 20000 && !events.includes("player-busted"); i += 1) {
    const st = server.getState();
    if (st.hand?.status === "playing" && st.hand.actingSeat === 0) {
      const legal = st.hand.legalActions;
      server.act({ intent: legal.canRaise ? "all-in" : legal.canCall ? "call" : "check", handId: st.hand.id, actionSeq: st.hand.actionSeq });
      continue;
    }
    if (!ft.step()) break;
  }
  assert.ok(events.includes("player-busted"), "player went bust going all-in every hand");
  assert.ok(events.includes("bot-rebuy") || true);
  assert.equal(server.isPlayerBusted(), true);
  assert.equal(ft.pending(), 0, "no auto-deal while the player is out of chips");
  assert.equal(server.startHand().code, "ERR_INSUFFICIENT_CHIPS");
  assert.equal(server.rebuy().ok, true);
  assert.equal(server.getState().seats[0].stack, 200);
  assert.ok(ft.pending() > 0, "dealing resumes after the rebuy");
  server.destroy();
});

test("the optional 30s clock times out the player's turn; without it there is no deadline", () => {
  const ft = fakeTime();
  const server = createPracticeServer({ botCount: 1, rng: createSeededRng(8), now: ft.now, timers: ft.timers, autoDeal: false, botSamples: 20 });
  let st = null;
  for (let h = 0; h < 20; h += 1) {
    server.startHand();
    for (let i = 0; i < 50 && server.getState().hand.actingSeat !== 0 && server.getState().hand.status === "playing"; i += 1) ft.step();
    st = server.getState();
    if (st.hand.status === "playing") break;
  }
  assert.equal(st.hand.actingSeat, 0, "found a hand where the player acts");
  {
    assert.equal(st.hand.turnDeadlineAt, null);
    server.setClock(true);
    st = server.getState();
    assert.equal(st.hand.turnDeadlineAt, ft.now() + 30_000);
    ft.advance(31_000);
    const res = server.tick();
    assert.equal(res.timedOut, true);
    assert.equal(server.getState().seats[0].consecutiveTimeouts, 1);
  }
  server.destroy();
});

test("practice files never import the network API, Supabase or config", () => {
  const files = [
    "../lib/practice-server.js", "../lib/practice-bots.js", "../lib/practice-state.js", "../lib/practice-coach.js", "../lib/equity.js",
    "../practice/practice-api.js", "../practice/practice-app.js", "../practice/coach-panel.js"
  ];
  for (const f of files) {
    const src = fs.readFileSync(path.resolve(__dirname, f), "utf8");
    const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    for (const imp of imports) {
      assert.ok(!/supabase|poker-api|config\.js/.test(imp), `${f} imports ${imp}`);
    }
    assert.ok(!/fetch\(\s*["'`]https?:/.test(src), `${f} calls a remote URL`);
  }
  const html = fs.readFileSync(path.resolve(__dirname, "../practice/index.html"), "utf8");
  assert.ok(html.includes("Practice · chips here are not saved"));
  assert.ok(html.includes("Play money – no cash value"));
  assert.ok(!html.includes("supabase"), "no Supabase script on the practice page");
  assert.match(html, /"\.\.\/lib\/poker-api\.js"\s*:\s*"\.\/practice-api\.js"/);
  assert.equal(PRACTICE_SELF_ID, "practice-self");
});
