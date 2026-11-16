// Tests for the `apply` Edge Function handler (board applications), with a stub store and mailer.
import test from "node:test";
import assert from "node:assert/strict";
import {
  createApplyHandler, hmacIp, isAllowedOrigin, ROLES, RATE_MAX, MIN_FILL_MS, MAX_CV_BYTES
} from "../../supabase/functions/apply/handler.js";

const ORIGIN = "https://kthpokersociety.se";

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

function setup({ mailFails = false, countFails = false, insertFails = false, uploadFails = false } = {}) {
  const rows = [];
  const files = new Map();
  const mails = [];
  const store = {
    async countRecentByIpHash(ipHash, sinceIso) {
      if (countFails) throw new Error("db down");
      return rows.filter((r) => r.ip_hash === ipHash && r.created_at >= sinceIso).length;
    },
    async insertApplication(row) {
      if (insertFails) throw new Error("db down");
      rows.push({ ...row, created_at: new Date().toISOString() });
    },
    async uploadCv(path, bytes) {
      if (uploadFails) throw new Error("storage down");
      files.set(path, bytes);
    },
    async deleteCv(path) { files.delete(path); }
  };
  const sendMail = async (msg) => {
    mails.push(msg);
    if (mailFails) throw new Error("smtp down");
  };
  const handle = createApplyHandler({
    store, sendMail, hashIp: (ip) => hmacIp("test-secret", ip), newId: () => "11111111-2222-3333-4444-555555555555"
  });
  return { rows, mails, files, handle };
}

function post(body, { origin = ORIGIN, ip = "203.0.113.7", method = "POST" } = {}) {
  const headers = { "content-type": "application/json" };
  if (origin) headers.origin = origin;
  if (ip) headers["x-forwarded-for"] = ip + ", 10.0.0.1";
  return new Request("https://example.supabase.co/functions/v1/apply", {
    method,
    headers,
    body: method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined
  });
}

async function call(handle, body, opts) {
  const res = await handle(post(body, opts));
  return { status: res.status, body: await res.json(), headers: res.headers };
}

test("valid application is inserted, notice sent, ok:true", async () => {
  const { rows, mails, handle } = setup();
  const r = await call(handle, validPayload());
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
  assert.equal(r.headers.get("access-control-allow-origin"), ORIGIN);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.full_name, "Test Person");
  assert.equal(row.role, ROLES[2]);
  assert.deepEqual(row.role_ranking, validPayload().role_ranking);
  assert.match(row.ip_hash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(row).includes("203.0.113.7"), "raw IP never stored");
  assert.ok(!("website_url" in row) && !("elapsed_ms" in row), "spam fields not stored");
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, "kthpokersociety@gmail.com");
});

test("empty optional fields become null", async () => {
  const { rows, handle } = setup();
  const r = await call(handle, validPayload({ phone: "", program: "  ", github_url: "", hours_per_week: "", motivation: "" }));
  assert.equal(r.status, 200);
  for (const k of ["phone", "program", "github_url", "hours_per_week", "motivation"]) assert.equal(rows[0][k], null, k);
});

test("notice contains only name and first-choice role (no email, phone, LinkedIn, CV)", async () => {
  const { mails, handle } = setup();
  const p = validPayload();
  await call(handle, p);
  const all = mails[0].subject + "\n" + mails[0].text;
  assert.ok(all.includes(p.full_name));
  assert.ok(all.includes(p.role));
  for (const secret of [p.email, p.phone, p.linkedin_url, p.cv_url, p.program, "linkedin", "drive.google", "@example.com", "+46"]) {
    assert.ok(!all.includes(secret), `notice leaks ${secret}`);
  }
});

