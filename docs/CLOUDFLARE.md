# Cloudflare Pages setup (Netlify stays as fallback)

The same repository deploys to both Netlify and Cloudflare Pages. There is no build step and the site root is the repository root. Nothing here changes Netlify. Netlify keeps serving kthpokersociety.se until the domain is moved on purpose.

## What is in the repo

| File | Used by | Purpose |
|---|---|---|
| `netlify.toml` | Netlify | Headers, forced-404 list, game-gate edge function (unchanged source of truth for Netlify) |
| `netlify/edge-functions/game-gate.js` | Netlify | Thin wrapper around `shared/game-gate-core.js` |
| `functions/_middleware.js` | Cloudflare | Runs before every request: game gate on `/game` and `/game/*`, 404 for repository files, security headers on every response |
| `shared/game-gate-core.js` | both | The gate logic (HMAC-signed `kps_dev` cookie, 30 days, constant-time comparison, closed when env vars are missing) |
| `shared/site-policy.js` | Cloudflare | Security headers and block list (must equal `netlify.toml`, checked by `game/tests/cloudflare-config.test.js`) |
| `_headers` | Cloudflare (Netlify also reads it) | Same five headers as `netlify.toml`, byte-identical values |
| `_redirects` | Cloudflare (Netlify also reads it) | Comments only, on purpose (see limits below) |

### Platform differences and limits (read before changing anything)
- **Pages `_redirects` cannot return 404.** It supports only 200 (rewrite) and 301/302/303/307/308. So the forced-404 list from `netlify.toml` is enforced by `functions/_middleware.js`, not by `_redirects`. Redirects in `_redirects` also do not apply to requests that a Function handles.
- **Pages `_headers` is not applied to responses that a Function creates** (the gate page, the 404). The middleware adds the same headers itself, and only when the header is not already set, so there are no duplicates.
- **Files are uploaded, only not served.** With output directory = repo root, `docs/`, `supabase/`, `netlify/`, `functions/`, `shared/` and the repo meta files are uploaded to Cloudflare. The middleware answers 404 for them (also for encoded, doubled-slash, dot-segment and upper-case variants such as `/%64ocs/...`). `.assetsignore` is a Workers feature, not Pages, so it is not used. The only way to not upload them at all would be a build step that copies the site to a `dist/` folder; not done, to keep "no build step".
- **The middleware runs on every request** (no `_routes.json`), on purpose: narrowing it would let encoded path variants bypass the block list. Every page view therefore counts as Functions requests (about 10 to 30 per page load). The free plan allows 100,000 Functions requests per day.
- **Quota decision for Love.** When the daily free Functions quota runs out, Pages either serves static assets without running the middleware ("fail open": the game gate and the block list are off, so the game and the repo files are public) or returns an error page ("fail closed"). Because the middleware runs on every request, fail closed takes the **whole site** down (home page included) until midnight UTC. At 10 to 30 requests per page load the free quota is roughly 3,000 to 10,000 page views a day, and anyone can use it up on purpose. Choices: fail closed (site down when exhausted, recommended while the game is gated), fail open (gate and block list off when exhausted), or the paid Workers plan (no daily limit). Do not add a `_routes.json` exclude to save quota: it can let encoded paths such as `/assets/%2e%2e/docs/...` skip the middleware.
- **Unknown paths:** the repo has no `404.html`. On Cloudflare an unknown path such as `/xyz` returns `index.html` with status 200 (Pages single-page fallback). Netlify returns its own 404 page. Harmless, but different.
- **Netlify also reads `_headers` and `_redirects`.** Because the values are identical to `netlify.toml`, Netlify should behave the same. UNVERIFIED until checked on a Netlify deploy preview (checklist below).
- **Netlify bundling of `shared/game-gate-core.js`** (an import from outside `netlify/edge-functions/`) is standard for Netlify edge functions but UNVERIFIED until a Netlify deploy preview builds.

## Click-by-click setup (Love)

1. Log in at https://dash.cloudflare.com. Left menu: **Workers & Pages**. Click **Create** (or "Create application"), then the **Pages** tab, then **Connect to Git** (or "Import an existing Git repository").
2. Connect GitHub if asked and give Cloudflare access to the repository `lovedenkillenja/kthpokersociety` only (choose "Only select repositories"). Select it and click **Begin setup**.
3. **Set up builds and deployments:**
   - Project name: `kthpokersociety` (this becomes `kthpokersociety.pages.dev`; take any free name).
   - Production branch: `v3-merged-design`.
   - Framework preset: **None**.
   - Build command: leave **empty**.
   - Build output directory: `/` (the repository root).
   - Root directory (advanced): leave empty.
