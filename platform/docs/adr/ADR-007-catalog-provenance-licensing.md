# ADR-007 — Catalog provenance and licence status on every record

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10 |
| **Controls** | SR-4 (provenance), CM-10 (software/content usage restrictions), PM-9 (risk management strategy), AU-10 |

## Context

The reference catalog (points, Biomagnetic Pairs, entities, protocols, symptoms) is extracted from:
* Goiz, *Guía de Pares Biomagnéticos* 1er and 2do Nivel (2017) — every page footer reads
  "GOIZ TM INTELLECTUAL PROPERTY © COPYRIGHT ALL RIGHTS RESERVED";
* Leal (comp.), *Biomagnetismo Médico — Padecimientos & Patógenos* (2018) — a compilation "based on the
  teachings of Dr. Isaac Goiz Durán", page footers citing biomagnetismolibre.wordpress.com; redistribution
  rights are not established.

Using this material internally (testing, a licensed practitioner's own reference) differs from
**distributing** it commercially in a product or SaaS. See REGULATORY.md §5.

## Decision

* Every catalog record carries `source: {doc, page}`.
* `sources.json` records each source with `license_status` ∈ `internal-use | licensed | public-domain |
  original` and its notice text.
* The server can **filter the loaded catalog by licence** (`YH_CATALOG_LICENSES`, e.g.
  `licensed,original,public-domain`), so a SaaS or distributable build excludes `internal-use` content
  without code changes.
* The offline bundle builders (`deploy/offline/build-bundle.*`) **refuse to build** when the catalog
  contains `internal-use` sources unless `--allow-internal-use` / `-AllowInternalUse` is given, and then
  print that the bundle must not leave the licensed organisation.
* The PDF renders themselves are never extracted (ADR-005); source PDFs are gitignored and excluded from
  images and bundles (`.dockerignore`, installer excludes).

## Consequences

Licence status becomes a data property that can be audited, filtered and reported; switching a source
from `internal-use` to `licensed` after a licence is signed is a one-line data change plus reload.
Content without a clear licence remains usable for internal evaluation only.

## Alternatives considered

Manually maintained separate "commercial" catalog (drift, error-prone); ignoring provenance until launch
(unquantifiable legal exposure, rework of every record later).
