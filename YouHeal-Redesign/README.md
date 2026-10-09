# YOU HEAL — website redesign prototype (v1.0)

A complete, bilingual (English / Colombian Spanish) redesign concept for **youheal.us**, built as a static, self-contained website. No build step, no framework: open `index.html` in a browser.

## Open it

- Double-click `index.html`, **or**
- serve the folder locally for the cleanest experience (the language switch and fonts work either way):

```bash
npx serve .
```

Pages:

| File | What it is |
|---|---|
| `index.html` | Language gate (English / Español) with the animated field-line hero |
| `home.html` | Main marketing page with the living body atlas in the hero |
| `atlas.html` | Interactive virtual atlas: fields → pairs → points, two realms (Goiz / Hervás) |
| `history.html` | Timeline (science thread + Goiz 1988 + Hervás 2014 + YOU HEAL), realm comparison |
| `science.html` | Practitioner model (interactive pH demo), tiered evidence summary, 14 references |
| `pathways.html` | In person vs remote, how each session works, comparison table, packages |
| `lab.html` | Immersive session simulator (play / step through, in person or remote) |
| `shop.html` | Magnet kits, what magnets do, gauss scale, safety, demo cart → email order |
| `stories.html` | Testimonials (sample placeholders), filter, "share your story" form |
| `about.html` | Sandra, credentials, contact, booking form (opens a pre-filled email) |

Shared code lives in `assets/`:

- `assets/css/style.css` — the design system (tokens, type, components)
- `assets/js/main.js` — language engine, header/footer, field-line canvas, 528 Hz ambient tone
- `assets/js/body.js` — body silhouette and anatomical landmarks (shared by home, atlas, lab)
- `assets/js/atlas.js` — atlas data (fields, pairs, realms)

## Editing text

Every visible string is bilingual. Each page has a `window.YH_DICT = { key: ['English', 'Español'] }` block near the bottom; shared strings (navigation, footer) are in `assets/js/main.js`. Data-driven content (atlas pairs, timeline items, references, products, stories, lab steps) is in plain arrays in the page scripts with `{en:'…', es:'…'}` fields.

## Placeholders to replace before launch

1. **Prices** on `pathways.html` and `shop.html` are sample numbers (marked "sample pricing").
2. **Testimonials** on `stories.html` and the quote on `home.html` are written placeholders. Replace with client-approved quotes.
3. **Portrait** of Sandra on `about.html`; studio photos if desired.
4. **Hours** and the "steps from the N/W train" line on `about.html`.
5. **Quantum Biomagnetism credential**: `about.html` says "continuing training". Confirm Sandra's actual level with the Escuela Internacional BQ and adjust.
6. **Polarity convention**: the site follows the concept art (North + = expansive/alkaline, South − = contractive/acidic). Magnet labeling differs between schools and suppliers, so confirm with Sandra's own magnets and adjust `common.northsub` / `common.southsub` in `main.js` and the polarity cards on `shop.html` if needed.
7. **Timeline facts to verify**: Dr. Goiz's passing (listed as 2021) and the Broeringmeyer item (presented as practitioner history because the original report is hard to source).
8. **Product specs and suppliers** on `shop.html`.
9. **Booking and orders** currently open the visitor's email app (mailto). For real bookings, connect a scheduler (Calendly, Acuity, GoDaddy Appointments) to the "Book a session" buttons and a payment link to the shop.

## Hosting on GoDaddy

The current site runs on **GoDaddy Websites + Marketing** (the drag-and-drop builder). That builder cannot host a custom multi-page HTML site as-is. Three options, in order of fidelity:

1. **Static hosting with the domain pointed at it (best fidelity).** Upload this folder to GoDaddy Web Hosting (cPanel, `public_html`) or to a static host (Cloudflare Pages, Netlify, GitHub Pages) and point `youheal.us` DNS to it from the GoDaddy domain panel. The prototype works unchanged.
2. **Keep Websites + Marketing, rebuild the layout there, embed the interactive pieces.** Recreate sections in the builder using the design tokens below, and drop the Atlas, Lab and language gate into "HTML" sections (each is self-contained and can be inlined). Interactive fidelity is partial.
3. **Hybrid.** Keep the builder for the home page and link to the prototype pages hosted on a subdomain such as `atlas.youheal.us`.

## Design tokens

See `design/design-system.md`.

## Health claims

Copy was written to stay on the right side of advertising rules for complementary therapies: no cure/treat language, a visible disclaimer in every footer, a safety box on the shop page, and an evidence page that distinguishes measured science from the practitioner model. The current live site lists conditions including cancer; that list was deliberately not carried over.
