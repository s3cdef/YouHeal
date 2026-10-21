# Performance benchmarks

Reproducible measurements used for the optimization pass (CONTRACT-independent, read-only against a running server).

```sh
# fresh server with the real catalog (raise API rate limits for load seeding only)
YH_DATA_DIR=<tmp> YH_CATALOG_DIR=data/catalog YH_PORT=18621 YH_DEV_INSECURE_NO_MFA=1 \
  YH_RATE_API_BURST=100000 YH_RATE_API_PER_MIN=1000000 npm start
node tests/perf/api.mjs <tmp>        # first-run setup + catalog/API latency & payload table
node tests/perf/load.mjs 1000         # seed 1,000 patients / 3,000 sessions / ~10k findings; list/search/audit timings
node tests/perf/browser.mjs           # Chromium: login, scan workspace cold + warm (requests, bytes, largest)
```
`BASE_URL` overrides the target. Never run against a server holding real PHI.

## Baseline (2026-10-21, before optimization)

| Metric | Value |
|---|---|
| Cold start → healthy (first catalog load) | 2,820 ms |
| HTTP compression | none |
| three.module.js on the wire | 1,285 KB |
| Scan workspace, first visit | 1,365 ms · 36 requests · 3,397 KB |
| Scan workspace, warm reload | 5,860 ms · 57 requests · 786 KB |
| GET /catalog/pairs (all) | 481 KB · p50 6.7 ms |
| POST /catalog/suggest | p50 15.4 ms |
| Lists at 1,000 patients / 3,000 sessions / 10.5k findings | 4–22 ms p50 |
| GET /audit/verify (~19k rows) | 320 ms (linear) |
| Server RSS | 141–162 MB |

## After optimization (2026-10-21, same harness, independent re-measurement)

| Metric | Before | After | Change |
|---|---|---|---|
| Cold start → healthy (first catalog load) | 2,820 ms | 832 ms | −70% |
| Warm restart → healthy | ~280–430 ms | 202 ms | −40% |
| HTTP compression | none | Brotli/gzip (static + public reference data only — BREACH-safe) | |
| three.js on the wire | 1,285 KB | 137 KB (min build + Brotli) | −89% |
| Body model (index + preset) on the wire | 953 KB | 528 KB | −45% |
| Scan workspace, first visit: bytes · requests | 3,397 KB · 36 | 1,021 KB · 34 | −70% bytes |
| Scan workspace, warm reload: 3D ready | 5,860 ms* | 1,197 ms | −80% |
| Scan workspace, warm reload: bytes · 304s | 786 KB · 0 | 10 KB · 6 | −99% bytes |
| 3D view settled · main-thread blocking (3D harness) | 5.1 s · 4.6 s | 1.6 s · 1.1 s | |
| `/catalog/pairs` on the wire | 481 KB† | ~31 KB (Brotli); 304 on repeat | −94% |
| POST /catalog/suggest p50 | 15.4 ms | 4.3 ms | −72% |
| Follow-up list p50 (1k patients / 3k sessions) | 21.6 ms | 5.2 ms | −76% |
| GET /audit/verify (~19k rows), default | 320 ms (linear) | 5.3 ms (incremental; `?full=1` ≈ 250 ms) | −98% |
| Server RSS after restart | 141 MB | 73 MB (grows to ~180 MB with capped caches under load) | |

\* The baseline warm figure combined a measurement artefact (different end condition than cold) with real waste
(per-finding detail requests, uncompressed/uncached catalog re-download). † measured by the browser incl. headers.
Bilingual end-to-end walkthrough after the changes: green, zero console/CSP/server errors, zero PHI in logs.
