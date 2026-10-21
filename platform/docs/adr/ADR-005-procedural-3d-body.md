# ADR-005 — Procedural 3D body model; optional licensed GLB later

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10 |
| **Controls** | SR-4 (provenance), CM-10 (software usage restrictions) |

## Context

Practitioners place magnets on anatomical points; a 3D body map is central to the UX and to the report.
The source guides contain anatomical renders that are © GOIZ ("All Rights Reserved") and may not be
extracted or reused. Free anatomy meshes on the web frequently have unclear or non-commercial licences,
and anatomical scan data can carry its own consent/licensing questions.

## Decision

* The body is **generated procedurally in code** from parametric primitives (`web/js/viewer3d/body-model.js`).
  No third-party mesh is shipped unless its licence is proven.
* Point coordinates (`data/catalog/point-anatomy.json`) are authored independently in a documented frame
  (metres, feet at y=0, +z = facing, +x = patient's left) — not traced from the copyrighted renders.
* The viewer can later load an **optional licensed GLB** (`web/assets/models/body.glb`), normalized to the
  same frame, re-snapping points by raycast along each point's `view` direction.
* WebGL unavailable → 2D SVG front/back fallback with the same API (accessibility and robustness).

## Consequences

Clean IP position for commercial distribution of the viewer; lower anatomical realism than a scanned
mesh (acceptable for point localisation); a licensed model can be dropped in without code changes to
consumers.

## Alternatives considered

Tracing/extracting the GOIZ renders (copyright infringement — rejected); CC-BY-NC meshes (blocks
commercial SaaS); commercial anatomy SDKs (cost, licence terms for redistribution, often online-only).
