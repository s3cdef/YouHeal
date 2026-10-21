# YOU HEAL Clinical — Integration Contract (v1.0)

**Authority:** Principal Software Architect. This document is the single source of truth that every
workstream builds against. If an implementation needs to deviate, update this file in the same change
and say so in the commit message.

Product: **YOU HEAL Clinical** — a secure practitioner platform for Biomagnetic Pair (Par Biomagnético, PB)
practice. Primary users are biomagnetists and physicians. Deployment order: **on-premises first** (single
clinic, single host, offline-capable), **SaaS later** (multi-tenant). English is the primary UI language;
Spanish ships alongside; every string and every catalog record is locale-keyed.

---

## 1. Non-negotiable architecture decisions (see `docs/adr/`)

| # | Decision | Rationale |
|---|---|---|
| ADR-001 | **Node.js ≥ 22.13 LTS, zero runtime npm dependencies** on the server. Use only `node:http`, `node:https`, `node:crypto`, `node:sqlite`, `node:fs`, `node:path`, `node:url`, `node:zlib`, `node:test`. | Medical/PHI software; eliminate supply-chain attack surface; trivial offline install; no native builds on Windows. |
| ADR-002 | **SQLite via `node:sqlite`** (WAL mode, `foreign_keys=ON`, `secure_delete=ON`). Every tenant-owned table carries `org_id`. All SQL is parameterized. Data access goes through `server/lib/db.js` so a PostgreSQL adapter can be added for SaaS. | Single-file DB is ideal on-prem; `org_id` from day one makes SaaS a deployment change, not a rewrite. |
| ADR-003 | **Field-level AES-256-GCM encryption** for PHI columns (patient names, DOB, contact, notes, findings notes). Key-encryption key from `YH_MASTER_KEY` (base64, 32 bytes) or key file `data/keys/master.key` (0600). Ciphertext format: `v1:<keyId>:<iv b64>:<tag b64>:<ct b64>`. A blind index (HMAC-SHA256, separate derived key) enables exact-match search on last name / DOB. | HIPAA §164.312(a)(2)(iv), NIST SC-28. |
| ADR-004 | **Frontend is a no-build vanilla ES-module SPA** served from `web/`. No inline scripts or inline event handlers (strict CSP). Three.js is **vendored and pinned** (`web/vendor/three/`, v0.170.0) with SHA-256 recorded in `web/vendor/three/VERSION`. Addons are rewritten to import `./three.module.js` (no import map). | Strict CSP `script-src 'self'`; offline; reproducible. |
| ADR-005 | **3D body is procedural** (built in code from parametric primitives) — no third-party mesh whose license we cannot prove. The viewer accepts an optional licensed GLB later (`web/assets/models/body.glb`), normalized to the same frame, and re-snaps points by raycast. | IP cleanliness; the PDF renders are © GOIZ and are **not** to be extracted or reused. |
| ADR-006 | **Reports are rendered by the browser into a print-perfect HTML page** (`@page` letter, running header/footer) and saved as PDF through the native print dialog. Server stores an immutable JSON snapshot + SHA-256 for every finalized report. | Zero-dependency PDF path that works offline on every OS. Server-side PDF (headless Chromium) is a SaaS roadmap item. |
| ADR-007 | **Catalog provenance**: every catalog record carries `source` `{doc, page}` and the source table carries `license_status` (`internal-use` \| `licensed` \| `public-domain` \| `original`). SaaS builds can filter to `licensed`/`original`/`public-domain` only. | The Goiz guides are marked "GOIZ ™ Intellectual Property — All Rights Reserved". Internal testing is fine; commercial distribution requires a license from the rights holder. |

---

## 2. Repository layout (ownership in brackets)

