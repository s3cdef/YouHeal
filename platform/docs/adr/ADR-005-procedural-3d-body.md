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

## Revision 2026-10-21: primary body = MakeHuman CC0 mesh; procedural SDF retained as fallback

**Status:** Accepted (amends the Decision above; owner request "make the 3D model more human accurate").

**Decision.**
* The **primary body** is the **MakeHuman base mesh (hm08) with macro targets**, which the MakeHuman project
  released under **CC0 1.0** (`LICENSE.md` §C: base mesh, proxies, targets and textures; full text in
  `web/assets/models/LICENSE.ASSETS.md`). The upstream commit is pinned
  (`makehumancommunity/makehuman@a8bc2d54ff0ac92e78ff71431b1023eda42bf482`) and every input file's SHA-256 is
  recorded and verified by the zero-dependency build-time converter `tools/3d/build-body.mjs`.
* The converter keeps only the `body` skin group (plus the eyeballs as a separate small group), drops all
  joint/proxy/helper geometry (tights, skirt, hair, genital helper, teeth, tongue, eyelashes), applies the
  macro targets for three adult presets (**neutral, female, male**, average muscle/weight, race mix ⅓ each),
  applies one Catmull-Clark subdivision step, normalises to the CONTRACT §4.3 frame (feet y=0, vertex 1.75 m,
  faces +z, +x = patient's left) and writes compact binaries (`web/assets/models/body-*.bin`, Int16 positions,
  shared Uint16 index; ≈1.6 MB total). Provenance: `web/assets/models/PROVENANCE.md`.
* The viewer fetches and decodes the asset in a module Worker (CSP-safe, cached per preset) and uses its own
  mesh query (uniform grid ray casts) for point snapping and picking. The **procedural SDF mannequin**
  (`web/js/viewer3d/body-sdf.js`) is kept as the **automatic fallback** when the asset cannot be loaded, and
  the 2D SVG fallback now derives its silhouettes from the same MakeHuman mesh, so 2D matches 3D.
* `data/catalog/point-anatomy.json` is re-authored against the neutral MakeHuman skin (limb points relative
  to the MakeHuman skeleton joints; trunk/head points mapped through matched anatomical landmarks) and is
  tested to lie on the skin (≤ 2 mm) and re-snap correctly for all three presets.

**Rationale.** The MakeHuman mesh is anatomically realistic (articulated hands and feet, real facial
features, natural musculature and bony landmarks such as clavicles, sternum, scapulae, iliac crest,
popliteal fossa and malleoli), which makes point localisation visibly more precise and the product more
credible to clinicians, while CC0 keeps the IP position as clean as the procedural body: no attribution or
share-alike obligations, commercial redistribution allowed, provenance pinned by commit and hash. The base
mesh is genital-neutral and is kept that way (modest, medical-atlas presentation). Keeping the SDF body as
fallback preserves offline robustness if the binary assets are missing or corrupted.

**Consequences.** +1.6 MB of static assets (gzip-friendly); a build-time network fetch of upstream files
(only when regenerating assets); the MakeHuman rest pose (arms ~45° abducted, palms facing the thighs) is
used as-is: posterior/lateral points remain reachable without re-posing.
