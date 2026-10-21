# YOU HEAL Clinical — Operations Runbook

Version 1.0 · October 2026 · Audience: clinic IT administrator, managed-service provider, vendor support.
Related: [`SECURITY.md`](SECURITY.md) (controls, shared responsibility), [`ARCHITECTURE.md`](ARCHITECTURE.md),
[`../deploy/reverse-proxy/README.md`](../deploy/reverse-proxy/README.md).

Conventions: `$` = unprivileged shell, `#` = root (the Linux/macOS scripts re-execute themselves through
`sudo`/`doas` when needed; the Windows scripts raise a UAC prompt). Every script supports `--help` /
`Get-Help`, a dry-run mode (`--dry-run` / `-DryRun`) and writes a 0600/ACL-protected log file.

---

## 1. Quick reference

| | Linux | macOS | Windows | Docker |
|---|---|---|---|---|
| App (code, read-only) | `/opt/youheal/current` → `releases/<ver>-<ts>` | same | `%ProgramFiles%\YouHeal\current` (junction) | `/app` in image |
| Data (0700 / ACL) | `/var/lib/youheal` | `/usr/local/var/youheal` | `%ProgramData%\YouHeal` | volume `youheal_data` at `/data` |
| Database | `<data>/db/youheal.sqlite` (+ `-wal`, `-shm`) | | | |
| Master key | `<data>/keys/master.key` (0600); retired: `<data>/keys/retired/*.key` | | `…\keys\master.key` (ACL) | Docker secret `/run/secrets/yh_master_key` |
| TLS | `<data>/tls/cert.pem`, `key.pem` | | | `/data/tls/…` (generated) or secrets |
| Config | `/etc/youheal/youheal.env` (0640 root:youheal), `install.state` | same | `%ProgramData%\YouHeal\config\youheal.env`, `install.state.json`, service XML in `%ProgramFiles%\YouHeal\service\` | `compose.yaml` + `.env` |
| Service | `systemctl status youheal` / `rc-service youheal status` | `launchctl print system/com.youheal.clinical` | `Get-Service YouHeal` | `docker compose ps` |
| Logs | `journalctl -u youheal` (OpenRC: `/var/log/youheal/youheal.log`) | `/usr/local/var/log/youheal/youheal.log` | `%ProgramData%\YouHeal\logs\YouHeal.*.log` (+ script logs) | `docker compose logs youheal`; `/data/logs/entrypoint.log` |
| Script logs | `/var/log/youheal-{install,backup,restore,upgrade,uninstall}.log` | same | `%ProgramData%\YouHeal\logs\<script>-<ts>.log` | — |
| Health | `node deploy/common/healthcheck.mjs` (env from config) — or `curl -k https://127.0.0.1:8443/api/v1/health` | | | `docker inspect -f '{{.State.Health.Status}}' youheal-youheal-1` |
| Port | 8443/tcp (TLS) | | | published on `127.0.0.1:8443` by default |

Package scripts are run with `node --run <name>` (no npm needed; equivalent to `npm run <name>`):
`migrate`, `catalog:load`, `create-admin`, `rotate-key -- --yes`, `backup [-- --out F | --verify F]`,
`restore -- <file> --yes`.

---

## 2. Installation

Prerequisites (all variants): a dedicated, patched host with **full-disk encryption**, correct time (NTP),
a static IP or DHCP reservation, and a decision on how users will trust the certificate (§4).

### 2.1 Docker (Linux host, Docker Engine ≥ 24 with Compose v2)

```sh
cd platform/deploy/docker
umask 077 && mkdir -p secrets && openssl rand -base64 32 > secrets/master.key
sudo chown 10001:10001 secrets/master.key && sudo chmod 0400 secrets/master.key
# escrow secrets/master.key NOW (§6.1)
YH_ALLOWED_HOSTS=clinic.lan,192.168.1.20 docker compose up -d --build   # names/IPs users browse to (F-05)
docker compose ps            # STATUS should become "healthy" within ~40 s
docker compose exec youheal cat /data/setup-token   # one-time first-run setup token (§3)
docker compose logs youheal  # entrypoint prints the generated certificate's SHA-256 fingerprint
```

Properties enforced by `compose.yaml`: read-only root filesystem, `tmpfs /tmp` (noexec), `cap_drop: ALL`,
`no-new-privileges`, uid/gid 10001, pids 256, memory 1 GiB, port bound to **127.0.0.1** (override with
`YH_BIND_ADDR`), master key as a file secret passed by path (`YH_MASTER_KEY_FILE`), named volume for
`/data`. The image contains no npm/npx/corepack. To expose on the LAN set `YH_BIND_ADDR=0.0.0.0` (or the
NIC address) **and** restrict the source subnet in the host firewall, or front it with a proxy.

