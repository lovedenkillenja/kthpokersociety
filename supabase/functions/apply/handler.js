// Pure request handler for the `apply` Edge Function (board applications).
// No Deno or network imports here so the logic runs under `node --test` with a stub store and mailer.
// The Deno entrypoint (index.js) injects: store, sendMail, hashIp, now, and optionally sheet + postSheet.

import { buildSheetBody, isAllowedSheetUrl } from "./sheet.js";

export const ROLES = Object.freeze([
  "Strategy & Research",
  "Events & Tournaments",
  "Sponsorships & Partnerships",
  "Marketing & Community",
  "Tech & Development"
]);

export const HOURS = Object.freeze(["Less than 2 hours", "2-4 hours", "5-7 hours", "8 or more hours"]);

export const NOTICE_TO = "kthpokersociety@gmail.com";
export const MIN_FILL_MS = 3000;
export const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
export const RATE_MAX = 3; // applications per hashed IP per window
const MAX_BODY_BYTES = 16 * 1024; // JSON part of the request (the form fields)
export const MAX_CV_BYTES = 5 * 1024 * 1024; // uploaded CV, PDF only
const MAX_UPLOAD_REQUEST_BYTES = MAX_CV_BYTES + 64 * 1024; // CV plus multipart framing and the JSON part

const ALLOWED_ORIGINS = [
  /^https:\/\/kthpokersociety\.se$/,
  /^https:\/\/www\.kthpokersociety\.se$/,
  /^https:\/\/kthpokersociety-v3\.netlify\.app$/,
  /^https:\/\/[a-z0-9-]+--kthpokersociety-v3\.netlify\.app$/, // branch and deploy previews
  /^https:\/\/([a-z0-9-]+\.)?kthpokersociety\.pages\.dev$/, // Cloudflare Pages production and previews
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/
];

export function isAllowedOrigin(origin) {
  return typeof origin === "string" && ALLOWED_ORIGINS.some((re) => re.test(origin));
}

function corsHeaders(origin) {
  const h = {
    "Access-Control-Allow-Headers": "apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "600",
    Vary: "Origin"
  };
  if (isAllowedOrigin(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

export function reply(origin, status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json; charset=utf-8" }
  });
}

// ---------- validation ----------

const CONTROL = /[\u0000-\u001f\u007f]/; // no control characters in single-line fields
const CONTROL_MULTILINE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/; // allows \t \n \r
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class Invalid extends Error {}

// Returns a trimmed string, or null when empty and optional. Throws Invalid on bad type/length.
function str(v, { required = false, max, min = 1, multiline = false } = {}) {
  if (v === undefined || v === null) {
    if (required) throw new Invalid();
    return null;
  }
  if (typeof v !== "string") throw new Invalid();
  const s = v.trim();
  if (!s) {
    if (required) throw new Invalid();
    return null;
  }
  if (s.length < min || s.length > max) throw new Invalid();
  if ((multiline ? CONTROL_MULTILINE : CONTROL).test(s)) throw new Invalid();
  return s;
}

function httpsUrl(s, { allowHttp = false } = {}) {
  if (s === null) return null;
  if (/\s/.test(s)) throw new Invalid();
  let u;
  try { u = new URL(s); } catch { throw new Invalid(); }
  if (u.protocol !== "https:" && !(allowHttp && u.protocol === "http:")) throw new Invalid();
  if (!u.hostname.includes(".")) throw new Invalid();
  if (u.username || u.password) throw new Invalid();
  return s;
}

// Validates the payload the form in index.html sends. Returns the row to insert, or throws Invalid.
export function validateApplication(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) throw new Invalid();

  const full_name = str(p.full_name, { required: true, max: 200 });
  const email = str(p.email, { required: true, min: 3, max: 320 });
  if (!EMAIL.test(email)) throw new Invalid();
  const phone = str(p.phone, { max: 50 });
  const program = str(p.program, { max: 200 });

  const linkedin_url = httpsUrl(str(p.linkedin_url, { required: true, max: 500 }));
  const lh = new URL(linkedin_url).hostname.toLowerCase();
  if (!(lh === "linkedin.com" || lh.endsWith(".linkedin.com"))) throw new Invalid();
  if (!/linkedin\.com\//i.test(linkedin_url)) throw new Invalid(); // live DB constraint
  // The form uploads a PDF (see validateCvFile). A link is still accepted from older page versions;
  // the handler requires one of the two.
  const cv_url = httpsUrl(str(p.cv_url, { max: 500 }));
  const github_url = httpsUrl(str(p.github_url, { max: 500 }), { allowHttp: true });

  const role = p.role;
  if (typeof role !== "string" || !ROLES.includes(role)) throw new Invalid();
  const rk = p.role_ranking;
  if (!Array.isArray(rk) || rk.length !== ROLES.length) throw new Invalid();
  if (!rk.every((r) => typeof r === "string" && ROLES.includes(r))) throw new Invalid();
  if (new Set(rk).size !== ROLES.length) throw new Invalid();
  if (rk[0] !== role) throw new Invalid();

  const hours_per_week = str(p.hours_per_week, { max: 50 });
  if (hours_per_week !== null && !HOURS.includes(hours_per_week)) throw new Invalid();
  const motivation = str(p.motivation, { max: 4000, multiline: true });

  return {
    full_name, email, phone, program, linkedin_url, cv_url, github_url,
    role, role_ranking: [...rk], hours_per_week, motivation
  };
}

// Validates an uploaded CV: a non-empty PDF up to MAX_CV_BYTES. Checks the size and the "%PDF-" signature
// (the browser-supplied name and type are not trusted). Returns the bytes, or throws Invalid.
export async function validateCvFile(file) {
  if (!file || typeof file !== "object" || typeof file.arrayBuffer !== "function") throw new Invalid();
  if (typeof file.size !== "number" || file.size < 8 || file.size > MAX_CV_BYTES) throw new Invalid();
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length !== file.size || bytes.length > MAX_CV_BYTES) throw new Invalid();
  const sig = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4]);
  if (sig !== "%PDF-") throw new Invalid();
  return bytes;
}

