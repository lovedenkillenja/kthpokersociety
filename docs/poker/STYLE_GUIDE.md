# Style guide – KTH Poker Society game

Same family as the society website: dark navy, quiet, editorial, with one warm table-green accent area for the game surface. Premium and calm, not casino-flashy: a premium card room, not a slot machine. No neon, no confetti, no sound, no looping effects. Real-looking chips and short card and chip movement are allowed and wanted (see Chips and Motion).

## Colour tokens (CSS custom properties, define in `game/styles/tokens.css`)
| Token | Hex | Use |
|---|---|---|
| --ink | #06142a | page background |
| --deep | #0a2142 | cards, panels |
| --brand | #004791 | KTH blue accents |
| --line | #1d3a63 | borders, dividers |
| --control | #4a6a96 | input borders |
| --paper | #eef2f8 | primary text |
| --muted | #a3b4cb | secondary text |
| --sky | #7db2f4 | links, highlights |
| --action | #1f66c9 | primary buttons (hover #1a5cb8) |
| --danger | #ff9b8f | fold/destructive/errors |
| --felt | #0d3b2e | table surface (add a faint radial highlight to #14503e) |
| --chip | #e9c46a | chip/pot amounts only (the single warm accent; use sparingly) |

Contrast: body text on --ink/--deep must be ≥ 4.5:1 (paper and muted pass). Never convey state by colour alone (add text/icon: "Folded", "All-in").

## Type
- Display / headings / big numbers (pot, balance): **Libre Caslon Display**, fallback Georgia, serif.
- UI / body / buttons: **Hanken Grotesk**, fallback system-ui, sans-serif. Weights 400, 600.
- Load via Google Fonts `<link>` with `display=swap`. Scale: 14 / 17 / 20 / 28 / 44 px. Tabular numerals (`font-variant-numeric: tabular-nums`) for all chip amounts.

## Layout and spacing
- Mobile first at 375px. 8px spacing grid. Side gutters 16px. Max content width 1120px on desktop; the table is centred, max 520px wide on desktop.
- Tap targets ≥ 48×48px. Action bar (Fold / Check-Call / Raise) fixed to bottom with safe-area padding, thumb reachable. Raise uses a slider plus quick buttons (Min, ½ pot, Pot, All-in).
- Radius 12px on panels, 999px on pills. Borders 1px --line. Shadows minimal, only on the table and floating action bar.
- Generous empty space; one idea per screen. Don't stack more than two panels.

## Cards and table
- Cards drawn in CSS/SVG (no copyrighted deck images). Rounded 8px, white-ish face #f7f9fc, suits in two clear colours (♠♣ ink, ♥♦ #c2382f) plus the suit symbol – distinguishable without colour.
- Rank in Libre Caslon Display, large. Back of card: --brand with a subtle diagonal line pattern.
- Table: oval felt, seats around it; your seat bottom centre always. Show name, stack, status pill; dealer button as a small round "D".
- Pot in --chip colour, centred above community cards.

## Chips
- Real poker chips drawn in CSS (no image files, no third-party assets): round chip, rim with edge inserts, an inner ring and the society's game-tree mark (the favicon glyph, white) in the centre. Tokens `--chip-<denom>-face/-insert/-edge` and `--chip-mark` in `tokens.css`; component `createChip` / `createChipStacks` in `ui/components.js`; the stack breakdown is the pure `lib/chips.js` (`chipStacks`, `iconDenomination`).
- Denominations: 1 grey, 5 red, 25 green, 100 navy, 500 purple, 1000 gold (the `--chip` accent). Colour is never the only cue: the number of rim inserts differs per denomination (4, 6, 8, 10, 12, 16) and the amount is always printed as text.
- Stacks are capped: largest denominations first, at most 5 chips per stack and 3 stacks (bets: 4 and 2), so 1,380 never draws 50 chips. The picture is an approximation; the number is the truth. All chips are `aria-hidden`.
- Used for: bets in front of seats, a cluster next to the pot amount, and one chip of the highest fitting denomination beside stack amounts. Chip amounts keep `--chip` text colour and tabular numerals.

## Motion
- Allowed motion, all short and quiet: hole cards dealt from the dealer button around the table (two rounds, about 100ms apart; own cards flip face-up, opponents stay face-down); flop as three cards sliding out and flipping, turn and river one card each; folded cards tossed toward the centre with a slight turn and fade (about 300ms); chips slide from a seat to its bet spot, bets slide into the pot at the end of a street, the pot slides to each winner (split pots split).
- Rules: only `transform`/`translate`/`rotate`/`scale` and `opacity` (no layout changes); 150–450ms with `--ease-out`; nothing loops; no sound, no confetti, no glow pulses.
- Implementation (`ui/table-motion.js`): the renderer always builds the final state first, and the resting style of every card and chip is the visible one. Animations are Web Animations API calls that run FROM an offset (`fill: backwards`), driven by diffing the previous and next table snapshot (`diffSnapshots`, tested). Leaving things (folded cards, swept bets, the pot) are decorative ghost copies in `.table-motion-layer` that are invisible unless their animation runs. Nothing depends on an event handler or timer having fired.
- Never replay: the first render of a table (page load, reconnect, joining a hand in progress) and plain re-renders do not animate. A re-render while a deal is running resumes the animation on the new elements. Animations never delay state updates or the action controls.
- Fallbacks: `prefers-reduced-motion: reduce`, a hidden tab, or a browser without `translate` animation means instant final state. A settle timer and `visibilitychange` cancel anything still running, so `document.getAnimations().forEach(a => a.finish())` or a cancel always leaves every card and chip in its final place.
- Sound off by default; optional toggle. Haptic pulse (navigator.vibrate) when it becomes your turn, if allowed.
- Review without a server: `game/dev/table-harness.html?state=demo-hand` plays one hand from the real engine (deal, bets, a fold, flop, turn, river, showdown) about 1.2s per step; `&step=ms` changes the pace, `&auto=0` waits for the "Play sequence" button.

## Voice and copy
- English, short, friendly, no gambling slang ("bet big", "jackpot", "lucky"). Say "chips", never "money" or "cash". Always visible: "Play money – no cash value".
- Buttons are verbs: "Join table", "Fold", "Call 200", "Raise to 600".
- Errors say what to do next: "Connection lost. Reconnecting…".

## Components checklist
Button (primary/ghost/danger), Pill, Panel, Seat, Card, CardBack, ChipAmount, ActionBar, RaiseSlider, Toast, Dialog (native `<dialog>`, `[hidden]` honoured), Leaderboard row, Empty state. Build once in `game/ui/`, reuse everywhere.

## Accessibility
Landmarks, labels on every control, visible focus ring (2px --sky, 2px offset), live region announces "Your turn", "Alice raised to 400", "You won 1,200". Table must be playable by keyboard (F fold, C check/call, R raise).
