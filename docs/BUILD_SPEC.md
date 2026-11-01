# Build spec: KTH Poker Society website (prototype 2)

Read `docs/creative-brief.md` first. Its "Decisions by Love" section overrides everything else.
Design reference: Stitch design "KTH Poker Society – Academic & Editorial Edition", screenshots in `docs/design/`.
Live Stitch project: https://stitch.withgoogle.com/projects/17479753279682622955

## Tech
- Plain static site: HTML + one shared CSS file + small vanilla JS. No build step, no framework.
- Deployed on Netlify from the repo root (`netlify.toml` publishes `.`). Keep everything at the root, assets in `assets/`.
- Fonts from Google Fonts: Inter (headlines + body), Fira Code (small labels, numbers, eyebrow text only).
- Accessible: semantic HTML, alt text, visible focus states, AA contrast, `prefers-reduced-motion` respected.
- Responsive: desktop and mobile (hamburger nav under ~760px). Max content width ~1100px. No horizontal scroll.

## Pages (each main section is its own page)
| File | Content |
|---|---|
| `index.html` | Hero ("Mastering the math of uncertainty."), short value prop, teaser cards linking to the other pages |
| `about.html` | Philosophy, poker as a mathematical model, zero-money declaration card, 3 pillar cards (e.g. Nash Equilibrium & CFR, Bayesian Range Inference, Quantitative Pathways) |
| `board.html` | Five roles as cards + application form (see below) |
| `sponsors.html` | "Recruit talent that understands risk.", 3 partnership offering cards, CTA to contact |
| `contact.html` | Email, Instagram, LinkedIn, short text |

Shared header (logo `assets/logo.png` + "KTH Poker Society", nav links, active page highlighted) and footer on every page, with a short no-real-money disclaimer in the footer.

## Visual system (from the design)
- Palette: KTH Blue `#004791`, White `#FFFFFF`, Steel Blue `#739AC2`, Pale Blue `#BFD1E3`, dark navy derived from KTH Blue (about `#0A1220`) for dark sections, very light `#F5F8FC` for light sections. No neon green or cyan.
- Alternate dark navy and light sections for breathing room. Generous vertical padding (around 120px desktop, 72px mobile).
- Small Fira Code eyebrow labels above headings, like `01 / ACADEMIC FOUNDATION`.
- Flat cards: thin Steel Blue border (1px), 8px radius, no glows; small Fira Code tag line at the bottom of cards.
- One primary button style (KTH Blue fill, white text), one secondary (outlined).
- Hero: headline left, the logo shown large in a rounded KTH-blue card on the right (as in `docs/design/01-hero.jpg`).

## Copy
Use the copy in `docs/creative-brief.md`, trimmed to 2–3 sentences per paragraph. English only.
The society never plays for real money; say so clearly on Home, About and in the footer.

## Board application form (`board.html`)
Fields: full name (required), email (required), study program, role (required; select with the five roles exactly as written below), motivation (textarea, max 4000 chars).
Role values must match exactly: `Strategy & Research`, `Events & Tournaments`, `Sponsorships & Partnerships`, `Marketing & Community`, `Tech & Development`.
"Apply for role" links on each role card should scroll to the form and preselect that role (e.g. `board.html?role=...#apply`).

Submit with supabase-js v2 from a CDN (`https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2`) into table `board_applications` with columns `full_name, email, program, role, motivation`. Use **insert only, no select** (`.insert(row)` without `.select()`), because the table only allows anonymous inserts.

```js
const SUPABASE_URL = "https://hrdqlaurdzyueviplbmj.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_hKLPSwMbvmSNNnyj1osGfQ_uFgcnfPW"; // public, safe in the browser
```
Show a clear success message and an error message on failure; disable the button while sending.

## Do not
- Add any real-money, betting or casino imagery.
- Add fake metrics, terminal status badges or decorative "telemetry".
- Change `docs/` or `assets/logo.png`.