Base-image pinning for production: build with `--build-arg NODE_IMAGE=node:<ver>-alpine<ver>@sha256:<digest>`
(Dockerfile header explains how to obtain the digest). Behind a TLS-intercepting egress proxy, pass its CA
as a BuildKit secret: `--secret id=build_ca,src=proxy-ca.pem` (never baked into a layer).

### 2.2 Linux (Debian/Ubuntu, RHEL/Rocky/Alma/Fedora, openSUSE, Alpine, Arch)

```sh
$ ./deploy/linux/install.sh --dry-run                       # review the plan (no root needed)
$ ./deploy/linux/install.sh --hostname clinic.lan \
      --open-firewall --firewall-source 192.168.1.0/24      # re-executes via sudo
```

The installer: detects OS/arch/init/package manager; ensures Node ≥ 22.13 (`--node-source auto`: an
adequate system node → an adequate distro package → the official nodejs.org tarball verified against
`SHASUMS256.txt`, installed privately under `<prefix>/runtime`); creates the `youheal` system account
(no login shell); installs the release; creates the data dir (0700); generates the master key (0600) and a
self-signed certificate (P-256 default, `--cert-algo rsa` for RSA-3072; SAN = FQDN, short name,
localhost, 127.0.0.1, ::1, every global IP; 825 days); writes `/etc/youheal/youheal.env` (0640
root:youheal); installs the hardened systemd unit (or OpenRC script); optionally opens ufw/firewalld;
runs migrations and the catalog load; starts the service; health-checks it; prints the setup URL and the
certificate fingerprint.

Useful options: `--prefix`, `--data-dir`, `--port`, `--host 127.0.0.1` (behind a local proxy),
`--trust-proxy` (forces `--host 127.0.0.1` unless `--trusted-proxies LIST`), `--public-origin URL`,
`--allowed-hosts LIST` (extra Host-header names; the installer always writes `YH_ALLOWED_HOSTS` from the
certificate SANs), `--tls-cert/--tls-key`, `--master-key-file` (DR), `--node-source
distro|tarball|system`, `--no-start`, `--init none`. Re-running is safe: unchanged releases are detected
by tree digest, keys and certificates are kept, local settings below the marker in `youheal.env` are
preserved.

Alpine: official Node tarballs are glibc-only, so the installer uses `apk add nodejs` (must be ≥ 22.13) or
fails with guidance; for Alpine hosts the Docker image is the preferred deployment.

Check the sandbox after install: `systemd-analyze security youheal` (expect an exposure score around
"OK"/"MEDIUM"; `MemoryDenyWriteExecute=no` is intentional — V8's JIT needs to make generated code
executable; use a drop-in adding `--jitless` to `ExecStart` if your policy requires MDWE).

### 2.3 macOS (13+)

Same script: `./deploy/linux/install.sh`. Creates a hidden `youheal` user via `dscl`, installs the
official darwin tarball (SHA-256 verified) unless an adequate node exists outside home directories,
writes `/Library/LaunchDaemons/com.youheal.clinical.plist` (KeepAlive, `Umask` 0077) and logs to
`/usr/local/var/log/youheal/`. `--open-firewall` adds node to the Application Firewall allow-list.

### 2.4 Windows (10/11, Server 2016+; Windows PowerShell 5.1 or PowerShell 7+)

```powershell
# from an elevated or normal PowerShell; the script self-elevates (UAC) and sets the execution policy
# to Bypass for its own process only:
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows\Install-YouHeal.ps1 -DryRun
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows\Install-YouHeal.ps1 `
    -HostName clinic.lan -OpenFirewall -FirewallRemoteAddress 192.168.1.0/24
