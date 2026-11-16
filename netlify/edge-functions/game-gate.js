// Server-side gate for the game while it is not public (Netlify edge function).
// The dev code is the Netlify env var DEV_CODE; the cookie is an HMAC signed with DEV_COOKIE_SECRET.
// Neither value is in the repository. If either variable is missing the gate stays closed.
// The logic lives in shared/game-gate-core.js (also used by the Cloudflare Pages middleware).
// To launch the game: delete this file and the [[edge_functions]] blocks in netlify.toml
// (and the gate part of functions/_middleware.js for Cloudflare).

import { handleGate, safeNext } from "../../shared/game-gate-core.js";

export { safeNext };

export default async function gameGate(request, context) {
  return handleGate(request, {
    code: Netlify.env.get("DEV_CODE"),
    secret: Netlify.env.get("DEV_COOKIE_SECRET"),
    next: () => context.next(),
  });
}
