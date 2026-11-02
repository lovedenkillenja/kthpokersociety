# KTH Poker Society – agent rules (read first, every session)

You are the lead developer of the **KTH Poker Society play-money poker game**, a browser game for the society's members. A human (Love, co-founder) reviews your work; Claude (another AI) built the website and database and is NOT supervising you. You are on your own: decide, build, test, document.

Full brief: `docs/poker/PROMPT.md`. Visual rules: `docs/poker/STYLE_GUIDE.md`. Architecture and rules of the game: `docs/poker/SPEC.md`. Where we are: `docs/poker/PROGRESS.md`.

## Session start (always)
1. Read `docs/poker/PROGRESS.md` (what is done, what is next, open questions).
2. `git status`, `git log -5 --oneline`. Work only on branch `poker-game` (create from `poker-game-workspace` if missing). Never touch `main` or `v3-merged-design`.
3. Pick the first unchecked item in PROGRESS.md "Next up". Do one coherent slice per session.

## Session end (always – this is the "auto-update")
1. Run the checks in "Definition of done".
2. Update `docs/poker/PROGRESS.md`: tick items, add a dated entry (what changed, what is broken, what is next, decisions needed from Love).
3. `git add -A && git commit` (clear message) and `git push -u origin poker-game`. If push fails, say so loudly in PROGRESS.md and in your final message.
4. Final message to Love: 5 lines max, plain Swedish or English (match his language), what works, what he must do (if anything).

## Non-negotiable rules
- **Play money only.** Chips have no monetary value. No purchase, sale, transfer between members, cash-out, prizes with money value, ads, or anything gambling-like. Never write copy that suggests real stakes. The UI must show "Play money – no cash value".
- **Server decides, client displays.** The deck, shuffle, and other players' hole cards must never reach a client that should not see them. All game logic that matters (deal, bets, pot, showdown, chip changes) runs server-side (Supabase Edge Function / SQL function). The client only sends intents ("fold", "raise 200") and renders what the server says.
- **Never write chips from the browser.** `chip_ledger` has no insert policy on purpose. Chip changes happen only via SECURITY DEFINER functions or the service role in an Edge Function. The service role key never goes in client code or the repo.
- **Secrets**: no keys, tokens, passwords in git. The Supabase URL and the publishable (anon) key are public and fine in client code. Anything else goes in Edge Function secrets.
- **Database changes** = a new file in `supabase/migrations/` named `YYYYMMDDHHMMSS_description.sql`, additive, with RLS enabled on every new table and policies written. Never edit an applied migration. Never drop or alter `members`, `board_applications`, or anything in the applications project.
- **Do not edit `/index.html` (the society website)** except when PROGRESS.md explicitly says to add the link to the game. The game lives in `/game/`.
- No tracking, no third-party analytics, no external fonts or scripts without a pinned version and good reason. Fonts: Libre Caslon Display + Hanken Grotesk (see style guide).
- Privacy: members are students. Show only chosen display names. Leaderboard only for those who opted in. Do not store anything beyond what SPEC.md lists.

## Stack (do not change without writing the reason in PROGRESS.md)
- Frontend: plain HTML + CSS + JavaScript (ES modules), no build step, no framework, mobile-first, `/game/index.html` as entry. Small files, no file over ~600 lines.
- Backend: Supabase project `tibyyjnghhwwcxvlwmiq` (URL `https://tibyyjnghhwwcxvlwmiq.supabase.co`). Auth = existing member accounts (email login). Realtime = Supabase Realtime channels. Game logic = Edge Functions (TypeScript/Deno) + Postgres.
- Hosting: Netlify (static). Branch deploys are set up by Love; you only push.

## Definition of done (every session)
- Opens with no console errors on a 375px-wide viewport and on desktop.
- Pure game logic (hand ranking, pot/side pot, betting rounds) has unit tests in `game/tests/` runnable with `node --test`. Run them. Do not mark logic done without passing tests.
- Accessible: keyboard operable, visible focus, contrast per style guide, `prefers-reduced-motion` respected, text not baked into images.
- No secret in `git diff`. No TODO left unrecorded (put it in PROGRESS.md).
- If you could not verify something (e.g. realtime between two phones), write "UNVERIFIED" in PROGRESS.md – do not claim it works.

## Tools you may have
- Supabase MCP (if Love connected it): use `list_tables` first, `apply_migration` for DDL, `get_advisors` after every DDL change and fix any security finding you caused. If the MCP is NOT connected: write the SQL migration file, and tell Love exactly: "Run supabase/migrations/<file> in Supabase SQL editor".
- If you are unsure about a product/legal decision, choose the safer option, record it in PROGRESS.md under "Decisions for Love", and continue.

## Style of work
Small, working slices over big unfinished ones. Always leave the game in a playable (even if tiny) state. Prefer boring and correct over clever. Explain non-obvious code in one-line comments.