// The notice contains only the applicant's name and first-choice role. Nothing else.
export function buildNotice(row) {
  return {
    to: NOTICE_TO,
    subject: "New board application",
    text:
      "A new board application has arrived.\n\n" +
      "Name: " + row.full_name + "\n" +
      "First choice: " + row.role + "\n\n" +
      "Read the full application in Supabase (applications project, table board_applications).\n"
  };
}

// ---------- IP hashing (raw IP is never stored) ----------

export function clientIp(req) {
  const xff = req.headers.get("x-forwarded-for");
  const first = xff ? xff.split(",")[0].trim() : "";
  const ip = first || (req.headers.get("cf-connecting-ip") || "").trim() || (req.headers.get("x-real-ip") || "").trim();
  return ip && ip.length <= 64 ? ip : null;
}

// HMAC-SHA256(secret, ip) as hex. A plain hash of an IPv4 address could be brute-forced.
export async function hmacIp(secret, ip) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(ip)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- handler ----------

/**
 * store: { countRecentByIpHash(ipHash, sinceIso) -> number, insertApplication(row) -> void (throws on error),
 *          uploadCv(path, bytes) -> void (throws on error), deleteCv(path) -> void }
 * sendMail: ({to, subject, text}) -> Promise
 * hashIp: (ip) -> Promise<string>
 * now: () -> ms
 * sheet: { url, token } from env SHEET_WEBHOOK_URL / SHEET_WEBHOOK_TOKEN; the copy is skipped unless both are set
 * postSheet: (url, body) -> Promise (throws on failure); see createSheetPoster in sheet.js
 */