```

Steps performed: Node.js ≥ 22.13 (existing machine-wide install, or the official MSI verified against
`SHASUMS256.txt` and Authenticode-checked; `-NodeSource Winget` to use winget instead); release copy to
`%ProgramFiles%\YouHeal\releases\…` with the `current` junction; data dir `%ProgramData%\YouHeal` with
inheritance removed and access for SYSTEM, Administrators and `NT SERVICE\YouHeal` only (SID-based, so
it works on localized Windows); master key; self-signed certificate created with
`New-SelfSignedCertificate`, exported to PEM (PKCS#8) and then **deleted from the certificate store**;
service registration through **WinSW 2.12.0** (SHA-256 pinned; rationale in ARCHITECTURE.md §7.1) running
as the virtual account `NT SERVICE\YouHeal`, delayed automatic start, restart on failure, rolling logs;
optional Windows Defender Firewall rule scoped to node.exe, TCP 8443, Domain/Private profiles and the
given remote addresses; migrations, catalog load, start, health check.

**Production code signing.** Sign all scripts and run under AllSigned:
```powershell
.\deploy\windows\Sign-Scripts.ps1 -Thumbprint '<40-hex thumbprint of a Code Signing cert>'
# Group Policy: Computer Configuration > Administrative Templates > Windows Components >
#   Windows PowerShell > Turn on Script Execution = "Allow only signed scripts"
# Import the signer certificate into "Trusted Publishers" on clinic hosts.
```
The scripts never change the machine-wide execution policy; they only set `Bypass` for their own
process, which a Group Policy setting overrides (and then signatures are required).

Optional hardening after install: restrict the service's privileges to the minimum
(`sc.exe privs YouHeal SeChangeNotifyPrivilege`), then restart and verify health.

### 2.5 Air-gapped / offline

On a connected build machine (no admin rights needed):
```sh
$ deploy/offline/build-bundle.sh --os linux --arch x64            # → dist/youheal-<ver>-linux-x64.tar.gz
PS> .\deploy\offline\build-bundle.ps1 -OS win -Arch x64           # → dist\youheal-<ver>-win-x64.zip
```
The bundle contains the app, the official Node runtime for the target (+ upstream `SHASUMS256.txt` and
`.asc`), WinSW for Windows, `BUNDLE.json`, `CHECKSUMS.sha256` and `SIGNATURES.md`. The builder **refuses**
to package a catalog containing `internal-use` (unlicensed) sources unless `--allow-internal-use` is given
— see REGULATORY.md §5. Publish the archive's SHA-256 out-of-band; sign `CHECKSUMS.sha256` per
`SIGNATURES.md`.

On the target: verify the archive hash, then
`sudo ./install.sh --offline-bundle /media/usb/youheal-<ver>-linux-x64.tar.gz` (or run the installer from
inside the extracted bundle — it is detected automatically), or
`Install-YouHeal.ps1 -OfflineBundle E:\youheal-<ver>-win-x64.zip`. The installers verify **every file**
against `CHECKSUMS.sha256` and abort on any mismatch.

---

## 3. First-run setup

The setup endpoint creates the clinic organisation and the first admin. It is accepted **only while no
users exist, only from a loopback address** (unless `YH_ALLOW_REMOTE_SETUP=1`), **never when the request
carries forwarding headers** (`X-Forwarded-For`, `Forwarded`, `X-Real-IP` — i.e. never through a reverse
proxy), and **only with the one-time setup token** the server writes to `<data>/setup-token` and prints in
its log at first start. Read the token as the service account / an administrator:

| Platform | Command |
|---|---|
| Linux | `sudo -u youheal cat /var/lib/youheal/setup-token` (or `journalctl -u youheal \| grep -i setup`) |
| macOS | `sudo -u youheal cat /usr/local/var/youheal/setup-token` |
| Windows | `Get-Content "$env:ProgramData\YouHeal\setup-token"` (elevated PowerShell), or the service log in `%ProgramData%\YouHeal\logs\` |
| Docker | `docker compose exec youheal cat /data/setup-token` (or `docker compose logs youheal`) |

The token is single-use and becomes invalid once setup completes. The CLI path (`create-admin`) does not
need it — it already requires root/Administrator on the host.

* **On the host**: browse `https://localhost:8443/#/setup` and paste the setup token.
* **From a workstation via SSH tunnel** (recommended for headless hosts):
  `ssh -L 8443:127.0.0.1:8443 admin@clinic-host`, then browse `https://localhost:8443/#/setup` on the
  workstation. The browser connects to its own loopback; SSH forwards to the server's loopback, so the
  server sees a loopback client. Windows Server: enable the OpenSSH Server feature, or use the CLI.
* **CLI** (interactive, needs a TTY):
  Linux: `sudo -u youheal sh -c 'set -a; . /etc/youheal/youheal.env; cd /opt/youheal/current; exec node --run create-admin'`
  (use the node path from `/etc/youheal/install.state` if node is not on PATH);
  Windows: `.\deploy\windows\Invoke-YouHealCli.ps1 create-admin`;
  Docker: `docker compose exec -it youheal node --run create-admin`.
* **Docker alternative**: set `YH_ALLOW_REMOTE_SETUP=1` once **while the port is bound to 127.0.0.1**,
  complete the wizard at `https://localhost:8443/#/setup` with the setup token, then unset it and
  `docker compose up -d`.

Immediately after setup: sign in as the admin, **enrol MFA** (mandatory for admins), create named accounts
for every staff member with the least role needed, complete the clinic profile, and record the master-key
fingerprint in the escrow log (§6.1).

---

## 4. TLS certificates

