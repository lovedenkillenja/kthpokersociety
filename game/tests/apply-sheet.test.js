// Tests for the optional Google Sheet copy in the `apply` Edge Function (stub poster and stub fetch).
import test from "node:test";
import assert from "node:assert/strict";
import { createApplyHandler, hmacIp, ROLES } from "../../supabase/functions/apply/handler.js";
import {
  buildSheetBody, createSheetPoster, isAllowedSheetUrl, sanitizeCell
} from "../../supabase/functions/apply/sheet.js";

const ORIGIN = "https://kthpokersociety.se";
const SHEET_URL = "https://script.google.com/macros/s/TESTDEPLOYMENTID/exec";
const TOKEN = "test-token-not-a-secret";
const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);

function validPayload(over = {}) {
  return {
    full_name: "Test Person",
    email: "applicant@example.com",
    phone: "+46 70 000 00 00",
    program: "CINTE, year 2",
    linkedin_url: "https://www.linkedin.com/in/test-person",
    cv_url: "https://drive.google.com/file/d/abc/view",
    github_url: null,
    role: ROLES[2],
    role_ranking: [ROLES[2], ROLES[0], ROLES[1], ROLES[3], ROLES[4]],
    hours_per_week: "2-4 hours",
    motivation: "I like probability.\nAnd events.",
    website_url: "",
    elapsed_ms: 20000,
    ...over
  };
}

function setup({ sheet = { url: SHEET_URL, token: TOKEN }, posterFails = null } = {}) {
  const rows = [];
  const posts = [];
  const logs = [];
  const store = {
    async countRecentByIpHash() { return 0; },
    async insertApplication(row) { rows.push(row); }
  };
  const postSheet = async (url, body) => {
    posts.push({ url, body });
    if (posterFails) throw posterFails;
  };
  const handle = createApplyHandler({
    store, sendMail: async () => {}, hashIp: (ip) => hmacIp("k", ip), now: () => NOW,
    log: (m) => logs.push(m), sheet, postSheet
  });
  return { rows, posts, logs, handle };
}

async function call(handle, body) {
  const res = await handle(new Request("https://example.supabase.co/functions/v1/apply", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, "x-forwarded-for": "203.0.113.7" },
    body: JSON.stringify(body)
  }));
  return { status: res.status, body: await res.json() };
}

test("sheet: poster called once with the expected body when both env values are set", async () => {
  const { rows, posts, handle } = setup();
  const r = await call(handle, validPayload());
  assert.equal(r.status, 200);
  assert.equal(rows.length, 1);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, SHEET_URL);
  assert.deepEqual(posts[0].body, {
    token: TOKEN,
    submitted_at: "2026-11-16T12:00:00.000Z",
    full_name: "Test Person",
    email: "applicant@example.com",
    phone: "'+46 70 000 00 00",
    program: "CINTE, year 2",
    linkedin_url: "https://www.linkedin.com/in/test-person",
    cv_url: "https://drive.google.com/file/d/abc/view",
    github_url: "",
    role: ROLES[2],
    role_ranking: [ROLES[2], ROLES[0], ROLES[1], ROLES[3], ROLES[4]].join(" > "),
    hours_per_week: "2-4 hours",
    motivation: "I like probability.\nAnd events."
  });
  assert.equal(rows[0].phone, "+46 70 000 00 00", "the DB row is not sanitized");
});

test("sheet: not called when env is unset or only half set", async () => {
  for (const sheet of [null, { url: "", token: "" }, { url: SHEET_URL, token: "" }, { url: "", token: TOKEN },
    { url: "   ", token: TOKEN }, { url: undefined, token: undefined }]) {
    const { rows, posts, handle } = setup({ sheet });
    const r = await call(handle, validPayload());
    assert.equal(r.status, 200, JSON.stringify(sheet));
    assert.equal(rows.length, 1);
    assert.equal(posts.length, 0, JSON.stringify(sheet));
  }
});

test("sheet: not called for a non-https or non-Apps-Script URL, logs a short code only", async () => {
  for (const url of ["http://script.google.com/macros/s/x/exec", "https://evil.example/exec",
    "https://script.google.com.evil.example/exec", "https://user:pw@script.google.com/x", "https://script.google.com:8443/x", "not a url"]) {
    const { posts, logs, handle } = setup({ sheet: { url, token: TOKEN } });
    const r = await call(handle, validPayload());
    assert.equal(r.status, 200, url);
    assert.equal(posts.length, 0, url);
    assert.deepEqual(logs, ["apply: sheet skipped (bad_url)"], url);
  }
});

test("sheet: poster failure does not fail the request and logs no payload, URL, token or error text", async () => {
  const p = validPayload();
  const err = new Error(`boom ${SHEET_URL} ${TOKEN} ${p.email} ${p.full_name}`);
  const { rows, logs, handle } = setup({ posterFails: err });
  const r = await call(handle, p);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
  assert.equal(rows.length, 1);
  assert.deepEqual(logs, ["apply: sheet failed (error)"]);
  const all = logs.join("\n");
  for (const leak of [SHEET_URL, "script.google", TOKEN, p.email, p.full_name, p.phone, "boom"]) {
    assert.ok(!all.includes(leak), `log leaks ${leak}`);
  }
});

