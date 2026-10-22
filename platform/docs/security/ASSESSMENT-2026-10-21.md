# Independent Security Assessment — Record of Findings and Closure

| | |
|---|---|
| **System** | YOU HEAL Clinical (server, SPA, deployment tooling) |
| **Assessment window** | 2026-10-21 — initial assessment, re-test (round 3), final re-test (round 4), architect closure |
| **Assessor** | Independent assessor (separation of duties: did not author the code under test) |
| **Method** | White-box code review + live black-box exploitation against isolated instances (fresh data dirs, own ports), fixture and production catalogs; every CONFIRMED finding reproduced with a proof-of-concept |
| **Final head assessed** | `6a3208b` (round 4) + architect closure commit (this record) |
| **Result** | **No open finding above Low.** 22 closed (verified fixed), 4 risk-accepted with rationale, 1 residual dependent on operator action |

Status vocabulary: **VERIFIED-FIXED** — assessor reproduced the original PoC and it now fails safely;
**CLOSED (architect)** — Info item fixed after the final re-test with a regression test, pending next periodic
assessment; **ACCEPTED** — risk accepted with rationale (POA&M item for SaaS); **RESIDUAL** — mitigated,
remaining exposure depends on an operator action that is documented.

## 1. Findings register

| ID | Sev. | Finding | Remediation | Final status |
|---|---|---|---|---|
| F-01 | **High** | Account lockout bypassed by concurrent login attempts (stale counter after `await`); enabled online TOTP guessing | Atomic `UPDATE … RETURNING` counter, fresh re-read after password check, per-account in-flight bucket, IPv6 /64 buckets | VERIFIED-FIXED — 100 concurrent wrong passwords → 5 evaluated; correct password then 423 |
| F-02 | Medium | TOTP replay and recovery-code reuse / resurrection under concurrency | Guarded step claim (exactly one row); `user_recovery_codes` table consumed atomically | VERIFIED-FIXED |
| F-03 | Medium | Root deploy scripts followed symlinks planted in the service-owned data dir (service account → root) | All data-dir operations run as the service account; symlink / reparse-point refusal; restore input must be root-controlled or read as service account | VERIFIED-FIXED |
| F-04 | Medium | First-run setup reachable through a same-host proxy (trailing-slash bypass) | Prefix block at proxy; proxy headers refused; one-time setup token (file, 0600, never logged in production) | VERIFIED-FIXED |
| F-05 | Low | No Host validation (DNS rebinding against unconfigured loopback instance) | Host allow-list → 421; numeric/trailing-dot/IPv4-mapped variants rejected | VERIFIED-FIXED |
| F-06 | Low | Last-admin check racy → zero admins | In-transaction recount + DB trigger | VERIFIED-FIXED |
| F-07 | Low | Report signature name not bound to signer | Signature = signer account; password step-up at finalize | VERIFIED-FIXED |
| F-08 | Low | PHI (last name, DOB, MRN) in query strings / proxy logs / history | `POST /patients/search`; `GET` with PHI params → 410; proxies log path only; SPA never puts terms in URL | VERIFIED-FIXED |
| F-09 | Low | Spoofable `X-Forwarded-For` defeated rate limits and audit IPs | Forwarded headers honoured only from `YH_TRUSTED_PROXIES`; installer forces loopback bind behind proxy | VERIFIED-FIXED |
| F-10 | Low | Recovery codes hashed with unkeyed SHA-256 | HMAC with dedicated subkey + key id; legacy codes flagged and user prompted to regenerate | VERIFIED-FIXED for regenerated codes; **RESIDUAL** until each legacy user regenerates (UI banner) |
| F-11 | Low (High for SaaS) | Cross-tenant leaks (org-less audit rows, global verify count, email-existence oracle) | Tenant-scoped audit views and verify counts | Audit leaks VERIFIED-FIXED; email oracle **ACCEPTED** for single-tenant on-prem — per-tenant identity namespaces are a SaaS prerequisite |
| F-12 | Info | Auditor role could read draft and final PHI reports | Drafts → 403; final-report reads audited (`report.read.auditor`) | **ACCEPTED** — auditors require final-report access by role definition |
| F-13 | Info | JSON depth check crashed (500) on large arrays | Iterative shape limits | VERIFIED-FIXED |
| F-14 | Info | MFA disable kept other sessions | Sessions revoked | VERIFIED-FIXED |
| F-15 | Info | Backup decompressed before tag verification | Two-pass authenticate-then-decrypt with output cap | VERIFIED-FIXED |
| F-16 | Info | Restore not audited; audit chain roll-back undetectable | Restore audited; HMAC-signed external anchor log; export point recorded in DB **and bound into the anchor MAC** (architect closure) | Within-host tampering detected (delete / truncate / roll back DB / clear export point); **RESIDUAL**: simultaneous roll-back of DB *and* anchor log by a host-level attacker requires off-host shipping (`backup.sh --anchor-ship`, documented) |
| F-17 | Info | Session cookie lacked `__Host-` prefix | `__Host-yh_sid` over TLS; duplicates rejected | VERIFIED-FIXED |
| F-18 | Info | Safety snapshots bundled the master key | DB-only snapshots, 0600, removed on success | VERIFIED-FIXED |
| F-19 | Info | Unknown-account lockouts in memory only | Persisted, keyed by HMAC(email) | VERIFIED-FIXED |
| F-20 / NEW-1 | Medium (regression) | Connection caps made idle-socket DoS cheaper; sockets never reaped | First-byte deadline, request/keep-alive timeouts, 503 + Retry-After, trusted-proxy exemption, fd-derived cap | VERIFIED-FIXED — slowloris and TLS-stall variants reaped ≤ 10 s |
| NEW-2 | Low | Empty trusted-proxy list in compose | Empty treated as unset; refuse start if trust-proxy on with empty list | VERIFIED-FIXED |
| NEW-3 | Low | Step-up re-authentication was a password oracle without lockout | Shared step-up path counts toward lockout + per-account limiter | VERIFIED-FIXED |
| NEW-4 | Info | Host allow-list could silently lock out upgraded deployments | Rejected-Host logging, startup and upgrade warnings | VERIFIED-FIXED |
| NEW-5 | Info | Per-account limiter usable to lock any user out | — | **ACCEPTED** — inherent to AC-7 lockout; admin unlock |
| NEW-6 | Info | Rejected-Host warn lines not rate-limited across distinct values (log flooding) | Global budget of 10 lines/min + suppressed-count summary | CLOSED (architect) — live check: 40 distinct Hosts → 10 lines |
| NEW-7 | Info | Client aborts logged as server errors | Aborts classified as client disconnects (info) | CLOSED (architect) — live check: 0 error lines, 1 info line |
| NEW-8 | Info | Stolen session can lock the owner out via step-up failures | — | **ACCEPTED** — consequence of NEW-3; monitor `auth.reauth.failure` in audit review |