4. **Environment variables** (same page, or later under the project's **Settings > Variables and Secrets**): add, for **Production** and **Preview**:
   - `DEV_CODE`: the developer code, type **Secret** (Encrypt).
   - `DEV_COOKIE_SECRET`: a long random string (for example the output of `openssl rand -hex 32` on your Mac), type **Secret**. Use a different value than on Netlify, so a cookie from one host does not work on the other.
   Never put either value in git, docs or chat.
5. Click **Save and Deploy**. Wait for the first deployment to finish. If you added the secrets after the first deploy, go to **Deployments**, open the latest one, and click **Retry deployment** (secrets only apply to new deployments).
6. **Settings > Runtime** (in older dashboards: **Settings > Functions**): set the free-tier limit behaviour (see "Quota decision" above; fail closed while the game is gated).
7. Preview check: open `https://kthpokersociety.pages.dev` (the name from step 3) and run the verification checklist below. **First check that the middleware runs:** if `/game/` returns 200 or `/docs/PROJECT.md` is not 404, the Functions were not deployed (the deployment page lists "Functions" when they are). Stop, do not share the URL, and check the deploy log. Each pull request also gets a preview URL `https://<hash>.kthpokersociety.pages.dev`.
8. **Optional:** **Settings > Builds & deployments > Preview deployments**: choose "None" or "Custom branches" if you do not want every branch built.

### Attaching kthpokersociety.se later (ask first, DNS change)
Only when the checklist passes and you decide to switch:
1. Pages project > **Custom domains** > **Set up a custom domain** > `kthpokersociety.se`, then also `www.kthpokersociety.se`.
2. If the domain's DNS is on Cloudflare, Cloudflare adds the records for you. If the DNS stays at the current registrar, Cloudflare shows a CNAME target (`kthpokersociety.pages.dev`); a root domain usually needs the DNS moved to Cloudflare (change the nameservers at the registrar to the two Cloudflare shows).
3. Before switching, lower the TTL of the current records (for example to 300 seconds) a day ahead so a rollback is quick.
4. Supabase Auth: add `https://kthpokersociety.pages.dev` (and the preview pattern if needed) to **Authentication > URL Configuration > Redirect URLs** only if you want to log in on the pages.dev URL. The live domain stays the same, so no change is needed for kthpokersociety.se itself. (This is an Auth setting change: decide it yourself.)
5. In Netlify, remove the custom domain from the Netlify project only after Cloudflare serves the domain correctly.

### Rollback to Netlify
- Netlify keeps deploying from the same branch the whole time, so nothing needs to be rebuilt.
- Point the DNS records for `kthpokersociety.se` back to Netlify (the values Netlify shows under **Domain management**), or, if the nameservers moved to Cloudflare, set the records in Cloudflare DNS to Netlify's target and remove the domain from the Pages project.
- Re-add the custom domain in Netlify if it was removed there.
- To stop Cloudflare entirely: Pages project > **Settings** > **Delete project** (ask first, it cannot be undone). Deleting `functions/`, `shared/site-policy.js`, `_headers` and `_redirects` is not needed for Netlify to work.

### Launching the game later
Remove the `isGamePath` branch in `functions/_middleware.js` (keep the block list and headers) and, for Netlify, the edge function file and its `[[edge_functions]]` blocks. Then `shared/game-gate-core.js` can go too.

## Verification checklist
Run on the Pages URL (replace `$B`, for example `B=https://kthpokersociety.pages.dev`). Never paste the dev code into a shared terminal log.

- [ ] `curl -sI $B/` shows status 200 and `content-security-policy`, `x-frame-options: DENY`, `permissions-policy`, `referrer-policy`, `x-content-type-options`, each exactly once.
- [ ] `curl -s -o /dev/null -w '%{http_code}\n' $B/docs/PROJECT.md` gives 404. Same for `/%64ocs/PROJECT.md`, `/supabase/`, `/netlify/edge-functions/game-gate.js`, `/functions/_middleware.js`, `/shared/site-policy.js`, `/AGENTS.md`, `/README.md`, `/netlify.toml`, `/_headers`.
- [ ] `curl -sI $B/game/` gives 401, `x-robots-tag: noindex`, `cache-control: no-store` and the CSP. In a browser, `/game/` shows "Game coming soon" with a code field.
- [ ] A wrong code shows "Wrong code." and no cookie. The right code redirects to `/game/` and sets `kps_dev` (HttpOnly, Secure, SameSite=Lax, Path=/game, Max-Age 2592000). The game lobby loads and logging in works (Supabase calls are not blocked by the CSP: check the browser console).
- [ ] With the cookie, `/game/tests/engine.test.js` is still 404.
- [ ] Temporarily remove `DEV_CODE` in a preview environment and redeploy: `/game/` gives 403 without a code form (closed). Put it back.
- [ ] Settings > Runtime shows the limit behaviour Love chose (fail closed while the game is gated).
- [ ] Netlify deploy preview of this branch (the PR): `curl -sI` on `/` shows each security header exactly once (not "DENY, DENY"), `/docs/PROJECT.md` and `/functions/_middleware.js` give 404, and the gate unlock still works (shared module bundled).
- [ ] Pages at 375px and desktop width: the home page and the game open with no console errors.

## Verified locally (2026-11-16)
`wrangler pages dev .` (wrangler 3.114.0, local Miniflare, throwaway code): all paths in the checklist behave as listed (headers once each, blocked paths and their encoded, doubled-slash, dot-segment and upper-case variants 404, gate 401/303/cookie/pass-through, forged cookie 401, `/game/tests/*` 404 with a valid cookie). `node --test` covers header and block-list parity and the middleware. Not verified: a real Cloudflare deployment, fail-closed behaviour, the Netlify deploy preview with `_headers` present, Realtime under the CSP on Pages.
