# Catalog importer

Build-time pipeline that turns the three licensed source PDFs in `data/sources/` into the committed
catalog JSON in `data/catalog/` (formats: `docs/CONTRACT.md` §4). Node ≥ 22 ESM, **zero npm
dependencies**; the only external tool is poppler's `pdftotext`.

```sh
node importer/run.js            # parse, validate, write data/catalog/*.json + IMPORT-REPORT.md
node importer/run.js --check    # parse and validate only; writes nothing
node importer/validate.js       # re-validate the committed catalog (refs, counts, sha256 in manifest)
```

`run.js` exits non-zero if validation fails. Re-running on unchanged sources produces byte-identical
files (stable ordering, 2-space JSON, and `manifest.generatedAt` is kept when no hash changed;
set `SOURCE_DATE_EPOCH` to pin it explicitly).

Requirements: `pdftotext` (poppler-utils ≥ 22) on `PATH`, and the PDFs:

| source id | file | printed page numbers |
|---|---|---|
| `goiz-n1` | `data/sources/goiz-nivel-1-guia.pdf` (142 pp) | = PDF page ("Pg. N") |
| `goiz-n2` | `data/sources/goiz-nivel-2-guia.pdf` (120 pp) | = PDF page + 140 ("P. N") |
| `leal-2018` | `data/sources/leal-padecimientos-patogenos-2018.pdf` (474 pp) | = PDF page |

Every catalog record carries `source: {doc, page}` with the **printed** page number.

## Layout

```
importer/
  run.js                 orchestration, writes files, manifest (counts + sha256), report
  validate.js            referential-integrity validator (also a CLI)
  overrides.json         every manual correction, each with a "_why" (all reported in IMPORT-REPORT.md)
  lib/slug.js            CONTRACT §4 slug(), verbatim (+ slugKeep() that keeps parenthesised text)
  lib/pdf.js             runs `pdftotext -bbox-layout`, returns pages → blocks → lines with coordinates
  lib/layout.js          rows / columns / footer page numbers / de-hyphenation helpers
  lib/goiz.js            Goiz guides: index, pair blocks (text column vs. figure column), block fields
  lib/backmatter.js      Top 10/Top 5/basic lists, disease protocols, symptom lists, general
                         recommendations, contraindications, abbreviations, intake form (Hoja de Registro)
  lib/leal.js            Leal compendium: entries, labelled prose cells, pole table (multi-line cells)
  lib/point-aliases.js   canonical anatomical points: es/en name, laterality, aliases/typos
  lib/points.js          point-reference parser: canonical point + side + qualifiers + notes
  lib/symptom-aliases.js symptom typo folding (Diarrrea → diarrea, …)
  lib/build.js           assembly of all catalog files
  lib/i18n*.js           English names (categories, systems, protocols, diseases, entities, symptoms, contraindications)
  lib/report.js          IMPORT-REPORT.md writer
```

## How the sources are parsed

`pdftotext -bbox-layout` (same poppler binary as `-layout`, but with word/line/block coordinates) is
used instead of plain `-layout` text: the Goiz pages put figure labels in a left column and the pair
text in a right column whose x-offset varies per block, and the Leal compendium puts each table cell
(`Contagio / Causa`, `Descripción`, pole cells) in its own text block with a vertically centred label.
Coordinates make both separations exact.

* **Goiz pair blocks** – every `Relación …` line anchors a block; the nearest numbered line above it is
  the title (two-line titles and alternate names such as `Pubis (D) – Pubis (I)` are handled). Lines at or
  right of the `Relación` x-offset are text, the rest is the figure (labels, caption) and is ignored for
  symptoms. Ratings are the count of `√` after `F`, `P`, `R`. `Sintomatología` lines are grouped into
  systems (`Síntomas Neurológicos` + `- item` bullets, `Inmunológico (detalle)`, free lines classified via
  the symptom vocabulary); `Recomendaciones` keeps the set (`Generales` → `general-full`,
  `Enf. Tropicales` → `tropical`, …) and one string per bullet (`"<header>: <bullet>"`).
* **Index (Índice General)** – ground truth for numbering (1–210, 211–325), section/category of Level 1
  regular pairs, and a cross-check of every block title (mismatches are reported).
* **Leal compendium** – entries are centred titles `Name (Pt|Pr|Pd|Est-XX)`; a repeated title at the top of a
  page continues the entry. Prose blocks are assigned to the label whose centre falls inside them; an
  unlabeled block continues the previous field across a page break. Pole rows pair lines of the
  `Polo Negativo` / `Polo Positivo` columns by baseline, and multi-line cells (e.g.
  `Articulación` / `(hombro, codo, …)`) by matching vertical centres.

## Normalization

