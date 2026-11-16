// Optional copy of each accepted board application to a Google Sheet, via a Google Apps Script web app.
// Setup and the Apps Script source: docs/APPLICATIONS_SHEET.md.
// No Deno imports: runs under `node --test`. `fetch` is injected so the network path is testable.

export const SHEET_HOSTS = Object.freeze(["script.google.com", "script.googleusercontent.com"]);
export const SHEET_TIMEOUT_MS = 8000;
const MAX_HOPS = 4;

// Only https, only the two Apps Script hosts, no userinfo, no explicit port.
export function isAllowedSheetUrl(s) {
  if (typeof s !== "string" || !s) return false;
  let u;
  try { u = new URL(s); } catch { return false; }
  return u.protocol === "https:" && SHEET_HOSTS.includes(u.hostname.toLowerCase()) &&
    !u.username && !u.password && u.port === "";
}

// Spreadsheet formula injection: a cell starting with = + - @ (or tab / CR) is text, not a formula.
// Idempotent: a value already starting with ' is left alone. The Apps Script does the same.
export function sanitizeCell(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

// The JSON body for the Apps Script. A copy for the sheet only; the DB row is not touched.
export function buildSheetBody(row, token, submittedAt) {
  return {
    token,
    submitted_at: submittedAt,
    full_name: sanitizeCell(row.full_name),
    email: sanitizeCell(row.email),
    phone: sanitizeCell(row.phone),
    program: sanitizeCell(row.program),
    linkedin_url: sanitizeCell(row.linkedin_url),
    // An uploaded CV is not linked (the bucket is private); the cell says where to find the file.
    cv_url: sanitizeCell(row.cv_url || (row.cv_path ? "Uploaded PDF in Supabase Storage: " + row.cv_path : "")),
    github_url: sanitizeCell(row.github_url),
    role: sanitizeCell(row.role),
    role_ranking: sanitizeCell(Array.isArray(row.role_ranking) ? row.role_ranking.join(" > ") : ""),
    hours_per_week: sanitizeCell(row.hours_per_week),
    motivation: sanitizeCell(row.motivation)
  };
}

class SheetError extends Error {
  constructor(code) { super(code); this.code = code; }
}

/**
 * Returns a poster `(url, body) => Promise<void>` that throws a SheetError with a short code on failure.
 * Apps Script runs doPost on the first POST and answers 302 to a googleusercontent URL that serves the
 * output. Redirects are followed by hand so every hop is checked against the allowlist and sent as a GET
 * without a body (the token only goes in the first request). Never retried: the row may already be written.
 * Success means the script answered JSON {ok: true}; a rejected token still comes back as HTTP 200.
 */
export function createSheetPoster(fetchImpl, { timeoutMs = SHEET_TIMEOUT_MS } = {}) {
  return async function postSheet(url, body) {
    if (!isAllowedSheetUrl(url)) throw new SheetError("bad_url");
    const signal = AbortSignal.timeout(timeoutMs);
    let res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "manual",
      signal
    });
    for (let hop = 0; res.status >= 300 && res.status < 400; hop++) {
      if (hop >= MAX_HOPS) throw new SheetError("too_many_redirects");
      const loc = res.headers.get("location");
      let next;
      try { next = new URL(loc, url).href; } catch { throw new SheetError("bad_redirect"); }
      if (!isAllowedSheetUrl(next)) throw new SheetError("bad_redirect");
      try { await res.body?.cancel(); } catch { /* ignore */ }
      url = next;
      res = await fetchImpl(url, { method: "GET", redirect: "manual", signal });
    }
    if (!res.ok) throw new SheetError("http_" + res.status);
    let out;
    try { out = JSON.parse(await res.text()); } catch { throw new SheetError("bad_response"); }
    if (!out || out.ok !== true) throw new SheetError("rejected");
  };
}