const INVALID = {
  "missing name": { full_name: "" },
  "name not a string": { full_name: 42 },
  "name too long": { full_name: "x".repeat(201) },
  "name with newline": { full_name: "Evil\nBcc: x" },
  "missing email": { email: undefined },
  "bad email": { email: "not-an-email" },
  "email too long": { email: "a".repeat(316) + "@b.se" },
  "phone too long": { phone: "1".repeat(51) },
  "program too long": { program: "x".repeat(201) },
  "linkedin missing": { linkedin_url: "" },
  "linkedin http": { linkedin_url: "http://www.linkedin.com/in/x" },
  "linkedin wrong host": { linkedin_url: "https://evil.example/linkedin.com/in/x" },
  "linkedin lookalike host": { linkedin_url: "https://linkedin.com.evil.example/in/x" },
  "linkedin without path": { linkedin_url: "https://linkedin.com" },
  "cv missing": { cv_url: null },
  "cv http": { cv_url: "http://drive.google.com/x" },
  "cv javascript": { cv_url: "javascript:alert(1)" },
  "cv too long": { cv_url: "https://example.com/" + "x".repeat(500) },
  "github bad": { github_url: "ftp://github.com/x" },
  "role unknown": { role: "Treasurer", role_ranking: ["Treasurer", ROLES[0], ROLES[1], ROLES[3], ROLES[4]] },
  "role not a string": { role: ["x"] },
  "ranking not array": { role_ranking: "all" },
  "ranking too short": { role_ranking: [ROLES[2], ROLES[0], ROLES[1], ROLES[3]] },
  "ranking duplicate": { role_ranking: [ROLES[2], ROLES[2], ROLES[1], ROLES[3], ROLES[4]] },
  "ranking first not role": { role_ranking: [ROLES[0], ROLES[2], ROLES[1], ROLES[3], ROLES[4]] },
  "hours unknown": { hours_per_week: "all of them" },
  "motivation too long": { motivation: "x".repeat(4001) }
};

for (const [name, over] of Object.entries(INVALID)) {
  test(`rejects invalid input: ${name}`, async () => {
    const { rows, mails, handle } = setup();
    const r = await call(handle, validPayload(over));
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { ok: false, error: "invalid" });
    assert.equal(rows.length, 0);
    assert.equal(mails.length, 0);
  });
}

test("rejects non-JSON and non-object bodies", async () => {
  const { rows, handle } = setup();
  for (const body of ["not json", "[]", "null", "\"x\""]) {
    const r = await call(handle, body);
    assert.equal(r.status, 400, body);
    assert.equal(r.body.ok, false);
  }
  assert.equal(rows.length, 0);
});

test("honeypot filled: rejected, nothing saved or mailed", async () => {
  const { rows, mails, handle } = setup();
  const r = await call(handle, validPayload({ website_url: "http://spam.example" }));
  assert.equal(r.status, 400);
  assert.deepEqual(r.body, { ok: false, error: "rejected" });
  assert.equal(rows.length, 0);
  assert.equal(mails.length, 0);
});

test("too fast or missing fill time: rejected", async () => {
  const { rows, handle } = setup();
  for (const elapsed_ms of [MIN_FILL_MS - 1, 0, -5, undefined, "99999", Number.NaN]) {
    const r = await call(handle, validPayload({ elapsed_ms }));
    assert.equal(r.status, 400, String(elapsed_ms));
    assert.deepEqual(r.body, { ok: false, error: "too_fast" });
  }
  assert.equal(rows.length, 0);
});

test("rate limit per hashed IP", async () => {
  const { rows, handle } = setup();
  for (let i = 0; i < RATE_MAX; i++) {
    assert.equal((await call(handle, validPayload())).status, 200);
  }
  const r = await call(handle, validPayload());
  assert.equal(r.status, 429);
  assert.deepEqual(r.body, { ok: false, error: "rate_limited" });
  assert.equal(rows.length, RATE_MAX);
  // A different IP is not affected.
  assert.equal((await call(handle, validPayload(), { ip: "198.51.100.9" })).status, 200);
  // No IP header: no shared bucket, stored without hash.
  const n = await call(handle, validPayload(), { ip: null });
  assert.equal(n.status, 200);
  assert.equal(rows.at(-1).ip_hash, null);
});

test("rate-limit lookup failure fails open", async () => {
  const { rows, handle } = setup({ countFails: true });
  assert.equal((await call(handle, validPayload())).status, 200);
  assert.equal(rows.length, 1);
});

test("mail failure still returns ok:true and keeps the application", async () => {
  const { rows, mails, handle } = setup({ mailFails: true });
  const r = await call(handle, validPayload());
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
  assert.equal(rows.length, 1);
  assert.equal(mails.length, 1);
});

