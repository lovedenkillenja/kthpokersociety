-- M7.1: Replace daily chip claim with referral reward system.
-- Play-money chips: no monetary value, cannot be bought/sold/transferred/cashed out.
-- Writes to chip_ledger happen server-side only. Chip conservation invariant preserved.
--
-- STATUS: APPLIED to the members project (tibyyjnghhwwcxvlwmiq) on 2026-11-02 by Claude, with the corrections below.
-- Kept here as the source of truth. Do not edit; add a new migration file instead.
-- Corrections vs the original draft: (1) ON CONFLICT (member_id, ref) WHERE ref IS NOT NULL (partial unique index),
-- (2) btrim instead of pg_catalog.trim (applied as follow-up migration m7_1_fix_redeem_btrim),
-- (3) extensions.gen_random_bytes only (no unqualified fallback), (4) referral tables: revoke all from anon/authenticated,
-- grant SELECT to authenticated only, (5) referral_config() has search_path = '' (migration m7_1_referral_config_search_path).
--
-- Rollback note:
--   drop function if exists public.claim_referral_rewards();
--   drop function if exists public.redeem_referral(text);
--   drop function if exists public.get_my_referral();
--   drop function if exists public.pay_referral(uuid);
--   drop function if exists public.generate_referral_code();
--   drop function if exists public.referral_config();
--   drop table if exists public.referrals cascade;
--   drop table if exists public.referral_codes cascade;
--   alter table public.chip_ledger drop constraint if exists chip_ledger_source_check;
--   alter table public.chip_ledger add constraint chip_ledger_source_check
--     check (source in ('welcome','daily','event','admin','game'));
--   (And re-add public.claim_daily_chips() if restored).

-- 1. Allow 'referral' in chip_ledger.source (keep 'daily' so legacy rows remain valid)
alter table public.chip_ledger
  drop constraint if exists chip_ledger_source_check;

alter table public.chip_ledger
  add constraint chip_ledger_source_check
  check (source in ('welcome', 'daily', 'event', 'admin', 'game', 'referral'));

-- 2. Tables for referral tracking (RLS enabled; direct insert/update/delete denied)
create table if not exists public.referral_codes (
  member_id uuid primary key references public.members(id) on delete cascade,
  code text not null unique check (code ~ '^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$'),
  created_at timestamptz not null default now()
);

alter table public.referral_codes enable row level security;

drop policy if exists "Members read own referral code" on public.referral_codes;
create policy "Members read own referral code"
  on public.referral_codes
  for select
  to authenticated
  using ((select auth.uid()) = member_id);

create table if not exists public.referrals (
  referred_id uuid primary key references public.members(id) on delete cascade,
  referrer_id uuid not null references public.members(id) on delete cascade,
  created_at timestamptz not null default now(),
  rewarded_at timestamptz,
  check (referred_id <> referrer_id)
);

create index if not exists referrals_referrer_idx
  on public.referrals (referrer_id, created_at desc);

alter table public.referrals enable row level security;

drop policy if exists "Members read referrals involving themselves" on public.referrals;
create policy "Members read referrals involving themselves"
  on public.referrals
  for select
  to authenticated
  using ((select auth.uid()) in (referred_id, referrer_id));

-- 3. Central configuration constant (single point of change for payout delay / amounts)
create or replace function public.referral_config(
  out reward_chips integer,
  out max_rewarded integer,
  out payout_delay interval,
  out max_account_age interval
)
language sql
immutable
parallel safe
as $$
  select
    250::integer,             -- 250 chips per qualified invited friend
    20::integer,              -- cap: at most 20 rewarded invites (max 5,000 chips)
    interval '0 seconds',     -- during dev: immediate. Switch to interval '7 days' later in one line
    interval '7 days';        -- member must redeem invite within 7 days of account creation
$$;

revoke all on function public.referral_config() from public, anon;
grant execute on function public.referral_config() to authenticated, service_role;

-- 4. Code generator: 8-char random code from unambiguous 32-char alphabet (no 0/O/1/I)
create or replace function public.generate_referral_code()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_alphabet constant text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; -- 32 unambiguous chars
  v_bytes bytea;
  v_code text := '';
  v_byte integer;
  v_i integer;