```
platform/
  package.json                  [backend]  "type":"module", engines node>=22.13, NO dependencies
  server/                       [backend]
    index.js                    bootstrap (http/https, graceful shutdown)
    lib/                        config, db, crypto, totp, auth, rbac, csrf, audit, validate, ratelimit, router, http, log
    db/migrations/NNN_*.sql     forward-only migrations
    catalog/load.js             loads data/catalog/*.json into catalog tables (idempotent, hash-versioned)
    routes/*.js                 one module per resource
  importer/                     [data]     PDF -> JSON pipeline (build-time only; needs poppler `pdftotext`)
  data/
    sources/                    (gitignored) the licensed PDFs
    catalog/                    [data + anatomy]  generated, committed JSON (formats in §4)
    keys/  db/  backups/        (gitignored) runtime
  web/                          [frontend + anatomy]
    index.html  css/  locales/{en,es}.json  js/app.js js/api.js js/i18n.js js/router.js js/views/*.js
    js/viewer3d/                [anatomy]  body-model.js, viewer.js, regions.js
    vendor/three/               [anatomy]  pinned three.js + OrbitControls
  deploy/                       [devops]   Dockerfile, compose, install.sh, install.ps1, systemd unit, backup/restore
  docs/                         [architect] this file, ADRs, security controls matrix, ops runbook, user guide
  tests/                        [all]      node:test suites, Playwright smoke (optional)
```

---

## 3. Domain model (what practitioners actually do)

From the source guides (Goiz Level 1 = pairs 1–210, Level 2 = pairs 211–325, Leal compendium = A–Z of
pathogens / named pairs / conditions):

- **Point** (punto anatómico): an anatomical location, e.g. *Timo* (Thymus), *Riñón* (Kidney). Has laterality.
- **Biomagnetic Pair (PB)**: `tracking point` (punto de rastreo, **negative / −** magnet) + `impact point`
  (punto de impacto, **positive / +** magnet). Numbered 1–325. Has a category, F/P/R ratings
  (Frequency / Pathogenicity / Resolution, 1–3 ✓), related pathogens/conditions with ordinal
  (e.g. "VIH (1) – E. Coli (1)"), symptoms grouped by system, recommendations.
- **Categories:** regular → `virus`, `bacteria`, `fungus`, `parasite`; special → `dysfunctional`,
  `psychoemotional`, `reservoir`, `complex`; compendium also uses `prion`, `special`, `temporary`, `glandular-dysfunction`.
- **Entity** (relation): a pathogen, condition or *named pair* (e.g. "Abraham", "David") from relations and the compendium.
- **Protocol:** an ordered list of pairs (or of other protocols): Basic protocols, **Top 10** / **Top 5** lists,
  **disease protocols** (Level 2 "Protocolos por Enfermedad": disease → list of Top lists + specific pairs),
  and illustrated application protocols like *"19. Circulación de Piernas"* (see `docs/reference-protocol-card-circulacion-piernas.jpg`).
- **Scan session (rastreo):** for a patient, methodology (`biomagnetism` | `bioenergetics` | `telebioenergetics`),
  the practitioner scans (guided by protocol or free/head-to-toe), records **findings** (pair found in resonance)
  with sides, qualifiers, phenomena (infiltrate, exudate, cyst, abscess, neoplasia), magnet dwell time, notes;
  then finalizes → **report**. Guides recommend a **follow-up scan after 1 week** (reservoir release).
- **Intake / consent (Hoja de Registro):** demographics, explanation of technique, scope questions, signed
  authorization; **contraindication screening** (relative + absolute lists from the guides).

Polarity convention (from the source figures, configurable per org): **negative (−) = blue `#2563EB` on the
tracking point; positive (+) = red `#DC2626` on the impact point.** Never convey polarity by color alone —
always also render "−"/"+" glyphs.

---

## 4. Catalog JSON formats (`platform/data/catalog/`)

All ids are **slugs**: lowercase ASCII, accents stripped, non-alphanumerics → `-`, collapsed, trimmed.
`slug("Trocánter Menor (D)") === "trocanter-menor"` (sides are NOT part of a point id).
Reference implementation (both data and anatomy workstreams MUST use exactly this):

```js
export const slug = s => s.normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase()
  .replace(/\(.*?\)/g,' ').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
```

Localized text is always an object `{ "es": "...", "en": "..." }`; `en` may be absent for prose not yet
translated (UI falls back to `es` and shows a small "ES" badge). Point names, categories, systems, protocol
names and UI-facing labels MUST have `en`.

### 4.1 `sources.json`
```json
[{ "id":"goiz-n1", "title":"Guía de Pares Biomagnéticos — 1er Nivel (2017)", "author":"David Goiz Martínez / BRI",
   "license_status":"internal-use", "notice":"GOIZ ™ Intellectual Property © All rights reserved" }]
```
ids: `goiz-n1`, `goiz-n2`, `leal-2018`, `youheal` (original content).