test("insert failure returns a generic error without details", async () => {
  const { mails, handle } = setup({ insertFails: true });
  const r = await call(handle, validPayload());
  assert.equal(r.status, 500);
  assert.deepEqual(r.body, { ok: false, error: "server_error" });
  assert.equal(mails.length, 0);
});

test("CORS: allowlisted origins only, preflight and method checks", async () => {
  for (const o of ["https://kthpokersociety.se", "https://work-x--kthpokersociety-v3.netlify.app", "https://deploy-preview-3--kthpokersociety-v3.netlify.app", "http://localhost:8000", "http://127.0.0.1:5500"]) {
    assert.ok(isAllowedOrigin(o), o);
  }
  for (const o of ["https://evil.example", "http://kthpokersociety.se", "https://kthpokersociety.se.evil.example", "https://x--other.netlify.app", null, ""]) {
    assert.ok(!isAllowedOrigin(o), String(o));
  }
  const { rows, handle } = setup();
  const pre = await handle(post(null, { method: "OPTIONS" }));
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), ORIGIN);
  assert.match(pre.headers.get("access-control-allow-headers"), /apikey/);
  assert.match(pre.headers.get("vary"), /Origin/);

  const bad = await call(handle, validPayload(), { origin: "https://evil.example" });
  assert.equal(bad.status, 403);
  assert.equal(bad.headers.get("access-control-allow-origin"), null);
  const none = await call(handle, validPayload(), { origin: null });
  assert.equal(none.status, 403);
  const get = await handle(post(null, { method: "GET" }));
  assert.equal(get.status, 405);
  assert.equal(rows.length, 0);
});

test("IP hash is a keyed HMAC, stable per key", async () => {
  const a = await hmacIp("k1", "203.0.113.7");
  assert.equal(a, await hmacIp("k1", "203.0.113.7"));
  assert.notEqual(a, await hmacIp("k2", "203.0.113.7"));
  assert.match(a, /^[0-9a-f]{64}$/);
});

// ---------- CV upload (multipart: JSON in "data", the PDF in "cv") ----------

function pdfBytes(size = 2048) {
  const b = new Uint8Array(size);
  b.set(new TextEncoder().encode("%PDF-1.7\n"));
  return b;
}

function postUpload(data, file, { origin = ORIGIN, ip = "203.0.113.7" } = {}) {
  const fd = new FormData();
  fd.append("data", typeof data === "string" ? data : JSON.stringify(data));
  if (file !== null) fd.append("cv", file, "my cv.pdf");
  return new Request("https://example.supabase.co/functions/v1/apply", {
    method: "POST",
    headers: { origin, "x-forwarded-for": ip },
    body: fd
  });
}

async function upload(handle, data, file, opts) {
  const res = await handle(postUpload(data, file, opts));
  return { status: res.status, body: await res.json() };
}

const noLink = () => validPayload({ cv_url: undefined });

test("PDF upload: stored under a random name, row has cv_path and no cv_url, notice sent", async () => {
  const { rows, mails, files, handle } = setup();
  const r = await upload(handle, noLink(), new File([pdfBytes()], "my cv.pdf", { type: "application/pdf" }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cv_path, "11111111-2222-3333-4444-555555555555.pdf");
  assert.equal(rows[0].cv_url, null);
  assert.ok(!JSON.stringify(rows[0]).includes("my cv"), "applicant's file name is never stored");
  assert.equal(files.size, 1);
  assert.equal(files.get(rows[0].cv_path).length, 2048);
  assert.equal(mails.length, 1);
  assert.ok(!mails[0].text.includes(rows[0].cv_path), "notice does not mention the file");
});

test("a link still works for older page versions (cv_path is null)", async () => {
  const { rows, files, handle } = setup();
  const r = await call(handle, validPayload());
  assert.equal(r.status, 200);
  assert.equal(rows[0].cv_path, null);
  assert.equal(files.size, 0);
});

const BAD_FILES = {
  "not a PDF (wrong signature)": () => new File([new TextEncoder().encode("MZ this is an exe renamed .pdf")], "x.pdf", { type: "application/pdf" }),
  "HTML renamed to pdf": () => new File([new TextEncoder().encode("<html><script>alert(1)</script></html>")], "x.pdf", { type: "application/pdf" }),
  "empty file": () => new File([], "x.pdf", { type: "application/pdf" }),
  "too small to be a PDF": () => new File([new TextEncoder().encode("%PDF-")], "x.pdf"),
  "over the size limit": () => new File([pdfBytes(MAX_CV_BYTES + 1)], "x.pdf", { type: "application/pdf" })
};

for (const [name, make] of Object.entries(BAD_FILES)) {
  test(`rejects upload: ${name}`, async () => {
    const { rows, mails, files, handle } = setup();
    const r = await upload(handle, noLink(), make());
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { ok: false, error: "invalid" });
    assert.equal(rows.length, 0);
    assert.equal(files.size, 0);
    assert.equal(mails.length, 0);
  });
}

