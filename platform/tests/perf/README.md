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