export function createApplyHandler({
  store, sendMail, hashIp, now = () => Date.now(), log = () => {}, sheet = null, postSheet = null,
  newId = () => crypto.randomUUID()
}) {
  // Optional copy to the board's Google Sheet. Never fails the request; logs only a short code.
  async function copyToSheet(row) {
    const url = sheet && typeof sheet.url === "string" ? sheet.url.trim() : "";
    const token = sheet && typeof sheet.token === "string" ? sheet.token.trim() : "";
    if (!url || !token || typeof postSheet !== "function") return;
    if (!isAllowedSheetUrl(url)) { log("apply: sheet skipped (bad_url)"); return; }
    try {
      await postSheet(url, buildSheetBody(row, token, new Date(now()).toISOString()));
    } catch (err) {
      const code = err && typeof err.code === "string" && /^[a-z0-9_]{1,32}$/.test(err.code) ? err.code : "error";
      log("apply: sheet failed (" + code + ")"); // never the payload, the URL or the error text
    }
  }


  return async function handle(req) {
    const origin = req.headers.get("origin");
    if (req.method === "OPTIONS") {
      return new Response(null, { status: isAllowedOrigin(origin) ? 204 : 403, headers: corsHeaders(origin) });
    }
    if (req.method !== "POST") return reply(origin, 405, { ok: false, error: "method_not_allowed" });
    if (!isAllowedOrigin(origin)) return reply(origin, 403, { ok: false, error: "forbidden_origin" });

    // Two body formats: multipart (fields as JSON in "data", the PDF in "cv"; what the form sends) and plain
    // JSON (older page versions, CV as a link).
    let payload;
    let cvFile = null;
    const contentType = (req.headers.get("content-type") || "").toLowerCase();
    if (contentType.startsWith("multipart/form-data")) {
      const declared = Number(req.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > MAX_UPLOAD_REQUEST_BYTES) {
        return reply(origin, 413, { ok: false, error: "invalid" });
      }
      try {
        const form = await req.formData();
        const raw = form.get("data");
        if (typeof raw !== "string" || raw.length > MAX_BODY_BYTES) return reply(origin, 400, { ok: false, error: "invalid" });
        payload = JSON.parse(raw);
        const f = form.get("cv");
        if (f !== null && typeof f === "string") return reply(origin, 400, { ok: false, error: "invalid" });
        cvFile = f;
      } catch {
        return reply(origin, 400, { ok: false, error: "invalid" });
      }
    } else {
      try {
        const text = await req.text();
        if (text.length > MAX_BODY_BYTES) return reply(origin, 413, { ok: false, error: "invalid" });
        payload = JSON.parse(text);
      } catch {
        return reply(origin, 400, { ok: false, error: "invalid" });
      }
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return reply(origin, 400, { ok: false, error: "invalid" });
    }

    // Honeypot: a visually hidden field people never see. Any value means a bot (or a broken autofill),
    // so reject without saving; a human still sees the error banner and the contact address.
    if (payload.website_url !== undefined && payload.website_url !== null && payload.website_url !== "") {
      return reply(origin, 400, { ok: false, error: "rejected" });
    }
    // Minimum fill time, measured by the page from load to submit.
    const elapsed = payload.elapsed_ms;
    if (typeof elapsed !== "number" || !Number.isFinite(elapsed) || elapsed < MIN_FILL_MS) {
      return reply(origin, 400, { ok: false, error: "too_fast" });
    }

    let row;
    let cvBytes = null;
    try {
      row = validateApplication(payload);
      if (cvFile) cvBytes = await validateCvFile(cvFile);
      if (!cvBytes && !row.cv_url) throw new Invalid(); // a CV (PDF or link) is required
    } catch (err) {
      if (err instanceof Invalid) return reply(origin, 400, { ok: false, error: "invalid" });
      throw err;
    }

    // Rate limit per hashed IP. No IP -> no bucket (never lump everyone together); count errors fail open.
    const ip = clientIp(req);
    let ipHash = null;
    if (ip) {
      try { ipHash = await hashIp(ip); } catch { ipHash = null; }
    }
    if (ipHash) {
      let recent = 0;
      try {
        recent = await store.countRecentByIpHash(ipHash, new Date(now() - RATE_WINDOW_MS).toISOString());
      } catch {
        log("apply: rate-limit count failed");
        recent = 0;
      }
      if (recent >= RATE_MAX) return reply(origin, 429, { ok: false, error: "rate_limited" });
    }

    // The PDF goes into a private storage bucket under a random name (never the applicant's file name).
    let cv_path = null;
    if (cvBytes) {
      cv_path = newId() + ".pdf";
      try {
        await store.uploadCv(cv_path, cvBytes);
      } catch {
        log("apply: cv upload failed");
        return reply(origin, 500, { ok: false, error: "server_error" });
      }
    }

    try {
      await store.insertApplication({ ...row, cv_path, ip_hash: ipHash });
    } catch {
      log("apply: insert failed"); // never log the payload or the database error text (personal data)
      if (cv_path) {
        try { await store.deleteCv(cv_path); } catch { log("apply: cv cleanup failed"); }
      }
      return reply(origin, 500, { ok: false, error: "server_error" });
    }

    // The application is saved; neither the notice nor the sheet copy may fail the request.
    await Promise.all([
      (async () => {
        try {
          await sendMail(buildNotice(row));
        } catch {
          log("apply: notice mail failed");
        }
      })(),
      copyToSheet({ ...row, cv_path })
    ]);

    return reply(origin, 200, { ok: true });
  };
}
