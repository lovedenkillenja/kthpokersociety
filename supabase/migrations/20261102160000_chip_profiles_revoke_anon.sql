-- Defense in depth: RLS already denies anon (policies are `to authenticated`); remove the unused table privileges too.
-- Applied by Claude via Supabase MCP on 2026-11-02.
revoke all on public.chip_profiles from anon;
