# Reverse proxy (optional)

Put nginx or Caddy in front of YOU HEAL Clinical when the clinic wants a **CA-issued certificate on
port 443**, a single hostname, or centralised TLS policy. Without a proxy the app terminates TLS itself
on port 8443 with the installer-generated (or operator-supplied) certificate — that is a fully supported
configuration.

| File | Purpose |
|---|---|
| `nginx.conf` | nginx ≥ 1.25.1: HTTP→HTTPS redirect, TLS 1.2/1.3, HSTS, 5 MB body cap, backend TLS verification, setup block, auth rate limits, query-free access log |
| `Caddyfile` | Caddy ≥ 2.8 equivalent (ACME, file certificate, or `tls internal`), log filter without query strings |

## Required backend settings

| Variable | Value | Why |
|---|---|---|
| `YH_HOST` | `127.0.0.1` | Only the proxy can reach the app. `install.sh --trust-proxy` / `Install-YouHeal.ps1 -TrustProxy` **force** this unless trusted proxies are named explicitly. |
| `YH_TRUST_PROXY` | `1` | One trusted hop. The client IP is the **right-most** `X-Forwarded-For` entry (the one the proxy appends); scheme from `X-Forwarded-Proto`, host from `X-Forwarded-Host`. Use `2` only for two proxies you control in series. |
| `YH_TRUSTED_PROXIES` | unset (= loopback) | Peers allowed to send `X-Forwarded-*`. Set it only when the proxy runs on another host (`--trusted-proxies 10.0.0.5` / `-TrustedProxies 10.0.0.5`) or in Docker, where a host-side proxy arrives from the bridge gateway (e.g. `172.17.0.1`). Forwarding headers from any other peer are ignored. |
| `YH_PUBLIC_ORIGIN` | `https://clinic.example.org` | The Origin/Referer check on state-changing requests must match what browsers send. |
| `YH_ALLOWED_HOSTS` | includes `clinic.example.org` | Host-header allow-list (DNS-rebinding defence). The installers derive it from the certificate names/IPs and add the `--public-origin` host; add others with `--allowed-hosts`. |

Linux: `sudo ./deploy/linux/install.sh --trust-proxy --public-origin https://clinic.example.org`.
Windows: `Install-YouHeal.ps1 -TrustProxy -PublicOrigin https://clinic.example.org`.
Docker: set `YH_TRUST_PROXY=1`, `YH_TRUSTED_PROXIES=<bridge gateway>`, `YH_PUBLIC_ORIGIN`,
`YH_ALLOWED_HOSTS` in the environment; keep the port bound to `127.0.0.1`.

> Never let clients reach a backend that trusts forwarding headers: they could forge
> `X-Forwarded-For`, defeating per-IP rate limiting (AC-7) and the IP recorded in the audit trail (AU-3).

## Backend TLS

The examples keep TLS between proxy and app (defense in depth). The proxy verifies the app's self-signed
certificate against a copy of it, with SNI/verification name `localhost` (always in the generated SAN).
Copy it **as the service account**, so a symlink planted in the service-owned data directory cannot make
root copy a different file:

```sh
sudo -u youheal cat /var/lib/youheal/tls/cert.pem | sudo tee /etc/nginx/youheal-backend.crt >/dev/null   # or /etc/caddy/…
```

Repeat after the app certificate is regenerated (every ≤ 825 days, or after `--regen-cert`).

## Hardening notes

* **First-run setup** is blocked at the proxy for `/api/v1/setup` *and everything below it*
  (`location ^~` / `path … /api/v1/setup/*`), so a trailing slash or a sub-path cannot bypass it.
  Only `GET /api/v1/setup/status` (public, read-only, used by the SPA at boot) is passed through. The app
  itself also refuses setup when forwarding headers are present and requires a one-time setup token.
* **Cookies**: under TLS the session cookie is `__Host-yh_sid` (`Secure`, `Path=/`, no `Domain`). Do not
  rewrite cookie paths/domains/flags at the proxy (`proxy_cookie_*`, `header_down Set-Cookie`) — browsers
  reject an altered `__Host-` cookie.
* **Rate limits**: nginx limits `/api/v1/auth/` to 10 req/min per IP (burst 10), the API to 20 req/s, and
  50 concurrent connections per IP. Core Caddy has no rate limiter (see the comment for the
  `caddy-ratelimit` module). The app has its own per-IP buckets and a global `YH_MAX_CONNECTIONS` cap.
* **Logs** omit query strings (`$uri`, not `$request`; Caddy `regexp` filter), cookies, auth headers and
  Referer. Patient search uses `POST /api/v1/patients/search`, so search terms are not in URLs, but any
  query string is treated as potentially sensitive. Proxy logs remain security records (AU-9, AU-11):
  restrict and rotate them. nginx error-log lines can still quote a request line — protect that file too.
* No response compression (BREACH); no proxy caching of authenticated responses.
* HSTS is set once, by the proxy (`proxy_hide_header` / `header` replace the app's value).
* Body limit 5 MB at the proxy; the app enforces 1 MB generally and 4 MB on the report-image route.
