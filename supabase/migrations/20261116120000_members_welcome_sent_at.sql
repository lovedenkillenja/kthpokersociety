-- NOT APPLIED. Written for review by Love before it is applied.
-- Adds members.welcome_sent_at: set once by the `welcome` Edge Function (service role)
-- when the welcome mail has been sent. Browsers must never be able to set or clear it.
--
-- Why the UPDATE grant is rewritten: `authenticated` currently holds table-level UPDATE on
-- public.members (own row via RLS). A table-level grant covers every column, including new
-- ones, and a column-level REVOKE has no effect while it exists. So the table-level UPDATE is
-- revoked and UPDATE is granted back only on the profile columns that already existed:
-- full_name, email, program, study_year. (The website itself only reads members today; the
-- other existing columns id, consent_at, created_at, updated_at are deliberately not
-- re-granted, since no client has a reason to change them. updated_at is still set by the
-- members_set_updated_at trigger.)
-- While here, the leftover client privileges listed as a hygiene item in
-- supabase/schema/members-project.md (INSERT, DELETE, TRUNCATE, REFERENCES, TRIGGER) are
-- revoked too; RLS has no insert/delete policy, and the members row is created by the
-- SECURITY DEFINER trigger handle_new_member, so nothing legitimate uses them.
-- SELECT and the existing RLS policies are unchanged. The service role is unaffected.
-- Test first with supabase/checks/members_welcome_sent_at_rollback_test.sql.

alter table public.members
  add column if not exists welcome_sent_at timestamptz;

comment on column public.members.welcome_sent_at is
  'When the welcome mail was sent (claimed atomically by the welcome Edge Function). Server-only.';

revoke insert, update, delete, truncate, references, trigger on public.members from anon, authenticated;
grant update (full_name, email, program, study_year) on public.members to authenticated;
