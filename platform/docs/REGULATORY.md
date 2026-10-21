# YOU HEAL Clinical — Regulatory and Intellectual-Property Notes

Version 1.0 · October 2026 · Owner: Product / Platform Security

> **Not legal advice.** This document records the engineering team's understanding of the regulatory
> landscape so that product and deployment decisions are traceable. Laws differ by country and U.S. state
> and change frequently. **Engage qualified counsel** (FDA/health-regulatory, privacy/HIPAA, and
> intellectual-property) before commercial distribution, before any marketing claim is published, and
> before entering into a licence with the rights holders named below.

---

## 1. What the source material itself says about validity

The reference catalog is derived from the Goiz *Guía de Pares Biomagnéticos* (1st and 2nd level, 2017,
David Goiz Martínez / Biomagnetism Research Institute) and the Leal compendium (2018). The Goiz guides
themselves state that the technique is **not scientifically validated for identifying disease** and must
not be used to diagnose:

* Goiz 1er Nivel, p. 19 (identical text in 2do Nivel, PDF p. 19): Biomagnetic Pairs "**pueden, pero no deben
  identificar enfermedades**" ("can, but must not, identify diseases") because they "are not
  pathognomonic"; "**no existen estudios protocolizados, estandarizados, aleatorizados** y que puedan ser
  reproducibles, validados y certificados por instituciones de salud, universidades y centros de
  investigación … tan solo se tiene la opinión de expertos" (no protocolized, standardized, randomized,
  reproducible or institutionally validated studies exist; there is only expert opinion). Practitioners are
  told to use the word **"relación"** (relation) "**con el objetivo de no dar diagnósticos, y evitar así,
  repercusiones legales**".
* Same page: scans "frequently" produce **false positives** (stress, doubt, "therapeutic ego", unconscious
  wish to diagnose, electromagnetic interference …), results differ considerably between practitioners,
  and using the technique "para identificar y diagnosticar patologías, puede representar **más un riesgo
  que un beneficio** para la población y el Biomagnetista desde el punto de vista ético, profesional y
  legal". "Se hace énfasis en no dar diagnósticos una vez más."
* Goiz 1er Nivel, p. 105 (2do Nivel, PDF p. 73): protocols "no sustituyen y no son más importantes que el
  rastreo completo".
* The guides also disclaim completeness and responsibility for results (1er Nivel, introduction).

Independent, controlled clinical evidence establishing diagnostic accuracy or therapeutic efficacy of
Biomagnetic Pair therapy is, to our knowledge, lacking. **The product therefore positions findings as
complementary, non-diagnostic observations** — which is also the stance of the source authors.

### Product design consequences (already implemented, CONTRACT §3, §8)
* UI and reports say "**related to**", never "diagnosed with" / "detected".
* Every report carries the fixed disclaimer: *"Biomagnetic Pair findings are complementary, non-diagnostic
  observations. They do not identify disease and do not replace evaluation, diagnosis or treatment by a
  licensed physician. Continue all medical indications."*
* Intake includes an explanation of the technique, scope questions, signed authorization and
  contraindication screening (relative/absolute lists from the guides).
* No feature claims to detect pathogens or conditions, to prescribe, or to advise stopping medical care.

---

## 2. Product claims: FDA, FTC and positioning

### 2.1 Positioning
Market YOU HEAL Clinical as **practice-management and documentation software for complementary/wellness
practitioners and physicians**: patient records, consent, session documentation, a reference library of
the practitioner's discipline, and reports. Do **not** describe it — in the app, website, sales material,
app-store listings, social media or sales calls — as diagnosing, detecting, treating, curing, mitigating or
preventing any disease, infection or condition, or as identifying viruses, bacteria, fungi, parasites or
cancer.

### 2.2 FDA (United States)
* A product is a **medical device** if it is *intended* for use in the diagnosis, cure, mitigation,
  treatment or prevention of disease (FD&C Act §201(h)). Intended use is judged from labelling,
  advertising and the circumstances of distribution (21 CFR 801.4) — so marketing claims, not just code,
  determine status. Software can be a device in its own right (**Software as a Medical Device, SaMD**,
  per the IMDRF definition used by FDA).
* Section 520(o) of the FD&C Act (added by the 21st Century Cures Act, §3060) **excludes** certain software
  functions from the device definition, including administrative support of a health-care facility and
  electronic patient records that are not intended to interpret or analyse data for diagnosis or
  treatment. Record-keeping, scheduling, consent and report-printing functions fit this description.
* FDA's **General Wellness** policy (guidance "General Wellness: Policy for Low Risk Devices") covers
  low-risk products intended only for maintaining or encouraging a general state of health, without
  reference to specific diseases. Claims tied to named diseases (e.g., "related to HIV", "for cancer") fall
  outside it.
