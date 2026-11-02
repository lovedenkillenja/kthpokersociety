-- ALREADY APPLIED (2026-11-02). Added by Claude after reviewing 20261102012000_poker_tables.sql.
-- RLS does not cover TRUNCATE/REFERENCES/TRIGGER, so remove them from client roles on every game table.
revoke truncate, references, trigger on public.poker_tables, public.table_seats, public.hands, public.hole_cards, public.hand_actions, public.chip_ledger, public.chip_profiles from anon, authenticated;
-- Anonymous visitors never need the game tables.
revoke all on public.poker_tables, public.table_seats, public.hole_cards, public.hand_actions from anon;
revoke all on public.chip_ledger from anon;
revoke insert, update, delete on public.chip_ledger from authenticated;