begin
  v_bytes := extensions.gen_random_bytes(8);

  for v_i in 0..7 loop
    v_byte := pg_catalog.get_byte(v_bytes, v_i);
    -- 256 is an exact multiple of 32 (256/32 = 8), giving uniform distribution without modulo bias
    v_code := v_code || pg_catalog.substr(v_alphabet, (v_byte % 32) + 1, 1);
  end loop;

  return v_code;
end;
$$;

revoke all on function public.generate_referral_code() from public, anon, authenticated;
grant execute on function public.generate_referral_code() to service_role;

-- 5. Internal payout helper (no client grants)
create or replace function public.pay_referral(p_referred_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_config record;
  v_referral record;
  v_rewarded_count integer;
  v_inserted_id bigint;
begin
  select * into v_config from public.referral_config();

  -- Lock referral row FOR UPDATE
  select *
  into v_referral
  from public.referrals
  where referred_id = p_referred_id
  for update;

  if not found then
    return 0;
  end if;

  if v_referral.rewarded_at is not null then
    return 0;
  end if;

  -- Verify payout delay has elapsed
  if pg_catalog.clock_timestamp() < v_referral.created_at + v_config.payout_delay then
    return 0;
  end if;

  -- Advisory xact lock on referrer_id (salt = 2) to serialize cap check and ledger insert
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_referral.referrer_id::text, 2));

  -- Check cap: at most max_rewarded rewarded referrals per referrer
  select count(*)::integer
  into v_rewarded_count
  from public.referrals
  where referrer_id = v_referral.referrer_id
    and rewarded_at is not null;

  if v_rewarded_count >= v_config.max_rewarded then
    -- Cap reached: referral recorded but not rewarded
    return 0;
  end if;

  -- Insert chip_ledger entry for REFERRER (idempotent via unique index on member_id, ref)
  insert into public.chip_ledger (member_id, delta, reason, source, ref)
  values (
    v_referral.referrer_id,
    v_config.reward_chips,
    'Friend joined via your invite',
    'referral',
    'referral:' || p_referred_id::text
  )
  on conflict (member_id, ref) where ref is not null do nothing
  returning id into v_inserted_id;

  -- Mark referral as rewarded
  update public.referrals
  set rewarded_at = pg_catalog.now()
  where referred_id = p_referred_id
    and rewarded_at is null;

  if v_inserted_id is not null then
    return v_config.reward_chips;
  end if;

  return 0;
end;
$$;

revoke all on function public.pay_referral(uuid) from public, anon, authenticated;
grant execute on function public.pay_referral(uuid) to service_role;

