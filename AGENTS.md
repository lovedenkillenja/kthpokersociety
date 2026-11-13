# KTH Poker Society: agent rules (read first, every session)

Project overview, infrastructure map, current state and open issues: `docs/PROJECT.md`. Read it first, then only the files your task needs.

## Roles
- **Love** (co-founder, owner) decides. He writes Swedish: talk to him in Swedish, keep messages short. All code, comments, commit messages and agent prompts are in English.
- **Project lead agent** plans, splits work, writes the briefs, reviews results, owns the docs and talks to Love. It does not write bulk code itself.
- **Worker agents** (Claude Opus for security, database, engine and tricky logic; Claude Sonnet for UI, content, tests and routine edits) implement one well-defined slice each and report back briefly.

## How the lead works (token-efficient)
1. Read `docs/PROJECT.md`. Do not re-read what you already know; do not load whole files when a search or line range is enough.
2. Turn a goal into small independent slices. For each slice write a self-contained brief: goal, files to touch, constraints that apply (below), acceptance check (a command or a visible result), and "report in at most 5 lines". Give workers the file paths, not file contents.
3. Run independent slices in parallel on separate feature branches (`work/<topic>`). Never let two workers edit the same file at once.
4. Review by evidence: run `node --test`, open the page in a headless browser at 375px and 1280px width, read the diff (`git diff --stat` first). Do not trust a report you have not checked. Security-sensitive work (database, auth, chips, Edge Functions) gets a second independent review before it goes live.
5. Merge to `v3-merged-design` only when checks pass. That branch deploys to the live site immediately.
6. At the end of every session update `docs/PROJECT.md` (current state, open issues) and report to Love.

## Practical tips that save tokens
- `index.html` is about 390 KB. One line (about line 524) is a base64 image: never print it (`cut -c1-200`, or read by line range).
- Run the site locally with `python3 -m http.server` and test with Playwright (Chromium is usually installed).
- The Supabase and Netlify MCP tools, if connected, are faster than the dashboards. If they are not connected, write the SQL migration and tell Love exactly what to run.

## Non-negotiable rules
- **Play money only.** Chips have no monetary value. No purchase, sale, transfer between members, cash-out, prizes with money value, ads or anything gambling-like. Never write copy that suggests real stakes. The game UI shows "Play money – no cash value".
- **Server decides, client displays.** The deck, the shuffle and other players' hole cards never reach a client that should not see them. Anything that matters (deal, bets, pot, showdown, chip changes) runs server-side. The client sends intents and renders what the server says.
- **Never write chips from the browser.** `chip_ledger` has no insert policy on purpose. Chip changes happen only in SECURITY DEFINER functions or with the service role in an Edge Function.
- **Secrets:** no keys, tokens or passwords in git, docs or chat. The Supabase URL and the publishable (anon) key are public. Anything else goes in Edge Function secrets or stays on Love's computer.
- **Database changes** are a new file in `supabase/migrations/` (`YYYYMMDDHHMMSS_description.sql`), additive, with RLS on every new table and the policies written. Never edit an applied migration. Test in a rolled-back `DO` block before applying; run the security advisors after; keep the repo file identical to what was applied.
- **Ask Love first** before anything destructive or hard to undo: deleting accounts or data, dropping tables, changing domains or DNS, changing the Supabase Auth URL settings, force-pushing, deleting branches or Netlify projects, publishing the game, removing `noindex`.
- **Personal data:** applications and member accounts contain personal data about students. Do not copy it into the repo, logs, docs or prompts. When you need to look at it, look at counts and aggregates first.
- No tracking, analytics or third-party scripts without a pinned version and a good reason. Fonts: Libre Caslon Display + Hanken Grotesk.
- Accessibility is a requirement: keyboard operable, visible focus, contrast, `prefers-reduced-motion` respected, text not baked into images.

## Definition of done
- `node --test` passes (all tests, from the repo root).
- Pages open with no console errors at 375px and at desktop width; no horizontal scroll on mobile.
- No secret in `git diff`. No TODO left unrecorded (put it in `docs/PROJECT.md` open issues).
- If something could not be verified (for example live multi-device play), write "UNVERIFIED" in the docs. Do not claim it works.
- Commit messages are clear and in English. Docs changed if the behavior, infrastructure or a decision changed.
