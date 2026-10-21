# English pack — translator notes for clinical/source review

Items where the Spanish baseline is ambiguous, defective, or medically questionable. The English mirror stays
faithful to the source; corrections should be made in the Spanish baseline (or as reviewed overrides) by a
bilingual practitioner. Keys are source hashes (`srcHash`); find them with Settings → Language packs → search.

| srcHash | Issue | Translation choice |
|---|---|---|
| d14da0cdf88d0639, aa1f82eb505b3ad4 | Source list lines broken mid-word by PDF extraction ("procesa-", "recomendacio-"); tails concatenated on last line | Fragments translated as-is to preserve line structure; **fix source extraction** |
| aa1f82eb505b3ad4 (item 25) | "usar la palabra usuario o cliente, en vez de paciente" | "use the word user or client, instead of patient" (style-guide mapping would read "client or client") |
| 5ec5d34eb5ba7fc4 | Source typo "Epliplón - Epiplón"; "S. epidermis"; unbalanced "((" | Greater omentum – Greater omentum; source spelling/punctuation kept |
| 5cf3bbe17b6c3021 | Oliguria defined as "< 400 miligramos al día" — medically ~400 **mL**/day | Kept "400 milligrams" (faithful); **source check recommended** |
| 8f454c6a8c8ea550 | "200 miligramos / litro", stray space "+6 ." | Kept as source |
| cb3f3dbdd055b6e5 | "estafilococo áureo o estafilococo dorado" | "golden staphylococcus or golden staph" |
| dbfcb553df1f4251 | "Matlali (Chrysanthemum parthenium)"; "Sien - Sien" | Name kept; "Temple – Temple" |
| 5c1c1c5a719e54fa | "Polo - Polo": termbase name "Frontal hairline pole" reads awkwardly in pair lists | Used verbatim; consider shorter display name |
| 3e34aa14711822bc | Source lists "embolia encefalocraneal" as synonym for traumatic brain injury (source error) | Translated literally |
| 8eab9854438f5586 | Bursitis text ends with unrelated sentences ("Significa miedo.") | Kept faithfully; **source cleanup** |
| d7c87d5607ff2104, 33c468a70dd49aa3 | Numbered lists broken by PDF extraction | Structure preserved; **fix source extraction** |
| 45b0e95a0f1f15a4, f5b917ad954ae5d3 | "Vesícula" here means gallbladder; termbase point name "Vesicle" | "Gallbladder" — matches point `vesicula` (EN "Gallbladder"); "Vesicle" came from a symptom-term collision in the termbase |
| 7f2ca02d0efa6d84 | Schistosoma (a worm) called "esta bacteria" | "this bacterium" (faithful); **source error** |
| 7e4accb39b7fc339 | "adicciones" typo for "adiciones" | "additions" |
| be26c0e5ac35c3ed | "fibra liposoluble" (likely insoluble fiber) | Literal |
| feb150e7b347f615 | "Trastornos de la médula espinal" (likely bone marrow intended) | "Spinal cord disorders" (literal) |
| 3381b384f0c6335f, 68f41e0decbc5b52, c50e7a16dd37abd6, 18de4231cc59ea45, b089b26dec981cfd | Lists broken / reordered by PDF extraction | Structure mirrored; **fix source extraction** |
| 0cb034c2f8ae4c0a | "Esófago de garret" typo | "Barrett's esophagus (esophageal varices)" |
| 123ea27823a1f762 | "Mácula" in eye context (termbase "Macule" is the skin sense) | "Macula" |
| 64762dad91bfdd65 | Termbase collision "Temporal"→"Temporary" (compendium classification) for the temporal point | "Temporal" |
| 8564472deefcefd3 | "conjunción mental" typo for "confusión mental" | "mental confusion" |
| 27f78e12878a11f4 | "nanaga" typo for nagana | "nagana" |
| af54de0403d9baea | Prostate TB text says pain in the "uterus" (likely pubis) | Literal; **source error** |
| 7af80527f52e5c1f | Endometriosis glossed as infection (endometritis); "miometriosis" | Literal |
| c7d2831d4d85eefe | "ahorcamiento" in intestinal list | "strangulation" |
| 0f4c2816ed142780 | Unknown toxin "limosina"; leprosy bacterium credited with plague/cancer | Kept literally; **source accuracy review** |
| 89bb0668386fa6ca | Pleura described as "cobertura cutánea" | "the covering" |
| 7d3add28d3339ad7 | "celulitis" defined as fat build-up | "cellulite" |
| 803a679fad59ba68 | Cholera serotypes "01 and 0139" (should be O1/O139) | Kept as source |
| (style) | Curated names used British spelling (oesophagus, tumour, oedema…) | Normalized to US English at the importer; Latin taxa (Haemophilus, E. faecalis) unchanged |
