# Schema snapshot: members and game project (`tibyyjnghhwwcxvlwmiq`)

Snapshot of the live database on 2026-11-13 (structure only, no data). Source of truth for definitions is `supabase/migrations/`; this file shows what is actually deployed, including the objects created by the earliest migration that is not in the repo (`create_members`, version 20261031235720).
Applied migration versions in Supabase: create_members, chips_ledger_leaderboard, poker_tables, poker_tables_privilege_hardening, hand_persistence_tx, m5_timers_sitout_cleanup, chip_profiles_revoke_anon, m7_1_referrals, m7_1_fix_redeem_btrim, m7_1_referral_config_search_path (the last two are small follow-ups to m7_1 that are folded into the repo file `20261102170000_m7_1_referrals.sql`).
Edge Functions deployed: `table` (v2), `act` (v2), both with JWT verification. Source: `supabase/functions/`.
Realtime: no tables are in the `supabase_realtime` publication; the game uses broadcast channels.

## Tables and columns (public)
```
chip_ledger: id bigint pk, member_id uuid not null -> members, delta integer not null, reason text not null, source text not null, ref text, created_at timestamptz default now()
chip_profiles: member_id uuid pk -> members, display_name text not null, show_on_leaderboard boolean default true, created_at, updated_at
hand_actions: id bigint pk, hand_id uuid -> hands, seat_no int, action text, amount int default 0, created_at
hands: id uuid pk, table_id uuid -> poker_tables, hand_no int, dealer_seat int, board text[] default '{}', pot int default 0, state jsonb not null (server only: includes the deck), showdown jsonb, started_at, ended_at
hole_cards: (hand_id, member_id) pk, cards text[2], created_at
members: id uuid pk -> auth.users, full_name text not null, email text not null, program text, study_year text, consent_at timestamptz default now(), created_at, updated_at
poker_tables: id uuid pk, code text unique (5 chars A-Z0-9), host_id uuid -> members, sb int default 10, bb int default 20, min_buyin int default 400, max_buyin int default 2000, max_seats int default 6, status text default 'open' (open|playing|closed), closed_at, created_at, last_activity_at
referral_codes: member_id uuid pk -> members, code text unique (8 chars, unambiguous alphabet), created_at
referrals: referred_id uuid pk -> members, referrer_id uuid -> members, created_at, rewarded_at (null until paid)
table_seats: (table_id, seat_no) pk, member_id uuid -> members, stack int, status text default 'active' (active|sitout|left), consecutive_timeouts int default 0, joined_at, left_at
```
Views: `chip_balances(member_id, balance)` = sum of delta per member (security_invoker); `public_hands` = hands without `state`, with a `status` of playing/complete (security_invoker).

## Checks and constraints worth knowing
- `chip_ledger.source` in (welcome, daily, event, admin, game, referral); `delta <> 0` and `abs(delta) <= 1000000`; unique `(member_id, ref)` where ref is not null (this makes awards idempotent).
- `hands`: unique `(table_id, hand_no)`; at most one unfinished hand per table (`hands_one_active_per_table_uniq`).
- `table_seats`: a member can hold only one active or sit-out seat per table.
- Foreign keys cascade from `auth.users` to `members` and from `members` to ledger, profile, hole cards, referral rows. `poker_tables.host_id` and `table_seats.member_id` are RESTRICT.

## Row level security (all tables have RLS on)
Browsers (role `authenticated`) can only SELECT, with these exceptions that are intentional:
- `chip_profiles`: select, insert and update own row.
- `members`: select and update own row.
- `chip_ledger`, `hole_cards`, `referral_codes`: select own rows. `referrals`: select rows where the member is referrer or referred.
- `poker_tables`, `table_seats`, `hands`, `hand_actions`: select for any signed-in member (the secret `hands.state` is protected by column privileges and by reading through the view `public_hands`).
- No insert, update or delete policies exist for ledger, tables, seats, hands, referrals. All writes go through the functions below.
- Role `anon` has no table access in this project.

## Functions (public)
Callable by signed-in users (`authenticated`): `get_leaderboard(p_limit)`, `get_my_referral()`, `redeem_referral(p_code)`, `claim_referral_rewards()`, and `referral_config()` (read-only constants).
Service role only (called by Edge Functions): `apply_hand_tx`, `start_hand_tx`, `sit_down`, `leave_seat`, `set_seat_status`, `close_table`, `close_idle_tables`, `award_chips`, `pay_referral`, `generate_referral_code`.
Trigger functions: `handle_new_member` (on `auth.users` insert creates the `members` row from signup metadata), `grant_welcome_chips` (on `members` insert gives +1000 with ref 'welcome'), `set_updated_at`, `touch_poker_table_activity`, `enforce_max_open_tables_per_host` (max 3 open tables per host).
Bodies of these are in the migrations, except the three below and `handle_new_member`, which were created outside the repo files:

```sql
create or replace function public.handle_new_member() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.members (id, full_name, email, program, study_year)
  values (new.id,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), split_part(new.email, '@', 1)),
    new.email,
    nullif(trim(new.raw_user_meta_data ->> 'program'), ''),
    nullif(trim(new.raw_user_meta_data ->> 'study_year'), ''));
  return new;
end; $$;

create or replace function public.grant_welcome_chips() returns trigger
language plpgsql security definer set search_path = 'public' as $$
begin
  insert into public.chip_ledger (member_id, delta, reason, source, ref)
  values (new.id, 1000, 'Welcome bonus', 'welcome', 'welcome') on conflict do nothing;
  return new;
end $$;

create or replace function public.award_chips(p_member uuid, p_delta integer, p_reason text, p_source text default 'admin', p_ref text default null)
returns bigint language sql security definer set search_path = 'public' as $$
  insert into public.chip_ledger (member_id, delta, reason, source, ref)
  values (p_member, p_delta, p_reason, p_source, p_ref) returning id;
$$;

create or replace function public.get_leaderboard(p_limit integer default 20)
returns table(place bigint, display_name text, balance integer)
language sql stable security definer set search_path = 'public' as $$
  select rank() over (order by b.balance desc), p.display_name, b.balance
  from (select member_id, sum(delta)::integer as balance from public.chip_ledger group by member_id) b
  join public.chip_profiles p on p.member_id = b.member_id
  where p.show_on_leaderboard
  order by b.balance desc limit least(greatest(p_limit, 1), 100);
$$;
```

## Triggers
`on_auth_user_created` on `auth.users` (after insert) runs `handle_new_member`; `members_welcome_chips` (after insert on members); `members_set_updated_at`; `hands_touch_activity_trg` and `table_seats_touch_activity_trg` keep `poker_tables.last_activity_at` fresh; `poker_tables_max_open_per_host_trg`.

## Known hygiene items (low risk)
`authenticated` holds broader privileges than needed on `members` (INSERT, DELETE, TRUNCATE, REFERENCES, TRIGGER) and on the views `chip_balances` and `public_hands`; `anon` holds all privileges on the view `chip_balances`. RLS and `security_invoker` make these unexploitable through the API, but they should be revoked (keep SELECT, and UPDATE on `members`). `pg_cron` is not installed. Leaked-password protection is off.
