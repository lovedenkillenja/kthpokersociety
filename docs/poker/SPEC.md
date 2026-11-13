# Spec – game rules and data model

## Product constraints (from the original brief)
1. Play money only: no cash value, no purchases, no cash-outs, no money prizes (Swedish gambling law and the society's reputation). The UI shows "Play money – no cash value".
2. Mobile first: most players are on phones, portrait, one thumb. Desktop works but is secondary.
3. Fair and cheat-proof: the server shuffles, deals and judges. A player must never see others' hole cards or modify chips from dev tools.
4. Only signed-in society members play. Guests see the landing and explainer only.
5. Cheap to host: static files on Netlify and the Supabase free tier. No servers to maintain.
6. Known hard parts: side pots with several all-ins, split pots and odd chips (first player left of the button), disconnects (timer and auto-fold), chip conservation (`supabase/checks/chip_conservation.sql`), concurrency (per-table row lock), secure shuffle (server side, `crypto.getRandomValues`).

## Variant
No-Limit Texas Hold'em, play-money. Blinds default 10/20. Tables 2–6 seats at first. Buy-in 400–2000 chips (20–100 BB) taken from the member's balance.

## Chip flow (ledger is the single source of truth)
- Earn: welcome +1000 (automatic on signup), referral +250 per invited member (cap 20 rewarded invites, see `public.referral_config()`), events via `award_chips`, admin. The daily check-in was removed (inflation); old `daily` ledger rows stay valid.
- Sit down: ledger row `-buyin`, source `game`, ref `buyin:<table>:<seat>:<ts>`. The stack then lives in `table_seats.stack`.
- Leave: ledger row `+stack`, source `game`, ref `cashout:<...>`. A table closing returns all stacks.
- Invariant: chips in ledger + chips at tables = constant between awards. Test it.
- Idea, NOT implemented: a member who is busted (balance < min buy-in) gets a small free top-up so nobody is locked out. Decide with Love before building (inflation concern).

## Tables to add (new migration, RLS on)
- `poker_tables(id, code unique 5 chars, host_id, sb, bb, max_seats, status, created_at)`
- `table_seats(table_id, seat_no, member_id, stack, status[active|sitout|left], joined_at)`
- `hands(id, table_id, hand_no, dealer_seat, board text[], pot, state jsonb, started_at, ended_at)` – state is server-only (deck included); clients never select it.
- `hole_cards(hand_id, member_id, cards text[2])` – RLS: select only where member_id = auth.uid(); reveal at showdown through a public `showdown` payload, not via this table.
- `hand_actions(id, hand_id, seat_no, action, amount, created_at)` – public, append-only.
Public table state is broadcast on Realtime channel `table:<code>`; private cards are fetched via RLS select.

## Edge Function `act`
Input `{table, intent, amount?}` + user JWT. Steps: verify member → lock table row → validate turn and amount → apply via the shared engine → write actions/state → settle if hand over (ledger only on leave) → broadcast. Return the new public state. Reject anything illegal with a clear error code.

## Engine contract (`game/engine/`)
Pure functions, no I/O: `newHand(seats, dealer, blinds, rng)`, `legalActions(state, seat)`, `apply(state, seat, action)`, `showdown(state)` (handles side pots, ties, odd chips), `evaluate(cards7)`. Cards as strings like `As`, `Td`. Deterministic given an injected rng so tests can fix decks.

## Test list (minimum)
All hand ranks and kickers; wheel straight (A-5); ties and split pots; 3-way all-in with different stacks (two side pots); fold-out wins uncalled bet back; min-raise rules; heads-up blind order (dealer posts small blind and acts first preflop); odd-chip split.
