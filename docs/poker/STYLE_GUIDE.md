# Style guide – KTH Poker Society game

Same family as the society website: dark navy, quiet, editorial, with one warm table-green accent area for the game surface. Premium and calm, not casino-flashy. No neon, no gold coins, no slot-machine effects.

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
- Pot in --chip colour, centred above community cards. Chip stacks are simple flat discs (no 3D).

## Motion
- 150–250ms ease-out for dealing, chip movement and state changes. Nothing loops. Respect `prefers-reduced-motion: reduce` (instant transitions). Sound off by default; optional toggle. Haptic pulse (navigator.vibrate) when it becomes your turn, if allowed.

## Voice and copy
- English, short, friendly, no gambling slang ("bet big", "jackpot", "lucky"). Say "chips", never "money" or "cash". Always visible: "Play money – no cash value".
- Buttons are verbs: "Join table", "Fold", "Call 200", "Raise to 600".
- Errors say what to do next: "Connection lost. Reconnecting…".

## Components checklist
Button (primary/ghost/danger), Pill, Panel, Seat, Card, CardBack, ChipAmount, ActionBar, RaiseSlider, Toast, Dialog (native `<dialog>`, `[hidden]` honoured), Leaderboard row, Empty state. Build once in `game/ui/`, reuse everywhere.

## Accessibility
Landmarks, labels on every control, visible focus ring (2px --sky, 2px offset), live region announces "Your turn", "Alice raised to 400", "You won 1,200". Table must be playable by keyboard (F fold, C check/call, R raise).
