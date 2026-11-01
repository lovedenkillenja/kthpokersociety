// Public Supabase configuration for KTH Poker Society (copied from /index.html).
// Both URL and anon key are public client values; all chip writes are protected by RLS and server functions.

export const SUPABASE_URL = "https://tibyyjnghhwwcxvlwmiq.supabase.co";
export const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRpYnl5am5naGh3d2N4dmx3bWlxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM0ODkxNDcsImV4cCI6MjEwOTA2NTE0N30.si0ZY3v3kKAV5gZw0WFQnDwcqZm33p4Gz8YwHOOd5oU";

export const GAME_CONFIG = Object.freeze({
  welcomeChips: 1000,
  dailyClaimChips: 100,
  defaultSmallBlind: 10,
  defaultBigBlind: 20,
  minBuyIn: 400,
  maxBuyIn: 2000,
  leaderboardLimit: 50,
  recentLedgerLimit: 10,
  stockholmTimeZone: "Europe/Stockholm"
});