**Trusting the self-signed certificate**: compare the SHA-256 fingerprint printed by the installer (or
`openssl x509 -noout -fingerprint -sha256 -in <data>/tls/cert.pem`) with what the browser shows before
accepting; better, import `cert.pem` into each workstation's trust store (GPO/MDM) so no warning appears.

**Replacing with a CA-issued certificate** (recommended):
* Linux/macOS: `sudo ./install.sh --tls-cert /path/fullchain.pem --tls-key /path/privkey.pem` (validates
  that key and certificate match, installs into `<data>/tls/`, restarts).
* Windows: `Install-YouHeal.ps1 -TlsCertPath C:\certs\fullchain.pem -TlsKeyPath C:\certs\privkey.pem`.
* Docker: add secrets `yh_tls_cert`/`yh_tls_key` (commented in `compose.yaml`) or replace
  `/data/tls/cert.pem` + `key.pem` in the volume; `docker compose restart`.
* Behind a reverse proxy, the public certificate lives on the proxy (deploy/reverse-proxy).

**Regenerating** the self-signed certificate (expiry, hostname/IP change): `install.sh --regen-cert`,
`Install-YouHeal.ps1 -RegenerateCert`, or delete `/data/tls/*.pem` in Docker and restart. The installers
warn when the certificate expires within 30 days. If a proxy verifies the backend, recopy `cert.pem`.

---

## 5. Configuration reference

Set in `youheal.env` (Linux/macOS/Windows; below the "local settings" marker for anything not managed by
the installer) or the compose `environment:` block. Invalid values stop the server at start-up.

| Variable | Default | Meaning |
|---|---|---|
| `YH_HOST` | `127.0.0.1` (installers: `0.0.0.0`) | Listen address. Plain HTTP is refused on non-loopback unless TLS, `YH_TRUST_PROXY` or `YH_ALLOW_INSECURE_HTTP=1` |
| `YH_PORT` | 8443 with TLS, 8080 without | Listen port (installers require ≥ 1024) |
| `YH_DATA_DIR` | `<app>/data` | Runtime data root |
| `YH_DB_PATH` | `<data>/db/youheal.sqlite` | Database file |
| `YH_TLS_CERT` / `YH_TLS_KEY` | auto: `<data>/tls/cert.pem`/`key.pem` | PEM certificate (chain) and key |
| `YH_MASTER_KEY_FILE` / `YH_KEYS_DIR` | `<data>/keys/master.key` / `<data>/keys` | Master key file; retired keys in `<keys>/retired/` |
| `YH_MASTER_KEY` | — | Base64 key in the environment (avoid; prefer the file) |
| `YH_CATALOG_DIR` | `<data>/catalog` (installers set `<app>/data/catalog`) | Catalog JSON |
| `YH_CATALOG_LICENSES` | all | Comma list filter, e.g. `licensed,original,public-domain` (ADR-007) |
| `YH_CATALOG_STRICT` | `1` | Fail catalog load on validation errors |
| `YH_TRUST_PROXY` | `0` | Number of trusted proxy hops (deploy/reverse-proxy). Installers force `YH_HOST=127.0.0.1` with it unless trusted proxies are named |
| `YH_TRUSTED_PROXIES` | loopback | Peers allowed to send `X-Forwarded-*` (comma list of IPs/CIDRs; installers: `--trusted-proxies` / `-TrustedProxies`) |
| `YH_PUBLIC_ORIGIN` | — | External origin for the Origin check behind a proxy |
| `YH_ALLOWED_HOSTS` | localhost, loopback IPs, machine hostname, bound IP, `YH_PUBLIC_ORIGIN` host | Host-header allow-list (DNS-rebinding defence). Installers write it from the certificate names/IPs (+ `--allowed-hosts` / `-AllowedHosts`); **Docker: set it** to the name/IP users browse to |
| `YH_MAX_CONNECTIONS` | server default | Cap on concurrent connections (resource-exhaustion defence) |
| `YH_ALLOW_REMOTE_SETUP` | `0` | Allow first-run setup from non-loopback clients (temporary use only) |
| `YH_SESSION_IDLE_MIN` / `YH_SESSION_ABS_HOURS` | 15 / 12 | Session timeouts |
| `YH_LOCKOUT_ATTEMPTS` / `YH_LOCKOUT_MIN` | 5 / 15 | Account lockout |
| `YH_RATE_AUTH_BURST`, `YH_RATE_AUTH_PER_MIN`, `YH_RATE_API_BURST`, `YH_RATE_API_PER_MIN` | 10, 10, 300, 600 | Per-IP rate limits |
| `YH_LOG_LEVEL` | `info` | `debug|info|warn|error|silent` |
| `YH_WEB_DIR`, `YH_STATIC_MAX_AGE` | `<app>/web`, 300 | Static assets |
| Docker entrypoint only | | `YH_TLS_DISABLE`, `YH_TLS_HOSTNAME`, `YH_TLS_SAN`, `YH_TLS_KEY_ALG` (`ec`/`rsa`), `YH_TLS_DAYS`, `YH_AUTO_MIGRATE`, `YH_AUTO_CATALOG`, `YH_GENERATE_MASTER_KEY` (dev only), `YH_HEALTH_SCHEME` |