### 4.2 `points.json`  [data]
```json
[{ "id":"timo", "name":{"es":"Timo","en":"Thymus"}, "aliases":["Timo"],
   "laterality":"central" }]          // "central" | "bilateral"
```
### 4.3 `point-anatomy.json`  [anatomy]
```json
{ "timo": { "region":"thorax", "view":"anterior", "pos":{"x":0,"y":1.33,"z":0.10} } }
```
Frame: meters, feet at `y=0`, vertex ≈ `y=1.75`; body faces **+z**; **+x = patient's LEFT**
(viewer's right when looking at the front). For `bilateral` points `pos` is the **patient-RIGHT** instance
(`x<0`); the left instance is mirrored. `view` ∈ `anterior|posterior|lateral|superior|inferior|internal`
is the raycast direction used to snap onto the mesh surface. `region` ∈ ids in `regions.json`.

### 4.4 `regions.json`  [anatomy]
`[{ "id":"head", "name":{"es":"Cabeza","en":"Head"}, "parent":null }, ...]` — clickable body regions:
head, face, neck, thorax, abdomen, pelvis, upper-back, lower-back, arm-r/l (shared id `arm`), forearm, hand,
thigh, knee, leg, foot, plus internal groupings if useful.

### 4.5 `entities.json`  [data]
```json
[{ "id":"vih", "name":{"es":"VIH","en":"HIV"}, "kind":"pathogen", "classification":"virus",
   "contagion":{"es":"..."}, "description":{"es":"..."},
   "polePairs":[{"neg":"timo","pos":"recto","pairId":"pb-001"}],
   "protocols":["top10-inmunologico-inmunodeficiencia"],
   "source":{"doc":"leal-2018","page":456} }]
```
`kind` ∈ `pathogen|condition|named-pair`. `classification` ∈ categories in §3.

### 4.6 `pairs.json`  [data]
```json
[{ "id":"pb-001", "number":1, "level":1,
   "name":{"es":"Timo – Recto","en":"Thymus – Rectum"},
   "tracking":{"point":"timo","side":"C","qualifiers":[]},
   "impact":{"point":"recto","side":"C","qualifiers":[]},
   "category":"virus",
   "relations":[{"entity":"vih","ordinal":1},{"entity":"e-coli","ordinal":1}],
   "ratings":{"F":3,"P":2,"R":1},
   "symptoms":[{"system":"immunological","text":{"es":"Disminución de la respuesta inmunitaria"}}],
   "recommendations":[{"es":"Rastreo dirigido con el imán e impactación profiláctica en: Inmunodeficiencia (SIDA)"}],
   "notes":[{"es":"..."}],
   "source":{"doc":"goiz-n1","page":25} }]
```
`side` ∈ `R` (D), `L` (I), `C` (central/unspecified), `RL` (D/I either or both).
`qualifiers` ⊂ `S` superior, `INF` inferior, `A` anterior, `P` posterior, `LAT` lateral.
Compendium-only pole pairs that do not match a numbered pair get ids `cx-<neg>--<pos>`, `level: 0`.
Systems (symptom groups) ids: `general, respiratory, gastrointestinal, neurological, musculoskeletal, urological,
cardiological, gynecological, endocrine, hematological, dermatological, ophthalmological, auditory,
immunological, psychiatric, oncological, dental, tropical, toxicological`.

### 4.7 `protocols.json`  [data]
```json
[{ "id":"top10-gastrointestinal", "kind":"top10", "name":{"es":"Top 10 Gastrointestinal","en":"Top 10 Gastrointestinal"},
   "items":[{"pair":"pb-045"},{"protocol":"basic-detox"}], "source":{"doc":"goiz-n1","page":107} }]
```
`kind` ∈ `basic|top10|top5|disease|application`.

**Additive fields (v1.1, produced by the importer; consumers must tolerate them):** pairs may carry
`altNames`, `magnets` (multi-point pairs such as pb-282 four-point pancreas: `[{point, sub, polarity}]`),
`samePoints` (other pair ids with identical points), `variants`; ratings may be partial (reservoir pairs
print only F); relations may omit `ordinal`; protocols of kind `application` may carry `number`,
per-item `label`, `dosage` and `notes`. Records that do not come from the source PDFs (e.g. the clinic's
protocol cards) are declared in `importer/supplements.json` under their own `source` id. English
vocabularies for categories/systems/sides/qualifiers live in `manifest.json → vocabularies`.

### 4.8 `symptoms.json`  [data] — canonical symptom vocabulary for search/suggest
`[{ "id":"cefalea", "system":"neurological", "name":{"es":"Cefalea","en":"Headache"}, "pairs":["pb-006","pb-010"] }]`

### 4.9 `contraindications.json`, `recommendations.json`, `glossary.json`  [data]
`[{ "id":"abs-01", "kind":"absolute", "text":{"es":"...","en":"..."}, "source":{...} }]`;
general recommendation sections `{id, title:{}, body:{}}`; abbreviations `{abbr, meaning:{}}`.

### 4.10 `manifest.json`  [data]
`{ "version":"2026.10.0", "generatedAt":"ISO", "counts":{...}, "sha256":{ "pairs.json":"..." } }`

---

## 5. HTTP API (`/api/v1`, JSON, UTF-8)

Conventions: errors `{ "error": { "code":"VALIDATION", "message":"...", "fields":{...} } }`;
list endpoints `{ "items":[...], "total":n }` with `?limit=&offset=`; timestamps ISO-8601 UTC.
State-changing requests (`POST/PATCH/PUT/DELETE`) MUST carry header `X-CSRF-Token` equal to the session's
token (returned by `/auth/me` and `/auth/login`). Auth cookie: `yh_sid` — `HttpOnly; Secure (when TLS); SameSite=Strict; Path=/`.

| Method & path | Role | Body / query → response |
|---|---|---|
| GET `/health` | public | `{status:"ok", version, catalogVersion}` |
| GET `/setup/status` | public | `{needsSetup:boolean}` |
| POST `/setup` | public, only while no users | `{org:{name}, admin:{email,name,password}}` → `{ok:true}` |
| POST `/auth/login` | public | `{email,password,totp?}` → `{user, csrfToken}` or `401 {error:{code:"MFA_REQUIRED"}}` |
| POST `/auth/logout` | any | → `{ok:true}` |
| GET `/auth/me` | any | `{user:{id,email,name,role,locale,mfaEnabled}, org:{...}, csrfToken}` |
| POST `/auth/password` | any | `{current,next}` |
| POST `/auth/mfa/setup` | any | → `{secret, otpauthUrl}` |
| POST `/auth/mfa/enable` | any | `{code}` → `{ok:true, recoveryCodes:[...]}` |
| POST `/auth/mfa/disable` | any | `{password, code}` |
| PATCH `/auth/prefs` | any | `{locale?, theme?}` |
| GET/POST `/users`, PATCH `/users/:id` | admin | `{email,name,role,password?, active?}` |
| GET `/users?minimal=1` | admin, auditor | `{items:[{id,name}], total}` only (audit actor filter) |
| GET/PATCH `/org` | GET any / PATCH admin | clinic profile: `name, legalName, address, phone, email, website, license, reportFooter, polarity:{negative,positive}, defaultLocale, logo` — `logo` is a `data:image/(png\|jpeg\|webp);base64,...` URL ≤ 200 KB, signature-checked, **no SVG**; `null` removes it. GET `/org` always includes `logo` (null if none); `/auth/me` org carries only `hasLogo` |
| GET `/catalog/manifest` | any | manifest |
| GET `/catalog/points` | any | all points merged with anatomy (`id,name,laterality,region,view,pos`) |
| GET `/catalog/regions` | any | regions |
| GET `/catalog/pairs` | any | `?q=&category=&level=&point=&system=&protocol=` → summaries |
| GET `/catalog/pairs/:id` | any | full pair + resolved relations + protocols containing it |
| GET `/catalog/points/:id/pairs` | any | pairs where point is tracking or impact (+ which role) |
| GET `/catalog/entities` / `:id` | any | `?q=&kind=&classification=` |
| GET `/catalog/protocols` / `:id` | any | protocol with items **expanded** to ordered pair list |
| GET `/catalog/symptoms` | any | `?q=&system=` |
| POST `/catalog/suggest` | any | `{symptoms:[ids], text?:string}` → ranked `[{pairId, score, score01, matched:[...]}]` (`score01` = score / top score, 0–1) |
| GET `/catalog/search` | any | `?q=` unified search across points/pairs/entities/protocols/symptoms |
| GET `/catalog/contraindications` `/catalog/recommendations` `/catalog/glossary` | any | |
| GET `/patients` | practitioner+ | `?q=` (blind-index exact last-name / MRN, or first-letter list); items include `sessionCount`, `lastSessionDate` (superseded revisions excluded) |
| POST `/patients` | practitioner, assistant | `{firstName,lastName,dob,sex,phone,email,address,mrn?,notes?}` |
| GET/PATCH `/patients/:id` | practitioner+ | decrypted record |
| POST `/patients/:id/consents` | practitioner, assistant | `{type:"intake", answers:{}, contraindications:{relative:[ids],absolute:[ids]}, signatureName, signedAt}` |
| GET `/patients/:id/sessions` | practitioner+ | summaries incl. `findingsCount`, `startedAt`; `chiefComplaint` (decrypted) for practitioner/admin only |
| GET `/sessions` | practitioner, admin, assistant (auditor: 403) | `?from&to&status&followUpTo&patientId&latest&limit&offset` cross-patient list (dashboard). `from`/`to` = date (inclusive) or ISO timestamp on session start; `status` comma list; `followUpTo` = follow-up date ≤ (sorted by follow-up asc); `latest=1` hides superseded revisions. Item: `id, patientId, patient:{id,mrn,name}, patientName, status, methodology, startedAt, finalizedAt, followUpDate, findingsCount` + `chiefComplaint` (practitioner/admin only). One `session.list` audit row per call (filters, no PHI) |
| POST `/patients/:id/sessions` | practitioner | `{methodology, protocolIds:[], chiefComplaint, symptoms:[ids], vitals?:{}}` |
| GET/PATCH `/sessions/:id` | practitioner+ | session + findings; PATCH (draft only) also accepts `scanState` (object ≤ 64 KB: checklist marks, cursor, active protocol ids, directed-scan text), stored encrypted, returned by GET |
| POST `/sessions/:id/findings` | practitioner | `{pairId? , trackingPoint?, impactPoint?, trackingSide, impactSide, qualifiers?, phenomena:[], dwellMinutes?, status:"found"\|"impacted"\|"cleared", notes?}` |
| PATCH/DELETE `/sessions/:id/findings/:fid` | practitioner | |
| POST `/sessions/:id/finalize` | practitioner | locks session; stores report snapshot + sha256; `{signatureName}` |
| POST `/sessions/:id/amend` | practitioner | `{reason}` → new revision, original kept |
| GET `/sessions/:id/report` | practitioner+ | assembled report JSON (org, patient, practitioner, session, findings with resolved catalog data, recommendations, follow-up date, disclaimer, hash). `org.logo` included. `generalRecommendations` (also `recommendations.general`) = only the general sections relevant to the found pairs (always `general-short`; `parasitic`, `tropical`, `sti`, `stress-management`, `good-eating`, … by pair category/recommendation text/relations), each `{id, title, summary, body, matchedBy}`. Report images PUT before finalize are part of the hashed snapshot |
| PUT `/sessions/:id/report/images` | practitioner | `{front:"data:image/png;base64,...", back:"..."}` (≤ 2 MB each) |
| GET `/audit` | admin, auditor | `?limit=&offset=&actor=&action=` |
| GET `/audit/verify` | admin, auditor | `{ok, checked, brokenAt?}` (hash-chain verification) |
| GET `/admin/backup` | admin | streams an encrypted backup |

Roles: `admin` (clinic owner), `practitioner` (biomagnetist / MD), `assistant` (front desk: patients +
intake, no findings), `auditor` (read-only audit + reports).

---

## 6. Frontend ↔ 3D viewer interface  [anatomy implements, frontend consumes]

```js
import { createBodyViewer } from '/js/viewer3d/viewer.js';
const viewer = await createBodyViewer(containerEl, {
  points,                 // from GET /catalog/points
  regions,                // from GET /catalog/regions
  locale: 'en',
  polarity: { negative:'#2563EB', positive:'#DC2626' },
  sex: 'neutral',         // 'female' | 'male' | 'neutral' (proportions)
  onPointClick:  ({ pointId, side, clientX, clientY }) => {},   // side: 'R'|'L'|'C'
  onRegionClick: ({ regionId, side, clientX, clientY }) => {},
  onHover:       ({ pointId|null, side }) => {},
});
viewer.setView('anterior'|'posterior'|'left'|'right'|'superior');  // animated
viewer.setMagnets([{ id, pointId, side, polarity:'negative'|'positive', label?, state?:'active'|'done' }]);
viewer.setPairs([{ id, a:{pointId,side}, b:{pointId,side}, state:'candidate'|'found'|'impacted'|'cleared' }]);
viewer.highlight(pointIds /* array */, { pulse:true });
viewer.setPointFilter(pointIds | null);   // null = show all points
viewer.setShowAllPoints(boolean);
viewer.focusPoint(pointId, side);
viewer.snapshot({ view:'anterior', width:800, height:1100, transparent:false }) // -> Promise<dataURL>
viewer.resize();  viewer.dispose();
```
Points render as small discs; magnets render as **square tiles split / colored by polarity with − / + glyph**
(matching the reference protocol card). Keyboard: arrow keys orbit, `F`/`B` front/back, `+`/`-` zoom,
Tab cycles visible points (an accessible list mirror lives beside the canvas). Respect `prefers-reduced-motion`.
Must degrade gracefully if WebGL is unavailable (render a 2D front/back SVG with the same API).

---

## 7. Security baseline (maps to NIST SP 800-53 r5 / HIPAA Security Rule; detail in `docs/SECURITY.md`)

- Passwords: `crypto.scrypt` (N=2^15, r=8, p=1, 32-byte salt), min 12 chars, breached-pattern basics. (IA-5)
- MFA: TOTP RFC 6238 (SHA-1, 30 s, 6 digits, ±1 step), 10 single-use recovery codes (hashed). Admins MUST enroll. (IA-2(1))
- Sessions: 256-bit random token, stored **hashed** (SHA-256); idle timeout 15 min, absolute 12 h; rotate on login. (AC-11, AC-12, SC-23)
- Lockout: 5 failed attempts / 15 min per account + per-IP token bucket. (AC-7)
- CSRF: per-session token header + `SameSite=Strict`. Origin/Referer check on mutations.
- Headers: CSP `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`, HSTS (TLS), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy` minimal, `Cross-Origin-Opener-Policy: same-origin`. (SC-8, SI-10)
- Audit: append-only table, each row `hash = SHA256(prev_hash || canonical_json(row))`; every auth event, PHI read, create/update/delete, export, finalize. DB triggers forbid UPDATE/DELETE on audit rows. (AU-2, AU-3, AU-9, AU-10)
- PHI encrypted at rest (ADR-003), TLS in transit (installer generates a self-signed cert if none supplied), encrypted backups (AES-256-GCM, key = master key). (SC-8, SC-28, CP-9)
- Input validation on every route (schema validator in `lib/validate.js`), body size limit 1 MB (4 MB for report images), JSON only.
- Least privilege: service runs as dedicated non-root user; container read-only root FS; data dir 0700.
- Logs never contain PHI, tokens or passwords.

---

## 8. Report ("clinical report", lab-report layout — own branding, never another company's)

Letter size, print CSS. Sections: header (clinic logo/name/address/phone, report title
"Biomagnetic Pair Scan Report", Report ID, status FINAL/AMENDED) · patient block (name, DOB, age, sex,
MRN) · session block (date/time, methodology, practitioner, protocols run) · **Results table**
(# · Pair · Tracking point (−) · Impact point (+) · Related to · Category · F/P/R · Status · Dwell) grouped by
category · body maps (anterior + posterior snapshots with magnets) · symptoms reported · recommendations
(pair-specific + general) · follow-up (default +7 days) · practitioner signature/attestation · footer with
page X of Y, report hash (first 16 hex), printed timestamp, and the scope disclaimer:

> "Biomagnetic Pair findings are complementary, non-diagnostic observations. They do not identify disease
> and do not replace evaluation, diagnosis or treatment by a licensed physician. Continue all medical
> indications."

(The guides themselves instruct practitioners to use the word *relation*, not diagnosis — the UI and report
must say "related to", never "diagnosed with".)
