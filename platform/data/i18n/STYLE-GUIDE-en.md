# English language pack — translation style guide

Source: Spanish baseline (Goiz Level 1/2 guides, Leal 2018 compendium). Target: US English, clinical register,
read by biomagnetists and physicians. The English pack is a **mirror**: one English text per Spanish field,
never merged, split or reordered.

## Fidelity rules
1. Translate meaning faithfully and completely. Do not summarize, omit, add, soften or strengthen claims.
2. Keep the guides' scope language: *relación / relacionado con* → **related to / relation**, never
   "diagnosis", "causes" or "cures" unless the Spanish literally says so.
3. Preserve numbers, units, ranges, dosages, percentages, list markers ("- ", "1."), line breaks, parentheses,
   capitalization style of headings, and abbreviations in the source order.
4. Latin binomials and pathogen species stay Latin, italic-free (e.g. *Staphylococcus aureus*): "Staphylococcus aureus".
5. Proper names of named pairs (Abraham, David, Tsunami, Wall Street…) stay as-is.
6. Use the termbase (`_work/en/termbase.json`, 1,407 curated pairs) for every point, symptom, entity,
   protocol, category and region name. Termbase wins over your own preference.
7. If a Spanish text is already English, a code, or untranslatable (e.g. a lone abbreviation), return it unchanged.

## Fixed terminology
| Spanish | English |
|---|---|
| Par Biomagnético (PB), pares biomagnéticos (PB´s) | biomagnetic pair (BP), biomagnetic pairs (BPs) |
| punto de rastreo / punto de impacto | tracking point / impact point |
| rastreo, rastrear | scan / tracking, to scan |
| rastreo dirigido con el imán | magnet-directed scan |
| impactar, impactación | to impact, impaction |
| despolarizar, despolarización | depolarize, depolarization |
| imán negativo / imán positivo | negative magnet / positive magnet |
| Biomagnetista | biomagnetist |
| usuario (person receiving the technique) | client |
| DMP (dismetría de miembros pélvicos) | PLD (pelvic-limb dysmetria) — keep "DMP" in parentheses on first use only if the Spanish uses the abbreviation |
| MP / MT | lower limbs / upper limbs |
| reservorio | reservoir |
| crisis curativa | healing crisis |
| Recomendaciones generales | General recommendations |
| Sintomatología | Symptoms |
| Enf. Tropicales | Tropical diseases |
| IVU / IRA / ITS / EPI / EPOC / CUCI / EVC | UTI / ARI / STI / PID / COPD / UC (chronic nonspecific ulcerative colitis) / stroke |
| VIH / SIDA | HIV / AIDS |
| D / I / C (sides) | R / L / C |
| Pb (probable) | Prob. |

## Format
Return a JSON array with exactly the same `h` values as the input, each `{ "h": "...", "en": "..." }`.
