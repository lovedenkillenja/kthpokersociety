// Tests for the member register copy (name, email, join date) to the Google Sheet.
import test from "node:test";
import assert from "node:assert/strict";
import { syncMembersToSheet } from "../../supabase/functions/_shared/member-sheet.js";
import { buildMemberSheetBody } from "../../supabase/functions/apply/sheet.js";
import { handleWelcomeRequest } from "../../supabase/functions/_shared/welcome.js";

const URL_OK = "https://script.google.com/macros/s/abc/exec";
const TOKEN = "t".repeat(40);
const NOW = () => Date.parse("2026-11-16T12:00:00Z");

function member(n, over = {}) {
  return { id: "id-" + n, full_name: "Member " + n, email: `m${n}@kth.se`, created_at: "2026-11-10T08:00:00+00:00", ...over };
}

function makeStore(rows) {
  const store = {
    unsynced: [...rows], claimed: [], released: [], claimCalls: 0,
    async claimMembersForSheet(limit, claimedAt) {
      store.claimCalls++;
      const batch = store.unsynced.splice(0, limit);
      store.claimed.push(...batch.map((m) => m.id));
      store.claimedAt = claimedAt;
      return batch;
    },
    async releaseMembersSheetClaim(ids, claimedAt) {
      store.released.push(...ids);
      store.releasedAt = claimedAt;
      store.unsynced.push(...rows.filter((r) => ids.includes(r.id)));
    }
  };
  return store;
}

test("buildMemberSheetBody: kind member, ISO join date, formula-injection safe", () => {
  const b = buildMemberSheetBody(member(1, { full_name: "=HYPERLINK(\"x\")", email: "+a@b.se" }), "tok");
  assert.equal(b.kind, "member");
  assert.equal(b.token, "tok");
  assert.equal(b.joined_at, "2026-11-10T08:00:00.000Z");
  assert.equal(b.full_name, "'=HYPERLINK(\"x\")");
  assert.equal(b.email, "'+a@b.se");
  assert.deepEqual(Object.keys(b).sort(), ["email", "full_name", "joined_at", "kind", "token"]);
});

test("sync: off (and claims nothing) unless URL and token are both set", async () => {
  for (const sheet of [null, { url: "", token: TOKEN }, { url: URL_OK, token: "" }]) {
    const store = makeStore([member(1)]);
    const posts = [];
    const r = await syncMembersToSheet({ store, sheet, postSheet: async (u, b) => posts.push(b), now: NOW });
    assert.equal(r.synced, 0);
    assert.equal(store.claimCalls, 0);
    assert.equal(posts.length, 0);
  }
});

test("sync: bad URL is skipped without claiming", async () => {
  const store = makeStore([member(1)]);
  const logs = [];
  await syncMembersToSheet({ store, sheet: { url: "https://evil.example/x", token: TOKEN }, postSheet: async () => {}, log: (m) => logs.push(m) });
  assert.equal(store.claimCalls, 0);
  assert.deepEqual(logs, ["member sheet skipped (bad_url)"]);
});

test("sync: one batch per call, posts a row per claimed member, nothing released", async () => {
  const store = makeStore([1, 2, 3, 4, 5].map((n) => member(n)));
  const posts = [];
  const r = await syncMembersToSheet({ store, sheet: { url: URL_OK, token: TOKEN }, postSheet: async (u, b) => posts.push({ u, b }), now: NOW });
  assert.equal(r.synced, 3);
  assert.equal(posts.length, 3);
  assert.ok(posts.every((p) => p.u === URL_OK && p.b.kind === "member" && p.b.token === TOKEN));
  assert.equal(store.released.length, 0);
  assert.equal(store.claimedAt, "2026-11-16T12:00:00.000Z");
  // the next call syncs the rest (backfill over time)
  const r2 = await syncMembersToSheet({ store, sheet: { url: URL_OK, token: TOKEN }, postSheet: async () => {}, now: NOW });
  assert.equal(r2.synced, 2);
  const r3 = await syncMembersToSheet({ store, sheet: { url: URL_OK, token: TOKEN }, postSheet: async () => {}, now: NOW });
  assert.equal(r3.synced, 0);
});

test("sync: a failed post releases only that member's claim; the log has a short code only", async () => {
  const store = makeStore([1, 2, 3].map((n) => member(n)));
  const logs = [];
  const postSheet = async (u, b) => {
    if (b.email === "m2@kth.se") { const e = new Error("secret detail m2@kth.se"); e.code = "rejected"; throw e; }
  };
  const r = await syncMembersToSheet({ store, sheet: { url: URL_OK, token: TOKEN }, postSheet, log: (m) => logs.push(m), now: NOW });
  assert.equal(r.synced, 2);
  assert.deepEqual(store.released, ["id-2"]);
  assert.equal(store.releasedAt, store.claimedAt);
  assert.deepEqual(logs, ["member sheet failed (rejected)"]);
  assert.ok(!logs.join().includes("kth.se") && !logs.join().includes(TOKEN));
});

test("sync: a failing claim never throws", async () => {
  const store = { async claimMembersForSheet() { throw new Error("db down"); } };
  const logs = [];
  const r = await syncMembersToSheet({ store, sheet: { url: URL_OK, token: TOKEN }, postSheet: async () => {}, log: (m) => logs.push(m) });
  assert.equal(r.synced, 0);
  assert.deepEqual(logs, ["member sheet claim failed"]);
});

test("welcome: runs the sheet sync for any authenticated caller; a throwing sync never fails the call", async () => {
  const store = {
    async verifyUserJwt(jwt) { return jwt === "jwt" ? { id: "u1", email: "a@kth.se", email_confirmed_at: "2026-11-16T10:00:00Z" } : null; },
    async claimWelcome() { return null; }, // already welcomed
    async releaseWelcome() { return true; },
    async getDisplayName() { return null; }
  };
  let calls = 0;
  const ok = await handleWelcomeRequest({ store, sendMail: async () => {}, jwt: "jwt", now: NOW, syncSheet: async () => { calls++; } });
  assert.equal(ok.status, 200);
  assert.equal(calls, 1, "sync runs even though the member was already welcomed");
  const boom = await handleWelcomeRequest({ store, sendMail: async () => {}, jwt: "jwt", now: NOW, syncSheet: async () => { throw new Error("x"); } });
  assert.equal(boom.status, 200);
  const noAuth = await handleWelcomeRequest({ store, sendMail: async () => {}, jwt: "bad", now: NOW, syncSheet: async () => { calls++; } });
  assert.notEqual(noAuth.status, 200);
  assert.equal(calls, 1, "no sync without a valid JWT");
});
