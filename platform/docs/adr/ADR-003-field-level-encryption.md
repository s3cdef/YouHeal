# ADR-003 — Field-level AES-256-GCM encryption of PHI with a master key and blind indexes

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10 |
| **Controls** | SC-28, SC-28(1), SC-12, SC-13, MP-6 (crypto-erase), CP-9(8); HIPAA §164.312(a)(2)(iv), §164.312(e)(2)(ii); §164.402 "unsecured PHI" safe harbor |

## Context

Clinic hosts are frequently desktop PCs without full-disk encryption, shared with other software, and
backed up to USB drives or consumer cloud folders. A stolen laptop or a copied database file must not
disclose PHI. Under HIPAA, PHI encrypted consistent with HHS guidance (NIST SP 800-111 for data at rest)
is not "unsecured PHI", so its loss is not a reportable breach **provided the key was not also
compromised** (45 CFR §164.402; HHS Guidance to Render Unsecured PHI Unusable).

## Decision

* PHI columns (patient names, DOB, contact data, notes, finding notes, …) are encrypted **per field**
  with **AES-256-GCM**, 96-bit random IV, and AAD binding the ciphertext to `<table>.<column>:<rowId>` so
  values cannot be swapped between rows/columns. Stored format: `v1:<keyId>:<iv b64>:<tag b64>:<ct b64>`.
* A 32-byte **master key** comes from `YH_MASTER_KEY` (base64), or the key file `YH_MASTER_KEY_FILE`
  (default `<data>/keys/master.key`, mode 0600, checked at start-up on POSIX). Purpose-specific subkeys
  are derived with **HKDF-SHA256**: field encryption, blind index, backup, audit anchor, key id.
* **Blind indexes** (HMAC-SHA256 with the separate blind-index subkey over a normalized value) allow
  exact-match search on last name, DOB and MRN without decrypting the table.
* **Key rotation** (`npm run rotate-key -- --yes`) re-encrypts with a new key; retired keys move to
  `keys/retired/` and remain decrypt-only (old backups stay restorable).
* Backups are encrypted with the backup subkey; **the key is never inside a backup**.
* Deployment: installers generate the key with a CSPRNG, store it 0600 / ACL-restricted to the service
  account, never in the env file, never in logs; Docker passes it as a secret file by path.

## Consequences

**Positive**: database files, WAL, snapshots and backups are useless without the key; crypto-erase is
possible by destroying keys (decommissioning, NIST SP 800-88 Rev. 1); the SaaS path upgrades the
master key to a KMS-wrapped per-tenant data key without changing the ciphertext format (keyId field).

**Negative / residual risks**
* On-prem the key sits on the **same host** as the data (file 0600). It protects against file/DB/backup
  exfiltration and media loss, **not** against a full compromise of the running host or root/admin
  access. Host FDE (BitLocker/FileVault/LUKS) is a required compensating control (see SECURITY.md).
* Key loss = permanent data loss. Mandatory offline escrow (two sealed copies) — OPERATIONS.md §6.
* Encrypted columns cannot be range-queried or sorted in SQL; only exact-match via blind index.
* Blind indexes leak equality (two patients with the same last name share an index value).

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Rely on OS full-disk encryption only | Does not protect copied DB files, backups or a running-host file read; not portable to SaaS. |
| SQLCipher whole-DB encryption | Native dependency (ADR-001); all-or-nothing; no per-field AAD binding. |
| AES-CBC + HMAC | GCM is standard AEAD in `node:crypto`; simpler and less error-prone. |
| Password-derived key (unlock at boot) | Service could not start unattended after a reboot; acceptable only as a future option with a TPM/KMS. |
