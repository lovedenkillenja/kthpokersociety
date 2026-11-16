import test from "node:test";
import assert from "node:assert/strict";
import {
  handleWelcomeRequest,
  SOCIETY_NOTICE_ADDRESS,
  buildWelcomeMail
} from "../../supabase/functions/_shared/welcome.js";

const ALICE_ID = "11111111-1111-1111-1111-111111111111";
const ALICE_EMAIL = "alice@kth.se";

function createStore({ displayName = "Alice K.", confirmed = true } = {}) {
  const members = new Map([[ALICE_ID, { full_name: "Alice Karlsson", welcome_sent_at: null }]]);
  const users = new Map([
    ["jwt-alice", { id: ALICE_ID, email: ALICE_EMAIL, email_confirmed_at: confirmed ? "2026-11-16T10:00:00Z" : null }]
  ]);
  return {
    members,
    releases: 0,
    async verifyUserJwt(jwt) {
      return users.get(jwt) ?? null;
    },
    // Mirrors UPDATE ... WHERE welcome_sent_at IS NULL RETURNING (single-threaded JS is atomic here).
    async claimWelcome({ memberId, claimedAt }) {
      const row = members.get(memberId);
      if (!row || row.welcome_sent_at !== null) return null;
      row.welcome_sent_at = claimedAt;
      return { full_name: row.full_name };
    },
    async releaseWelcome({ memberId, claimedAt }) {
      this.releases += 1;
      const row = members.get(memberId);
      if (row && row.welcome_sent_at === claimedAt) {
        row.welcome_sent_at = null;
        return true;
      }
      return false;
    },
    async getDisplayName() {
      return displayName;
    }
  };
}

function createMailer({ failFor = null } = {}) {
  const sent = [];
  async function sendMail(msg) {
    // Yield so concurrent calls genuinely interleave.
    await new Promise((r) => setTimeout(r, 1));
    if (failFor && failFor(msg)) {
      const err = new Error("ERR_MAIL_SEND");
      err.code = "ERR_MAIL_SEND";
      throw err;
    }
    sent.push(msg);
  }
  return { sent, sendMail };
}

const NOW = () => Date.parse("2026-11-16T12:00:00Z");

test("welcome: sends the member mail and the society notice once", async () => {
  const store = createStore();
  const mailer = createMailer();
  const res = await handleWelcomeRequest({ store, sendMail: mailer.sendMail, jwt: "jwt-alice", now: NOW });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, sent: true });
  assert.equal(mailer.sent.length, 2);
  assert.equal(mailer.sent[0].to, ALICE_EMAIL);
  assert.equal(mailer.sent[1].to, SOCIETY_NOTICE_ADDRESS);
  assert.ok(store.members.get(ALICE_ID).welcome_sent_at);
});

test("welcome: second call is a no-op", async () => {
  const store = createStore();
  const mailer = createMailer();
  await handleWelcomeRequest({ store, sendMail: mailer.sendMail, jwt: "jwt-alice", now: NOW });
  const res = await handleWelcomeRequest({ store, sendMail: mailer.sendMail, jwt: "jwt-alice", now: NOW });
  assert.deepEqual(res.body, { ok: true, sent: false });
  assert.equal(mailer.sent.length, 2);
});

test("welcome: concurrent calls send only once", async () => {
  const store = createStore();
  const mailer = createMailer();
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      handleWelcomeRequest({ store, sendMail: mailer.sendMail, jwt: "jwt-alice", now: NOW })
    )
  );
  assert.equal(results.filter((r) => r.body.sent === true).length, 1);
  assert.equal(mailer.sent.filter((m) => m.to === ALICE_EMAIL).length, 1);
});

test("welcome: a failed member mail releases the claim so a retry sends", async () => {
  const store = createStore();
  const failing = createMailer({ failFor: (m) => m.to === ALICE_EMAIL });
  const res = await handleWelcomeRequest({ store, sendMail: failing.sendMail, jwt: "jwt-alice", now: NOW });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, sent: false });
  assert.equal(store.releases, 1);
  assert.equal(store.members.get(ALICE_ID).welcome_sent_at, null);
  assert.equal(failing.sent.length, 0, "no society notice when the member mail failed");

  const ok = createMailer();
  const retry = await handleWelcomeRequest({ store, sendMail: ok.sendMail, jwt: "jwt-alice", now: NOW });
  assert.deepEqual(retry.body, { ok: true, sent: true });
  assert.equal(ok.sent.length, 2);
});

