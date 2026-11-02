# Progress log (agent: update this every session)

## Status
M1 skeleton (`game/`) and M2 pure poker engine (`game/engine/` + `game/tests/engine.test.js`) are complete. Database for chips is live (`supabase/migrations/20261102000000_chips_ledger_leaderboard.sql`).

## Next up
- [x] M1 skeleton: sign-in, profile, balance, daily claim, leaderboard (no poker yet)
- [x] M2 engine + tests (`game/engine/`: hand evaluation, betting rounds, pots, side pots, showdown + `node --test`)
- [ ] M3 tables migration + Edge Function `act`
- [ ] M4 heads-up playable on two phones
- [ ] M5 3–6 players, timers, reconnect
- [ ] M6 polish and tutorial
- [ ] M7 link from website, event awards

## Decisions for Love
(none right now)

## Session log
- 2026-11-02 (Gemini – M2):
  - **What changed**: Built the dependency-free No-Limit Texas Hold'em engine in `game/engine/` (`cards.js`, `evaluator.js`, `pots.js`, `betting.js`, `index.js`) compatible with both Node and Deno. Implemented `newHand(seats, dealer, blinds, rng)`, `legalActions(state, seat)`, `apply(state, seat, action)`, `showdown(state)`, `evaluate(cards7)`, `publicView(state)`, and `checkChipConservation(state)`. Added full `node --test` coverage in `game/tests/engine.test.js` covering all hand ranks and kickers, wheel straight (`A-2-3-4-5`), ties/split pots, 3-way all-in with two side pots, fold-out uncalled bet return, min-raise & short all-in reopening rules, heads-up blind order, odd-chip split (first winner left of button), and chip conservation.
  - **Verified**: `node --test game/tests/*.test.js` (17/17 tests passing). UI and `/index.html` untouched.
  - **UNVERIFIED**: Live branch deploy at `https://poker-game--kthpokersociety-v3.netlify.app/game/` (M1 loading and authenticated member flow on Netlify branch deploy are UNVERIFIED from this environment).
  - **What is broken**: Nothing known.
  - **What is next**: M3 – `poker_tables`, `table_seats`, `hands`, `hole_cards`, and `hand_actions` migration with RLS + Supabase Edge Function `act` + Realtime broadcast.
- 2026-11-02 (Gemini – M1):
  - **What changed**: Created branch `poker-game` from `poker-game-workspace`. Built M1 skeleton in `game/` following `STYLE_GUIDE.md` (`game/config.js`, `game/index.html`, `game/app.js`, `game/lib/supabase.js`, `game/lib/format.js`, `game/ui/components.js`, `game/ui/auth-dialog.js`, `game/styles/{tokens,base,components}.css`, and unit tests in `game/tests/format.test.js`). Wired member sign-in/sign-up/password-reset, `chip_profiles` (display name 1–40 chars + leaderboard opt-in), `chip_balances`, `chip_ledger` history, `claim_daily_chips()` (+100/day, Europe/Stockholm), and `get_leaderboard(p_limit)`.
  - **Verified**: `node --test` (8/8 passing), headless Chrome render on 375px and 1280px viewports with 0 console errors, PostgREST RPC signature check against live Supabase (`tibyyjnghhwwcxvlwmiq`).
  - **UNVERIFIED**: End-to-end authenticated `claim_daily_chips()` and `chip_profiles` write with a real signed-in member session in a live browser (requires a member account login).
  - **What is broken**: Nothing known.
  - **What is next**: M2 – pure dependency-free Texas Hold'em engine in `game/engine/` with full `node --test` coverage.
- 2026-11-02 (Claude): workspace, rules, specs and chip schema created. No game code.
