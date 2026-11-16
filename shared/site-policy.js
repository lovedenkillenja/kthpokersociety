// Site policy for the Cloudflare Pages middleware (functions/_middleware.js).
// Mirrors netlify.toml: the security headers and the forced-404 list must stay identical
// (checked by game/tests/cloudflare-config.test.js). Cloudflare Pages `_redirects` cannot
// return 404, so the middleware enforces the block list instead.

// Same values as the [[headers]] for = "/*" block in netlify.toml and the _headers file.
export const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https://tibyyjnghhwwcxvlwmiq.supabase.co wss://tibyyjnghhwwcxvlwmiq.supabase.co https://hrdqlaurdzyueviplbmj.supabase.co wss://hrdqlaurdzyueviplbmj.supabase.co; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'; upgrade-insecure-requests",
  "Permissions-Policy": "accelerometer=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), hid=(), magnetometer=(), microphone=(), midi=(), payment=(), serial=(), usb=(), xr-spatial-tracking=(), browsing-topics=(), fullscreen=(self)",
};

// Same entries as the forced-404 [[redirects]] in netlify.toml ("/x/*" blocks /x and everything below it).
export const BLOCKED = [
  "/docs/*", "/supabase/*", "/netlify/*", "/functions/*", "/shared/*",
  "/AGENTS.md", "/CLAUDE.md", "/README.md", "/netlify.toml", "/.gitignore", "/_headers", "/_redirects",
  "/game/tests/*", "/game/scripts/*", "/game/README.md",
];

// Decode, unify slashes, resolve dot segments and lower-case, so /%64ocs/x, //docs/x,
// /a/../docs/x and /Docs/x are all matched like /docs/x. Returns null if undecodable.
export function normalizePath(pathname) {
  let p;
  try { p = decodeURIComponent(pathname); } catch (_) { return null; }
  p = p.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  try { p = new URL(p, "https://x.invalid").pathname; } catch (_) { return null; }
  try { p = decodeURIComponent(p); } catch (_) { return null; }
  return p.toLowerCase();
}

export function isBlocked(path) {
  if (path === null) return true;
  return BLOCKED.some((rule) => {
    const r = rule.toLowerCase();
    if (r.endsWith("/*")) {
      const dir = r.slice(0, -2);
      return path === dir || path.startsWith(dir + "/");
    }
    return path === r;
  });
}

export function isGamePath(path) {
  return path !== null && (path === "/game" || path.startsWith("/game/"));
}
