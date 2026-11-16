-- APPLICATIONS PROJECT ONLY (hrdqlaurdzyueviplbmj, "kthps-prototype-2"). NOT APPLIED.
-- Apply ONLY AFTER the `apply` Edge Function is deployed AND the site version that posts to it is live,
-- otherwise the live form stops working. After this, browsers can no longer insert directly with the
-- publishable key (which would bypass validation, honeypot, fill time and rate limit); only the
-- service role (the Edge Function) can insert. The guard makes this file a no-op in the members project.
do $$
begin
  if to_regclass('public.board_applications') is null then
    raise notice 'board_applications not found: skipping (wrong project?)';
    return;
  end if;
  drop policy if exists "Anyone can submit an application" on public.board_applications;
  revoke insert on public.board_applications from anon, authenticated;
end
$$;
