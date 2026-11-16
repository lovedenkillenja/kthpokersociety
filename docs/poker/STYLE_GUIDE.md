# Style guide – KTH Poker Society game

Same family as the society website: dark navy, quiet, editorial, with one warm table-green accent area for the game surface. Premium and calm, not casino-flashy: a premium card room, not a slot machine. No neon, no confetti, no looping effects; sound is quiet, synthesized and off by default (see Sound). Real-looking chips and short card and chip movement are allowed and wanted (see Chips and Motion).

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
- Rules: only `transform`/`translate`/`rotate`/`scale` and `opacity` (no layout changes); 150–600ms with `--ease-out`; nothing loops; no confetti, no screen shake, no flashing. One soft glow that fades is allowed for a winner's plaque.
- Implementation (`ui/table-motion.js`): the renderer always builds the final state first, and the resting style of every card and chip is the visible one. Animations are Web Animations API calls that run FROM an offset (`fill: backwards`), driven by diffing the previous and next table snapshot (`diffSnapshots`, tested). Leaving things (folded cards, swept bets, the pot) are decorative ghost copies in `.table-motion-layer` that are invisible unless their animation runs. Nothing depends on an event handler or timer having fired.
- Never replay: the first render of a table (page load, reconnect, joining a hand in progress) and plain re-renders do not animate. A re-render while a deal is running resumes the animation on the new elements. Animations never delay state updates or the action controls.
- Fallbacks: `prefers-reduced-motion: reduce`, a hidden tab, or a browser without `translate` animation means instant final state. A settle timer and `visibilitychange` cancel anything still running, so `document.getAnimations().forEach(a => a.finish())` or a cancel always leaves every card and chip in its final place.
- Win moment (`computeWinSpec`, `buildWinRun` in `ui/table-motion.js`, about 2.1 s for a showdown, 1.5 s for a fold-out, skipped by the next state update): (1) hole cards flip, (2) the five cards of each winning hand lift 4px and get a soft `--chip` outline while all other revealed cards dim, (3) the existing status banner (same slot, one line of layout height, second line hangs below so the board never moves) shows the hand name in the display serif ("Straight, King high") and "Sam wins 1,380" (split pot: every winner; fold-out: "Sam wins 140 / Everyone else folded", no steps 1 and 2), (4) pot chips slide to each winner and the stack counts up in about 600ms, (5) the plaque glows once and fades (a little stronger for the player). A big pot (more than 20 big blinds) won by the player adds five small chips hopping onto the stack. The five cards come from `showdown.hands[seat].cards`, or are evaluated on the client from cards the server revealed (opponents' `revealedCards`, your own hole cards); an unrevealed card is never touched. The marks (lift, outline, dim) and the banner text are part of the resting DOM, only their entrance is animated, so reduced motion shows the same text banner at once.
- Your turn: the action bar slides up 14px and the own plaque ring pulses once (`cueMyTurn`); `navigator.vibrate(30)` if available and the tab is visible or sound is on. After one consecutive timeout (`consecutiveTimeouts >= 1`) the action bar shows "Next timeout sits you out" on the next turn.
- Nothing plays on the first render of a table, so the first state never chimes or buzzes either.

## Sound
- Off by default, remembered in `localStorage` (`kth_poker_sound`: `on`/`off`, `kth_poker_volume`: `low`/`normal`). Toggles: the speaker button in the table top bar (`aria-pressed`, name "Sound on/off") and the drawer (Sound on/off plus Low / Normal volume). The `AudioContext` is created or resumed only from a user gesture; sound is muted while the document is hidden. `prefers-reduced-motion` affects motion only, not sound.
- Engine: `ui/table-sound.js`, Web Audio only (no files, no downloads, no libraries). Every sound is built from short filtered noise bursts and tuned resonant partials with attack/decay envelopes, with random variation in pitch (+-4%), gain (+-14%) and timing per play, and stereo panning by seat position (gentle, within +-0.65). Chain: panner, compressor, soft clipper (ceiling about -12.5 dBFS), master gain (Low = half).
- Cues: card deal (paper swish and a tap as it lands, one per card, timed with the deal animation), card flip, chip bet (2 to 5 ceramic clicks by bet size in big blinds, a short cascade for a big bet or all-in), chips swept to the pot (soft rattle), check (two soft knocks), fold (soft slide), your turn (warm two-note chime, quiet, one per turn), timer tick at 10 and 5 seconds (own turn only), win (pot rattle and a warm rising three-note figure, four notes and slightly longer for a big pot). Others winning: only the soft pot slide, no jingle. No cue is longer than about 1.0s.
- Sound is driven by the same state diff as the motion (`diffSnapshots`, plus `commits` and `checks` events) through the pure, tested `planSoundCues`, so sound and animation stay in sync and a re-render, reconnect or first render is silent. Throttled: at most 16 cues per update and 24 per second, lowest priority dropped first.
- Review: `game/dev/table-harness.html` has a "Sound test" panel (one button per cue, "Verify offline" renders each cue through an `OfflineAudioContext` and reports duration and peak). Audible quality needs a human listener.
- Review without a server: `game/dev/table-harness.html?state=demo-hand` plays five hands from the real engine (showdown win by you, fold-out win, split pot, big all-in pot, an opponent's showdown win; deal, bets, folds, streets) about 1.2s per step, with a jump button per hand; `&step=ms` changes the pace, `&auto=0` waits for the "Play sequence" button.

## Voice and copy
- English, short, friendly, no gambling slang ("bet big", "jackpot", "lucky"). Say "chips", never "money" or "cash". Always visible: "Play money – no cash value".
- Buttons are verbs: "Join table", "Fold", "Call 200", "Raise to 600".
- Errors say what to do next: "Connection lost. Reconnecting…".

## Components checklist
Button (primary/ghost/danger), Pill, Panel, Seat, Card, CardBack, ChipAmount, ActionBar, RaiseSlider, Toast, Dialog (native `<dialog>`, `[hidden]` honoured), Leaderboard row, Empty state. Build once in `game/ui/`, reuse everywhere.

## Accessibility
Landmarks, labels on every control, visible focus ring (2px --sky, 2px offset), live region announces "Your turn", "Alice raised to 400", "You won 1,200". Table must be playable by keyboard (F fold, C check/call, R raise).
