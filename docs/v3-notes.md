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
The five roles are ranked with up/down buttons; the first one is stored in `role`, the full order in `role_ranking`.
Allowed `role` values are enforced by a CHECK constraint: Strategy & Research, Events & Tournaments, Sponsorships & Partnerships, Marketing & Community, Tech & Development.

## Open items

- Member accounts use a separate Supabase project from the application form (prototype 1's project).
- The site is marked `noindex` until it replaces the live site.
- Adam Kango has initials instead of a photo.
