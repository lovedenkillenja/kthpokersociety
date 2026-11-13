# KTH Poker Society, site v3

Single-file site (`index.html`, everything inline) that merges two prototypes:

- Prototype 1 is the base: navy palette, Libre Caslon Display + Hanken Grotesk, game tree in the hero, member accounts (Supabase Auth).
- Prototype 2 contributes the airier spacing, light colour breaks and the inline application form (now dark).

## Behaviour

- Desktop (>= 961px): sections are grouped into pages by `data-page` and switched with hash routing (`#about`, `#events`, `#board`, `#roles`, `#partners`, `#faq`). Back/forward and direct links work.
- Mobile: all sections show as one long page.
- Without JavaScript everything shows as one long page.

## Application form

Writes to `public.board_applications` in the KTH Poker Society Supabase project (insert only, anon key).
Required: name, email, LinkedIn, CV link. Optional: phone, program, GitHub, hours per week, motivation.
The five roles are ranked by dragging (mouse: drag the row; touch: drag the grip; arrow buttons remain for keyboard users); the first one is stored in `role`, the full order in `role_ranking`.
Allowed `role` values are enforced by a CHECK constraint: Strategy & Research, Events & Tournaments, Sponsorships & Partnerships, Marketing & Community, Tech & Development.

## Open items

- Member accounts (project `tibyyjnghhwwcxvlwmiq`) and the application form (project `hrdqlaurdzyueviplbmj`) use different Supabase projects. See `docs/PROJECT.md` and `docs/DATABASE.md`.
- The site is live at kthpokersociety.se but still marked `noindex`.
- Adam Kango has initials instead of a photo.
- The menu shows "Game soon" (not a link) until the game is launched.
