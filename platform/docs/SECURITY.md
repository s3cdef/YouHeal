# YOU HEAL Clinical — Security Architecture, Threat Model and Controls

Version 1.0 · October 2026 · Owner: DevOps / Platform Security
Applies to release 1.0.x, on-premises deployments (Docker, Linux, macOS, Windows, air-gapped).
Related: [`ARCHITECTURE.md`](ARCHITECTURE.md) (views, trust boundaries TB1–TB7), [`OPERATIONS.md`](OPERATIONS.md)
(runbook), [`REGULATORY.md`](REGULATORY.md), [`CONTRACT.md`](CONTRACT.md) §7 (security baseline).

This document is written to be lifted into a System Security Plan (SSP): §1 categorization, §2 threat
model, §3 the NIST SP 800-53 Rev 5 control implementation matrix with evidence, §4 the HIPAA Security
Rule crosswalk, §5 the continuous-monitoring / authorization lifecycle (CSRMC), §6 shared
responsibility, §7 the residual-risk register (POA&M seed).

---

## 1. System categorization

| Item | Value |
|---|---|
| Information types | Patient identity and contact data, intake/consent answers, complementary-practice session findings and notes (PHI/ePHI under HIPAA when held by or for a covered entity); practitioner accounts; audit records; reference catalog (non-sensitive, licence-restricted) |
| FIPS 199 (on-prem, single clinic) | **Confidentiality: Moderate · Integrity: Moderate · Availability: Low** → Moderate baseline |
| FIPS 199 (SaaS, aggregated tenants) | Confidentiality: **High** (aggregation), Integrity: Moderate, Availability: Moderate |
| Control baseline used | NIST SP 800-53B Moderate, tailored for a single-host appliance (§3) |
| Authorization boundary (on-prem) | The application (server, SPA, CLI, deploy scripts), its data directory, its service account and service definition. **Outside**: host OS hardening, physical site, network, client workstations, backup media handling — clinic responsibilities (§6) |

---

## 2. Threat model (STRIDE per trust boundary)

Assumed adversaries: (A1) opportunistic attacker on the clinic LAN/Wi-Fi; (A2) thief of a laptop, disk
or backup drive; (A3) malicious or curious insider with a valid low-privilege account; (A4) remote
attacker exploiting an Internet-exposed instance; (A5) supply-chain attacker tampering with a download;
(A6) ransomware on the host. Out of scope: nation-state attacks on the host OS kernel, compromised
client browsers/OS (keyloggers), physical coercion.

Ratings: L/M/H residual after listed controls. "Ctl" = primary implemented controls.

### TB1 — Browser ↔ server (network, HTTP API)

| STRIDE | Threat | Ctl (implemented) | Residual |
|---|---|---|---|
| **S** | Credential stuffing / brute force; session hijack via stolen cookie | scrypt hashes; lockout 5/15 min per account (HTTP 423) + per-IP token buckets; shadow counters prevent account enumeration; TOTP MFA (mandatory for admins); session token 256-bit, stored as SHA-256, `HttpOnly; Secure; SameSite=Strict`, rotated on login, idle 15 min / absolute 12 h | M (MFA optional for non-admins → clinic policy should require it) |
| **T** | CSRF, request tampering, parameter injection | Per-session CSRF token header + Origin/Referer check on mutations; `SameSite=Strict`; schema validation on every route; parameterized SQL only; JSON-only bodies with size limits (1 MB; 4 MB images) | L |
| **R** | User denies having viewed/changed a record | Hash-chained audit of every auth event, PHI read, create/update/delete, export, finalize; actor, role, IP, request id, timestamp; HMAC anchor detects truncation | L |
| **I** | Eavesdropping; XSS exfiltration; caching of PHI | TLS 1.2+ (self-signed or CA cert; HSTS); strict CSP `script-src 'self'`, no inline script (ADR-004); `Cache-Control: no-store`; `Referrer-Policy: no-referrer`; no PHI in URLs/logs | M (self-signed cert → users may click through warnings; mitigate with CA-issued cert or distributed trust, fingerprint check) |
| **D** | Request floods, slowloris, large bodies | Token-bucket rate limits (auth and API); body size caps; proxy timeouts; systemd `Restart=on-failure`, Docker restart policy, pids/memory limits | M (single host; no upstream DDoS protection on-prem) |
| **E** | Horizontal/vertical privilege escalation (assistant → findings; practitioner → admin) | Server-side RBAC on every route; admin-only user management; first-run setup only while no users exist, only from loopback (`YH_ALLOW_REMOTE_SETUP` off by default), never with forwarding headers, and only with the one-time `<data>/setup-token`; Host-header allow-list `YH_ALLOWED_HOSTS` defeats DNS rebinding | L |

### TB2 — Reverse proxy ↔ app (optional)

| STRIDE | Threat | Ctl | Residual |
|---|---|---|---|
| S/T | Client forges `X-Forwarded-For`/`-Proto` to spoof IP, bypass rate limits, reach loopback-only setup | App honours forwarding headers only with `YH_TRUST_PROXY=n` **and** only from peers in `YH_TRUSTED_PROXIES` (default loopback), taking the client from the right-most n hops; installers force the backend to 127.0.0.1 with `--trust-proxy`; proxies block `/api/v1/setup` and everything below it; the app refuses setup whenever forwarding headers are present | L |
| I | Query strings / cookies in proxy logs | Log formats without query strings, Referer, cookies or auth headers; patient search is `POST /api/v1/patients/search` | L |
| D | Login floods through the proxy | nginx `limit_req` on `/api/v1/auth/`, `limit_conn` per IP; app per-IP buckets + `YH_MAX_CONNECTIONS` | L |
| I | Plaintext hop between proxy and app | Backend keeps TLS; proxy verifies it (`proxy_ssl_verify`, Caddy `tls_trust_pool`) | L |
| I | BREACH (compression oracle) | Examples disable response compression | L |

### TB3 — App process ↔ host OS / filesystem

