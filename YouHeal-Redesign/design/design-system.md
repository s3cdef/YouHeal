# YOU HEAL design system v1.0

## Concept

"The body is a field." Every page is drawn with one visual device: the magnetic field line. It is the hero background, the section divider, the nav underline, the brand mark and the way pairs are connected on the atlas. Nothing else decorates.

The palette is dark and warm, with two accent hues that *mean* something: coral = north pole (+), azure = south pole (−). Gold is the drawing ink (Goiz, the medical realm). Aqua marks the quantum realm (Hervás). The tone generator in the footer plays 528 Hz, the "healing frequency" the colorway is named after.

## Color

| Token | Hex | Role |
|---|---|---|
| `--bg` | `#070B0F` | page base (deep blue-black) |
| `--bg-2` | `#0B1217` | panels, header |
| `--bg-3` | `#111B22` | raised surfaces |
| `--ink` | `#F3EEE3` | text (linen) |
| `--ink-2` | `#B9C1C6` | secondary text |
| `--ink-3` | `#7E8A91` | tertiary / meta |
| `--gold` | `#D4AF6A` | field lines, primary actions, Goiz realm |
| `--gold-2` | `#F1D9A3` | highlights, hover |
| `--aqua` | `#63D6C5` | quantum realm, secondary actions, 528 Hz |
| `--north` | `#F0715A` | north pole (+) |
| `--south` | `#5B8DEF` | south pole (−) |

Contrast: body text on `--bg` is above 12:1; `--ink-2` above 8:1; `--ink-3` is reserved for meta text at 14px+ (≈4.6:1).

## Type

- **Display:** Cormorant Garamond 500 (headings, pull quotes, prices, timeline years). Editorial, medical-atlas voice.
- **Body / UI:** Manrope 400–700. Labels, nav, buttons, tables.
- Scale: 13 / 15 / 17 (body) / 20 / 26 / 36 / fluid 38–58 (h2) / fluid 48–86 (h1). Line length ≤ 64ch for prose.
- Small-caps tracking is used only where it classifies (field names, polarity, realm), never as a decorative eyebrow.

## Layout

- Max width 1280px, fluid gutters 16–48px.
- Section rhythm 56–112px. Interior pages open with `.page-hero` (breadcrumb, H1, lead).
- Signature layouts: `.hero` (text + living figure), `.atlas` (field list / stage / detail, 3-column → stacked), `.lab` (scene + steps), `.timeline` (centered spine), `.realms` (two founders side by side).

## Components

Buttons (`.btn-primary` gold, `.btn-outline`, `.btn-aqua`, `.btn-ghost`), panels (`.panel`, `.panel-gold`, `.panel-aqua`), pole markers (`.pole-n`, `.pole-s`), chips, field rule divider, pathway cards, product cards, story cards, forms, CTA band with field canvas, header with language switch and mobile drawer, footer with disclaimer and tone toggle.

## Motion

One orchestrated entrance on the home hero (`.rise`). Everything else moves only in answer to the user (atlas selection pulses, lab playback, cart toast). Field-line particles are decorative and are disabled under `prefers-reduced-motion`.

## Accessibility

Visible focus rings (aqua), keyboard-operable atlas points (`tabindex`, Enter/Space), ARIA pressed/current states on toggles and steps, `lang` attribute follows the chosen language, forms with real labels, no information carried by color alone (poles also carry N/S letters and labels).

## Page map

Language gate → Home → Atlas · History · Science · Pathways · Lab · Magnets · Stories · Sandra (booking). Every page links to booking; the footer disclaimer appears everywhere.