* **Risk areas in this product**: (a) the catalog maps pairs to pathogens and diseases, and (b)
  `POST /catalog/suggest` ranks pairs for entered symptoms. If marketed as identifying or treating those
  conditions, these functions could make the software (and the magnet protocol it directs) a device
  requiring premarket review, which the evidence base (§1) would not support. Keep them framed and
  labelled as a **reference to the practitioner's own discipline literature** ("the source guide lists the
  following relations"), with source citations (ADR-007) and the disclaimer, and keep final judgement with
  the practitioner. Have regulatory counsel review the suggest feature and all copy before U.S. launch.
* Magnets marketed with therapeutic claims are themselves regulated as devices; FDA has historically acted
  against magnet products promoted for disease treatment. The product must not sell, recommend specific
  magnet products, or make therapeutic claims about magnets.

### 2.3 FTC (United States) and advertising generally
* Sections 5 and 12 of the FTC Act prohibit unfair or deceptive acts and false advertising of
  health-related products and services. The FTC's **Health Products Compliance Guidance** (December 2022)
  expects health claims to be substantiated by **competent and reliable scientific evidence** —
  generally well-controlled human clinical studies for disease-related claims; testimonials and
  "traditional use" do not substitute.
* Implications: no efficacy claims in product marketing; case-study/testimonial content must not imply
  disease outcomes; practitioners using the product are responsible for their own advertising (consider
  stating this in the customer terms of service).
* Other jurisdictions (e.g., COFEPRIS rules on health advertising in Mexico, EU MDR 2017/745 Rule 11 for
  software, consumer-protection laws) apply analogous principles; review per market.

---

## 3. HIPAA and privacy-law applicability

### 3.1 Covered entity or not?
HIPAA applies to **covered entities** — health plans, health-care clearinghouses, and **health-care
providers who transmit health information electronically in connection with a HIPAA standard transaction**
(e.g., electronic insurance claims, eligibility checks) — and to their **business associates**
(45 CFR §160.103).
* A **physician or other provider who bills insurance electronically** is a covered entity; records about
  patients kept in YOU HEAL Clinical are ePHI subject to the Privacy, Security and Breach Notification Rules.
* A **cash-only biomagnetist** who never conducts standard electronic transactions is generally **not** a
  HIPAA covered entity. HIPAA then does not apply — but other laws can, and patients expect equivalent
  protection:
  * **State laws**: e.g., California's Confidentiality of Medical Information Act (broad definition of
    "provider of health care"), Texas Health & Safety Code ch. 181 (a broader "covered entity" definition,
    including persons who assemble or store PHI), state data-breach statutes in every state.
  * **Consumer-health-data laws** aimed at non-HIPAA entities, e.g. Washington's My Health My Data Act
    (RCW 19.373) and similar laws in other states (consent, deletion rights, private right of action in WA).
  * **FTC**: Section 5 (unfair/deceptive data practices) and, for vendors of personal health records, the
    **Health Breach Notification Rule** (16 CFR Part 318, amended 2024).
  * Outside the U.S.: e.g., GDPR Art. 9 (health data is special-category data) for EU patients; Mexico's
    federal private-sector data-protection law (LFPDPPP, re-enacted 2025) treats health data as sensitive
    and requires express consent.
* **Design stance**: the product implements HIPAA Security Rule safeguards (SECURITY.md §4) for every
  deployment, so the same build serves covered and non-covered practices.

### 3.2 Vendor role and BAAs
* **On-prem, no vendor access to PHI** (the default): the vendor generally does not create, receive,
  maintain or transmit PHI on the clinic's behalf and is not a business associate. Remote support sessions
  must avoid PHI or be covered by a BAA.
* **SaaS, hosted backups, or remote support with PHI access**: the vendor **is a business associate**
  and must sign a **Business Associate Agreement** with each covered-entity customer (45 CFR §164.502(e),
  §164.504(e), §164.314(a)), and flow equivalent terms down to sub-processors (cloud hosting, e-mail,
  logging, support tooling).
* Breach-notification duties and timelines: OPERATIONS.md §10.4.

---

## 4. Scope-of-practice notes (non-physician biomagnetists)

* Every U.S. state prohibits the **unlicensed practice of medicine** — typically defined to include
  diagnosing, treating, prescribing for, or holding oneself out as able to treat disease. A non-physician
  biomagnetist who "diagnoses" an infection or tells a patient to stop prescribed treatment risks
  prosecution and civil liability. The source guides' "relation, not diagnosis" rule (§1) is aligned with
  this.
* Several states have **"health freedom" / unlicensed complementary-practitioner statutes** that permit
  such practice under conditions — for example **California** Business & Professions Code §§2053.5–2053.6
  (no diagnosis/treatment of illness in the medical sense, no invasive procedures, and a **written
  disclosure** signed by the client stating the practitioner is not a licensed physician and the services
  are alternative/complementary), and **Minnesota** Statutes ch. 146A (unlicensed complementary and
  alternative health-care practitioners; required **Client Bill of Rights**; prohibited conduct). Other
  states (e.g., Colorado, Idaho, Louisiana, Rhode Island and others) have enacted comparable laws with
  differing conditions. **Verify the current statute for each state of practice.**
* **Licensed** clinicians (MD/DO, ND, DC, LAc, nurses) remain bound by their board's standards, including
  informed consent about non-evidence-based modalities and not delaying or substituting standard care.
