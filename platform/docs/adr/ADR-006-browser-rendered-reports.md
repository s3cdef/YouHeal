# ADR-006 — Reports rendered by the browser (print CSS → PDF); immutable server-side snapshot + SHA-256

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10 |
| **Controls** | AU-10 (non-repudiation), SI-7 (integrity), AU-3, CM-7 |

## Context

Practitioners hand patients a printed/PDF "Biomagnetic Pair Scan Report". Server-side PDF generation
usually means headless Chromium or a native PDF library — hundreds of MB, frequent security patches,
and native builds — conflicting with ADR-001 and offline installs.

## Decision

* The report is a **print-perfect HTML page** (`@page` Letter, running header/footer, page X of Y)
  produced by the SPA and saved as PDF through the browser's **native print dialog**.
* On **finalize**, the server stores an **immutable JSON snapshot** of the assembled report plus its
  **SHA-256**; the first 16 hex characters print in the footer. Corrections use **amend** (new revision,
  original kept, reason recorded); finalize and amend are audit events (hash-chained).
* Every report carries the fixed scope disclaimer (CONTRACT §8) and uses "related to", never "diagnosed".

## Consequences

**Positive**: no PDF engine in the trust boundary; works offline on every OS; integrity of what was
finalized is provable (hash in footer ↔ stored snapshot ↔ audit row).

**Negative**: PDF fidelity depends on the browser's print engine (tested in current Chromium/Firefox/
Safari); the server cannot email a PDF on its own. Server-side PDF (isolated headless-Chromium service)
is on the SaaS roadmap (ARCHITECTURE.md §7).

## Alternatives considered

Headless Chromium on-prem (size, patch cadence, sandboxing on Windows); PDFKit/pdf-lib (npm
dependencies, manual layout); wkhtmltopdf (unmaintained, old WebKit).