After editing: `systemctl restart youheal` / `rc-service youheal restart` / launchd `kickstart -k` /
on Windows re-run `Install-YouHeal.ps1` (it regenerates the WinSW XML from `youheal.env`) / `docker compose up -d`.

---

## 6. Key management

### 6.1 Escrow (mandatory)

The master key decrypts all PHI and every backup. Without it, data is **unrecoverable**; with it, anyone
holding a backup can read PHI. Procedure, immediately after installation and after every rotation:

1. Read the key on the host as root/Administrator (`cat <data>/keys/master.key`, or `Get-Content`).
2. Make **two** copies: e.g. printed on paper (with a QR code if desired) in tamper-evident envelopes, or
   on two encrypted USB drives (BitLocker To Go / VeraCrypt) with separately held passphrases.
3. Store in **two separate secure locations** (office safe + bank deposit box / owner's home safe). Never
   store a key copy with the backups.
4. Record in the **custody log**: date, key fingerprint (printed by the installer: first 16 hex of
   SHA-256 of the key bytes), who created/sealed, locations, envelope seal numbers.
5. Also escrow **retired** keys (`<data>/keys/retired/*.key`) until every backup encrypted under them has
   aged out of retention.

### 6.2 Rotation

Rotate after suspected exposure, staff departure with key access, or annually per policy.
`rotate-key` re-encrypts every PHI field, blind index and the audit anchor in one transaction; the old
key moves to `keys/retired/<keyId>.key` (decrypt-only, so older backups stay restorable). **The server
must be stopped; take a backup first.**

```sh
# Linux
sudo ./deploy/linux/backup.sh
sudo systemctl stop youheal
sudo -u youheal sh -c 'set -a; . /etc/youheal/youheal.env; cd /opt/youheal/current; exec node --run rotate-key -- --yes'
sudo systemctl start youheal
```
```powershell
# Windows
.\deploy\windows\Backup-YouHeal.ps1; Stop-Service YouHeal
.\deploy\windows\Invoke-YouHealCli.ps1 rotate-key --yes
Start-Service YouHeal
```
Docker: the key is a read-only secret, so rotation is offline: `docker compose stop`; copy the current
secret into the volume (`docker compose run --rm --no-deps -v "$PWD/secrets/master.key:/tmp/k:ro"
--entrypoint sh youheal -c 'cp /tmp/k /data/keys/master.key && chmod 600 /data/keys/master.key'`); run
`docker compose run --rm --no-deps -e YH_MASTER_KEY_FILE=/data/keys/master.key --entrypoint node youheal
--run rotate-key -- --yes`; copy the new `/data/keys/master.key` out to `secrets/master.key` (keep
`/data/keys/retired/`), remove it from the volume, `docker compose up -d`.

Then escrow the new key (§6.1) and verify: sign in, open a patient, `GET /api/v1/audit/verify` → `ok`.

### 6.3 Importing a key (disaster recovery / host replacement)

`install.sh --master-key-file /secure/master.key` or `Install-YouHeal.ps1 -MasterKeyPath …` installs an
escrowed key on a new host (refuses to overwrite a different existing key unless forced; the old one is
retired, not deleted). `restore.sh --master-key-file` / `Restore-YouHeal.ps1 -MasterKeyPath` do the same as
part of a restore.

---

## 7. Backup, restore and DR testing

### 7.1 What is backed up
`backup` produces `*.yhbak`: a transactionally consistent `VACUUM INTO` snapshot, gzip-compressed and
encrypted with AES-256-GCM under the backup subkey; the header (app version, schema, key id, timestamp) is
authenticated. It runs **online** (no downtime). The master key, TLS key and configuration are **not**
included — escrow the key (§6.1); config is reproducible with the installer.

### 7.2 Scheduling and retention

```sh
sudo ./deploy/linux/backup.sh --keep 30 --copy-to /mnt/offsite/youheal             # one-off
sudo ./deploy/linux/backup.sh --install-cron "17 2 * * *" --keep 30 --copy-to /mnt/offsite/youheal
```
```powershell
.\deploy\windows\Backup-YouHeal.ps1 -InstallSchedule -At 02:17 -Keep 30 -CopyTo \\nas\youheal
```
Each run: writes `youheal-<host>-<UTC>.yhbak` (0600, service-owned) + `.sha256`, re-verifies the GCM tag
with `backup --verify`, copies to `--copy-to` and verifies the copy's hash, and keeps the newest N in each
location. Docker: `docker compose exec youheal node --run backup` (writes to `/data/backups`), then copy
out with `docker compose cp`.

Follow **3-2-1**: three copies, two media, one offsite — and at least one **offline/immutable** copy
(ransomware). Backups contain only ciphertext, so cloud/NAS storage does not expose PHI as long as the key
is held separately.

### 7.3 Restore

```sh
sudo ./deploy/linux/restore.sh --in /mnt/offsite/youheal/youheal-clinic01-20261020T021700Z.yhbak
```
```powershell
.\deploy\windows\Restore-YouHeal.ps1 -InputFile E:\youheal-clinic01-20261020T021700Z.yhbak
```
The script verifies the `.sha256`, asks for confirmation, stops the service, takes a cold safety snapshot of
`db/` (never `keys/`; 0600, written by the service account), runs the application restore (which verifies the GCM tag and SQLite integrity **before**
replacing the DB and keeps its own `.pre-restore-*` copy), applies migrations (an older backup is brought
forward), starts and health-checks. On any failure it **rolls back** to the snapshot automatically (and
reinstates the previous master key if one was replaced) and **keeps** the snapshot for analysis; after a
successful restore the snapshot is **deleted**. A key replaced via `--master-key-file` is kept as a
decrypt-only retired key in `keys/retired/`.
Docker: `docker compose stop youheal && docker compose run --rm --no-deps --entrypoint node youheal --run
restore -- /data/backups/<file>.yhbak --yes && docker compose up -d`.

If a restore fails *and* rollback reports "NOT healthy": stop the service, extract the
`pre-restore-*.tar.gz`/`.zip` snapshot from `<data>/backups/` back into `<data>/` **as the service
account** (`sudo -u youheal tar -xzf <snapshot> -C <data>`), start, and contact support with the restore log.

**Symlink/junction protection (F-03).** The scripts run as root/Administrator but the data directory is
writable by the service account. They therefore never write, `chmod`/`chown` or recursively delete
*inside* it as root: all such operations run as the service account, and every run first scans the data
directory and **aborts if it contains any symlink (Linux/macOS) or reparse point/junction (Windows)**.
If you see "refusing to continue: symlinks found…", treat it as a possible compromise of the service
account (§10).

### 7.4 DR test procedure (quarterly; evidence for CP-4 / §164.308(a)(7)(ii)(D))

1. Pick the latest offsite backup and the escrowed key (exercise the escrow retrieval itself).
2. On a scratch host/VM (isolated network): install the same version
   (`install.sh --master-key-file <escrowed key> --no-start` or Docker with the key as secret).
3. `restore.sh --in <backup> --yes` (Docker: the `restore` command above).
4. Verify: health OK; admin login with MFA; open three known patients (names/DOB decrypt correctly);
   open a finalized report and compare its footer hash with the original; `GET /api/v1/audit/verify`
   returns `ok: true`.
5. Record: date, backup file + SHA-256, backup age (RPO achieved), elapsed time (RTO achieved), verifier,
   issues. Destroy the scratch instance with `uninstall.sh --purge --force` (§11).

Targets for a typical clinic: **RPO ≤ 24 h** (daily backup), **RTO ≤ 4 h** (new host + restore).

---

## 8. Upgrades and rollback

```sh
sudo ./deploy/linux/upgrade.sh --from /tmp/youheal-1.1.0-linux-x64.tar.gz     # or a source tree
```
```powershell
.\deploy\windows\Upgrade-YouHeal.ps1 -From D:\youheal-1.1.0-win-x64.zip
```
Sequence: preflight (bundle checksums, version, Node engine requirement) → encrypted backup → stop →
cold DB snapshot (`<data>/backups/pre-upgrade-<oldver>-<ts>.*`, db only, deleted after success) → the **new** release's installer stages it
beside the old one and switches `current` → migrations + catalog load → start → health check. Any failure
triggers **automatic rollback**: `current` back to the previous release, DB snapshot restored, previous
env/state/service definition restored, service restarted and health-checked.

Docker: `docker compose pull` (or `build`) then `docker compose up -d`; the entrypoint migrates. Before
that, take a backup; to roll back, redeploy the previous image tag **and** restore the pre-upgrade backup
(migrations are forward-only).

**Manual rollback later** (after the automatic window): stop the service; point `current` at the previous
directory in `<prefix>/releases/` (`ln -sfn …` / recreate the junction); restore the pre-upgrade `.yhbak`
(written to `<data>/backups/` at step 2) with `restore.sh` / `Restore-YouHeal.ps1`; start. Old releases are pruned to
`--keep-releases` (default 3).

---

## 9. Monitoring, logs, break-glass

* **Health**: `GET /api/v1/health` → `{"status":"ok","version","catalogVersion"}`. Docker HEALTHCHECK every
  30 s; installers and upgrades probe with `deploy/common/healthcheck.mjs` (loopback; verifies the
  self-signed certificate when available).
* **Application logs** are JSON lines (no PHI, tokens or passwords by design); access lines carry request
  ids that match audit rows. journald retention is governed by `/etc/systemd/journald.conf`.
* **Audit review**: auditor/admin role → Audit view, or `GET /api/v1/audit?action=…&actor=…`; integrity:
  `GET /api/v1/audit/verify`.
* **Break-glass admin access** (§164.312(a)(2)(ii)): if every admin is locked out or loses MFA, an
  operator with root/Administrator on the host runs `create-admin -- --email <admin> --reset-mfa` (§3 CLI
  forms). This unlocks/resets the account and writes a `cli.admin.reset` audit record. Review it afterwards.
* **Service will not start**: check the log for `Configuration error:` (invalid env), key-file permission
  errors (`chmod 600`), `refusing to serve PHI over plain HTTP` (TLS missing), or port conflicts.

---

## 10. Incident response — suspected PHI breach

This runbook supports, but does not replace, the clinic's own incident-response plan and legal advice.

### 10.1 Detect and triage (hour 0)
Triggers: unexplained audit entries (bulk `patient.read`, off-hours `backup.export`), `audit/verify`
returning `ok:false`, lost/stolen device or backup media, ransomware, a misdirected report. Open an incident
record; note **date/time of discovery** (HIPAA: a breach is treated as discovered on the first day it is
known — or by exercising reasonable diligence would have been known — to any workforce member other than
the person committing it, 45 CFR §164.404(a)(2)).

### 10.2 Contain and preserve
* Disable affected accounts (`PATCH /users/:id {active:false}`); force password resets; re-enrol MFA.
* If host compromise is suspected: isolate it from the network but **do not power it off** before
  capturing volatile evidence if you have that capability; otherwise preserve disks.
* Preserve evidence read-only: `audit/verify` JSON, `GET /audit` export for the window, service and script
  logs, proxy logs, a copy of the DB and WAL (ciphertext), OS logs. Compute SHA-256 of each artefact and
  keep a chain-of-custody log.
* If the **master key** may be exposed: after preservation, rotate it (§6.2) and treat all backups
  encrypted under the old key as potentially readable by the attacker.

### 10.3 Assess (HIPAA four-factor risk assessment, §164.402(2))
An impermissible use/disclosure of PHI is **presumed to be a breach** unless a documented risk assessment
shows a low probability of compromise, considering: (1) nature and extent of PHI (identifiers, sensitivity,
likelihood of re-identification); (2) the unauthorized person who used/received it; (3) whether PHI was
actually acquired or viewed (audit `patient.read`/`report.read` rows help here); (4) extent to which the
risk was mitigated (e.g., assurances of destruction).
**Encryption safe harbor**: PHI that was encrypted per HHS guidance and whose key was **not** compromised
is not "unsecured PHI" — loss of a `.yhbak`, DB file or stolen disk containing only ciphertext, with the key
held elsewhere, is generally not a reportable breach. Document the reasoning either way.

### 10.4 Notify — HIPAA Breach Notification Rule timelines (covered entity)
| Recipient | When | Reference |
|---|---|---|
| Affected individuals | Without unreasonable delay, **no later than 60 calendar days after discovery**; first-class mail (or e-mail if agreed); substitute notice if contact info is insufficient | §164.404 |
| Prominent media | If **more than 500 residents of a State/jurisdiction** are affected: same 60-day limit | §164.406 |
| HHS Secretary | **500 or more** individuals: contemporaneously with individual notice (within 60 days) via the HHS breach portal. **Fewer than 500**: log and report **within 60 days after the end of the calendar year** of discovery | §164.408 |
| Covered entity (if the reporter is a business associate, e.g. SaaS vendor) | Without unreasonable delay, no later than 60 days after discovery, with identities of affected individuals | §164.410 |
| Law-enforcement delay | Notification may be delayed if law enforcement states it would impede an investigation | §164.412 |

Also check **state breach-notification laws** (some impose shorter deadlines or apply to non-HIPAA
entities) and, for non-HIPAA practitioners, applicable consumer-health-data laws and the **FTC Health
Breach Notification Rule** (16 CFR Part 318) where relevant (REGULATORY.md §3). Notification content must
include what happened, the types of PHI involved, steps individuals should take, what the entity is doing,
and contact procedures (§164.404(c)).

### 10.5 Recover and learn
Rebuild compromised hosts from clean media; restore from a pre-incident backup (§7.3); rotate the key and
TLS certificate; reset credentials; review firewall exposure; run `audit/verify`. Post-incident review
within 2 weeks; update the risk register (SECURITY.md §7). Retain incident documentation for **at least
6 years** (§164.316(b)(2), §164.530(j)).

---

## 11. Decommissioning (crypto-erase)

```sh
sudo ./deploy/linux/uninstall.sh --purge          # asks you to type "PURGE <hostname>"
```
```powershell
.\deploy\windows\Uninstall-YouHeal.ps1 -Purge     # asks you to type "PURGE <COMPUTERNAME>"
```
Docker: `docker compose down`, then destroy the secret file (`shred -u secrets/master.key`) and
`docker volume rm youheal_data`.

`--purge` first overwrites (3 passes) and deletes the **master key and all retired keys**, then deletes the
data directory, logs and the service account. Because all PHI and backups are encrypted, destroying every
copy of the keys renders **all remaining copies — including offsite backups — undecryptable**
(cryptographic erase, NIST SP 800-88 Rev. 1). Overwriting individual files is not reliable on SSDs and
copy-on-write/snapshotting filesystems; crypto-erase is what makes the result trustworthy.

Checklist (MP-6 evidence):
1. Export what must be retained under the clinic's records-retention obligations (state medical-records
   laws often require years of retention) **before** purging — e.g. a final backup + key kept under the
   records custodian's control.
