# KTH Poker Society: project overview

Last updated: 2026-11-14. Update the "Current state" and "Open issues" sections at the end of every work session.

## 1. What this project is
KTH Poker Society is a student association at KTH Royal Institute of Technology (Stockholm) for poker strategy, probability and game theory. **No real money, ever.** The project has three parts:

1. **The website** (`index.html`): presents the society, lets people create a member account, and has an application form for board roles.
2. **Member accounts** (Supabase Auth + table `members`).
3. **A play-money Texas Hold'em game** (`game/`) where members play with chips they earn (welcome bonus, invites, events). Finished and tested, but **not public yet**.

People: **Love** (co-founder, owner, makes the decisions, writes Swedish; talk to him in Swedish, write all code, comments and agent prompts in English). Agents: a project lead agent plans and reviews; worker agents (Claude Opus/Sonnet) do the coding. See `AGENTS.md`.

## 2. Infrastructure map

| Thing | Where | Notes |
|---|---|---|
| Source code | GitHub `lovedenkillenja/kthpokersociety` (public) | Live branch: `v3-merged-design` |
| Live site | https://kthpokersociety.se | Netlify project `kthpokersociety-v3` (id `fc4c2884-6e35-405b-86fb-319b463b6ff8`), production branch `v3-merged-design`, auto-deploys on push |
| Branch previews | `https://<branch>--kthpokersociety-v3.netlify.app` | Confirmed to work for `poker-game`; verify for other branches |
| Members + game database | Supabase project `tibyyjnghhwwcxvlwmiq` (eu-west-3) | URL `https://tibyyjnghhwwcxvlwmiq.supabase.co`. Auth, `members`, chips, tables, hands, referrals |
| Applications database | Supabase project `hrdqlaurdzyueviplbmj`, named "kthps-prototype-2" (eu-north-1) | Only table `board_applications` |
| Edge Functions | in the members project: `table`, `act` (v2, JWT required) | Source in `supabase/functions/`, deployed with the Supabase CLI or MCP |
| Old Netlify projects | `kthpokersociety` (prototype 1, id `24bb6f9e-7704-4452-8b81-513b9741c18a`) and `kthpokersociety-prototype-2` (id `58dfc7ea-4254-4325-9179-ac32d86fcc3f`) | Archived prototypes, not live. Do not touch without asking Love |
| Game gate | Netlify Edge Function `netlify/edge-functions/game-gate.js` | Server-side dev code for `/game`. Env vars `DEV_CODE` (the code) and `DEV_COOKIE_SECRET` (any long random string) on project `kthpokersociety-v3`; both must be set (as secret values) and the site redeployed, otherwise the gate stays closed for everyone. Cookie `kps_dev`, 30 days, per browser |
| Spare domain | `kthpokersociety.online` | Unused. Ask Love and check DNS before touching |

The Supabase URL and the publishable (anon) key are public and appear in client code. **The service role key, CLI logins and any other secret must never be written to the repo or to docs.** They live in Supabase (Edge Function secrets) and on Love's computer.

Branches in the repo:
- `v3-merged-design`: the live website AND the game (merged 2026-11-13). Everything is here.
- `poker-game`: where the game was built; fully merged, can be deleted after Love agrees.
- `main`: prototype 2 (old). Netlify does not use it. Ask Love before changing it.
- `poker-game-workspace`, `build-kth-website-870018167465421569`: old branches, no longer needed.

## 3. Architecture

**Website.** One file, `index.html`, everything inline (CSS, JS, an embedded base64 photo on one very long line, about line 524: never print that line). No build step. `netlify.toml` publishes the repo root, sets security headers and puts `/game` behind the dev-code gate. Desktop (width >= 961px) groups sections into "pages" by `data-page` with hash routing (`#about`, `#events`, `#board`, `#roles`, `#partners`, `#faq`); mobile shows one long page. Details and the design decisions: `docs/v3-notes.md`, `docs/creative-brief.md`, `docs/BUILD_SPEC.md` (older, prototype 2; the v3 notes win where they differ).

**Accounts.** The account dialog in `index.html` uses supabase-js (pinned v2.45.4 from jsDelivr) against the members project: sign up, sign in, password reset, profile. A trigger on `auth.users` creates the `members` row; another trigger gives +1000 welcome chips.

**Application form.** The "Open roles" section posts to `board_applications` in the *applications* project with the anon key (insert-only). The five roles are ranked by drag and drop (arrow buttons kept for keyboard users). The first choice goes in `role`, the whole order in `role_ranking`. LinkedIn and CV links are required. Nothing notifies anyone when an application arrives; read them in Supabase (see `docs/DATABASE.md`).