test("welcome: a failed society notice keeps the claim (no second welcome)", async () => {
  const store = createStore();
  const codes = [];
  const mailer = createMailer({ failFor: (m) => m.to === SOCIETY_NOTICE_ADDRESS });
  const res = await handleWelcomeRequest({
    store,
    sendMail: mailer.sendMail,
    jwt: "jwt-alice",
    now: NOW,
    logError: (c) => codes.push(c)
  });
  assert.deepEqual(res.body, { ok: true, sent: true });
  assert.equal(store.releases, 0);
  assert.ok(store.members.get(ALICE_ID).welcome_sent_at);
  assert.ok(codes.every((c) => !c.includes("@")));
});

test("welcome: society notice contains only display name and timestamp", async () => {
  const store = createStore({ displayName: "Alice K." });
  const mailer = createMailer();
  await handleWelcomeRequest({ store, sendMail: mailer.sendMail, jwt: "jwt-alice", now: NOW });
  const notice = mailer.sent.find((m) => m.to === SOCIETY_NOTICE_ADDRESS);
  const all = `${notice.subject}\n${notice.text}\n${notice.html}`;
  assert.ok(!all.includes(ALICE_EMAIL));
  assert.ok(!all.includes("alice@"));
  assert.ok(!all.includes("Karlsson"), "full name must not leak into the notice");
  assert.ok(!/@/.test(all), "no email address of any kind");
  assert.ok(all.includes("Alice K."));
  assert.ok(all.includes("2026-11-16T12:00:00.000Z"));
});

test("welcome: notice falls back to a derived name, never the email handle", async () => {
  const store = createStore({ displayName: null });
  const mailer = createMailer();
  await handleWelcomeRequest({ store, sendMail: mailer.sendMail, jwt: "jwt-alice", now: NOW });
  const notice = mailer.sent.find((m) => m.to === SOCIETY_NOTICE_ADDRESS);
  assert.ok(notice.text.includes("Alice K."));
  assert.ok(!notice.text.includes("@"));
});

test("welcome: rejects a missing or invalid JWT and sends nothing", async () => {
  const store = createStore();
  const mailer = createMailer();
  const missing = await handleWelcomeRequest({ store, sendMail: mailer.sendMail, jwt: null, now: NOW });
  assert.equal(missing.status, 401);
  const invalid = await handleWelcomeRequest({ store, sendMail: mailer.sendMail, jwt: "jwt-forged", now: NOW });
  assert.equal(invalid.status, 401);
  assert.equal(mailer.sent.length, 0);
  assert.equal(store.members.get(ALICE_ID).welcome_sent_at, null);
});

test("welcome: ignores any address in the request body", async () => {
  const store = createStore();
  const mailer = createMailer();
  await handleWelcomeRequest({
    store,
    sendMail: mailer.sendMail,
    jwt: "jwt-alice",
    payload: { to: "attacker@example.com", email: "attacker@example.com" },
    now: NOW
  });
  assert.ok(mailer.sent.every((m) => m.to !== "attacker@example.com"));
  assert.equal(mailer.sent[0].to, ALICE_EMAIL);
});

test("welcome: unconfirmed email is not mailed and not claimed", async () => {
  const store = createStore({ confirmed: false });
  const mailer = createMailer();
  const res = await handleWelcomeRequest({ store, sendMail: mailer.sendMail, jwt: "jwt-alice", now: NOW });
  assert.deepEqual(res.body, { ok: true, sent: false });
  assert.equal(mailer.sent.length, 0);
  assert.equal(store.members.get(ALICE_ID).welcome_sent_at, null);
});

test("welcome: mail copy is play money only and links the site", () => {
  const mail = buildWelcomeMail({ firstName: "Alice<script>" });
  assert.ok(mail.text.includes("https://kthpokersociety.se"));
  assert.ok(/play money/i.test(mail.text) && /spelpengar/i.test(mail.text));
  assert.ok(!/\b(win|prize|cash prize|deposit|bet real|vinn pengar)\b/i.test(mail.text));
  assert.ok(!mail.html.includes("<script>"));
});

test("welcome: with memberMail off only the society notice is sent, and it never goes to the member", async () => {
  const store = createStore();
  const mailer = createMailer();
  const res = await handleWelcomeRequest({ store, sendMail: mailer.sendMail, jwt: "jwt-alice", now: NOW, memberMail: false });
  assert.deepEqual(res.body, { ok: true, sent: true });
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].to, SOCIETY_NOTICE_ADDRESS);
  assert.ok(!JSON.stringify(mailer.sent[0]).includes(ALICE_EMAIL));
});

test("welcome: with memberMail off a failed notice releases the claim so it retries", async () => {
  const store = createStore();
  const mailer = createMailer({ failFor: () => true });
  const res = await handleWelcomeRequest({ store, sendMail: mailer.sendMail, jwt: "jwt-alice", now: NOW, memberMail: false });
  assert.deepEqual(res.body, { ok: true, sent: false });
  assert.equal(store.members.get(ALICE_ID).welcome_sent_at, null);
});
