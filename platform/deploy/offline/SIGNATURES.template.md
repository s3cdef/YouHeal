# Bundle signatures (placeholder)

This bundle is **unsigned**. `CHECKSUMS.sha256` protects against corruption in transit, not against a
malicious substitution of the whole bundle. Before production use, the release manager signs the checksum
file with an organisational key and installers verify it out-of-band. Any one of:

| Tool | Sign (release manager) | Verify (clinic, before install) |
|---|---|---|
| GnuPG | `gpg --armor --detach-sign --local-user <KEYID> CHECKSUMS.sha256` -> `CHECKSUMS.sha256.asc` | `gpg --verify CHECKSUMS.sha256.asc CHECKSUMS.sha256` |
| minisign | `minisign -S -s youheal.key -m CHECKSUMS.sha256` -> `CHECKSUMS.sha256.minisig` | `minisign -V -p youheal.pub -m CHECKSUMS.sha256` |
| cosign (keyless/KMS) | `cosign sign-blob --key <kms-uri> CHECKSUMS.sha256 > CHECKSUMS.sha256.sig` | `cosign verify-blob --key youheal.pub --signature CHECKSUMS.sha256.sig CHECKSUMS.sha256` |

Distribute the public key (or its fingerprint) through a separate channel (e.g. printed in the contract
or read over the phone). The Windows scripts inside `app/deploy/windows` should additionally be
Authenticode-signed with `Sign-Scripts.ps1` **before** the bundle is built.

The Node.js runtime carries its own upstream checksums (`runtime/SHASUMS256.txt`, clearsigned as
`runtime/SHASUMS256.txt.asc` by the Node.js release team; verify with the keys listed at
https://github.com/nodejs/node#release-keys).
