# Test YOU HEAL Clinical from an iPad or iPhone — no computer needed

GitHub Codespaces runs the platform for you in a GitHub-hosted cloud container and gives it a private HTTPS
address. Everything below is done in **Safari on the iPad or iPhone**. Use **fictitious data only**.

## First time (≈ 5 minutes)

1. In Safari, sign in at **github.com** and open the repository **s3cdef/YouHeal**.
2. Switch to the branch that contains the platform (the branch menu above the file list), e.g.
   `claude/biomagnetism-medical-platform-cdz2mb` (or `main` once it is merged).
3. Tap **Code → Codespaces → Create codespace on <branch>**. Wait ~1–2 minutes while it builds.
   A web editor opens; the platform starts automatically in the background.
4. Open the app. **Easiest on iPad/iPhone:** take the editor's address from Safari's address bar,
   e.g. `https://fuzzy-space-giggle-abc123.github.dev`, and insert **`-8080.app`** before `.github.dev`:
   `https://fuzzy-space-giggle-abc123-8080.app.github.dev`.
   Or use the **Ports** panel: it is a tab in the bottom panel next to **TERMINAL** (if the bottom panel is
   hidden: ☰ menu, top-left → View → Appearance → Panel; or ☰ → View → Command Palette → type
   `Ports: Focus on Ports View`). Port **8080 — "YOU HEAL Clinical (test)"** is listed; tap the 🌐 globe icon.
   Or in the Terminal type `cat /tmp/youheal-test.log` — the line "Open on iPad / iPhone" shows the address.
   - Keep that tab: it is your app address (`https://<codespace-name>-8080.app.github.dev`).
   - Share → **Add to Home Screen** for a full-screen app icon.
5. Sign-in accounts are in the editor's file list at **`platform/data-ipad-test/DEMO-CREDENTIALS.txt`**
   (created on first start; private to your codespace):
   - **Practitioner** — ready to use; three fictitious patients with intake already on file.
   - **Admin** — two-factor is already enrolled; add the printed key to an authenticator app
     (Google/Microsoft Authenticator → add account → enter setup key, time-based).

**White page, or nothing in the port's "Running Process" column?** The app isn't running. Open a terminal
(☰ menu → Terminal → New Terminal) and run:

```sh
git pull && bash platform/tools/codespace-start.sh
```
It checks Node (switching to Node 22 if the codespace has an older one), (re)starts the app, and prints
"app is RUNNING" with your address — or the error lines if it could not start. If it says nvm is missing, use
☰ → View → Command Palette → **Codespaces: Rebuild Container**, then run it again.

## Next times

github.com → profile menu → **Your codespaces** → tap the codespace to resume it. The app restarts
automatically with the same data and accounts. Codespaces stop after ~30 minutes idle (adjustable in GitHub
Settings → Codespaces → Default idle timeout, up to 4 hours) — stopping keeps your data; deleting it erases it.

## Sharing with another tester

The address is **private by default**: only you (signed in to GitHub) can open it. To let someone else test,
in the codespace Terminal run `gh codespace ports visibility 8080:public -c $CODESPACE_NAME`, share the
address, and give them an account created in Settings → Users. The app's own sign-in, rate limits and MFA
still apply. Set it back to private with `8080:private`.

## Cost and limits

Personal GitHub accounts include a monthly free Codespaces allowance (core-hours and storage — see
GitHub → Settings → Billing). With the default spending limit of $0 you are never charged; the codespace
simply stops when the allowance is used. A 2-core codespace is plenty for this app.

## Devices

| Device | Status |
|---|---|
| **iPad** (portrait and landscape) | Fully supported — layout and 3D/touch verified in iPad emulation; first real-Safari run is this test |
| **iPhone** | Sign-in, patients, catalog and reports work; the **scan workspace is not yet laid out for phone screens** (see `IPAD-TESTING.md` → Mobile version) |

## When to move to an always-on server

Codespaces is ideal for you testing on your own schedule. For several testers who need the app available
around the clock, use a small cloud VM (see `IPAD-TESTING.md` → *When a cloud server is worth it*); that can
also be set up entirely from the iPad using Azure Cloud Shell in Safari.
