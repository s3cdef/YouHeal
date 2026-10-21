# Body model assets — provenance

| | |
|---|---|
| Source project | MakeHuman — https://github.com/makehumancommunity/makehuman |
| Upstream commit (pinned) | `a8bc2d54ff0ac92e78ff71431b1023eda42bf482` |
| Licence of the assets | **CC0 1.0 Universal** — MakeHuman `LICENSE.md` §C ("The base mesh and proxies, Targets and modifiers, Textures … have been released under CC0 1.0 Universal"); full legal text in [`LICENSE.ASSETS.md`](LICENSE.ASSETS.md) (verbatim copy of upstream `LICENSE.ASSETS.md`). |
| Converter | `tools/3d/build-body.mjs` (Node ≥ 22, zero dependencies) |
| Generated | 2026-10-21 |

CC0 requires no attribution; we credit MakeHuman anyway. Copyright holders at the time of the CC0 release (per
the file headers): Data Collection AB, Joel Palmius, Jonas Hauquier.

## Upstream files (raw.githubusercontent.com/makehumancommunity/makehuman/<commit>/…) and SHA-256

| File | SHA-256 |
|---|---|
| `LICENSE.md` | `edd99571ca62698f78c943fd4fffb159a413c315fa0d4819d3cec5cadaf8b4f1` |
| `LICENSE.ASSETS.md` | `f6089cba01cb570a24712b41ab8a586ccd3cc5ef53dc266ca50b95c288956d2c` |
| `makehuman/data/3dobjs/base.obj` | `8e761e6624b8f54536409135d1636da63b32486a90d4897f84e121d144f6fb4c` |
| `makehuman/data/targets/macrodetails/african-female-young.target` | `92d61eeb3c164b421fd5a7c3537ee45e7e1a51de4d49bf312e19c3df2be1d8fc` |
| `makehuman/data/targets/macrodetails/african-male-young.target` | `894abc1fbb3d28543a51fef16f89d5d4bdf9aa2e1534413339811a3d47818b7d` |
| `makehuman/data/targets/macrodetails/asian-female-young.target` | `095fe79694fa19e1fe98d93009ec116199bd524e081c640351a10eccf2cca1eb` |
| `makehuman/data/targets/macrodetails/asian-male-young.target` | `ed2e8c191cb6b87b4a2d97c80486acb2604fa549316c7aa2a738a5d5a14334dc` |
| `makehuman/data/targets/macrodetails/caucasian-female-young.target` | `118379f6e8ba9266247fdb8788a20e1df40a239f97ced0b9905bcbcc74f6e820` |
| `makehuman/data/targets/macrodetails/caucasian-male-young.target` | `70e228ba7164737dae664454394536fc5935fa48d333c1a97d77e2dc6eacc5f5` |
| `makehuman/data/targets/macrodetails/proportions/female-young-averagemuscle-averageweight-idealproportions.target` | `0a3bd099b7a88150d56d68b69c07d3d3538cb57279e0e775d13f19d3dc3e339d` |
| `makehuman/data/targets/macrodetails/proportions/male-young-averagemuscle-averageweight-idealproportions.target` | `7bbd790604c908417ff8ca11e566e3577508d92a4f397a2ace0f89f4cc3aa373` |

## Transformations applied

1. Parse `base.obj` (hm08); keep group `body` (skin) and `helper-l-eye` / `helper-r-eye` (eyeballs, separate
   draw group). **Dropped:** all `joint-*` groups (used only to compute skeleton landmarks), `helper-tights`,
   `helper-skirt`, `helper-hair`, `helper-genital`, teeth, tongue, eyelashes. The base mesh is genital-neutral.
2. Apply macro targets (linear morph): race mix African/Asian/Caucasian ⅓ each, age "young" (adult), average
   muscle and weight; gender: neutral = 0.5 female + 0.5 male (+ 0.25 of each "ideal proportions" target),
   female = 1.0 female (+ 0.5 ideal proportions), male = 1.0 male (+ 0.5 ideal proportions).
3. One Catmull-Clark subdivision step per group (quads → 4 quads), then triangulation.
4. Normalise to the CONTRACT §4.3 frame: metres; feet at y = 0; vertex height 1.75 m (uniform scale); x/z
   origin at MakeHuman's `joint-ground`; the mesh already faces +z with its "l-" side at +x = patient's LEFT.
5. Skeleton landmarks (centroids of the deformed `joint-*` helper geometry) stored in `body.json`.
6. Quantisation: positions → Int16 normalised to each preset's bounding box (step ≈ 0.03 mm). Normals are
   recomputed at load time (area-weighted smooth normals).

## Files

| File | Content |
|---|---|
| `body.json` | header: format `yh-body-v1`, source/commit/hashes, groups, per-preset bbox + skeleton + target weights |
| `body-index.bin` | Uint16 triangle indices shared by all presets (skin group first, then eyes) |
| `body-neutral.bin`, `body-female.bin`, `body-male.bin` | Int16 quantised positions per preset |
| `LICENSE.ASSETS.md` | CC0 1.0 legal text (verbatim from upstream) |

Regenerate: `node tools/3d/build-body.mjs` (downloads into a temp cache outside the repo and verifies every
SHA-256 before converting).
