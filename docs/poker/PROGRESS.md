# Progress log (agent: update this every session)

## Status
M1 skeleton is built in `game/`. Database for chips is live (`supabase/migrations/20261102000000_chips_ledger_leaderboard.sql`).

## Next up
- [x] M1 skeleton: sign-in, profile, balance, daily claim, leaderboard (no poker yet)
- [ ] M2 engine + tests (`game/engine/`: hand evaluation, betting rounds, pots, side pots, showdown + `node --test`)
- [ ] M3 tables migration + Edge Function `act`
- [ ] M4 heads-up playable on two phones
- [ ] M5 3–6 players, timers, reconnect
- [ ] M6 polish and tutorial
- [ ] M7 link from website, event awards

## Decisions for Love
(none right now)

## Session log
- 2026-11-02 (Gemini – M1):
  - **What changed**: Created branch `poker-game` from `poker-game-workspace`. Built M1 skeleton in `game/` following `STYLE_GUIDE.md` (`game/config.js`, `game/index.html`, `game/app.js`, `game/lib/supabase.js`, `game/lib/format.js`, `game/ui/components.js`, `game/ui/auth-dialog.js`, `game/styles/{tokens,base,components}.css`, and unit tests in `game/tests/format.test.js`). Wired member sign-in/sign-up/password-reset, `chip_profiles` (display name 1–40 chars + leaderboard opt-in), `chip_balances`, `chip_ledger` history, `claim_daily_chips()` (+100/day, Europe/Stockholm), and `get_leaderboard(p_limit)`.
  - **Verified**: `node --test` (8/8 passing), headless Chrome render on 375px and 1280px viewports with 0 console errors, PostgREST RPC signature check against live Supabase (`tibyyjnghhwwcxvlwmiq`).
  - **UNVERIFIED**: End-to-end authenticated `claim_daily_chips()` and `chip_profiles` write with a real signed-in member session in a live browser (requires a member account login).
  - **What is broken**: Nothing known.
  - **What is next**: M2 – pure dependency-free Texas Hold'em engine in `game/engine/` with full `node --test` coverage.
- 2026-11-02 (Claude): workspace, rules, specs and chip schema created. No game code.
