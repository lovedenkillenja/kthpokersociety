# Game

Play-money Texas Hold'em for KTH Poker Society members. Plain HTML/CSS/ES modules, no build step. Entry: `game/index.html`.
Rules and data model: `../docs/poker/SPEC.md`. Visual rules: `../docs/poker/STYLE_GUIDE.md`. Project overview: `../docs/PROJECT.md`.

- `engine/` pure poker engine (copied to `supabase/functions/_shared/engine/` by `scripts/sync-engine.js`; a test checks they match)
- `lib/`, `ui/`, `styles/` client code
- `tests/` run with `node --test` from the repository root

The game is NOT public yet: `netlify.toml` redirects `/game` to the home page. Test it on the branch deploy.
