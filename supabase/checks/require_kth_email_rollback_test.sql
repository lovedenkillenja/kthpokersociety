-- Rolled-back test for supabase/migrations/20261119120000_require_kth_email.sql.
-- Run in the SQL editor BEFORE applying the migration. Expected outcome: an error whose
-- message is 'ROLLBACK OK: kth email checks passed'. Any other error means do not apply.

do $$
declare
  v_id uuid := gen_random_uuid();
begin
  create or replace function public.enforce_kth_email() returns trigger language plpgsql set search_path = '' as $f$
  begin
    if new.email is null or lower(btrim(new.email)) !~ '^[^@\s]+@kth\.se$' then
      raise exception 'Only @kth.se email addresses can be used for membership' using errcode = 'check_violation';
    end if;
    return new;
  end; $f$;
  create trigger enforce_kth_email_insert before insert on auth.users for each row execute function public.enforce_kth_email();
  create trigger enforce_kth_email_update before update of email on auth.users for each row
    when (new.email is distinct from old.email) execute function public.enforce_kth_email();

  begin
    insert into auth.users (id, email) values (gen_random_uuid(), 'someone@gmail.com');
    raise exception 'FAIL: non-kth email was accepted';
  exception when check_violation then null; end;

  begin
    insert into auth.users (id, email) values (gen_random_uuid(), 'x@kth.se.evil.com');
    raise exception 'FAIL: lookalike domain was accepted';
  exception when check_violation then null; end;

  insert into auth.users (id, email) values (v_id, 'Test.Person@KTH.se');

  begin
    update auth.users set email = 'other@gmail.com' where id = v_id;
    raise exception 'FAIL: email change to non-kth was accepted';
  exception when check_violation then null; end;

  update auth.users set updated_at = now() where id = v_id; -- unrelated update still works

  raise exception 'ROLLBACK OK: kth email checks passed';
end $$;
