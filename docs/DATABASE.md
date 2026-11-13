# Databases: where things are and how to look at them

There are two separate Supabase projects (Postgres + Auth). Both belong to the same Supabase organization, owned by Love's Supabase account.

| Project | Id | Region | Contains |
|---|---|---|---|
| Members and game | `tibyyjnghhwwcxvlwmiq` | eu-west-3 | Auth users, `members`, chips, poker tables, hands, referrals, Edge Functions `table` and `act` |
| Applications | `hrdqlaurdzyueviplbmj` ("kthps-prototype-2") | eu-north-1 | Only `board_applications` (board applications from the website form) |

Schema snapshots (structure only, no data): `supabase/schema/members-project.md` and `supabase/schema/applications-project.md`. Migrations: `supabase/migrations/` (members project). The applications project has no migration files in the repo; its snapshot is the reference.

## How to see the data

**In the browser (Love):** log in at https://supabase.com/dashboard with the owner account.
- Applications that came in: https://supabase.com/dashboard/project/hrdqlaurdzyueviplbmj/editor, then the table `board_applications`. Sort by `created_at`.
- Members and chips: https://supabase.com/dashboard/project/tibyyjnghhwwcxvlwmiq/editor
- Registered logins (Auth users): Authentication, Users, in each project's dashboard.
- Any query: `.../project/<id>/sql/new` (SQL editor). Example queries below.
- Logs (errors from Edge Functions, auth, API): Logs in the dashboard.

**Why the website cannot show it:** the public site only has the publishable (anon) key. In the applications project anon may only INSERT; nobody can read applications through the API. That is on purpose (personal data). Reading needs the dashboard, the service role key, or the Supabase MCP in an agent session. A small admin page could be added later, but it needs real authentication first.

**Agents:** use the Supabase MCP (`execute_sql`, `list_tables`, `apply_migration`, `get_advisors`, `query_logs`). Look at counts and aggregates first; do not copy personal data into the repo, logs or prompts.

## Useful queries

Applications project (`board_applications`):
```sql
-- newest first, short view
select created_at, full_name, role, hours_per_week, program
from public.board_applications order by created_at desc;

-- how many applications per first-choice role
select role, count(*) from public.board_applications group by 1 order by 2 desc;

-- one person's full answer (replace the name)
select * from public.board_applications where full_name ilike '%name%';

-- full ranking of the five roles per applicant
select full_name, role_ranking from public.board_applications order by created_at desc;
```

Members project:
```sql
select count(*) from public.members;                                  -- number of members
select created_at::date, count(*) from public.members group by 1 order by 1;   -- signups per day
select * from public.get_leaderboard(20);                              -- leaderboard (opted-in members)
select source, count(*), sum(delta) from public.chip_ledger group by 1;       -- chips by source
select status, count(*) from public.poker_tables group by 1;           -- tables by status
select count(*) filter (where rewarded_at is not null) rewarded, count(*) total from public.referrals;
```
Chip conservation check: `supabase/checks/chip_conservation.sql` (run in the SQL editor; every check should report zero).

## Rules of thumb
- Never write chips outside the ledger functions. Balance = `sum(delta)` in `chip_ledger`.
- Deleting a user in Auth cascades to `members`, ledger, profile, hole cards, referrals. `poker_tables.host_id` and `table_seats.member_id` are `ON DELETE RESTRICT`, so remove a member's seats and tables first. Deleting is irreversible: ask Love first.
- Free-plan projects pause when inactive. A paused applications project makes the website form fail. Restore it from the dashboard (or the MCP `restore_project`; it takes a few minutes).
- After any DDL change run `get_advisors` (security) and fix what you caused. Known and accepted warnings: the three referral functions and `get_leaderboard` are callable by signed-in users on purpose; leaked-password protection is off.
