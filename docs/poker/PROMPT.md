# Brief: KTH Poker Society play-money poker game

Paste this as your first message in Antigravity (the workspace rules in `AGENTS.md` load automatically). Language of the UI: English, with Swedish-friendly simple wording. Talk to Love in the language he writes in.

## The idea
KTH Poker Society (a student society at KTH Royal Institute of Technology, Stockholm) has a website. Members have accounts. We want a **free, in-browser Texas Hold'em game** where members play with **play-money chips** that they earn by being active in the society (joining, visiting, attending events). The point is social: friends at KTH open the link on their phones, create a table, share a room code and play together. It should be fun enough to spread by word of mouth across campus and bring people to the society.

## Hard constraints
1. Play money only, no cash value, no purchases, no cash-outs, no money prizes. (Swedish gambling law; also the society's reputation.) Show "Play money – no cash value" in the UI.
2. Mobile first. Most players are on phones, portrait, one thumb. Desktop works but is secondary.
3. Fair and cheat-proof: the server shuffles, deals and judges. A player must never be able to see others' hole cards or modify their chips from browser dev tools.
4. Only signed-in society members play (existing Supabase auth). Guests can watch the landing/explainer only.
5. Cheap to host: static files on Netlify + Supabase free tier. No servers to maintain.

## What exists already (do not rebuild)
- Website: `/index.html` (the society site, navy theme). Do not edit it.
- Supabase project `tibyyjnghhwwcxvlwmiq`: auth users, `public.members(id, full_name, email, program, study_year, consent_at, ...)`.
- Chips (already created and live): `chip_profiles`, `chip_ledger` (append-only, balance = sum of delta), view `chip_balances`, functions `claim_daily_chips()` (+100/day), `get_leaderboard(p_limit)`, `award_chips(...)` (service role only). New members get +1000 automatically. See `supabase/migrations/`.
- The Supabase URL and public (anon) key are in `/index.html` as `SUPABASE_URL` / `SUPABASE_KEY`; copy them into `game/config.js`.

## What to build (milestones, in order)
M1. `game/` skeleton: sign-in with existing member account, profile (display name, leaderboard opt-in), chip balance, daily claim button, leaderboard page. No poker yet. Deployable and demonstrable.
M2. Pure poker engine in `game/engine/` (hand evaluation, betting rounds, pots, side pots, showdown) with thorough `node --test` tests. This is the same code that will run in the Edge Function; keep it dependency-free and runnable in both Node and Deno.
M3. Tables: tables/seats/hands tables in a new migration with RLS; Edge Function `act` (join, leave, fold/check/call/raise/all-in, start hand); hole cards stored so only their owner can select them; Realtime broadcast of public table state.
M4. Heads-up (2 players) playable end to end on two phones, with a room code and a "buy-in" taken from the player's balance into the table stack; cash back to ledger on leave (as `game` ledger rows with unique `ref`).
M5. 3–6 players, turn timer, auto-fold on timeout, reconnect handling, sit-out.
M6. Polish: animations (respecting reduced motion), sound off by default, haptics on turn, tutorial for first-timers, hand-history of last 10 hands.
M7. Engagement: link from the website (ask Love first), event-based chip awards via `award_chips`, weekly leaderboard.

Do one milestone slice per session. Record state in `docs/poker/PROGRESS.md`.

## Known hard parts (plan for them)
- Side pots with multiple all-ins; split pots and odd chips (give to first player left of button).
- Disconnects mid-hand: timer and auto-fold; never stall a table.
- Chip conservation: sum of chips in play + ledger must always balance. Write a test and a SQL check query for it.
- Concurrency: two actions arriving at once. Use a per-table row lock (`select ... for update`) inside the function.
- Randomness: use a cryptographically secure shuffle (Fisher-Yates with `crypto.getRandomValues`), server side only.

## Your first session
Do M1 only. Create branch `poker-game`, build the skeleton per the style guide, add `game/config.js`, wire sign-in and the existing chip functions, write PROGRESS.md, commit, push. Then report in 5 lines.