-- 6. RPC: get_my_referral()
-- Returns calling member's code (creates lazily if missing), count invited, count rewarded, total earned.
create or replace function public.get_my_referral()
returns table (
  code text,
  invited_count integer,
  rewarded_count integer,
  total_earned integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member_id uuid;
  v_code text;
  v_invited integer := 0;
  v_rewarded integer := 0;
  v_total integer := 0;
begin
  v_member_id := auth.uid();
  if v_member_id is null then
    raise exception 'ERR_UNAUTHORIZED: sign-in required' using errcode = '42501';
  end if;

  if not exists (select 1 from public.members where id = v_member_id) then
    raise exception 'ERR_NOT_A_MEMBER: member % not found', v_member_id using errcode = '23503';
  end if;

  -- Lazily generate referral code if missing
  select rc.code
  into v_code
  from public.referral_codes rc
  where rc.member_id = v_member_id;

  if v_code is null then
    loop
      v_code := public.generate_referral_code();
      exit when not exists (
        select 1 from public.referral_codes rc where rc.code = v_code
      );
    end loop;

    insert into public.referral_codes (member_id, code)
    values (v_member_id, v_code)
    on conflict (member_id) do update set member_id = excluded.member_id
    returning public.referral_codes.code into v_code;
  end if;

  -- Compute invited_count and rewarded_count
  select
    count(*)::integer,
    count(r.rewarded_at)::integer
  into
    v_invited,
    v_rewarded
  from public.referrals r
  where r.referrer_id = v_member_id;

  -- Compute total chips earned from referrals directly from ledger
  select coalesce(sum(cl.delta), 0)::integer
  into v_total
  from public.chip_ledger cl
  where cl.member_id = v_member_id
    and cl.source = 'referral';

  return query select v_code, v_invited, v_rewarded, v_total;
end;
$$;

revoke all on function public.get_my_referral() from public, anon;
grant execute on function public.get_my_referral() to authenticated, service_role;

-- 7. RPC: redeem_referral(p_code text)
-- Links calling member to referrer. Returns 'ok', 'already_referred', 'invalid_code', 'too_old', 'self'.
create or replace function public.redeem_referral(p_code text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_calling_member_id uuid;
  v_normalized_code text;
  v_referrer_id uuid;
  v_member_created_at timestamptz;
  v_config record;
begin
  v_calling_member_id := auth.uid();
  if v_calling_member_id is null then
    raise exception 'ERR_UNAUTHORIZED: sign-in required' using errcode = '42501';
  end if;

  v_normalized_code := pg_catalog.upper(pg_catalog.btrim(coalesce(p_code, '')));
  if not (v_normalized_code ~ '^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$') then
    return 'invalid_code';
  end if;

  -- Rule 1: A member can only be referred once
  if exists (select 1 from public.referrals where referred_id = v_calling_member_id) then
    return 'already_referred';
  end if;

  -- Rule 2: Code must exist
  select rc.member_id
  into v_referrer_id
  from public.referral_codes rc
  where rc.code = v_normalized_code;

  if not found or v_referrer_id is null then
    return 'invalid_code';
  end if;

  -- Rule 3: No self-referral
  if v_referrer_id = v_calling_member_id then
    return 'self';
  end if;

  -- Rule 4: Calling member's account must be younger than max_account_age
  select * into v_config from public.referral_config();

  select m.created_at
  into v_member_created_at
  from public.members m
  where m.id = v_calling_member_id;

  if not found then
    return 'invalid_code';
  end if;

  if pg_catalog.now() > v_member_created_at + v_config.max_account_age then
    return 'too_old';
  end if;

  -- Insert referral record
  insert into public.referrals (referred_id, referrer_id, created_at, rewarded_at)
  values (v_calling_member_id, v_referrer_id, pg_catalog.now(), null)
  on conflict (referred_id) do nothing;

  if not found then
    return 'already_referred';
  end if;

  -- Trigger payout immediately (if payout_delay = 0, inviter is paid in the same transaction)
  perform public.pay_referral(v_calling_member_id);

  return 'ok';
end;
$$;

revoke all on function public.redeem_referral(text) from public, anon;
grant execute on function public.redeem_referral(text) to authenticated, service_role;

-- 8. RPC: claim_referral_rewards()
-- For the calling member as REFERRER, runs pay_referral for each due unrewarded referral.
create or replace function public.claim_referral_rewards()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_calling_member_id uuid;
  v_config record;
  v_rec record;
  v_total_paid integer := 0;
  v_paid integer;
begin
  v_calling_member_id := auth.uid();
  if v_calling_member_id is null then
    raise exception 'ERR_UNAUTHORIZED: sign-in required' using errcode = '42501';
  end if;

  select * into v_config from public.referral_config();

  -- Process unrewarded referrals where now >= created_at + payout_delay
  for v_rec in
    select r.referred_id
    from public.referrals r
    where r.referrer_id = v_calling_member_id
      and r.rewarded_at is null
      and pg_catalog.now() >= r.created_at + v_config.payout_delay
    order by r.created_at asc
  loop
    v_paid := public.pay_referral(v_rec.referred_id);
    v_total_paid := v_total_paid + coalesce(v_paid, 0);
  end loop;

  return v_total_paid;
end;
$$;

revoke all on function public.claim_referral_rewards() from public, anon;
grant execute on function public.claim_referral_rewards() to authenticated, service_role;

-- 9. Drop the daily chip claim function (preserves old ledger rows)
drop function if exists public.claim_daily_chips();

-- Hardening applied together with this migration (same content as in the applied version):
revoke all on public.referral_codes from anon, authenticated;
revoke all on public.referrals from anon, authenticated;
grant select on public.referral_codes to authenticated;
grant select on public.referrals to authenticated;
alter function public.referral_config() set search_path = '';