**Game.** `game/` is plain ES modules. The server decides everything: Edge Functions `table` (create/join/leave) and `act` (fold/check/call/raise/all-in, timers) run the shared pure engine (`game/engine/`, copied to `supabase/functions/_shared/engine/` by `game/scripts/sync-engine.js`) and persist through SQL functions (`start_hand_tx`, `apply_hand_tx`). Browsers can only read (RLS) and never write chips. Realtime channels broadcast table state. Chips are an append-only ledger (`chip_ledger`, balance = sum of `delta`). Referral system: `get_my_referral`, `redeem_referral`, `claim_referral_rewards` (reward 250 chips, cap 20 rewarded invites, payout delay set in `referral_config()`, currently immediate). Full schema: `supabase/schema/`. Rules and data model: `docs/poker/SPEC.md`. Build history: `docs/history/game-milestones.md`.

**Tests.** `node --test` from the repo root (71 tests: engine, edge-function handlers, store transactions, layout, referral, format, game gate, netlify config).

## 4. How things get deployed
- **Website and game files:** `git push` to `v3-merged-design`; Netlify deploys to kthpokersociety.se. There is no staging gate, so **push risky changes on a feature branch first** and check the branch preview.
- **Database changes:** a new file in `supabase/migrations/` (timestamped, additive, RLS on every new table). Apply with the Supabase MCP `apply_migration` or the SQL editor, test in a rolled-back `DO` block (raise an exception at the end with the results) and keep the repo file identical to what was applied. Never edit an applied migration. Check `get_advisors` afterwards.
- **Edge Functions:** `supabase functions deploy table act --project-ref tibyyjnghhwwcxvlwmiq` (needs `supabase login` on Love's machine) or the MCP `deploy_edge_function`.

## 5. Current state (2026-11-13)
- Website is live at kthpokersociety.se for everyone. The "coming soon" developer gate was removed. The menu shows "Game soon" (not a link).
- The game is complete (milestones M1 to M6.1 and M7.1) but not public: `/game` and `/game/*` are behind a server-side dev code (`netlify/edge-functions/game-gate.js`). Love and testers type the code once per browser. To launch, delete the edge function file and the two `[[edge_functions]]` blocks in `netlify.toml`.
- **Gate setup status:** code and tests are in the repo. The two env vars `DEV_CODE` and `DEV_COOKIE_SECRET` could not be set by the assistant (Netlify API returned 403 for secret values), so Love must set them in the Netlify UI (Project configuration, Environment variables) and trigger a redeploy. Until then `/game` shows "coming soon" without a code form.
- Chips: welcome +1000; daily check-in was removed; referral +250 per invited member (cap 20).
- The applications project had been paused by Supabase and was restored on 2026-11-13; it holds 2 older (test) applications.
- The members database holds 10 accounts after the 2026-11-14 cleanup (see open issues).
- The site is still `noindex` (search engines will not list it).

## 5b. Wave 1 (merged to live 2026-11-14 through PR #2)
- `index.html` is now about 80 KB: board photos live in `assets/board/*.jpg` (the old "never print the base64 line" warning no longer applies). Skip link, canonical and OG tags, SRI on supabase-js (both pages).
- Game lobby no longer scrolls sideways at 375px.
- `netlify.toml`: CSP, X-Frame-Options, Permissions-Policy; forced 404 for `/docs/*`, `/supabase/*`, `/netlify/*`, repo meta files, `/game/tests/*`, `/game/scripts/*`. Test: `game/tests/netlify-config.test.js`.
- Verified on the PR deploy preview with a logged-in test account: headers sent, 404 rules, site login, gate unlock form, lobby, table view, leaderboard, profile, Edge Function calls. UNVERIFIED: a hand in progress and Realtime between two players under the CSP.
- Netlify: project `kthpokersociety-v3` was NOT linked to GitHub before 2026-11-14 (earlier deploys were manual). Love linked it; pushes to `v3-merged-design` now deploy to production and pull requests get deploy previews (`deploy-preview-<n>--kthpokersociety-v3.netlify.app`). Plain branch URLs are not built. The old project `kthpokersociety-prototype-2` is also linked to the repo (production branch `main`) and builds its own, login-protected previews.
- The Netlify preview toolbar iframe is blocked by the CSP on previews only (harmless).
- Follow-ups: replace `'unsafe-inline'` in `script-src` with hashes or external script files; the CSP pins jsDelivr to `supabase-js@2.45.4/`, so a version bump must update the CSP and both SRI hashes; add a real `404.html`; add an `og:image`; convert board photos to WebP.

## 6. Open issues and decisions for Love (highest priority first)
1. **Game gate env vars: appear to be set.** On 2026-11-14 `/game/` answered 401 with the code form (403 would mean missing vars). Love should confirm the code works.
2. **Test data cleaned up 2026-11-14 (done).** Love approved deleting 11 accounts (9 obvious test accounts and 2 of his own duplicates). Seated chips were cashed out with `leave_seat` first, then the 8 tables those accounts hosted (with 18 hands), their seats and the accounts were deleted in one transaction. 10 accounts remain (one is Love's new test account). Side effect: `supabase/checks/chip_conservation.sql` now reports a constant global discrepancy of **+290** (chips the remaining members won from deleted accounts; the deleted accounts' ledger rows are gone). Treat 290 as the baseline, not as a bug; no negative balances.
3. **Supabase Auth Site URL: set by Love 2026-11-14 to `https://kthpokersociety.se` in both projects; still UNVERIFIED by a real confirmation email, and the redirect URL list has not been checked.** It was `http://localhost:3000`. It must be `https://kthpokersociety.se`, and the redirect URL list must include `https://kthpokersociety.se/**` and the branch previews. This affects confirmation and password-reset emails. The MCP cannot read or change it; check in the dashboard (Authentication, URL Configuration).
4. **Applications database can pause again** (Supabase pauses inactive projects on the free plan; check the plan). If it pauses, the form fails silently for visitors. Options: upgrade, move the table into the members project, or add a keep-alive. There is no notification for new applications: consider an email notification or a small admin view.
5. **`noindex`** is still on in `index.html`. Remove it when Love wants the site to appear in Google.
6. **Game launch checklist:** remove the game gate; decide the referral payout delay (currently immediate; Love suggested 7 days later: change `referral_config()`); verify Site URL (above); run the two-account referral test on a preview; decide what happens with test accounts and their chips; the in-game invite link points to `kthpokersociety.se/game/?ref=CODE`.
7. **Database hygiene (low risk, not urgent):** `anon`/`authenticated` hold broader table privileges than needed on `members` (INSERT/DELETE/TRUNCATE etc.), on the views `chip_balances` and `public_hands`, and on `board_applications` in the applications project. RLS and `security_invoker` views make this unexploitable through the API today, but revoking the extra privileges is cleaner. Also: leaked-password protection is off (Love's call), `pg_cron` is not installed (idle empty poker tables only close when a host creates a new table).
8. **Content:** Adam Kango's board photo is missing (initials are used). No date for the first event yet (Events section stays an empty state).
8b. **Welcome email (requested by Love 2026-11-14):** planned for wave 2. Simplest: turn the Supabase "Confirm signup" email template into a welcome email; a separate post-confirmation email needs a mail provider and an API key.
8c. **Wave 2 (game design), on branch `work/wave2`, pull request open, NOT merged:**
   - Lockout fix: "Join by room code" asks the server first and reopens a table the member is already seated at; the lobby shows "Your chips at tables" with "Return to table" (first panel when seated) and wallet / at-tables figures. Client reads only; no server or schema change. UNVERIFIED with a real login.
   - Lobby and shell redesign: slim play-money strip, compact header, Play first (join, then create; create is collapsed on mobile), invite panel with truncated link, compact history. Fixed a call to a non-existent `renderHeader()` in the referral callbacks.
   - Table redesign: oval felt with rail, seats around the table (own seat bottom centre), open seats drawn, bets between seat and pot, dealer button, one status line, pot hidden until a hand runs, side-pot pills only when they matter, readable showdown. Nothing clipped at 320 to 1280px in the harness.
   - Design harnesses (mock data, no network): `game/dev/table-harness.html?state=<name>&bar=0` (waiting-1, waiting-3, preflop-2, preflop-6, flop-self-to-act, turn-allin-sidepots, river-folded-self, showdown-split, sitout, timer-low) and `game/dev/lobby-harness.html?variant=seated|wallet#lobby|leaderboard|profile`; `game/dev/audit.js` checks clipping and overlaps. They sit behind the game gate today; **before launch add `/game/dev/*` to the forced-404 list in `netlify.toml`.** In a background browser tab the card deal animation does not run, so cards look faded in screenshots: front the tab or finish animations first.
   - UNVERIFIED: everything with a real login and two players (a full hand, Realtime, keyboard shortcuts, live-region announcements after the re-layout). Known polish left: dealer button can overlap a chip icon on a folded seat; seats are small on very wide desktop felts; minor overlaps at 667x375 landscape.
8c-2. **HANDOFF (2026-11-14 night, Love's feedback on PR #3, work continues 07:00): PR #3 must NOT be merged yet.**
   - Verified with a real login on the PR preview: "Return to table", "Join by room code" for an already seated member, and Leave (cash-out) all work.
   - **Two-player test failed ("it does not seem to work").** Love played two accounts at table BRQPN on the PR preview (one ~440px wide pane, one other device). Evidence from `hand_actions`/`table_seats` (no personal data): hand 1, SB (seat 0) timed out preflop and the other seat won. Hand 2: seat 1 called preflop, then EVERY later action is a timeout, alternating seats every 30s through flop, turn and river; both seats ended `sitout` (consecutive_timeouts 4 and 2) while the hand was still `playing`. Findings so far:
     1. Timeouts where a check is legal are stored as `timeout-fold` in `hand_actions` although the player stays in the hand (misleading label; see `game/engine/betting.js` ~line 377 and `persistHandTransition`).
     2. A hand keeps running between two sat-out players, 30 seconds per auto-check, for the whole board. Expected: a seat that is set to sit-out during a hand should be folded (or the hand should end) instead of auto-checking to showdown.
     3. A member who is `sitout` but still in the hand sees "Sitting out / Sit back in" instead of action controls (`game/ui/table-view.js` ~lines 215-248), so after two timeouts they can no longer act in that hand.
     4. NOT yet explained: why neither player acted in time in the first place. Check whether the action bar (Fold / Check-Call / Raise) is actually shown and clickable in the REAL app after the table redesign when it is your turn (the harness shows it; the real app was not observed on a turn), at ~440px and on desktop; check `hidden` handling, z-index/overlap with the new felt, and the keyboard shortcuts. Edge logs showed only 200s in that window, and the client polls `table` about every 3.5 seconds per player (too chatty; Realtime should carry most updates).
   - **Love: the oval table does not look good on a wide (desktop) screen.** At 1280x800 the felt stretches almost edge to edge, seats and cards are small and far apart, and the own seat sits off-centre next to its hole cards. Needs a desktop-specific pass: cap the felt size (roughly 2:1, max about 1000px wide), larger seat plaques, cards and board, own seat centred with hole cards above it, tighter composition; check 1280x800, 1440x900, 1920x1080 in `game/dev/table-harness.html`.
   - Polish: lobby shows both "Active table" banner and the same table under "Your chips at tables"; dealer button can cover the chip icon on a folded seat.
   - A one-off scheduled task runs at 07:00 on 2026-11-14 to continue with worker agents on `work/wave2` (push to that branch only; no merge to the live branch, no migrations, no Edge Function deploys).
8c-3. **Stakes (Love, 2026-11-14):** with 1000 welcome chips, one table type (10/20, min buy-in 400) and no daily bonus, two lost buy-ins lock a member out. Wanted: selectable blinds and buy-ins when creating a table (suggested presets Micro 1/2, Low 5/10, Standard 10/20). The `create` intent already accepts `sb`, `bb`, `minBuyIn`, `maxBuyIn`; verify DB constraints before building. Open decision for Love: a small top-up for members whose wallet plus seated chips is zero (needs a migration). Included in the 07:00 scheduled task (step 3b).
8d. **Still open from the game review:** the leaderboard and wallet do not count chips at tables (needs a migration to change `get_leaderboard`); closing the tab does not cash out (needs `pg_cron` or an idle rule).
8e. **Found in review, not fixed:** the turn timer only advances while a client is connected (needs `pg_cron`); referral rewards pay out immediately (farmable with fake accounts); the application form has no spam protection and no notification.
9. **Privacy.** The applications table holds personal data (name, email, phone, LinkedIn, CV link). Members are students. Keep access to the owner, never put exports in the repo, and keep the site's privacy notice accurate.
10. **Housekeeping:** decide what to do with the two old Netlify projects, the unused domain and the old branches.

## 7. Where to look first
- Fixing or extending the website: `index.html`, `docs/v3-notes.md`, `docs/creative-brief.md`.
- Anything database: `docs/DATABASE.md`, `supabase/schema/`, `supabase/migrations/`.
- The game: `docs/poker/SPEC.md`, `docs/poker/STYLE_GUIDE.md`, `game/`.
- How the game was built, including decisions and known unverified items: `docs/history/game-milestones.md`.