test("sheet: a short error code is logged, anything else becomes 'error'", async () => {
  const coded = Object.assign(new Error("x"), { code: "http_500" });
  let s = setup({ posterFails: coded });
  await call(s.handle, validPayload());
  assert.deepEqual(s.logs, ["apply: sheet failed (http_500)"]);
  const weird = Object.assign(new Error("x"), { code: "applicant@example.com" });
  s = setup({ posterFails: weird });
  await call(s.handle, validPayload());
  assert.deepEqual(s.logs, ["apply: sheet failed (error)"]);
});

test("sheet: formula injection is neutralised in every cell", async () => {
  for (const c of ["=", "+", "-", "@"]) {
    const { rows, posts, handle } = setup();
    const r = await call(handle, validPayload({
      full_name: c + "HYPERLINK(\"https://evil.example\")",
      email: c === "@" ? "applicant@example.com" : c + "x@example.com",
      program: c + "1+1",
      motivation: c + "cmd|' /C calc'!A0"
    }));
    assert.equal(r.status, 200, c);
    const b = posts[0].body;
    for (const k of ["full_name", "program", "motivation"]) assert.ok(b[k].startsWith("'" + c), `${k} ${c}`);
    if (c !== "@") assert.ok(b.email.startsWith("'" + c), `email ${c}`);
    assert.ok(!rows[0].full_name.startsWith("'"), "DB row untouched");
  }
  assert.equal(sanitizeCell("=SUM(A1)"), "'=SUM(A1)");
  assert.equal(sanitizeCell("@x"), "'@x");
  assert.equal(sanitizeCell("-1"), "'-1");
  assert.equal(sanitizeCell("\t=1"), "'\t=1");
  assert.equal(sanitizeCell("plain"), "plain");
  assert.equal(sanitizeCell(null), "");
  assert.equal(sanitizeCell(sanitizeCell("=1")), "'=1", "idempotent");
  const body = buildSheetBody({ email: "=a@b.se", role_ranking: ["=x", "y"] }, TOKEN, "t");
  assert.equal(body.email, "'=a@b.se");
  assert.equal(body.role_ranking, "'=x > y");
});

test("sheet URL allowlist", () => {
  assert.ok(isAllowedSheetUrl(SHEET_URL));
  assert.ok(isAllowedSheetUrl("https://script.googleusercontent.com/macros/echo?user_content_key=abc"));
  for (const u of ["http://script.google.com/x", "https://google.com/x", "https://xscript.google.com/x", "", null, 5]) {
    assert.ok(!isAllowedSheetUrl(u), String(u));
  }
});

// ---- the real poster, with a stub fetch ----

function fakeFetch(responses) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { f, calls };
}
const redirect = (loc, status = 302) => new Response(null, { status, headers: { location: loc } });
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

test("poster: POSTs JSON, follows the Apps Script 302 as a GET without body, accepts {ok:true}", async () => {
  const echo = "https://script.googleusercontent.com/macros/echo?user_content_key=k";
  const { f, calls } = fakeFetch([redirect(echo), json({ ok: true })]);
  await createSheetPoster(f)(SHEET_URL, { token: TOKEN, full_name: "A" });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "manual");
  assert.deepEqual(JSON.parse(calls[0].init.body), { token: TOKEN, full_name: "A" });
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.equal(calls[1].url, echo);
  assert.equal(calls[1].init.method, "GET");
  assert.equal(calls[1].init.body, undefined, "token never re-sent on a redirect");
});

test("poster: rejects bad URLs, off-list redirects, script rejections and HTTP errors with short codes", async () => {
  const codeOf = async (url, responses) => {
    const { f, calls } = fakeFetch(responses);
    try { await createSheetPoster(f)(url, { token: TOKEN }); return { code: "none", calls }; } catch (e) { return { code: e.code, calls }; }
  };
  let r = await codeOf("http://script.google.com/x", []);
  assert.equal(r.code, "bad_url");
  assert.equal(r.calls.length, 0);
  r = await codeOf(SHEET_URL, [redirect("https://evil.example/steal")]);
  assert.equal(r.code, "bad_redirect");
  assert.equal(r.calls.length, 1, "never follows to an off-list host");
  r = await codeOf(SHEET_URL, [redirect("http://script.googleusercontent.com/x")]);
  assert.equal(r.code, "bad_redirect");
  r = await codeOf(SHEET_URL, [json({ ok: false, error: "unauthorized" })]);
  assert.equal(r.code, "rejected");
  r = await codeOf(SHEET_URL, [new Response("<html>login</html>", { status: 200 })]);
  assert.equal(r.code, "bad_response");
  r = await codeOf(SHEET_URL, [json({}, 500)]);
  assert.equal(r.code, "http_500");
  const loop = Array.from({ length: 10 }, () => redirect(SHEET_URL));
  r = await codeOf(SHEET_URL, loop);
  assert.equal(r.code, "too_many_redirects");
});

test("poster: times out", async () => {
  const hang = (_url, init) => new Promise((_res, rej) => {
    init.signal.addEventListener("abort", () => rej(init.signal.reason));
  });
  await assert.rejects(createSheetPoster(hang, { timeoutMs: 20 })(SHEET_URL, { token: TOKEN }));
});
