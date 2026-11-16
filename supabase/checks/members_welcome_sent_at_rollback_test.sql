-- Rolled-back test for supabase/migrations/20261116120000_members_welcome_sent_at.sql.
-- Run in the SQL editor BEFORE applying the migration. It applies the same statements,
-- asserts the result and then raises an exception, so nothing is kept.
-- Expected outcome: an error whose message is 'ROLLBACK OK: welcome_sent_at checks passed'.
-- Any other error means a check failed and the migration must not be applied as is.

do $$
begin
  alter table public.members add column if not exists welcome_sent_at timestamptz;
  revoke insert, update, delete, truncate, references, trigger on public.members from anon, authenticated;
  grant update (full_name, email, program, study_year) on public.members to authenticated;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'members'
      and column_name = 'welcome_sent_at' and data_type = 'timestamp with time zone'
      and is_nullable = 'YES'
  ) then
    raise exception 'FAIL: welcome_sent_at column missing or wrong type';
  end if;

  if has_column_privilege('authenticated', 'public.members', 'welcome_sent_at', 'UPDATE') then
    raise exception 'FAIL: authenticated can still UPDATE welcome_sent_at';
  end if;
  if has_column_privilege('authenticated', 'public.members', 'welcome_sent_at', 'INSERT') then
    raise exception 'FAIL: authenticated can INSERT welcome_sent_at ';
  end if;
  if has_table_privilege('authenticated', 'public.members', 'DELETE') then
    raise exception 'FAIL: authenticated still holds DELETE on members';
  end if;
  if has_column_privilege('anon', 'public.members', 'welcome_sent_at', 'UPDATE') then
    raise exception 'FAIL: anon can UPDATE welcome_sent_at';
  end if;
  if not has_column_privilege('authenticated', 'public.members', 'full_name', 'UPDATE') then
    raise exception 'FAIL: authenticated lost UPDATE on full_name';
  end if;
  if not has_column_privilege('authenticated', 'public.members', 'welcome_sent_at', 'SELECT') then
    raise exception 'FAIL: authenticated lost SELECT on members';
  end if;
  if not has_column_privilege('service_role', 'public.members', 'welcome_sent_at', 'UPDATE') then
    raise exception 'FAIL: service_role cannot UPDATE welcome_sent_at';
  end if;

  raise exception 'ROLLBACK OK: welcome_sent_at checks passed';
end $$;