## 2. Controls verified as holding (regression sweeps, all rounds)

Session rotation and cookie flags; MFA enforcement for admins; login timing indistinguishable
(≈122 ms known vs unknown); CSRF (token, Origin, content-type); cross-org isolation (404 on every
foreign object, zero search results); role scoping; parameterized SQL and sanitized FTS; static-file
traversal (encoded, double-encoded, backslash, NUL, symlink); prototype-pollution keys; `no-store` on PHI;
generic 500s; strict CSP with no inline script or HTML sinks; AES-256-GCM with row-bound AAD and
per-purpose subkeys; scrypt; constant-time comparisons; atomic key rotation; audit hash chain; systemd
sandbox; read-only non-root container; checksum-verified runtime downloads.

## 3. Evidence

- Regression tests reproducing each PoC: `tests/server/secreview.test.js`, `secreview2.test.js`,
  `secreview3.test.js` (part of `npm test`; 84 / 84 passing at closure).
- Deployment checks: `bash -n`, ShellCheck, PSScriptAnalyzer (0 findings), `nginx -t`, `caddy validate`,
  `docker compose config`; symlink PoC refused by `backup.sh`, `install.sh`, `restore.sh`.
- End-to-end acceptance walkthrough against the hardened server with the production catalog: 33 screens,
  zero console / page / CSP errors, zero server errors, zero PHI in server logs.
- Assessor working papers (PoC scripts) are retained outside the repository with the assessment file.

## 4. Open items (POA&M)

| Item | Owner | Trigger |
|---|---|---|
| Windows scripts executed on a real Windows host (parsed and linted only so far) | DevOps | Before first Windows deployment |
| Off-host anchor shipping enabled at each clinic (`--anchor-ship`) | Clinic operator | At install |
| Per-tenant identity namespaces (F-11) and tenant-scoped audit chains | Architecture | Before multi-tenant SaaS |
| Legacy recovery-code regeneration (F-10) | Users (prompted) | Next login |
| Next independent assessment | Security | Any change to auth, crypto, deploy, or before SaaS launch |
