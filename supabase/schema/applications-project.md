# Schema snapshot: applications project (`hrdqlaurdzyueviplbmj`, "kthps-prototype-2")

Snapshot of the live database on 2026-11-13 (structure only, no data). This project has no migration files in the repo; applied migrations in Supabase: `create_board_applications`, `board_applications_extra_fields`. The website form (`index.html`, section "Open roles") inserts into this table with the anon key.

```sql
create table public.board_applications (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  full_name text not null,
  email text not null,
  program text,
  phone text,
  role text not null,              -- first choice
  role_ranking text[],             -- all five roles, first = role
  hours_per_week text,
  linkedin_url text,
  cv_url text,
  github_url text,
  motivation text
);
```
Constraints: `full_name` 1 to 200 chars; `email` 3 to 320 chars and contains '@'; `program` max 200; `phone` max 50; `motivation` max 4000;
`role` in ('Strategy & Research', 'Events & Tournaments', 'Sponsorships & Partnerships', 'Marketing & Community', 'Tech & Development');
`hours_per_week` null or one of ('Less than 2 hours', '2-4 hours', '5-7 hours', '8 or more hours');
`github_url` null or an http(s) URL up to 500 chars. The following three are `NOT VALID` (enforced for new rows only, so older rows may break them): `cv_url` required http(s) URL up to 500 chars; `linkedin_url` required and must contain `linkedin.com/`; `role_ranking` required, exactly 5 entries, first entry equals `role`.

Row level security: on. One policy: "Anyone can submit an application" (INSERT to anon and authenticated, check true). No select, update or delete policy, so applications can only be read in the dashboard, with the service role, or via the Supabase MCP.

Hygiene: `anon` and `authenticated` hold all table privileges (default grants); RLS blocks everything except INSERT, but revoking the extra privileges (keep INSERT) is cleaner.
**Planned (branch `work/apply-mail`, NOT APPLIED/DEPLOYED):** the form posts to the Edge Function `apply` (`supabase/functions/apply/`, deploy with `supabase functions deploy apply --project-ref hrdqlaurdzyueviplbmj --no-verify-jwt`), which validates, checks honeypot/fill time/rate limit and inserts with the service role. Migrations for this project (guarded to no-op elsewhere): `20261116120000_applications_ip_hash.sql` (adds `ip_hash`, apply before deploy) and `20261116120100_applications_insert_via_function_only.sql` (drops the anon insert policy; apply only after the new site is live).

Free-plan projects pause when inactive: if this one is paused the website form fails. See `docs/DATABASE.md`.

**Planned (branch `work/cv-upload`, NOT APPLIED):** `20261116130000_applications_cv_upload.sql` adds `cv_path text` (object name in the private storage bucket `applicant-cvs`, PDF only, 5 MB; no storage policies, so only the service role can read or write), drops the old required-`cv_url` check and adds `cv_url` null-or-https plus "`cv_url` or `cv_path` present" (all `NOT VALID`).
