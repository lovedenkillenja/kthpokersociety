# Progress log (agent: update this every session)

## Status
M1 skeleton (`game/`) and M2 pure poker engine (`game/engine/` + `game/tests/engine.test.js`) are complete. M3a migration (`supabase/migrations/20261102012000_poker_tables.sql`) and conservation check (`supabase/checks/chip_conservation.sql`) are written and handed over for review/application.

## Next up
- [x] M1 skeleton: sign-in, profile, balance, daily claim, leaderboard (no poker yet)
- [x] M2 engine + tests (`game/engine/`: hand evaluation, betting rounds, pots, side pots, showdown + `node --test`)
- [ ] M3a tables migration (`supabase/migrations/20261102012000_poker_tables.sql` + `supabase/checks/chip_conservation.sql` – ready, awaiting review & apply)
- [ ] M3b Edge Function `act` + Realtime broadcast
- [ ] M4 heads-up playable on two phones
- [ ] M5 3–6 players, timers, reconnect
- [ ] M6 polish and tutorial
- [ ] M7 link from website, event awards

## Decisions for Love
- Migration `supabase/migrations/20261102012000_poker_tables.sql` is ready and NOT applied. Ask Claude to review and apply it.

## Session log
- 2026-11-02 (Gemini – M3a):
  - **What changed**: Added `supabase/migrations/20261102012000_poker_tables.sql` defining `poker_tables`, `table_seats`, `hands`, `hole_cards`, `hand_actions`, `public_hands` view, RLS policies, and `service_role`-only transactional functions `sit_down(p_table_id, p_member_id, p_seat_no, p_buyin)` and `leave_seat(p_table_id, p_member_id)`. Added `supabase/checks/chip_conservation.sql` returning zero rows when ledger + table stacks + active pots balance.
  - **5 hostile-client attacks considered & SQL defenses**:
    1. **Reading opponents' hole cards or the undealt deck (`hands.state`) from DevTools**: `hole_cards` has RLS policy `((select auth.uid()) = member_id)` so a client can only ever read their own cards. On `public.hands`, `SELECT` on `state` is revoked from `anon` and `authenticated`; clients can only read non-secret columns (`id, table_id, hand_no, dealer_seat, board, pot, showdown, started_at, ended_at`) and the `public_hands` (`security_invoker = true`) view.
    2. **Calling `sit_down` or `leave_seat` directly from the browser RPC endpoint (or spoofing another member's `member_id`)**: Both functions have `REVOKE ALL ... FROM public, anon, authenticated`, explicit `GRANT EXECUTE ... TO service_role`, and an internal guard checking `request.jwt.claim.role = 'service_role'` (or database admin user). Clients cannot invoke them at all, nor can clients `INSERT`/`UPDATE`/`DELETE` on `chip_ledger`, `table_seats`, `poker_tables`, `hands`, `hole_cards`, or `hand_actions`.
    3. **Double buy-in race condition (sending two simultaneous `sit_down` requests across one or two tables to spend the same balance twice)**: `sit_down` takes a transaction-scoped advisory lock on `p_member_id` (`pg_advisory_xact_lock(hashtextextended(p_member_id::text, 0))`) and locks the `public.members` row `FOR UPDATE` before computing `SUM(delta)` from `chip_ledger` and inserting the `-buyin` row in the same transaction. Concurrent requests serialize and the second fails with `ERR_INSUFFICIENT_CHIPS` or `ERR_ALREADY_SEATED`.
    4. **Joining a full table, taking an occupied seat, or taking multiple seats at the same table**: `sit_down` locks the `poker_tables` row `FOR UPDATE`, validates `0 <= p_seat_no < max_seats`, checks active seat count `< max_seats`, verifies the seat is not active/sitout, and is backed by both primary key `(table_id, seat_no)` and partial unique index `table_seats_one_active_seat_per_member_uniq ON table_seats(table_id, member_id) WHERE status IN ('active', 'sitout')`.
    5. **Leaving mid-hand to cash out a pre-hand stack or forging game actions/pots**: Clients have zero write privileges on `hands`, `hand_actions`, or `table_seats` (so out-of-turn or forged actions cannot be written from the browser), and `leave_seat` rejects cash-outs while an unsettled hand (`ended_at IS NULL`) exists on the table (`ERR_HAND_IN_PROGRESS`), requiring the Edge Function to fold/settle the hand first.
  - **Verified**: `node --test game/tests/*.test.js` (17/17 passing). UI and `/index.html` untouched.
  - **UNVERIFIED**: Execution of `20261102012000_poker_tables.sql` and `chip_conservation.sql` against live Supabase (MCP not connected; handed over for review/apply).
  - **What is broken**: Nothing known.
  - **What is next**: M3b – Edge Function `act` + Realtime broadcast once M3a migration is applied.
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
