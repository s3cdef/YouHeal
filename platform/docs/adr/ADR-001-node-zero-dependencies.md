# ADR-001 — Node.js ≥ 22.13 LTS with zero runtime npm dependencies

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10 |
| **Deciders** | Principal Software Architect; DevOps / Platform Security |
| **Controls** | SR-3, SR-5, SR-11, SA-22, CM-7, CM-11, SI-2, SI-7 (NIST SP 800-53 Rev 5) |

## Context

YOU HEAL Clinical stores and processes PHI. It ships first as an on-premises product installed on a single
clinic computer — often by a non-specialist, sometimes with no Internet access — on Linux, macOS or
Windows. Later the same code base becomes a multi-tenant SaaS.

A typical Node web stack pulls hundreds of transitive npm packages. Each is a supply-chain attack path
(account takeover, typosquatting, malicious `postinstall`), each must be inventoried in an SBOM, tracked
for CVEs and re-assessed when it changes, and native add-ons (SQLite drivers, bcrypt, argon2) need a
compiler toolchain on Windows — which a clinic will not have and which breaks offline installs.

Node.js 22 LTS ("Jod", maintenance LTS until April 2027) provides everything the server needs in its
standard library: `node:http`/`https`, `node:crypto` (AES-GCM, HKDF, HMAC, scrypt, CSPRNG), `node:sqlite`
(embedded SQLite, available without a flag from 22.13), `node:zlib`, `node:test`, and `node --run` for
package scripts.

## Decision

* The server runs on **Node.js ≥ 22.13** and declares **no `dependencies`** in `package.json`.
* Only built-in modules are imported: `node:http`, `node:https`, `node:crypto`, `node:sqlite`, `node:fs`,
  `node:path`, `node:url`, `node:zlib`, `node:test` (and their submodules).
* Build-time tooling (e.g. the PDF importer's use of poppler `pdftotext`) never ships in the runtime image.
* The deployment scripts install exactly one third-party runtime artefact — the official Node.js build —
  verified against the release's `SHASUMS256.txt` (and optionally its GPG-clearsigned `.asc`). The Docker
  image removes `npm`, `npx`, `corepack` and `yarn`; package scripts run with `node --run`.

## Consequences

**Positive**
* The runtime SBOM is: Node.js (+ its bundled OpenSSL, libuv, V8, SQLite), the application, vendored
  three.js (ADR-004), and — on Windows — WinSW. Vulnerability management (RA-5, SI-2) reduces to tracking
  Node.js security releases.
* Offline/air-gapped install is a file copy plus one verified runtime archive (`deploy/offline/`).
* No native compilation on any OS; identical behaviour across Linux, macOS, Windows and containers.

**Negative / accepted risks**
* The team writes and maintains code that libraries would otherwise provide (router, validator, TOTP,
  CSRF, rate limiting). Mitigated by a focused `node:test` suite and by keeping each module small.
* `node:sqlite` is marked *experimental* in Node 22 (hence `--disable-warning=ExperimentalWarning`).
  Its API surface used here is small and isolated behind `server/lib/db.js` (ADR-002).
* Node 22 leaves maintenance in April 2027: the platform must be validated on the next LTS (Node 24)
  before then. `engines` is `>=22.13`, so newer majors are accepted by the installers.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Express/Fastify + better-sqlite3 + bcrypt + helmet | 100+ transitive packages; native builds on Windows; larger SR/RA burden. |
| Deno / Bun single binary | Smaller ecosystem knowledge in clinics' IT providers; SQLite and crypto APIs less settled for our needs at decision time; Node has the longest LTS track record. |
| Go or Rust single static binary | Strong option for supply chain, but the team's skill set and the shared JS between browser and server favoured Node; may be revisited for the SaaS edge services. |
| Electron desktop app | Ships Chromium (huge patch surface), still needs a server for multi-workstation clinics. |