* Product support: configurable intake/consent text per clinic (so state-required disclosures can be
  inserted), contraindication screening, the report disclaimer, "related to" vocabulary, audit trail of
  consents. Clinics are responsible for using disclosures valid in their state.

---

## 5. Intellectual property and content licensing

### 5.1 The sources and their notices

| Source (`sources.json` id) | Notice / provenance | `license_status` today |
|---|---|---|
| Goiz, *Guía de Pares Biomagnéticos — 1er Nivel* (2017), David Goiz Martínez / Biomagnetism Research Institute (`goiz-n1`) | Every page: "GOIZ TM INTELLECTUAL PROPERTY © COPYRIGHT ALL RIGHTS RESERVED" | `internal-use` |
| Goiz, *Guía … — 2do Nivel* (2017) (`goiz-n2`) | Same notice | `internal-use` |
| Leal (comp.), *Biomagnetismo Médico — Padecimientos & Patógenos* (2018) (`leal-2018`) | Cover: "Basados en las enseñanzas del Dr. Isaac Goiz Durán — Recopilación: Oscar Leal"; page footers cite biomagnetismolibre.wordpress.com; no licence statement found | `internal-use` |
| Original YOU HEAL content (`youheal`) | Authored by the project | `original` |

"GOIZ™" is used as a claimed trademark; "© … All rights reserved" asserts copyright with no licence
granted. The Leal compilation is itself derived from Dr. Isaac Goiz Durán's teachings; the "libre" in the
website name does not by itself establish a licence to copy or redistribute.

### 5.2 Internal testing vs. commercial distribution
* **Internal use** (development, testing, a practitioner's own reference copy within a licensed
  organisation) carries comparatively low risk, but it is still reproduction of copyrighted material;
  counsel should confirm the basis (e.g., fair use in the U.S. is a fact-specific defence, and other
  countries — including Mexico under the *Ley Federal del Derecho de Autor* — have narrower exceptions).
* **Commercial distribution** — shipping the catalog inside a product, an offline bundle, or a SaaS
  available to other clinics — requires **written permission from the rights holders**:
  * **Goiz guides**: a licence from the rights holder (presented in the guides as David Goiz Martínez /
    the Biomagnetism Research Institute; the Goiz family's other entities, such as the official Goiz
    schools, may hold related rights) covering reproduction in software, translation (English), display,
    distribution to subscribers/sublicensing to clinics, territory, term, updates, attribution and the
    © notice, use of the GOIZ™ name (or prohibition of it), audit rights, and data handling on
    termination.
  * **Leal compendium**: clearance from the compiler (Oscar Leal) **and** confirmation that the underlying
    Goiz-derived content is covered by the Goiz licence (double clearance), or exclusion.
* Facts (e.g., that a given pair of anatomical points is used together) may receive thinner protection
  than expressive text, but the catalog also contains **verbatim Spanish prose** (descriptions,
  symptoms, recommendations, notes) and reflects the guides' **selection and arrangement**, which can be
  protected; EU *sui generis* database rights may also apply in Europe. Do not rely on a facts-only
  theory without counsel's opinion.
* The guides' anatomical renders are **never extracted or reused** (ADR-005); the 3D body is procedural.
* Avoid "Goiz" in product names, domain names or ads beyond accurate, nominative reference.

### 5.3 How ADR-007 makes compliance enforceable
* Every catalog record carries `source: {doc, page}`; `sources.json` carries `license_status` and notice.
* **Runtime filter**: `YH_CATALOG_LICENSES=licensed,original,public-domain` loads only cleared content —
  the setting for any SaaS tenant or externally distributed install until a licence is signed.
* **Build gate**: `deploy/offline/build-bundle.sh` / `.ps1` refuse to package `internal-use` content unless
  explicitly overridden (`--allow-internal-use`), and then label the bundle as internal-only.
* **After a licence is executed**: change that source's `license_status` to `licensed` in `sources.json`
  (record the agreement reference and date in the commit message and the source's `notice`), reload the
  catalog (`node --run catalog:load`), and keep the agreement with the release records. Content outside
  the licence's scope (e.g., territory) can be handled by deploying with an appropriate
  `YH_CATALOG_LICENSES` value or by splitting the source entry.
* Reports cite sources, so attribution notices required by a licence can be displayed.

---

## 6. Pre-launch checklist (commercial / SaaS)

1. Regulatory counsel review of intended-use statement, all UI copy, marketing and the suggest feature
   (FDA device status; FTC substantiation).
2. Executed content licences (Goiz rights holder; Leal compiler) — or catalog limited to
   `original`/`licensed`/`public-domain`.
3. Terms of service: non-diagnostic use, practitioner responsibility for scope of practice and
   advertising, data-protection roles.
4. HIPAA: BAA template; sub-processor BAAs; SaaS security program (risk analysis, policies, training,
   incident response) — SECURITY.md becomes the SSP baseline.
5. State-law matrix for target states (privacy, consumer-health-data, breach notification, practice scope)
   and country-specific review for non-U.S. markets.
