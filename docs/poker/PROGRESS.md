# Progress log (agent: update this every session)

## Status
M1 skeleton (`game/`), M2 pure poker engine (`game/engine/` + `game/tests/engine.test.js`), and M3a tables migration (`supabase/migrations/20261102012000_poker_tables.sql` + `20261102013000_poker_tables_privilege_hardening.sql`, reviewed and applied by Claude) are complete. M3b Edge Functions (`supabase/functions/table` and `supabase/functions/act`) and tests (`game/tests/edge-functions.test.js`, `game/tests/engine-sync.test.js`) are written and ready for review and deployment.

## Next up
- [x] M1 skeleton: sign-in, profile, balance, daily claim, leaderboard (no poker yet)
- [x] M2 engine + tests (`game/engine/`: hand evaluation, betting rounds, pots, side pots, showdown + `node --test`)
- [x] M3a tables migration (`supabase/migrations/20261102012000_poker_tables.sql` + `supabase/checks/chip_conservation.sql` – reviewed and applied)
- [ ] M3b Edge Function `act` + Realtime broadcast (`supabase/functions/table` & `supabase/functions/act` – ready, awaiting review & deploy)
- [ ] M4 heads-up playable on two phones
- [ ] M5 3–6 players, timers, reconnect
- [ ] M6 polish and tutorial
- [ ] M7 link from website, event awards

## Decisions for Love
- Edge Functions are ready and NOT deployed. Ask Claude to review and deploy.

## Session log
- 2026-11-02 (Gemini – M3b):
  - **What changed**:
    - Added Edge Functions `supabase/functions/table/index.ts` (intents: `create`, `join`, `leave`, `state`) and `supabase/functions/act/index.ts` (intents: `start_hand`, `fold`, `check`, `call`, `raise`, `all_in`), backed by shared modules in `supabase/functions/_shared/` (`handlers.js`, `state-helpers.js`, `supabase-store.js`, `cors.js`).
    - Shared `game/engine/` with Deno via `game/scripts/sync-engine.js` copying into `supabase/functions/_shared/engine/` and guarded by `game/tests/engine-sync.test.js` (fails if any file diverges byte-for-byte). **Reason**: Supabase CLI bundles each function with `supabase/functions/_shared/` and can reject relative imports escaping above `supabase/functions/`; a deterministic sync script + automated parity test keeps a single source of truth while ensuring trouble-free Edge Function deployment.
    - **Chip conservation during running hands**: Whenever a hand starts (blinds posted), on every betting action, and when a hand settles, the Edge Function updates `table_seats.stack` to each seat's live remaining stack while `hands.pot` tracks all committed chips and `ended_at` remains `null` until settlement (at which point `table_seats.stack` gets final stacks and `hands.ended_at` is set). `supabase/checks/chip_conservation.sql` stays valid (`net_game_ledger + active_seat_stacks + active_hand_pots = 0`) at every step without modification.
    - **Leaving mid-hand**: If a player calls `leave` while a hand is open on their seat, `table` folds them first; if that ends the hand (always true in heads-up), the hand settles immediately (`ended_at = now()`) and `leave_seat` cashes out their stack. If 2+ other players remain active in a multi-way hand, the leaving player is folded, marked `'sitout'`, queued in `state.pendingLeaveMemberIds`, and cashed out via `leave_seat` automatically as soon as the hand settles.
    - **Privacy & Realtime broadcast**: `supabase-store.js` fetches `display_name` from `chip_profiles` using `service_role` and broadcasts sanitized public state on Realtime channel `table:<code>` (`table_state` event) with display names, never exposing `deck`, unrevealed `holeCards`, or raw `member_id` values. Deal writes each player's 2 cards to `public.hole_cards` so owners fetch only their own cards via RLS.
    - Fixed an edge case in `game/engine/pots.js` where a player who folded with the highest commitment on a street (e.g. big blind leaving/folding out of turn before small blind acts) had their excess commitment treated as an uncalled bet instead of dead money in the pot.
  - **5 hostile-client attacks considered against the Edge Function & defenses**:
    1. **Forged `member_id` in request body**: `handleTableRequest` and `handleActRequest` authenticate the caller exclusively via the `Authorization: Bearer <jwt>` header (`supabase.auth.getUser(token)`) and ignore any `member_id` or `memberId` fields in the request body.
    2. **Acting out of turn (or when not seated / hand not active)**: `handleActRequest` maps the authenticated `user.id` to their seated `seat_no` at the table and verifies `seat_no === state.actionOn` while the hand is in an active betting phase (`preflop`/`flop`/`turn`/`river`); otherwise it rejects with HTTP `409 ERR_OUT_OF_TURN`.
    3. **Replaying a previous action (`actionSeq` / `handId` mismatch)**: Every action increments `actionSeq`; if the client supplies `expectedActionSeq` (or `handId`) that does not match the current open hand's sequence or ID, the request is rejected with `409 ERR_ACTION_REPLAY` before touching the engine.
    4. **Raising more than the player's stack or below the legal minimum**: `handleActRequest` validates integer amounts, rejects `amount > stack + committed` with `400 ERR_RAISE_EXCEEDS_STACK`, checks `legalActions(state, seat)` bounds (`minRaiseTo` / `maxRaiseTo`), and runs `apply()` which enforces full-raise and all-in rules.
    5. **Two parallel requests racing on the same table (`act` + `act` or `act` + `leave`)**: Requests serialize per table through `withTableLock(tableId, ...)` and use compare-and-swap on the open `hands` row (`compareAndSwapHandState` checking `ended_at IS NULL` and prior `state`), returning `409 ERR_CONCURRENT_MODIFICATION` if another worker mutated the hand concurrently.
  - **Verified**: `node --test game/tests/*.test.js` (21/21 passing, including mocked DB full lifecycle, mid-hand leave, chip conservation at every step, all 5 hostile-client attack vectors, and engine parity check). UI and `/index.html` untouched.
  - **UNVERIFIED**: Live deployment and invocation of `table` and `act` Edge Functions on Supabase project `tibyyjnghhwwcxvlwmiq` (no Supabase MCP connected; handed over for review/deploy).
  - **What is broken**: Nothing known.
  - **What is next**: M4 – Heads-up (2 players) playable end-to-end on two phones once M3b Edge Functions are deployed.
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

- 2026-11-02 (Claude review): M3a migration reviewed and APPLIED to the members project, plus hardening migration 20261102013000 (revokes TRUNCATE/REFERENCES/TRIGGER from client roles). Tested as an `authenticated` user: hands.state and `select *` on hands denied, sit_down/leave_seat/award_chips denied, direct inserts into chip_ledger/table_seats denied, TRUNCATE denied. Security advisors: only the two intentional warnings remain.
  Notes for M3b (Edge Function):
  - The `service_role` check inside sit_down/leave_seat uses current_user, which is the function owner inside SECURITY DEFINER, so it never rejects. Real protection is the grants (execute only for service_role). Do not rely on that in-function check; do not grant execute to other roles.
  - chip_conservation.sql counts hands.pot for open hands, so while a hand is running `table_seats.stack` must be decremented as chips go into the pot, or the check shows false positives. Decide this in M3b and keep the check consistent.
  - table_seats exposes member_id (UUID) to all signed-in members. Display names live in chip_profiles, which is own-row read only; broadcast names from the Edge Function in the public table state instead.
  - leave_seat refuses while any hand is in progress at the table; the `act` function must fold a leaving player first and settle before cash-out.