* **Points** (`points.json`): one record per canonical point, id = `slug(canonical Spanish name)`, never a
  side. `lib/point-aliases.js` folds spelling variants and the compendium's hierarchical names
  (`Hígado - Suprahepático` → `suprahepatico`, `Riñón - Suprarrenal` → `suprarrenal`, `Dorsal 3 - Tercera`
  → `dorsal-3`, `Pubis - Suprapúbico` → `suprapubico`, `Inguinal (Nervio)` / `Nervio Inguineal` →
  `nervio-inguinal`, `Esfíntar` → `esfinter-uretral`, …) and gives every point an English anatomical name.
  `laterality` is `bilateral` when anatomically paired or when the Goiz guides mark it (D)/(I)/(D/I).
* **Sides**: `(D)`→`R`, `(I)`→`L`, `(D/I)`→`RL`, none→`C`; `(S)`,`(Inf)`,`(A)`,`(P)`/`(Post)`,`(Lat)` → qualifiers.
  `Contralateral`, `Ipsilateral`, `del mismo lado`, `lado del pie acortado` → side `RL` + a note
  (pair `notes`, or `notes` on the entity pole pair). `(C/D/I)` → `C` + note.
  `Ovario/Testículo`, `Próstata/Útero` → `point` + `altPoint`.
* **Categories**: Level 1 regular pairs from the index sections; special pairs and all of Level 2 (whose
  index has no section headers in the text layer) by: override → Level 2 psycho-emotional list (p.244) →
  reservoir list (p.245) → relation names a dysfunction → relation names a reservoir → classification of the
  related compendium entity → `complex`. `IMPORT-REPORT.md` lists the counts per rule.
* **Entities** (`entities.json`): every Leal entry plus every Goiz relation. Goiz relation names are merged
  into Leal entries through `overrides.json#entityAliases` (e.g. `Rabia Virus` → `rabia`,
  `Herpes Virus 1` → `herpes-1-zoster`). A number in a relation is an ordinal (`VIH (1)`) except for
  names listed in `typeNumberedEntities` (Herpes/Adenovirus serotypes).
* **Compendium pole pairs** are linked to a numbered pair when tracking/impact points match (preferring the
  pair related to the same entity, then side agreement). Otherwise they create a `cx-<neg>--<pos>` pair
  (level 0, category = entity classification, `source` = leal-2018 page). Protocol items naming a point
  pair that has no number (e.g. `Caries – Riñón (D/I)`) also map to `cx-` pairs and are listed in the report.
* **Protocols**: `basic-*`, `top10-*`, `top5-*` (Level 1 and Level 2 lists with the same name merge into one,
  items de-duplicated, `alsoIn` keeps the second source), `disease-<slug>` (Level 2 p.218–236; items are
  protocol refs and pairs; `PB´s relacionados a X` expands to the pairs related to X; free text goes to
  `notes`), and `basic-pb-diabetogenicos` / `basic-pb-hiperglicemicos` (Level 2 p.216 lists referenced by
  the Diabetes protocols). "Protocolo Básico" in disease protocols maps to `basic-short`.
* **Symptoms** (`symptoms.json`): seeded from the Level 1 symptom lists (p.113–118, with definitions),
  extended with every term used by a pair, typos folded (`lib/symptom-aliases.js`), English names for all.
* **Recommendations**: the general recommendation sections (p.96–104) plus `intake-form` (Hoja de
  Registro, Level 2 p.248–250) structured as sections/fields/questions/scan-record columns so the UI can mirror it.
* **Manifest**: `vocabularies` carries the category, system, side and qualifier lists with `es`/`en` names.

## Manual overrides

All live in `overrides.json`, each with a `_why`; the importer reports every override it applies.
Notable source errors corrected there: block for pair 288 printed under the title of 286; pair 300 and 259
blocks repeating a neighbour's title; garbled or repeated `Relación` lines of 108, 115, 222, 253, 294;
pair 113 title (`Dorsal` vs figure/index `Dorso`); pair 13 magnet positions (A/P); pair 282 four-magnet
"pancreatic belt" (`magnets` array, from Leal p.335).

## Spot checks

Pairs compared by hand against `pdftotext -layout` of the cited page (title, sides, relation, F/P/R,
symptoms, recommendations): 1, 5, 6, 13, 31, 56, 71, 101, 113, 115, 154, 174, 196, 207, 208, 210, 211, 212,
213, 216, 241, 282, 288, 294, 299, 300, 306, 313, 323, 325. The report reproduces a table of them.

## Known limitations

See the end of `data/catalog/IMPORT-REPORT.md`. In short: prose stays Spanish; Level 2 categories are
inferred; some reservoir pairs only print F; compendium pole names are free text normalised by alias
tables (review `IMPORT-REPORT.md` → unresolved items when sources change).
