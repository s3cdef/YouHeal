# Testing on iPad (and other tablets)

**No cloud server is needed.** The platform is a web application: the iPad uses Safari to talk to the server
running on any computer on the same Wi-Fi (or, optionally, anywhere via Tailscale). Use **fictitious data
only** on test instances.

## Quick start (same Wi-Fi) — about 5 minutes

On the computer (Windows, macOS or Linux, Node.js ≥ 22.13):

```powershell
# Windows (opens the firewall port; self-elevates only for that step)
powershell -ExecutionPolicy Bypass -File .\platform\deploy\windows\Start-YouHealIPadTest.ps1 -OpenFirewall
```
```sh
# macOS / Linux
platform/deploy/linux/ipad-test.sh --open-firewall      # or: cd platform && npm run ipad-test
```

The launcher creates a separate test instance in `platform/data-ipad-test/` (never your real data), a private
test certificate authority, a server certificate for this computer's Wi-Fi address, three fictitious patients
with intake on file, and two accounts. It prints:

```
 On the iPad (same Wi-Fi as this computer):
   1. Safari → http://192.168.1.20:8099/  → Allow → Settings → "Profile Downloaded" → Install
   2. Settings → General → About → Certificate Trust Settings → enable "YOU HEAL Clinical TEST CA"
   3. Safari → https://192.168.1.20:8443   (Share → Add to Home Screen for a full-screen app icon)
 Sign-in accounts (shown once — note them now):
   Practitioner  practitioner@demo.test   ••••••••   (ready to scan)
   Admin         admin@demo.test          ••••••••
                 MFA: add this key to an authenticator app (manual entry, time-based): ••••
```

Steps 1–2 are needed once per iPad (Apple requires a trusted certificate for secure sign-in cookies). The
certificate download closes automatically after 15 minutes. Stop with Ctrl+C; start fresh with `--reset`.

**Requirements:** LAN mode uses `openssl` (built into macOS/Linux; on Windows it comes with Git for Windows).
If the iPad cannot connect: both devices on the same network (not a guest/isolated Wi-Fi), firewall allows TCP
8443 and 8099, and the computer is awake.

## Alternative: Tailscale (no certificate install, works off-site)

Install [Tailscale](https://tailscale.com) (free personal tier) on the computer and the iPad, sign both into
the same tailnet, enable MagicDNS + HTTPS certificates, then:

```sh
cd platform && npm run ipad-test -- --mode tailscale     # Windows: ...Start-YouHealIPadTest.ps1 -Mode tailscale
```
The app is published privately at `https://<computer>.<tailnet>.ts.net` with a publicly trusted certificate,
reachable only by devices on your tailnet. Stop publishing with `tailscale serve --https=443 off`.

## When a cloud server (e.g. Azure) *is* worth it

| Situation | Needed? |
|---|---|
| You testing on your own iPad | No — use the quick start |
| Testers in other locations, short-term | No — Tailscale |
| Several clinics piloting continuously / the SaaS phase | Yes — one small Linux VM (Docker image in `deploy/docker`), TLS via the reverse-proxy examples, backups to blob storage |
| Real patient data in the cloud | Yes, **and** a signed HIPAA Business Associate Agreement with the provider, region selection, encryption and monitoring per `docs/SECURITY.md` |

A test VM costs on the order of tens of US dollars per month (check the provider's calculator) and adds operating
work: patching, backups, firewall, certificate renewal. It isn't needed for testing.

## What to test on the iPad (checklist)

- Sign in (practitioner), language switch EN/ES, dark mode
- Patient chart → intake & consent → start scan from protocol **19. Leg Circulation**
- 3D body: one-finger rotate, pinch zoom, two-finger pan, Front/Back/Left/Right, tap a point → panel → *Mark found*
- Findings: sides, phenomena, dwell timer; rotate the iPad mid-scan (portrait ↔ landscape); reload → checklist restored
- Finalize & sign (password re-entry) → report → Share → Print → pinch-out on the preview → *Save to Files* (PDF)
- Add to Home Screen and repeat a scan in full-screen mode
- Admin: sign in with the MFA code from the authenticator app; Settings → Language packs

Pre-verified in automated iPad emulation (Chromium with iPad Pro 11, iPad Mini, iPad gen 11 portrait and
landscape profiles, touch input): no horizontal scrolling, 3D body renders full height, tapping the body opens the
point panel. Safari's own engine (WebKit) has **not** been tested yet; the real-device run above covers it.

## Mobile version — overhead assessment

| Option | What it gives | Effort (engineering estimate) | Ongoing overhead |
|---|---|---|---|
| **Tablet (iPad / Android tablet) in the browser** | Full product, as above | **None** — supported now | None |
| **Installable web app (PWA)** | Home-screen icon, full-screen, faster start, offline app shell | ~1–2 days: manifest, icons, a service worker that caches the app and catalog only (never patient data) | Low |
| **Phone layout (< 600 px)** | Reference lookups, schedule, read reports, light scanning: single-column scan with bottom tabs (Protocol / Body / Findings) and bottom-sheet point panel | ~1–2 weeks incl. testing | Moderate (another layout to keep tested) |
| **Native App Store / Play Store apps** (same code wrapped with Capacitor) | Store distribution, device APIs | ~3–6 weeks incl. store review | High: Apple Developer Program (US$99/yr), Google Play (US$25 once), health-app review (no diagnostic claims — consistent with our "related to" wording), privacy labels, updates per OS release, and an internet-reachable server, i.e. the hosted/SaaS deployment |

**Recommendation:** test the tablet build now (zero cost). Add the PWA if home-screen launch matters to
clinicians. Do the phone layout only if practitioners ask for on-the-go reference use. Leave native store apps
until the SaaS phase, when there is a hosted server for them to connect to.
