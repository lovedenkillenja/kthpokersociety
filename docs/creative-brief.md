# KTH Poker Society: Prototype 2, Creative Brief

Source: Gemini 3.1 Pro conversation "KTH Poker Society Website Redesign" (2026-11-01).
Gemini owns the creative decisions; this file records them so code and design stay in sync.

## Chosen concept: The Quant's Playground
Dark-mode, terminal-inspired interface. Poker framed as algorithmic thinking, expected value and risk, with no casino aesthetics.

Mood: cerebral, high-tech, precise, late-night hackathon.

| Token | Hex |
|---|---|
| Obsidian Black (background) | #0B0C10 |
| Matrix Green (primary / CTA / glow) | #66FCF1 |
| Dark Cyan (secondary / borders) | #45A29E |
| Slate Grey (body text) | #C5C6C7 |

Fonts: Fira Code (headings, numbers), Inter (body).

## Sitemap
1. Home: hero hook, value proposition, no-real-money angle, quick links to Board and Sponsors
2. About: philosophy, poker as a math model, zero-money policy
3. Join the Board: five roles, application CTA
4. Sponsorships & Partnerships: B2B pitch
5. Contact & Community: email, Instagram, LinkedIn

## Copy (final, from Gemini)

### Home
**Mastering the math of uncertainty.**
KTH Poker Society studies the world's most complex game of incomplete information. We approach poker not as a gamble, but as a rigorous exercise in game theory, probability, and behavioral economics. Zero financial risk. Infinite intellectual reward. Join the next generation of strategic thinkers.

### About Us
Every hand is a data set. Every bet is a calculation of expected value. At KTH Poker Society, we strip away the casino lights to reveal the underlying mathematics of decision-making. We play exclusively for points, pride, and intellectual growth, never for real money. Our members are engineers, data scientists, and strategists refining their ability to navigate complex risk profiles, making our tables the ultimate training ground for careers in finance, tech, and consulting.

### Join the Board
We are actively building our leadership team. Step up, shape the society, and expand your professional network.
- **Strategy & Research:** Develop curriculum, run hand-analysis workshops, and explore advanced solver mechanics.
- **Events & Tournaments:** Architect our theoretical tournaments, manage logistics, and ensure flawless execution.
- **Sponsorships & Partnerships:** Connect our talent pool with top-tier finance, tech, and consulting firms.
- **Marketing & Community:** Grow our membership, manage our digital presence, and build a cohesive campus culture.
- **Tech & Development:** Build our internal tools, maintain the website, and optimize our tournament tracking software.

### Sponsorships & Partnerships
**Recruit talent that understands risk.**
Our members spend their free time calculating complex probabilities and executing optimal strategies under pressure. Partnering with KTH Poker Society grants your firm direct access to highly analytical, decisive students who are pre-trained for high-stakes environments. Connect with us to discuss tournament sponsorships, recruitment events, and custom partnerships.

### Contact & Community
**Ready to calculate your expected value?**
Reach out to ask questions, apply for the board, or discuss partnership opportunities.
- Email: kthpokersociety@gmail.com
- Instagram: @kthpokersociety
- LinkedIn: KTH Poker Society

## Stitch prompt
Build a responsive single-page website for KTH Poker Society using a high-tech, data-driven "dark mode" aesthetic. The color palette must use Obsidian Black (#0B0C10) for the background, Slate Grey (#C5C6C7) for primary text, and Matrix Green (#66FCF1) for primary buttons, active states, and glowing hover effects. Use Dark Cyan (#45A29E) for secondary accents and borders. Typography must feature Fira Code for all h1, h2, h3 headers and metric numbers, and Inter for all paragraph body copy.

On desktop, the hero section should feature a massive, left-aligned Fira Code headline with a subtle, looping background animation of cascading data points or connecting nodes. The navigation bar should be sticky, transparent with a blur effect, containing links to About, Board, Sponsors, and Contact. Use a sleek CSS grid for the "Join the Board" section, displaying the five roles as distinct terminal-style cards that elevate and glow Matrix Green on hover.

On mobile, collapse the navigation into a minimalistic hamburger menu. Stack the board roles into a single-column scrolling list. Ensure all touch targets are large and accessible. The footer should cleanly display the email, Instagram, and LinkedIn text links in a monospace layout, resembling a command-line output.

## Nano Banana image prompts
1. A high-tech, abstract visualization of a poker card (the Ace of Spades) constructed entirely out of glowing neon green digital data points and wireframe lines, floating in a dark obsidian void. Cinematic lighting, macro photography, cyberpunk aesthetic, 8k resolution.
2. A dark, moody photograph of a sleek black table. Instead of poker chips, there are glowing translucent geometric shapes and mathematical equations hovering slightly above the surface. Deep cyan and neon green lighting accents. Minimalist, modern, finance-tech aesthetic.
3. An abstract decision tree diagram glowing in neon cyan and green against a pitch-black background, slowly transforming into the shape of a royal flush. High contrast, sharp vector art style with a subtle glowing bloom effect, representing game theory and algorithmic thinking.
4. A close-up shot of a modern computer monitor in a dark room, displaying intricate code and a sleek data dashboard. Subtly reflected in the glossy screen is a pair of poker cards. High-frequency trading aesthetic, analytical, professional, sharp focus.
