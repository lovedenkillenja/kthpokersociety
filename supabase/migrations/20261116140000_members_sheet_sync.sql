-- MEMBERS PROJECT ONLY (tibyyjnghhwwcxvlwmiq). APPLIED 2026-11-16.
-- Member register in Google Sheets: the `welcome` Edge Function copies each confirmed member
-- (name, email, join date) to a private sheet tab. This adds the bookkeeping:
--   members.sheet_synced_at   set once per member when the row is claimed for the sheet (server-only:
--                             authenticated has UPDATE only on full_name, email, program, study_year)
--   claim_members_for_sheet   atomically claims up to p_limit not yet synced members with a confirmed
--                             email and returns id, full_name, email, created_at (service role only)
--   release_members_sheet_claim  gives a claim back after a failed copy so a later call retries
-- Additive. The functions are SECURITY DEFINER with a fixed search_path and executable by service_role only.
alter table public.members add column if not exists sheet_synced_at timestamptz;

comment on column public.members.sheet_synced_at is
  'When this member was claimed for the Google Sheet member register (welcome Edge Function). Server-only.';

create or replace function public.claim_members_for_sheet(p_limit integer, p_claimed_at timestamptz)
returns table (id uuid, full_name text, email text, created_at timestamptz)
language sql
security definer
set search_path = public, auth
as $$
  with picked as (
    select m.id
    from public.members m
    join auth.users u on u.id = m.id
    where m.sheet_synced_at is null
      and u.email_confirmed_at is not null
    order by m.created_at
    limit greatest(1, least(coalesce(p_limit, 3), 10))
    for update of m skip locked
  )
  update public.members m
     set sheet_synced_at = p_claimed_at
    from picked
   where m.id = picked.id
  returning m.id, m.full_name, m.email, m.created_at;
$$;

create or replace function public.release_members_sheet_claim(p_ids uuid[], p_claimed_at timestamptz)
returns integer
language sql
security definer
set search_path = public
as $$
  with r as (
    update public.members
       set sheet_synced_at = null
     where id = any(p_ids) and sheet_synced_at = p_claimed_at
    returning 1
  )
  select count(*)::integer from r;
$$;

revoke all on function public.claim_members_for_sheet(integer, timestamptz) from public, anon, authenticated;
revoke all on function public.release_members_sheet_claim(uuid[], timestamptz) from public, anon, authenticated;
grant execute on function public.claim_members_for_sheet(integer, timestamptz) to service_role;
grant execute on function public.release_members_sheet_claim(uuid[], timestamptz) to service_role;
