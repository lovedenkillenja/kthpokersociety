-- ALREADY APPLIED to the members project (tibyyjnghhwwcxvlwmiq) on 2026-11-02.
-- Kept here as the source of truth. Do not edit; add a new migration file instead.
-- Play-money chips: no monetary value, cannot be bought/sold/transferred/cashed out.
-- Browsers can only READ their own rows. All writes go through the functions below.

create table public.chip_profiles (
  member_id uuid primary key references public.members(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 40),
  show_on_leaderboard boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.chip_profiles enable row level security;
create policy "Members read own chip profile" on public.chip_profiles for select to authenticated using ((select auth.uid()) = member_id);
create policy "Members insert own chip profile" on public.chip_profiles for insert to authenticated with check ((select auth.uid()) = member_id);
create policy "Members update own chip profile" on public.chip_profiles for update to authenticated using ((select auth.uid()) = member_id) with check ((select auth.uid()) = member_id);

create table public.chip_ledger (
  id bigint generated always as identity primary key,
  member_id uuid not null references public.members(id) on delete cascade,
  delta integer not null check (delta <> 0 and abs(delta) <= 1000000),
  reason text not null check (char_length(reason) between 1 and 200),
  source text not null check (source in ('welcome','daily','event','admin','game')),
  ref text,
  created_at timestamptz not null default now()
);
create unique index chip_ledger_member_ref_uniq on public.chip_ledger (member_id, ref) where ref is not null;
create index chip_ledger_member_idx on public.chip_ledger (member_id, created_at desc);
alter table public.chip_ledger enable row level security;
create policy "Members read own ledger" on public.chip_ledger for select to authenticated using ((select auth.uid()) = member_id);

create view public.chip_balances with (security_invoker = true) as
  select member_id, sum(delta)::integer as balance from public.chip_ledger group by member_id;

-- + functions: grant_welcome_chips() trigger (+1000 on signup), claim_daily_chips() (+100/day, Europe/Stockholm),
--   award_chips(...) (service_role only), get_leaderboard(limit) (opted-in members only).
-- Full function bodies: see Supabase project -> Database -> Functions, or list_migrations 'chips_ledger_leaderboard'.
