// Server-side gate for the game while it is not public.
// The dev code is the Netlify env var DEV_CODE; the cookie is an HMAC signed with DEV_COOKIE_SECRET.
// Neither value is in the repository. If either variable is missing the gate stays closed.
// To launch the game: delete this file and the [[edge_functions]] block in netlify.toml.

const COOKIE = "kps_dev";
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days
const UNLOCK_PATH = "/game/__unlock";

async function sign(secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode("kps-game-dev-v1"));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

function same(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function readCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}

// Only allow redirecting back into /game (no open redirect).
export function safeNext(value) {
  const v = typeof value === "string" ? value : "";
  if (/^\/game(\/[^\s\\]*)?(\?[^\s\\]*)?$/.test(v) && !v.startsWith("//") && !v.startsWith("/game/__unlock")) return v;
  return "/game/";
}

function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function gatePage({ next, message, canUnlock, status }) {
  const form = canUnlock
    ? `<form method="post" action="${UNLOCK_PATH}" autocomplete="off">
         <input type="hidden" name="next" value="${escapeAttr(next)}">
         <input name="code" type="password" inputmode="numeric" placeholder="Developer code" aria-label="Developer code" autofocus>
         <button type="submit">Enter</button>
       </form>`
    : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Game coming soon | KTH Poker Society</title>
<style>
html{background:#06142a}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;background:#06142a;color:#f4f1ea;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;text-align:center}
main{max-width:420px;width:100%}h1{font-family:Georgia,"Times New Roman",serif;font-weight:400;font-size:clamp(2.25rem,8vw,3.25rem);line-height:1.05;margin:0 0 12px}
p{margin:0 0 24px;color:#a9b8cf}form{display:flex;gap:8px;justify-content:center}
input[name=code]{width:9em;padding:12px 14px;border-radius:8px;border:1px solid #3a557c;background:#0a2142;color:#f4f1ea;font:inherit;text-align:center;letter-spacing:.2em}
button{padding:12px 18px;border-radius:8px;border:0;background:#0a64d6;color:#fff;font:inherit;font-weight:600;cursor:pointer}
.err{min-height:1.5em;margin:12px 0 0;color:#ffb4a8;font-size:.9375rem}a{color:#8fb8ff}
</style></head><body><main><h1>Game coming soon</h1>
<p>The KTH Poker Society chip game is not public yet.</p>${form}<p class="err" role="alert">${escapeAttr(message || "")}</p>
<p><a href="/">Back to the website</a></p></main></body></html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" },
  });
}

export default async function gameGate(request, context) {
  const url = new URL(request.url);
  const code = Netlify.env.get("DEV_CODE");
  const secret = Netlify.env.get("DEV_COOKIE_SECRET");
  if (!code || !secret) return gatePage({ next: "/game/", message: "", canUnlock: false, status: 403 });

  const token = await sign(secret);

  if (url.pathname === UNLOCK_PATH) {
    if (request.method !== "POST") return Response.redirect(new URL("/game/", url).toString(), 303);
    let given = "", next = "/game/";
    try {
      const form = await request.formData();
      given = String(form.get("code") || "").trim();
      next = safeNext(form.get("next"));
    } catch (_) { /* fall through to wrong code */ }
    if (same(given, code)) {
      return new Response(null, {
        status: 303,
        headers: {
          location: next,
          "cache-control": "no-store",
          "set-cookie": `${COOKIE}=${token}; Path=/game; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Lax`,
        },
      });
    }
    return gatePage({ next, message: "Wrong code.", canUnlock: true, status: 401 });
  }

  if (same(readCookie(request, COOKIE), token)) return context.next();
  return gatePage({ next: url.pathname + url.search, message: "", canUnlock: true, status: 401 });
}

