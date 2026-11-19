-- Only @kth.se addresses can become members.
-- Enforced in the database, so it cannot be bypassed by calling the Auth API directly.
-- Applies to new accounts (insert) and to email changes (update of email). Existing
-- accounts with other addresses are untouched until they try to change their email.
-- Test first with supabase/checks/require_kth_email_rollback_test.sql.

create or replace function public.enforce_kth_email()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.email is null or lower(btrim(new.email)) !~ '^[^@\s]+@kth\.se$' then
    raise exception 'Only @kth.se email addresses can be used for membership'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_kth_email() from public, anon, authenticated;

drop trigger if exists enforce_kth_email_insert on auth.users;
create trigger enforce_kth_email_insert
  before insert on auth.users
  for each row execute function public.enforce_kth_email();

drop trigger if exists enforce_kth_email_update on auth.users;
create trigger enforce_kth_email_update
  before update of email on auth.users
  for each row
  when (new.email is distinct from old.email)
  execute function public.enforce_kth_email();
