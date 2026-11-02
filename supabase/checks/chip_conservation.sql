-- Chip Conservation Check Query (`supabase/checks/chip_conservation.sql`)
-- Expected result: ZERO rows when `chip_ledger` + chips at tables are consistent.
--
-- Invariant:
--   Every chip transferred into a table comes from a `chip_ledger` row (`source = 'game'`, negative delta)
--   and returns via a `chip_ledger` row (`source = 'game'`, positive delta).
--   Therefore:
--     SUM(chip_ledger.delta WHERE source = 'game')
--     + SUM(table_seats.stack WHERE status IN ('active', 'sitout'))
--     + SUM(hands.pot WHERE ended_at IS NULL)
--     = 0
--   And total chips across all member balances + tables equals total non-game chips ever awarded.

with ledger_totals as (
  select
    coalesce(sum(delta) filter (where source = 'game'), 0)::bigint as net_game_ledger,
    coalesce(sum(delta) filter (where source <> 'game'), 0)::bigint as total_awarded_chips,
    coalesce(sum(delta), 0)::bigint as total_ledger_balance
  from public.chip_ledger
),
seat_totals as (
  select
    coalesce(sum(stack) filter (where status in ('active', 'sitout')), 0)::bigint as active_seat_stacks
  from public.table_seats
),
hand_totals as (
  select
    coalesce(sum(pot) filter (where ended_at is null), 0)::bigint as active_hand_pots
  from public.hands
),
conservation_summary as (
  select
    l.net_game_ledger,
    s.active_seat_stacks,
    h.active_hand_pots,
    (l.net_game_ledger + s.active_seat_stacks + h.active_hand_pots) as discrepancy
  from ledger_totals l
  cross join seat_totals s
  cross join hand_totals h
)
-- 1. Global conservation check: net game ledger + table stacks + active pots must equal 0
select
  'global_chip_conservation_mismatch'::text as check_name,
  format(
    'net_game_ledger=%s, active_seat_stacks=%s, active_hand_pots=%s, discrepancy=%s',
    net_game_ledger,
    active_seat_stacks,
    active_hand_pots,
    discrepancy
  ) as details
from conservation_summary
where discrepancy <> 0

union all

-- 2. Member balance check: no member may ever have a negative ledger balance
select
  'negative_member_balance'::text as check_name,
  format('member_id=%s has negative balance=%s', member_id, balance) as details
from public.chip_balances
where balance < 0

union all

-- 3. Left seat check: no seat with status='left' may hold chips
select
  'left_seat_has_chips'::text as check_name,
  format('table_id=%s seat_no=%s status=left has stack=%s', table_id, seat_no, stack) as details
from public.table_seats
where status = 'left'
  and stack <> 0

union all

-- 4. Closed table check: no closed table may hold seated stacks or open hands
select
  'closed_table_has_active_chips'::text as check_name,
  format('closed table_id=%s code=%s still has active seat or hand', t.id, t.code) as details
from public.poker_tables t
where t.status = 'closed'
  and (
    exists (
      select 1
      from public.table_seats ts
      where ts.table_id = t.id
        and (ts.status in ('active', 'sitout') or ts.stack > 0)
    )
    or exists (
      select 1
      from public.hands h
      where h.table_id = t.id
        and h.ended_at is null
    )
  );
