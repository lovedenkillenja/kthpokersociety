// Pure request handler for the `apply` Edge Function (board applications).
// No Deno or network imports here so the logic runs under `node --test` with a stub store and mailer.
// The Deno entrypoint (index.js) injects: store, sendMail, hashIp, now.

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
const MAX_BODY_BYTES = 16 * 1024;

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
  const cv_url = httpsUrl(str(p.cv_url, { required: true, max: 500 }));
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
 * store: { countRecentByIpHash(ipHash, sinceIso) -> number, insertApplication(row) -> void (throws on error) }
 * sendMail: ({to, subject, text}) -> Promise
 * hashIp: (ip) -> Promise<string>
 * now: () -> ms
 */
export function createApplyHandler({ store, sendMail, hashIp, now = () => Date.now(), log = () => {} }) {
  return async function handle(req) {
    const origin = req.headers.get("origin");
    if (req.method === "OPTIONS") {
      return new Response(null, { status: isAllowedOrigin(origin) ? 204 : 403, headers: corsHeaders(origin) });
    }
    if (req.method !== "POST") return reply(origin, 405, { ok: false, error: "method_not_allowed" });
    if (!isAllowedOrigin(origin)) return reply(origin, 403, { ok: false, error: "forbidden_origin" });

    let payload;
    try {
      const text = await req.text();
      if (text.length > MAX_BODY_BYTES) return reply(origin, 413, { ok: false, error: "invalid" });
      payload = JSON.parse(text);
    } catch {
      return reply(origin, 400, { ok: false, error: "invalid" });
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
    try {
      row = validateApplication(payload);
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

    try {
      await store.insertApplication({ ...row, ip_hash: ipHash });
    } catch {
      log("apply: insert failed"); // never log the payload or the database error text (personal data)
      return reply(origin, 500, { ok: false, error: "server_error" });
    }

    try {
      await sendMail(buildNotice(row));
    } catch {
      log("apply: notice mail failed"); // the application is saved; do not fail the request
    }

    return reply(origin, 200, { ok: true });
  };
}