test("accepts a PDF of exactly the size limit", async () => {
  const { rows, handle } = setup();
  const r = await upload(handle, noLink(), new File([pdfBytes(MAX_CV_BYTES)], "x.pdf"));
  assert.equal(r.status, 200);
  assert.equal(rows.length, 1);
});

test("multipart without a file and without a link is rejected", async () => {
  const { rows, handle } = setup();
  const r = await upload(handle, noLink(), null);
  assert.equal(r.status, 400);
  assert.equal(rows.length, 0);
});

test("multipart: cv sent as a text field, or bad data part, is rejected", async () => {
  const { rows, handle } = setup();
  const fd = new FormData();
  fd.append("data", JSON.stringify(noLink()));
  fd.append("cv", "%PDF-1.7 pretend");
  const res = await handle(new Request("https://example.supabase.co/functions/v1/apply", {
    method: "POST", headers: { origin: ORIGIN }, body: fd
  }));
  assert.equal(res.status, 400);
  const r2 = await upload(handle, "not json", new File([pdfBytes()], "x.pdf"));
  assert.equal(r2.status, 400);
  assert.equal(rows.length, 0);
});

test("multipart: honeypot and fill-time checks still apply before anything is stored", async () => {
  const { rows, files, handle } = setup();
  const file = () => new File([pdfBytes()], "x.pdf");
  assert.equal((await upload(handle, { ...noLink(), website_url: "http://spam.example" }, file())).status, 400);
  assert.equal((await upload(handle, { ...noLink(), elapsed_ms: MIN_FILL_MS - 1 }, file())).status, 400);
  assert.equal(rows.length, 0);
  assert.equal(files.size, 0);
});

test("multipart: forbidden origin gets 403", async () => {
  const { handle } = setup();
  const r = await upload(handle, noLink(), new File([pdfBytes()], "x.pdf"), { origin: "https://evil.example" });
  assert.equal(r.status, 403);
});

test("upload is rate limited like the JSON path and stores nothing when limited", async () => {
  const { rows, files, handle } = setup();
  for (let i = 0; i < RATE_MAX; i++) {
    assert.equal((await upload(handle, noLink(), new File([pdfBytes()], "x.pdf"))).status, 200);
  }
  const r = await upload(handle, noLink(), new File([pdfBytes()], "x.pdf"));
  assert.equal(r.status, 429);
  assert.equal(rows.length, RATE_MAX);
  assert.equal(files.size, 1, "all uploads share the stubbed id; the 4th was not written");
});

test("storage failure: 500, nothing inserted, nothing mailed", async () => {
  const { rows, mails, handle } = setup({ uploadFails: true });
  const r = await upload(handle, noLink(), new File([pdfBytes()], "x.pdf"));
  assert.equal(r.status, 500);
  assert.equal(rows.length, 0);
  assert.equal(mails.length, 0);
});

test("insert failure after upload removes the uploaded file", async () => {
  const { rows, files, handle } = setup({ insertFails: true });
  const r = await upload(handle, noLink(), new File([pdfBytes()], "x.pdf"));
  assert.equal(r.status, 500);
  assert.equal(rows.length, 0);
  assert.equal(files.size, 0);
});
