// Cloudflare Pages middleware: runs for every request before static assets.
// 1. /game and /game/* go through the server-side dev-code gate (same logic as the Netlify
//    edge function, shared/game-gate-core.js). Env vars DEV_CODE and DEV_COOKIE_SECRET are set
//    as encrypted secrets in the Pages project; if either is missing the gate stays closed.
// 2. Repository files that are not part of the site get a 404 (Pages _redirects cannot do 404).
// 3. The security headers are added to every response, because Pages does not apply _headers
//    to responses produced by Functions.
// To launch the game: remove the isGamePath branch below (and the Netlify edge function).

import { handleGate } from "../shared/game-gate-core.js";
import { SECURITY_HEADERS, normalizePath, isBlocked, isGamePath } from "../shared/site-policy.js";

function notFound() {
  return new Response("Not found\n", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" },
  });
}

function withSecurityHeaders(response) {
  const res = new Response(response.body, response);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (!res.headers.has(k)) res.headers.set(k, v);
  }
  return res;
}

export async function onRequest(context) {
  const { request, env } = context;
  const path = normalizePath(new URL(request.url).pathname);
  const pass = () => (isBlocked(path) ? notFound() : context.next());

  let response;
  if (isGamePath(path)) {
    response = await handleGate(request, {
      code: env.DEV_CODE,
      secret: env.DEV_COOKIE_SECRET,
      next: pass,
    });
  } else {
    response = await pass();
  }
  return withSecurityHeaders(response);
}