2. Run the purge; keep the uninstall log.
3. **Destroy every escrowed key copy** (paper: cross-cut shred; USB: physically destroy or secure-erase)
   and Windows VSS snapshots / VM snapshots / filesystem snapshots containing the key.
4. Sanitize or destroy the host's disks per NIST SP 800-88 if the hardware leaves the clinic.
5. Sign a sanitization record: date, host, method, key fingerprints destroyed, witness.

Without `--purge`, uninstall removes the service, code, configuration, firewall rule and backup schedule but
**keeps** `<data>` (database, keys, TLS, backups) and a copy of the configuration in
`<data>/uninstalled-config/` for reinstallation.

---

## 12. Script reference

| Script | Purpose | Key options |
|---|---|---|
| `deploy/linux/install.sh` | Install/update (Linux, macOS) | `--dry-run --prefix --data-dir --host --port --hostname --san --tls-cert/--tls-key --cert-algo --regen-cert --master-key-file --trust-proxy --public-origin --node-source --offline-bundle --open-firewall --firewall-source --init --no-start` |
| `deploy/linux/backup.sh` | Encrypted backup + rotation | `--keep --out-dir --copy-to --install-cron [SCHED] --remove-cron` |
| `deploy/linux/restore.sh` | Restore with rollback | `--in --master-key-file --no-safety-backup -y` |
| `deploy/linux/upgrade.sh` | Upgrade with rollback | `--from --skip-backup --keep-releases -y` |
| `deploy/linux/uninstall.sh` | Remove (keep data) / purge | `--purge --force --remove-user --keep-runtime` |
| `deploy/windows/Install-YouHeal.ps1` | Install/update (Windows) | `-DryRun -Prefix -DataDir -BindHost -Port -HostName -Sans -TlsCertPath/-TlsKeyPath -CertAlgorithm -RegenerateCert -MasterKeyPath -TrustProxy -PublicOrigin -NodeSource -OfflineBundle -WinSWPath -OpenFirewall -FirewallRemoteAddress -NoStart` |
| `deploy/windows/Backup-YouHeal.ps1` | Backup + retention + Scheduled Task | `-Keep -OutDir -CopyTo -InstallSchedule -At -RemoveSchedule` |
| `deploy/windows/Restore-YouHeal.ps1` | Restore with rollback | `-InputFile -MasterKeyPath -NoSafetyBackup -Force` |
| `deploy/windows/Upgrade-YouHeal.ps1` | Upgrade with rollback | `-From -SkipBackup -Force` |
| `deploy/windows/Uninstall-YouHeal.ps1` | Remove / purge | `-Purge -Force` |
| `deploy/windows/Invoke-YouHealCli.ps1` | Run `create-admin`, `rotate-key`, … with installed config | `<script> [args]` |
| `deploy/windows/Sign-Scripts.ps1` | Authenticode-sign scripts | `-Thumbprint -StoreLocation -TimestampServer` |
| `deploy/offline/build-bundle.sh` / `.ps1` | Air-gapped bundle | `--os --arch --node-version --allow-internal-use` / `-OS -Arch -AllowInternalUse` |
| `deploy/docker/entrypoint.sh` | Container start-up | `--help`, `--dry-run` |
| `deploy/common/healthcheck.mjs` | Liveness probe | `--url --ca --retries --interval --timeout --quiet` |
