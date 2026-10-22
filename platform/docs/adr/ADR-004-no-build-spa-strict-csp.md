# ADR-004 — No-build vanilla ES-module SPA, strict CSP, vendored and pinned three.js

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10 |
| **Controls** | SI-10, SC-18 (mobile code), SC-8, CM-7, SR-4, SI-7 |

## Context

The UI renders PHI and must resist XSS — the dominant web risk for an application whose sessions grant
access to every patient record. It must work offline (no CDN), and its supply chain must be as small as
the server's (ADR-001).

## Decision

* The frontend is plain **ES modules served from `web/`** — no bundler, no transpiler, no npm build step.
* **No inline scripts, no inline event handlers, no inline styles that need `unsafe-inline`.** The server
  sends `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'
  data: blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none';
  form-action 'self'`, plus `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Cross-Origin-Opener-Policy: same-origin`, a minimal `Permissions-Policy`, and HSTS when on TLS.
* **three.js is vendored** at `web/vendor/three/` pinned to v0.170.0 with SHA-256 recorded in
  `web/vendor/three/VERSION`; addons are rewritten to import `./three.module.js` (no import map, which
  would otherwise require an inline script or `unsafe-inline`).

## Consequences

**Positive**: XSS that injects markup cannot execute script (CSP), no third-party origins at runtime,
fully offline, reproducible (what is in git is what runs), trivial to audit.

**Negative**: no tree-shaking/minification (acceptable on a LAN); developers must use DOM APIs safely
(`textContent`, never `innerHTML` with data); updating three.js is a deliberate, reviewed change
(update file + hash + VERSION).

## Alternatives considered

React/Vue/Svelte with a bundler (large dev-dependency tree, build reproducibility burden); CDN-hosted
libraries (breaks offline, adds third-party trust and SRI management); server-rendered HTML only
(poor fit for the interactive 3D body map).
