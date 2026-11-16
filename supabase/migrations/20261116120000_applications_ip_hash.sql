-- APPLICATIONS PROJECT ONLY (hrdqlaurdzyueviplbmj, "kthps-prototype-2"). NOT APPLIED.
-- This folder otherwise targets the members project; the guard below makes this file a no-op there.
-- Adds a salted hash (HMAC-SHA256, computed in the `apply` Edge Function) of the submitter's IP so the
-- function can rate-limit per IP. The raw IP is never stored. Additive only.
do $$
begin
  if to_regclass('public.board_applications') is null then
    raise notice 'board_applications not found: skipping (wrong project?)';
    return;
  end if;
  alter table public.board_applications add column if not exists ip_hash text;
  alter table public.board_applications drop constraint if exists board_applications_ip_hash_format;
  alter table public.board_applications
    add constraint board_applications_ip_hash_format check (ip_hash is null or ip_hash ~ '^[0-9a-f]{64}$');
  create index if not exists board_applications_ip_hash_created_at_idx
    on public.board_applications (ip_hash, created_at);
end
$$;
