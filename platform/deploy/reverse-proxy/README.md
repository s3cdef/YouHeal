# Reverse proxy (optional)

Put nginx or Caddy in front of YOU HEAL Clinical when the clinic wants a **CA-issued certificate on
port 443**, a single hostname, or centralised TLS policy. Without a proxy the app terminates TLS itself
on port 8443 with the installer-generated (or operator-supplied) certificate — that is a fully supported
configuration.

| File | Purpose |
|---|---|
| `nginx.conf` | nginx ≥ 1.25.1 server blocks (HTTP→HTTPS redirect, TLS 1.2/1.3, HSTS, 5 MB body cap, backend TLS verification) |
| `Caddyfile` | Caddy v2 equivalent (ACME, file certificate, or `tls internal`) |

## Required backend settings

| Variable | Value | Why |
|---|---|---|
| `YH_HOST` | `127.0.0.1` | Only the proxy can reach the app. |
| `YH_TRUST_PROXY` | `1` | One trusted hop. The server takes the client IP from the **right-most** `X-Forwarded-For` entry (the one the proxy appends), scheme from `X-Forwarded-Proto`, host from `X-Forwarded-Host`. Use `2` only for two proxies you control in series. |
| `YH_PUBLIC_ORIGIN` | `https://clinic.example.org` | Origin/Referer check on state-changing requests must match what browsers send. |

With the Linux installer: `sudo ./deploy/linux/install.sh --host 127.0.0.1 --trust-proxy --public-origin https://clinic.example.org`.
With Windows: `Install-YouHeal.ps1 -BindHost 127.0.0.1 -TrustProxy -PublicOrigin https://clinic.example.org`.
With Docker: set `YH_TRUST_PROXY=1` and `YH_PUBLIC_ORIGIN` in the environment; keep the port bound to `127.0.0.1`.

> **Never** set `YH_TRUST_PROXY` on an instance that clients can reach directly: they could forge
> `X-Forwarded-For`, defeating per-IP rate limiting (AC-7), the IP recorded in the audit trail (AU-3)
> and the loopback-only first-run setup guard.

## Backend TLS

The examples keep TLS between proxy and app (defense in depth, and it keeps the app's fail-closed
"no plain HTTP on non-loopback" rule meaningful). The proxy verifies the app's self-signed certificate
against a copy of it, with SNI/verification name `localhost` (always present in the generated SAN):

```sh
sudo install -m 0644 /var/lib/youheal/tls/cert.pem /etc/nginx/youheal-backend.crt   # or /etc/caddy/…
```

Repeat after the app certificate is regenerated (every ≤ 825 days, or after `--regen-cert`).

## Hardening notes

* `/api/v1/setup` is blocked at the proxy (the app refuses it anyway for non-loopback clients).
* No response compression (BREACH); no proxy caching of authenticated responses.
* HSTS is set once, by the proxy (`proxy_hide_header` / `header` replace the app's value).
* Body limit 5 MB at the proxy; the app enforces 1 MB generally and 4 MB on the report-image route.
* Proxy access logs contain URLs and client IPs (no bodies, no PHI by API design) — protect and rotate
  them as audit records (AU-9, AU-11).
