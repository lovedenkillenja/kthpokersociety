-- APPLICATIONS PROJECT ONLY (hrdqlaurdzyueviplbmj, "kthps-prototype-2"). NOT APPLIED.
-- CV upload: applicants upload a PDF instead of pasting a link. Apply BEFORE deploying the `apply` Edge
-- Function version that stores uploads. The guard makes this file a no-op in the members project. Additive.
--  1. column cv_path: object name inside the private bucket `applicant-cvs` (null for old rows and links)
--  2. cv_url is no longer required: the live "required http(s) URL" check constraint is dropped and replaced
--     by "cv_url null or http(s) URL up to 500 chars" plus "cv_url or cv_path present" (both NOT VALID, so
--     existing rows are not rechecked)
--  3. private storage bucket, PDF only, 5 MB. No storage.objects policies on purpose: anon and authenticated
--     users can neither read nor write; only the service role (the Edge Function, the dashboard) can.
do $$
declare
  c record;
begin
  if to_regclass('public.board_applications') is null or to_regclass('storage.buckets') is null then
    raise notice 'board_applications or storage not found: skipping (wrong project?)';
    return;
  end if;

  alter table public.board_applications add column if not exists cv_path text;

  for c in
    select conname from pg_constraint
    where conrelid = 'public.board_applications'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%cv_url%'
  loop
    execute format('alter table public.board_applications drop constraint %I', c.conname);
  end loop;

  alter table public.board_applications
    add constraint board_applications_cv_url_format
    check (cv_url is null or (char_length(cv_url) <= 500 and cv_url ~* '^https?://')) not valid;
  alter table public.board_applications
    add constraint board_applications_cv_path_format
    check (cv_path is null or cv_path ~ '^[0-9a-f-]{36}\.pdf$') not valid;
  alter table public.board_applications
    add constraint board_applications_cv_present
    check (cv_url is not null or cv_path is not null) not valid;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('applicant-cvs', 'applicant-cvs', false, 5242880, array['application/pdf'])
  on conflict (id) do update
    set public = false, file_size_limit = 5242880, allowed_mime_types = array['application/pdf'];
end
$$;