| STRIDE | Threat | Ctl | Residual |
|---|---|---|---|
| S | Another local account impersonates the service / reads its files | Dedicated non-login account (`youheal`, `NT SERVICE\YouHeal`, uid 10001); data dir 0700 / ACL SYSTEM+Administrators+service only | L |
| T | Code tampering by the service account (post-exploitation persistence) | Code owned by root/Administrators, read-only to the service; `ProtectSystem=strict`; read-only container rootfs | L |
| R | Admin edits DB directly to alter history | Audit triggers forbid UPDATE/DELETE; hash chain + HMAC anchor (keyed with a master-key subkey) make offline edits detectable by `/audit/verify` | M (a root user holding the key can rebuild the chain — inherent on-prem; detect via exported chain heads, R-05) |
| I | Copy of DB/WAL/backup file leaks PHI | Field-level AES-256-GCM (ADR-003); `secure_delete=ON`; backups encrypted; key not in backups | M (key co-located on host → R-01) |
| D | Ransomware encrypts/deletes data | Encrypted offsite/offline backups with retention; DR runbook; restore verification | M (depends on clinic keeping an offline copy, R-04) |
| E | Compromised service account plants symlinks/junctions in its data dir so that root/Administrator maintenance scripts (backup, restore, install, upgrade, uninstall) write, chown or delete arbitrary files | Scripts never write/chmod/chown/recursively delete inside the data dir as root: all such operations run as the service account; every run aborts if the data dir contains a symlink (POSIX) or reparse point (Windows); `chown -h`, icacls `/L`; env files allow-list `YH_*`/`NODE_ENV` only; Windows `config\` is not writable by the service (F-03) | L |
| E | RCE in Node/app escalates to root | No capabilities (`CapabilityBoundingSet=`), `NoNewPrivileges`, syscall filter, `PrivateDevices`, `ProtectKernel*`, `RestrictNamespaces`, `cap_drop: ALL` + `no-new-privileges` in Docker; zero npm dependencies | L/M (`MemoryDenyWriteExecute=no` required by V8 JIT, R-09) |

### TB4 — Operator ↔ host (administration)

| STRIDE | Threat | Ctl | Residual |
|---|---|---|---|
| S | Unauthorized person runs install/restore scripts | Scripts require root/Administrator (sudo/doas re-exec, UAC self-elevation); OS authentication | L |
| T | Tampered admin scripts | Windows: Authenticode signing (`Sign-Scripts.ps1`) + AllSigned via GPO recommended; bundle `CHECKSUMS.sha256` verified by installers; Linux scripts root-owned in the release dir | M (bundle signature is a placeholder until the org key exists, R-07) |
| R | Untracked admin actions | Every script logs to a 0600 file (install/backup/restore/upgrade/uninstall logs); CLI admin actions (create-admin) write audit rows | L |
| I | Key exposure during handling | Key never printed (fingerprint only), never in env files or process arguments; Docker passes it by file path | M (human escrow handling) |
| E | Execution-policy bypass abused | Bypass is **process-scope only**, never machine-wide; production guidance is AllSigned | L |

### TB5 — Host ↔ backup media / offsite

| STRIDE | Threat | Ctl | Residual |
|---|---|---|---|
| T | Backup modified or corrupted | GCM tag (authenticated), header as AAD; `.sha256` sidecar; `backup --verify` after each run; restore re-verifies before replacing | L |
| I | Lost USB/NAS backup | Backups are ciphertext; key held separately; HIPAA encryption safe harbor applies if key not compromised | L |
| D | Backups silently failing; no offline copy | Scheduled job with logs; retention; quarterly restore test (OPERATIONS §7) | M (R-04) |

### TB6 — Supply chain ↔ build/install

| STRIDE | Threat | Ctl | Residual |
|---|---|---|---|
| T/S | Malicious Node.js runtime, WinSW or base image | Node archives/MSIs verified against upstream `SHASUMS256.txt` (and Authenticode on Windows; `.asc` shipped for GPG verification); WinSW SHA-256 pinned; Docker base pinned by version tag with documented digest pinning; HTTPS-only downloads, never disabling TLS verification | M (SHASUMS fetched over the same TLS channel; GPG verification optional, R-06) |
| T | Malicious npm dependency | **None at runtime** (ADR-001); vendored three.js pinned by SHA-256 (ADR-004) | L |
| I | PHI/keys/licensed PDFs baked into images or bundles | `.dockerignore`, installer and bundle excludes for `data/sources`, `db`, `keys`, `backups`, `tls`, tests | L |
| — (legal) | Distribution of unlicensed content | Licence gate in bundle builders; `YH_CATALOG_LICENSES` filter (ADR-007) | M (R-10) |

### TB7 — Tenant ↔ tenant (SaaS, future)
Covered when the SaaS architecture is implemented: PostgreSQL RLS on `org_id`, per-tenant KMS keys,
per-tenant audit chains, cross-tenant negative tests in CI (ARCHITECTURE.md §8).

---

## 3. NIST SP 800-53 Rev 5 control implementation matrix

Legend — **Resp.**: V = vendor (implemented in the product), C = clinic/operator, S = shared.
**Evidence** names the artefact an assessor collects; most are produced automatically.

### AC — Access Control

| Control | Implementation | Resp. | Evidence |
|---|---|---|---|
| AC-2 Account management | Admin-only user CRUD (`/api/v1/users`), roles admin/practitioner/assistant/auditor, `active` flag (disable not delete); first admin via setup (loopback) or `create-admin` CLI | S | `GET /users` export; audit actions `user.*`, `cli.admin.*` |
| AC-3 Access enforcement | RBAC check on every route (`server/lib/rbac.js`) | V | Route-level tests (`npm test`); code review |
| AC-6 Least privilege | Role separation (assistant cannot record findings; auditor read-only); service runs unprivileged (no capabilities, dedicated account) | V | `systemd-analyze security youheal` output; `docker inspect` (CapDrop, ReadonlyRootfs, User); Windows `sc.exe qc YouHeal` (SERVICE_START_NAME `NT SERVICE\YouHeal`) |
| AC-7 Unsuccessful logon attempts | 5 failures / 15 min lock per account (HTTP 423), per-IP token bucket; tunable `YH_LOCKOUT_ATTEMPTS`, `YH_LOCKOUT_MIN`, `YH_RATE_AUTH_*` | V | Audit `auth.login.failure`/lockout rows; `youheal.env` |
| AC-8 System use notification | Login banner text configurable by clinic (org profile / report footer) | C | Screenshot |
| AC-11 / AC-12 Session lock / termination | Idle timeout 15 min, absolute 12 h (`YH_SESSION_IDLE_MIN`, `YH_SESSION_ABS_HOURS`); logout invalidates server-side session | V | Config; test results |
| AC-17 Remote access | Default bind behind host firewall; setup loopback-only; remote admin via SSH tunnel; Internet exposure only through a reverse proxy | S | Firewall rules (`ufw status`, `Get-NetFirewallRule YouHeal-HTTPS-In`) |
| AC-4 / SC-7 Information flow / boundary | No outbound connections at runtime; Docker publishes on 127.0.0.1 by default; ICC disabled on the compose network; optional source-CIDR firewall rule | S | compose.yaml; firewall export |

### AU — Audit and Accountability

| Control | Implementation | Resp. | Evidence |
|---|---|---|---|
| AU-2 / AU-12 Event logging | Auth events, PHI reads, create/update/delete, exports, finalize/amend, CLI admin actions; HTTP access log (method, path, status, ms, IP, request id) | V | `audit_log` table; service log (journald / WinSW logs / container log) |
| AU-3 Content | actor id + role, action, target type/id, outcome, IP, request id, UTC timestamp; `detail` limited to ids/counts/field names (no PHI) | V | Sample export from `GET /audit` |
| AU-8 Time stamps | UTC ISO-8601 from host clock | S | Host NTP config (clinic) |
| AU-9 Protection of audit info | Append-only (DB triggers forbid UPDATE/DELETE); `hash = SHA-256(prev ‖ canonical_json(row))`; HMAC anchor keyed with the audit subkey; DB file 0600 in 0700 dir | V | `GET /api/v1/audit/verify` → `{ok, checked, brokenAt?}` (archive the JSON monthly) |
| AU-10 Non-repudiation | Hash chain; finalized report snapshot + SHA-256 printed in report footer | V | Report footer hash ↔ stored snapshot ↔ audit row |
| AU-6 Review, analysis, reporting | Auditor role; filters by actor/action | C | Review log/minutes (clinic) |
| AU-11 Retention | DB retains audit indefinitely; backups per retention policy | C | Backup retention setting (`--keep`), policy document |

### IA — Identification and Authentication

| Control | Implementation | Resp. | Evidence |
|---|---|---|---|
| IA-2 / IA-2(1)(2) | Unique accounts; TOTP MFA (RFC 6238), **mandatory for admins**, available to all; 10 hashed single-use recovery codes | V/C (clinic decides MFA for non-admins) | User list with `mfaEnabled`; config |
| IA-5 Authenticator management | scrypt N=2¹⁵ r=8 p=1, 32-byte salt; min length 12 + breached-pattern basics; password change endpoint; TOTP secrets encrypted at rest | V | Code (`server/lib/crypto.js`), tests |
| IA-5(1) Password-based | As above; no password hints; constant-time compare | V | Tests |
| IA-6 Authenticator feedback | Hidden password input (UI and CLI) | V | — |
| IA-8 Non-org users | None (no patient portal in 1.0) | — | — |
| IA-11 Re-authentication | Password required for MFA disable / password change | V | API contract |

### SC — System and Communications Protection

| Control | Implementation | Resp. | Evidence |
|---|---|---|---|
| SC-8 / SC-8(1) Transmission confidentiality & integrity | TLS everywhere: installer/entrypoint generate a self-signed cert (P-256 or RSA-3072, SAN = hostnames + IPs, 825 days) or use a supplied CA cert; server **refuses plain HTTP on non-loopback** unless explicitly overridden; proxy examples: TLS 1.2/1.3 AEAD suites, HSTS | V/S | `openssl s_client` transcript; `youheal.env`; proxy config |
| SC-12 / SC-13 Key management / crypto | CSPRNG 256-bit master key; HKDF-SHA256 subkeys; AES-256-GCM; HMAC-SHA256; rotation with retired decrypt-only keys (`rotate-key --yes`); escrow procedure | S | Key fingerprint record, escrow log (OPERATIONS §6) |
| SC-17 PKI certificates | Self-signed by default; CA-issued recommended (supply `--tls-cert/--tls-key`) | C | Certificate details |
| SC-23 Session authenticity | Hashed session tokens, rotation on login, CSRF tokens, SameSite=Strict | V | Tests |
| SC-28 / SC-28(1) Protection at rest | Field-level AES-256-GCM for PHI (ADR-003); encrypted backups; `secure_delete`; host FDE recommended | S | Schema shows `v1:` ciphertext; FDE status (clinic) |
| SC-39 Process isolation | systemd sandbox (`ProtectSystem=strict`, `PrivateTmp`, `PrivateDevices`, `ProtectKernel*`, `RestrictNamespaces`, `SystemCallFilter=@system-service`, `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`); container read-only rootfs, tmpfs `/tmp` (noexec), pids/mem limits | V | Unit file; `systemd-analyze security`; `docker inspect` |
| SC-18 Mobile code | CSP `script-src 'self'`; no inline scripts/handlers; vendored pinned three.js | V | Response headers capture |
| SC-5 DoS protection | Rate limits, body caps, restart policies, resource limits | V | Config |

### SI — System and Information Integrity

| Control | Implementation | Resp. | Evidence |
|---|---|---|---|
| SI-2 Flaw remediation | Single external runtime (Node.js) → track Node security releases; upgrade script with automatic rollback; distro-package Node patched via OS updates | S | Node version (`node --version`), upgrade logs |
| SI-3 Malicious code | Host AV/EDR (clinic); zero npm runtime deps | C | EDR status |
| SI-4 Monitoring | Health endpoint + probes (Docker HEALTHCHECK, installer/upgrade checks); logs to journald/WinSW/container | S | Health check logs |
| SI-7 Software integrity | SHA-256 verification of runtime, WinSW, offline bundle (`CHECKSUMS.sha256`); release tree digest in `.youheal-release`; Authenticode for Windows scripts; root-owned read-only code | V | Installer log lines "SHA-256 verified"; `.youheal-release`; `Get-AuthenticodeSignature` |
| SI-10 Input validation | Schema validator on every route; parameterized SQL; JSON-only | V | Tests |
| SI-11 Error handling | Error envelope without stack traces; request id for correlation | V | Sample responses |
| SI-12 Information retention | PHI retained until clinic deletes per its retention schedule; crypto-erase at decommission | C | Retention policy |
| SI-16 Memory protection | `NoNewPrivileges`, syscall filter; **MDWE disabled** for V8 JIT (documented, R-09) | V | Unit file comment |

### CM — Configuration Management

| Control | Implementation | Resp. | Evidence |
|---|---|---|---|
| CM-2 Baseline configuration | Installer-rendered `youheal.env`, unit/plist/WinSW XML, `install.state(.json)`; Docker `compose.yaml` | V | The files themselves (diff against previous) |
| CM-3 / CM-4 Change control & impact | Versioned releases side by side; upgrade logs; pre-upgrade backup + snapshot | S | Upgrade logs, change tickets (clinic) |
| CM-5 Access restrictions for change | Code root/Administrators-owned; scripts require elevation | V | `ls -l` / `icacls` output |
| CM-6 Configuration settings | Secure defaults (fail-closed TLS, loopback setup, MFA for admins); env validated at start (ConfigError on invalid values) | V | Startup log |
| CM-7 Least functionality | No npm/npx/corepack in image; no outbound network; only port 8443 | V | Image inspection (`docker run --entrypoint sh … which npm` → none) |
| CM-8 Component inventory | `package.json` (zero deps), `BUNDLE.json` (Node version + SHA-256, WinSW hash, VCS revision), image labels | V | Files |
| CM-10 Usage restrictions | Catalog licence status + filter + bundle licence gate (ADR-007) | V/C | `sources.json`, build log |
| CM-11 User-installed software | N/A for app; host policy (clinic) | C | — |

### CP — Contingency Planning

| Control | Implementation | Resp. | Evidence |
|---|---|---|---|
| CP-2 Contingency plan | OPERATIONS.md §7–8 (backup, restore, DR, upgrade rollback) | S | Plan + annual review record |
| CP-4 Plan testing | Quarterly restore test to a scratch host (procedure in OPERATIONS §7.4) | C | DR test record (template in OPERATIONS) |
| CP-9 System backup | Online-consistent encrypted backups (`VACUUM INTO` + AES-256-GCM), verify-after-write, `.sha256`, retention, optional verified offsite copy, cron/Scheduled Task | S | `backup.log`, backup listings with hashes |
| CP-9(8) Cryptographic protection | Backups encrypted with HKDF backup subkey; key escrowed separately | V/C | Header key id; escrow record |
| CP-10 Recovery & reconstitution | `restore.sh` / `Restore-YouHeal.ps1` with safety snapshot + automatic rollback; DR to new host with `--master-key-file` | V | Restore logs |

### IR — Incident Response

| Control | Implementation | Resp. | Evidence |
|---|---|---|---|
| IR-4 Incident handling | Runbook OPERATIONS §10 (contain, preserve, assess 4-factor HIPAA risk, notify) | C | Incident record |
| IR-5 Monitoring | Audit queries; chain verification; health/log review | S | Exports |
| IR-6 Reporting | HIPAA breach-notification timelines (OPERATIONS §10.4) | C | Notification letters, HHS portal receipt |
| IR-8 IR plan | Clinic adopts OPERATIONS §10 as its plan; vendor contact path | S | Signed plan |

### MP — Media Protection

| Control | Implementation | Resp. | Evidence |
|---|---|---|---|
| MP-2 / MP-4 Media access & storage | Backups encrypted; offsite copies verified; storage location policy | C | Media log |
| MP-5 Transport | Ciphertext-only on removable media; key never on the same media | C | Procedure |
| MP-6 Sanitization | **Crypto-erase**: `uninstall.sh --purge` / `Uninstall-YouHeal.ps1 -Purge` overwrite and delete master + retired keys first, then data; plus destruction of escrowed copies (NIST SP 800-88 Rev. 1) | S | Uninstall log + sanitization certificate (OPERATIONS §11) |

### Also relevant: RA-5 (vulnerability scanning — clinic scans host; vendor tracks Node advisories),
SR-3/SR-4/SR-11 (supply chain: ADR-001, hash pinning, provenance), SA-22 (unsupported components:
Node 22 EOL April 2027 → plan Node 24 validation), PL-8 (security architecture: this document).

---

## 4. HIPAA Security Rule crosswalk (45 CFR Part 164 Subpart C)

(R) = required, (A) = addressable implementation specification. "Product support" lists what the software
provides; the covered entity remains responsible for the safeguard as a whole.

### §164.308 Administrative safeguards

| Standard / spec | Product support | Clinic action |
|---|---|---|
| (a)(1)(ii)(A) Risk analysis (R) | This threat model, risk register (§7), control matrix | Perform and document the clinic's own risk analysis including host, network, staff |
| (a)(1)(ii)(B) Risk management (R) | Hardened defaults; POA&M seed (§7) | Accept/treat residual risks; track POA&M |
| (a)(1)(ii)(C) Sanction policy (R) | — | Workforce sanction policy |
| (a)(1)(ii)(D) Information system activity review (R) | Audit log, auditor role, chain verification | Monthly review, record findings |
| (a)(2) Assigned security responsibility (R) | — | Name a security official |
| (a)(3) Workforce security (A) | Roles; account disable | Onboarding/termination procedures; disable accounts same day |
| (a)(4) Information access management (A) | RBAC (admin/practitioner/assistant/auditor) | Assign minimum necessary roles |
| (a)(5) Security awareness & training (A): log-in monitoring, password management | Failed-login audit, lockout; password policy; MFA | Train staff; phishing awareness |
| (a)(6) Security incident procedures (R) | Runbook §10; audit evidence | Adopt IR plan; document incidents |
| (a)(7) Contingency plan: backup (R), DR (R), emergency mode (R), testing (A), criticality (A) | Encrypted backups + verify; restore with rollback; DR to new host; runbook | Offsite/offline copy; quarterly test; paper fallback for emergency mode |
| (a)(8) Evaluation (R) | Evidence artefacts (§5) | Periodic technical and non-technical evaluation |
| (b)(1) Business associate contracts (R) | On-prem: vendor has no PHI access by design. SaaS/remote support: BAA required | Execute BAA before any vendor access to PHI |

### §164.310 Physical safeguards

| Standard | Product support | Clinic action |
|---|---|---|
| (a)(1) Facility access controls | — | Lock server room/cabinet; visitor control |
| (b) Workstation use / (c) Workstation security | Session idle timeout; no PHI cached by browser (`no-store`) | Screen locks, privacy screens, OS patching, EDR |
| (d)(1) Device & media controls: disposal (R), media re-use (R), accountability (A), data backup & storage (A) | Crypto-erase uninstall; encrypted backups; `.sha256` integrity | Media inventory; sanitize disks per NIST SP 800-88; store backups offsite |

### §164.312 Technical safeguards

| Standard / spec | Product support |
|---|---|
| (a)(1) Access control — unique user ID (R) | Individual accounts; no shared logins |
| — Emergency access procedure (R) | `create-admin` CLI on the host resets/creates an admin (audited `cli.admin.*`); escrowed master key; documented break-glass (OPERATIONS §9) |
| — Automatic logoff (A) | 15-min idle, 12-h absolute session limits |
| — Encryption and decryption (A) | AES-256-GCM field encryption; encrypted backups |
| (b) Audit controls (R) | Hash-chained append-only audit, verification endpoint |
| (c)(1) Integrity; (c)(2) mechanism to authenticate ePHI (A) | GCM authentication tags on every PHI field and backup; finalized report snapshot + SHA-256; locked sessions (DB triggers) |
| (d) Person or entity authentication (R) | Passwords (scrypt) + TOTP MFA |
| (e)(1) Transmission security — integrity controls (A), encryption (A) | TLS 1.2+ only; HSTS; plain HTTP refused on non-loopback interfaces |

---

## 5. Continuous monitoring and authorization lifecycle (CSRMC)

The DoD CIO's **Cybersecurity Risk Management Construct (CSRMC, announced September 2025)** replaces a
checklist-driven, point-in-time ATO with a five-phase lifecycle — **Design, Build, Test, Onboard,
Operations** — emphasising automation, critical controls, continuous monitoring and ATO, DevSecOps,
cyber survivability, training, enterprise services and inheritance, operationalisation, reciprocity and
threat-informed assessment. YOU HEAL Clinical is a commercial healthcare product, not a DoD system; the
construct is used here as a **disciplined, evidence-driven lifecycle** that maps cleanly onto RMF/JSIG
artefacts (SSP, SAR, POA&M, ConMon). The mapping below is the platform team's interpretation.

| Phase | What happens for YOU HEAL Clinical | Evidence produced (automatically where possible) |
|---|---|---|
| **Design** | Security requirements in CONTRACT §7; ADR-001…007; threat model (§2); categorization (§1) | ADRs, this document (SSP core), data-flow diagrams |
| **Build** | Zero-dependency server; secure defaults; hardened service definitions; pinned/verified supply chain | `package.json` (no deps), `BUNDLE.json`, image labels, `.youheal-release` tree digest, signed PowerShell scripts |
| **Test** | `npm test` (node:test suites incl. auth, RBAC, crypto, audit chain); script validation (`bash -n`, ShellCheck, PowerShell parser + PSScriptAnalyzer); config validation (`systemd-analyze verify/security`, `nginx -t`, `caddy validate`); container run as non-root/read-only; restore and rollback drills | CI logs, analyzer reports, test reports, DR test record → **SAR** inputs |
| **Onboard** | Clinic install with installer logs; first-run setup; MFA enrolment; key escrow; backup schedule; firewall rule; shared-responsibility acknowledgement (§6) | Install log, `youheal.env`, unit/WinSW XML, key fingerprint record, escrow log, firewall export → **authorization package** |
| **Operations** | Continuous monitoring (table below); patching via `upgrade.sh`/`Upgrade-YouHeal.ps1`; incident response | ConMon evidence stream; **POA&M** updates (§7) |

**Continuous-monitoring cadence (clinic + vendor)**

| Frequency | Check | Command / source | Evidence retained |
|---|---|---|---|
| Continuous | Liveness | Docker HEALTHCHECK / `healthcheck.mjs` / service manager restarts | Container/service logs |
| Daily | Backup success + verify | `backup.sh` / `Backup-YouHeal.ps1` log, `.sha256` sidecars | Backup log (≥ 6 years if used as HIPAA documentation) |
| Weekly | Failed logins, lockouts, off-hours PHI reads | `GET /api/v1/audit?action=auth.login.failure` etc. | Review note |
| Monthly | Audit chain integrity | `GET /api/v1/audit/verify` → archive JSON incl. `checked` count and chain head | Signed/dated JSON |
| Monthly | Node.js / OS security releases | nodejs.org security blog; OS updates | Patch record |
| Quarterly | Restore test (DR) | OPERATIONS §7.4 | DR test record |
| Quarterly | Access recertification | `GET /api/v1/users` vs. staff roster | Signed list |
| Annually | Risk analysis refresh; certificate expiry check (≤ 825 days); key rotation decision | This doc; `openssl x509 -enddate`; `rotate-key` | Updated risk register |

---

## 6. Shared responsibility (on-premises)

| Area | Vendor (product) | Clinic (operator / covered entity) |
|---|---|---|
| Application security | Secure code, authn/authz, audit, encryption, secure defaults, patches | Apply updates promptly |
| Host OS | Hardened service definitions, least-privilege account, documentation | **OS hardening and patching**, EDR/AV, local admin hygiene, NTP |
| Disk encryption | Field-level encryption of PHI | **Full-disk encryption** (BitLocker, FileVault, LUKS) on the host and on every workstation that prints/exports reports |
| Physical security | — | **Locked location** for the host; device inventory; visitor control |
| Network | Port binding guidance, firewall automation (optional) | Segmented LAN/Wi-Fi (WPA3/802.1X), no port-forwarding of 8443 to the Internet, VPN for remote access |
| Identity | MFA, lockout, session controls | Enforce MFA for all users; joiner/mover/leaver process |
| Keys | Generation, storage permissions, rotation tooling | **Offline escrow** (two sealed copies, separate locations), custody log, destruction at decommission |
| Backups | Encrypted, verified backups; restore tooling | **Offsite/offline copies** (3-2-1 rule), retention, quarterly restore tests |
| TLS certificate | Self-signed generation, replacement procedure | Prefer a CA-issued certificate or distribute trust; verify fingerprint on first use |
| Incident response | Runbook, audit evidence, vendor support | Breach risk assessment, notifications, documentation (HIPAA) |
| Regulatory | Non-diagnostic product design and wording | Practice within licence/scope; patient consent; marketing claims (REGULATORY.md) |

---

## 7. Residual-risk register (POA&M seed)

Likelihood/Impact: L/M/H. Owner: V = vendor, C = clinic.

| ID | Risk | L | I | Rating | Current mitigation | Planned treatment | Owner |
|---|---|---|---|---|---|---|---|
| R-01 | Master key stored on the same host as the data; root/admin compromise or full-disk image with key file exposes PHI | M | H | **High** | 0600/ACL key file; service isolation; FDE recommended; key not in backups | TPM/DPAPI-sealed key option (Windows DPAPI-NG, Linux systemd-creds/TPM2); SaaS: KMS envelope keys | V |
| R-02 | Self-signed certificate trains users to click through warnings → MITM on LAN | M | M | Medium | Fingerprint printed at install; HSTS once trusted; CA cert supported | Guide for distributing a clinic CA via GPO/MDM; ACME via proxy | C/V |
| R-03 | Loss of master key (no escrow) → permanent loss of PHI and backups | L | H | Medium | Loud warnings at generation; escrow procedure; retired keys kept | Key-escrow acknowledgement step in first-run setup | C |
| R-04 | Ransomware or disk failure with no offline backup copy | M | H | **High** | Encrypted backups, verify, `--copy-to`, schedules | Immutable/offline copy guidance; backup-age alert in admin UI | C |
| R-05 | Privileged insider with key rewrites DB and recomputes audit chain | L | H | Low | Triggers, hash chain, HMAC anchor; `<data>/audit-anchor.log` shipped off-host with `--anchor-ship` / log forwarding (F-16) | Clinic must actually configure anchor shipping to storage the insider does not control; SaaS: external audit sink | V/C |
| R-06 | Runtime download authenticity relies on HTTPS + SHASUMS from same origin | L | H | Medium | HTTPS-only, SHA-256 verify, Authenticode (MSI), `.asc` shipped in bundles | Make GPG verification against pinned Node release keys mandatory in bundle builds | V |
| R-07 | Offline bundle and Linux scripts unsigned (placeholder) | M | M | Medium | `CHECKSUMS.sha256`, out-of-band archive hash, Authenticode for PS scripts | Organisational signing key; installers verify signature before checksums | V |
| R-08 | Misconfigured proxy trust allows IP spoofing | L | M | Low | `YH_TRUSTED_PROXIES` (default loopback) limits who may send forwarding headers; installers force 127.0.0.1 with `--trust-proxy`; setup refused with forwarding headers + setup token; setup blocked at proxy (F-04, F-09) | Re-test after server fixes; close if confirmed | V |
| R-09 | `MemoryDenyWriteExecute=no` (V8 JIT) weakens exploit mitigation | L | M | Low | Syscall filter, NoNewPrivileges, no caps, read-only code | Optional `--jitless` profile for high-assurance sites | V |
| R-10 | Distribution of GOIZ/Leal content without licence | M | H | **High** | `license_status`, `YH_CATALOG_LICENSES`, bundle licence gate | Obtain licence or ship original/licensed-only catalog (REGULATORY §5) | V |
| R-11 | Node.js 22 end of life (April 2027) | H (by date) | M | Medium | `engines >=22.13` accepts newer LTS | Validate on Node 24 LTS; update installers' default major before Q1 2027 | V |
| R-12 | `node:sqlite` experimental API changes in a Node minor | L | M | Low | API isolated in `db.js`; tests; pinned runtime in bundles | Track Node changelog; CI on latest 22.x and 24.x | V |
| R-13 | Single host = single point of failure (availability) | M | L | Low | Restart policies, quick restore, paper fallback | Optional warm standby via scheduled restore on a second host | C |
| R-14 | MFA optional for non-admin roles | M | M | Medium | Admin MFA mandatory; lockout | Org setting "require MFA for all roles" | V |
| R-15 | Printed/PDF reports leave the system boundary unencrypted | M | M | Medium | Disclaimer, no PHI in filenames by default | Workstation FDE policy; secure print guidance | C |
| R-17 | TOCTOU window remains for **Windows** elevated node CLI runs (migrate/backup/restore run as Administrator against the service-writable data dir; reparse-point scan happens immediately before, not atomically) | L | M | Low | Scan before every elevated operation; `config\` not service-writable; env allow-list | Run maintenance CLIs under the service identity (e.g. a one-shot service/task as `NT SERVICE\YouHeal`) | V |
| R-19 | Account-existence oracle via login/e-mail responses (F-11, accepted on-prem) | M | L | Low | Lockout, per-IP rate limits, staff-only LAN system | Revisit before SaaS exposure | V |
| R-20 | Auditor role can read finalized-report PHI (F-12, accepted on-prem) | L | M | Low | Role assigned sparingly; every read audited (`report.read`) | PHI-redacted auditor view for SaaS | V/C |
| R-21 | Upgrade without `YH_ALLOWED_HOSTS` causes an availability outage ("Host not allowed") (NEW-4) | M | L | Low | Installers derive it; upgrade scripts warn; upgrade note | Docker operators must set it before pulling the image | C |
| R-18 | A compromised service account can still destroy or encrypt its own data (DB, keys, backups in `<data>/backups`) | L | H | Medium | Least privilege elsewhere; offsite `--copy-to` copies are root-owned and outside `<data>` | Offline/immutable backup copy (R-04) | C |
| R-16 | Untested Windows code paths (installer validated by parser/analyzer, not on a live Windows host in this release) | M | M | Medium | Static analysis, shared logic tested on PowerShell 7 | Windows Server 2022 / Windows 11 CI runner executing install → backup → restore → upgrade → uninstall | V |

---

## 8. Independent assessment — 2026-10-21

An independent security assessor reviewed the server, SPA and deployment tooling (PoCs retained with the
assessment working papers), then re-tested the fixes the same day. **Re-test summary: 13 findings verified
fixed; partials resolved in round 4 (below); F-11 and F-12 risk-accepted for on-prem; five new items
(NEW-1…NEW-5) raised and dispositioned.**Verdicts below are reconciled against the assessor's re-test sheet; the
final round-4 re-test result is recorded in `docs/security/ASSESSMENT-2026-10-21.md`.

| ID | Sev. | Area | Finding (summary) | Remediation | Status (round 1) | Re-test 2026-10-21 / round-4 disposition |
|---|---|---|---|---|---|---|
| F-01 | High | server | Account lockout bypass via concurrent login attempts (stale counter) — enabled online TOTP guessing | Atomic `UPDATE … RETURNING` counter, re-read after password check, reset in session tx; per-account in-flight bucket; IPv6 /64 rate buckets | Remediated in server | **VERIFIED-FIXED** — 100 concurrent wrong passwords → 5 evaluated, correct password then 423; 100 concurrent TOTP guesses → 5 evaluated |
| F-02 | Medium | server | TOTP replay and recovery-code reuse/resurrection under concurrency | Guarded `mfa_last_step` update (exactly one row); recovery codes in `user_recovery_codes`, consumed with `used_at IS NULL` guard (migration 003) | Remediated in server | **VERIFIED-FIXED** — same TOTP ×3 → one 200; same code ×3 → one 200; spent codes stay spent |
| F-03 | **Medium** | deploy | Root/Administrator scripts followed symlinks/junctions planted in the **service-owned data dir** (`.sha256` sidecar written + chown/chmod as root at a predictable path; installer chown/chmod of `db/keys/backups/tls`; restore snapshot handling) → arbitrary file overwrite/ownership change | All writes/chmods/deletes inside `<data>` run **as the service account**; root only `chown -h`s `<data>` itself; every script aborts if `<data>` contains a symlink; key/TLS generated in root-only staging; Windows `Assert-YHNoReparsePoint` before every elevated ACL change/write/CLI run/recursive delete, icacls `/L`, `config\` not service-writable, env-file allow-list | Fixed (deploy) | **Partial → fixed in round 4.** Residual (Low): `restore.sh` hashed/staged `--in` as root via a path the service account could swap. Now: `--in` and its sidecar must not be symlinks; a path inside `<data>` (as given *or* resolved) is opened only by the service account after a full symlink scan; any other path must be root-(or sudo-user-)owned with root-controlled, non-writable ancestors, and root works only on a private copy in its 0700 temp dir. `Restore-YouHeal.ps1`: reparse check on the file and every ancestor, data-dir scan when inside `<data>`, private ACL-restricted temp copy |
| F-04 | Medium | proxy + server | Setup block bypass via trailing slash / sub-path; setup reachable through proxies | Proxy prefix blocks (`^~`, `path …/*`) with `GET /api/v1/setup/status` passed; server refuses setup with forwarding headers + one-time `<data>/setup-token` | Fixed (deploy) / server | **Partial → fixed in round 4.** The token was also logged; the server no longer logs it in production. OPERATIONS §3 and both installer banners now read the 0600 file only |
| F-05 | Medium | server + deploy | DNS rebinding: arbitrary `Host` accepted | `YH_ALLOWED_HOSTS`; installers write it from certificate SANs; compose pass-through | Fixed (deploy) / server | Verified fixed; upgrade impact → NEW-4 |
| F-06 | Low | server | Last-admin check racy across the scrypt await → zero admins | Recount inside the transaction + DB trigger blocking removal of the last active admin | Remediated in server | **VERIFIED-FIXED** — concurrent cross-demotion → 200 + 409 `LAST_ADMIN`, one admin remains |
| F-07 | Low | server | Report signature name not bound to the signer | Signature = signer account name; mismatch → 422; password re-authentication at finalize | Remediated in server | **VERIFIED-FIXED** — forged name 422, missing password 400, wrong password 403 |
| F-08 | Low | proxy + server | Query strings could reach proxy logs | nginx `$uri` log format; Caddy query redaction + header drops; `POST /api/v1/patients/search` | Fixed (deploy) / server | Verified fixed |
| F-09 | Medium | server + deploy | Forwarding headers trusted from any peer | `YH_TRUSTED_PROXIES` (default loopback); installers force 127.0.0.1 with trust-proxy | Fixed (deploy) / server | Verified fixed; compose empty-list defect → NEW-2 |
| F-10 | Low | server | Recovery codes stored as unkeyed SHA-256 (offline-crackable from a stolen DB) | HMAC with dedicated HKDF subkey + key id per row; keyring-aware verification | Remediated in server | **PARTIAL → round 4:** legacy unkeyed codes stay valid until regenerated; users with legacy codes are flagged `recoveryCodesRegenerationRequired` and prompted to regenerate (residual until each user does so) |
| F-11 | — | server | Account-existence (e-mail) oracle | — | — | **Risk accepted (on-prem).** Rationale: staff-only system on a clinic LAN with a handful of known accounts; login lockout, per-IP rate limits and shadow lockout counters bound enumeration speed; e-mail addresses of clinic staff are not secret. Re-assess for SaaS (internet-exposed, many tenants) |
| F-12 | — | server | Auditor role can read PHI in finalized reports | — | — | **Risk accepted (on-prem).** Rationale: the auditor role is a deliberately privileged compliance role (CONTRACT §5: "read-only audit + reports"); report review is part of the audit function; every report read is itself audited (`report.read`); clinics assign the role sparingly. Re-assess with a PHI-redacted auditor view for SaaS |
| F-13 | Info | server | JSON depth check crashed (500) on very large arrays | Iterative shape check: depth, ≤ 5000 elements, forbidden prototype keys at any depth | Remediated in server | **VERIFIED-FIXED** — 400k-element array → 400; nested `constructor` → 400 |
| F-14 | Info | server | MFA disable did not revoke other sessions | `destroyForUser` on MFA disable | Remediated in server | **VERIFIED-FIXED** — second session → 401 after disable |
| F-15 | Info | server | Backup decompressed before GCM tag verification | Two-pass restore: authenticate, then decrypt + gunzip with output cap = header size | Remediated in server | **VERIFIED-FIXED** — 200 MB authenticated gzip bomb rejected in 20 ms, no residue |
| F-16 | — | server + ops | Audit-chain anchor kept only on the host it protects | Server writes `<data>/audit-anchor.log` | Remediated in server | **Partial → fixed in round 4 (ops).** `backup.sh --anchor-ship <dir>` / `Backup-YouHeal.ps1 -AnchorShip <dir>` copy it (+ `.sha256`) off-host on every backup; OPERATIONS §7.5 also documents rsyslog/journald forwarding |
| F-17 | Low | server + proxy | Cookie hardening (`__Host-yh_sid`) | Proxy docs: no cookie rewriting | Fixed (docs) / server | Verified fixed |
| F-18 | Low | deploy | Safety snapshots included `keys/`, root-written, retained | `db/` only, 0600 service-owned, deleted on success | Fixed (deploy) | Verified fixed |
| F-19 | Info | server | Unknown-account lockouts held in memory only | Persisted `auth_ghost_lockouts` keyed by HMAC(email), atomic counter, expiry purge | Remediated in server | **VERIFIED-FIXED** — 423 survives restart; timing still indistinguishable (122.3 vs 121.8 ms) |
| F-20 | Low | proxy + server | No edge connection/rate limiting | nginx `limit_conn`/`limit_req`; Caddy module guidance; `YH_MAX_CONNECTIONS` | Fixed (deploy) / server | Verified fixed; see NEW-1 |
| NEW-1 | Low | server + deploy | Connection-exhaustion / slow-loris tuning undocumented | Server: `YH_FIRST_BYTE_MS` (default 10 s), `YH_MAX_CONNECTIONS` (default 75 % of the fd limit), `YH_MAX_CONN_PER_IP`. Deploy: fd limit 8192 in systemd (`LimitNOFILE`), OpenRC (`rc_ulimit`), launchd (`NumberOfFiles`), compose (`ulimits.nofile`); OPERATIONS §5 documents all knobs | — | Fixed (round 4) |
| NEW-2 | Low | deploy | `compose.yaml` passed `YH_TRUSTED_PROXIES=""` (empty list) whenever unset | Optional variables are now value-less compose entries: passed only when set, otherwise **unset** in the container (verified); comment documents finding the bridge gateway. Server now refuses to start with trust-proxy on and an empty list | — | Fixed (round 4) |
| NEW-3 | Low | server | Finalize / password change / MFA disable re-auth = password-guessing oracle with no lockout | Re-auth failures routed through the per-account failure counter and limiter (round 4) | Fixed (round 4) | Round-4 fix — pending final re-test |
| NEW-4 | Low | deploy + docs | Upgrading to the Host allow-list release breaks installs without `YH_ALLOWED_HOSTS` (Docker especially) | Upgrade note in OPERATIONS §8 and reverse-proxy README; `upgrade.sh` / `Upgrade-YouHeal.ps1` warn (before and after staging) when `YH_ALLOWED_HOSTS` and `YH_PUBLIC_ORIGIN` are both empty on a non-loopback bind | — | Fixed (round 4) |
| NEW-5 | Info | server | Per-account limiter usable to lock out any user (inherent lockout DoS) | Admin unlock refunds limiter; lockout window 15 min | Accepted | **ACCEPTED** — inherent trade-off of AC-7 lockout; mitigated by admin unlock and per-IP limits |

Validation after round 4: `bash -n` + ShellCheck clean; PowerShell parser + PSScriptAnalyzer clean;
`docker compose config` valid (and value-less variables confirmed unset in a container); launchd plist
parses; restore input checks exercised (symlinked `--in`, input inside `<data>`, input in a
world-writable non-sticky directory → refused; root-owned input → accepted). Earlier rounds: `nginx -t`,
`caddy validate` and functional setup-block tests pass; the symlink PoC is refused.

---

## 9. Vulnerability reporting and patch policy

* Report suspected vulnerabilities privately to the vendor security contact (set in the support
  contract); do not include PHI in reports.
* Severity follows CVSS v3.1/v4; target remediation: Critical 7 days, High 30 days, Medium 90 days.
* Node.js security releases that affect `http`, `https`, `crypto`, `sqlite` or `zlib` are treated as at
  least High for this product; bundles and the Docker base pin are refreshed accordingly.
