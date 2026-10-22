# YOU HEAL Clinical — Visual Previews

Captured from the running platform against the **real backend and the full catalog** (325 numbered pairs,
530 compendium pairs, 221 protocols). All patient data is fictitious ("Jane Sample", "Dr. Alex Demo").
The body is the anatomically accurate **MakeHuman** base mesh (CC0 1.0 public domain — see
`web/assets/models/PROVENANCE.md`) rendered with three.js; no copyrighted artwork. Polarity follows the source guides: **negative (−, blue)** on the
tracking point, **positive (+, red)** on the impact point.

## Scan workspace — the heart of the product

Protocol runner (left) · 3D body map (center) · session findings (right).

![Scan workspace](ui/06-scan-workspace.jpg)

Click any point on the body → every pair that uses it, with F/P/R ratings, "related to" entities, symptoms by
system, recommendations and source citation:

![Point drawer](ui/07-point-drawer.jpg)

| Symptom-directed scan → ranked pair suggestions | Reference catalog — pair detail |
|---|---|
| ![Directed scan](ui/08-directed-scan-suggest.jpg) | ![Catalog pair](ui/09-catalog-pair.jpg) |

## Protocol card — clinic card "19. Circulación de Piernas", rebuilt as a live printable protocol

![Protocol card](ui/10-protocol-card.jpg)

## Clinical report — Letter size, print / Save as PDF, SHA-256 integrity seal

| Report, page 1 | Print layout |
|---|---|
| ![Report page 1](ui/11-report-page1.jpg) | ![Report print](ui/12-report-print.jpg) |

📄 **[Sample report (PDF)](ui/sample-report.pdf)**

## Español — full Spanish UI and catalog (mirrored language packs)

| Scan workspace (ES) | Point drawer (ES) | Report signed in Spanish |
|---|---|---|
| ![ES scan](ui/19-es-scan-workspace.jpg) | ![ES drawer](ui/20-es-point-drawer.jpg) | ![ES report](ui/21-es-report.jpg) |

| Settings → Language packs (coverage, review, edit) | Signed report viewed in another language |
|---|---|
| ![Language packs](ui/22-language-packs-admin.jpg) | ![Translation notice](ui/23-report-translation-notice.jpg) |

📄 **[Sample report in Spanish (PDF)](ui/sample-report-es.pdf)**

## Patients, intake & consent

| Dashboard | Patient chart |
|---|---|
| ![Dashboard](ui/03-dashboard.jpg) | ![Patient chart](ui/04-patient-chart.jpg) |

| Intake & consent (Hoja de Registro + contraindication screening) | Settings & tamper-evident audit log |
|---|---|
| ![Intake](ui/05-intake-consent.jpg) | ![Settings audit](ui/13-settings-audit.jpg) |

## Scan state & account security

| Reloaded scan — checklist restored | Recovery-code regeneration (demo codes) |
|---|---|
| ![Scan restored](ui/17-scan-state-restored.jpg) | ![Recovery codes](ui/18-recovery-codes-regenerate.jpg) |

## Security onboarding

| First-run setup | Sign-in with TOTP multi-factor |
|---|---|
| ![Setup](ui/01-setup.jpg) | ![Login MFA](ui/02-login-mfa.jpg) |

## Tablet · dark mode · Spanish

| Tablet 1024 px | Dark mode | Español |
|---|---|---|
| ![Tablet](ui/14-tablet-1024.jpg) | ![Dark](ui/15-dark-mode.jpg) | ![Spanish](ui/16-spanish.jpg) |

## 3D body map

| Anterior | Posterior | Lateral |
|---|---|---|
| ![Anterior](3d/01-body-anterior.jpg) | ![Posterior](3d/02-body-posterior.jpg) | ![Lateral](3d/03-body-lateral.jpg) |

| Protocol 19 magnets (posterior) | All 287 catalog points on the skin | Magnet tiles + field-line arcs |
|---|---|---|
| ![Protocol 19](3d/04-protocol-circulacion-piernas-posterior.jpg) | ![All points](3d/05-points-all.jpg) | ![Legs](3d/07-legs-posterior-magnets.jpg) |

| Hand close-up (fingers, nails) with points | Face close-up | Female · Neutral · Male presets |
|---|---|---|
| ![Hand](3d/10-hand-closeup.jpg) | ![Face](3d/11-face-closeup.jpg) | ![Presets](3d/12-female-male-neutral.jpg) |

| Female proportion variant | Cranial / facial points | 2D fallback (no WebGL) |
|---|---|---|
| ![Female](3d/08-female-variant.jpg) | ![Face](3d/09-face-points.jpg) | ![2D fallback](3d/06-fallback-2d.jpg) |
