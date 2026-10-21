# syntax=docker/dockerfile:1
#
# YOU HEAL Clinical — container image (CONTRACT ADR-001: zero npm dependencies, so no build stage).
#
# Build (from platform/):   docker build -f deploy/docker/Dockerfile -t youheal/clinical:$(node -p "require('./package.json').version") .
# Run:                      see deploy/docker/compose.yaml and docs/OPERATIONS.md §2.1
#
# Base image pinning
# ------------------
# The tag below pins Node + Alpine *versions*, but a tag is mutable (Docker Official Images are rebuilt
# for OS security patches). For a reproducible, attestable build (CM-2, CM-14, SR-4) pin by digest too:
#
#   docker buildx imagetools inspect node:22.23.4-alpine3.23 --format '{{json .Manifest.Digest}}'
#   # or: docker pull node:22.23.4-alpine3.23 && docker inspect --format '{{index .RepoDigests 0}}' node:22.23.4-alpine3.23
#
# then build with  --build-arg NODE_IMAGE=node:22.23.4-alpine3.23@sha256:<digest>
# (the digest is the multi-arch index digest; Docker selects the right platform manifest).
# Re-pin on a schedule (e.g. monthly) and record the digest in the release notes / SBOM.
ARG NODE_IMAGE=node:22.23.4-alpine3.23

FROM ${NODE_IMAGE}

ARG APP_VERSION=0.0.0-dev
ARG VCS_REF=unknown
ARG BUILD_DATE=unknown

LABEL org.opencontainers.image.title="YOU HEAL Clinical" \
      org.opencontainers.image.description="Secure practitioner platform for Biomagnetic Pair practice (PHI)" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.licenses="UNLICENSED"

# tini: PID 1 that reaps zombies and forwards SIGTERM so server/index.js can shut down gracefully.
# openssl: used ONLY by the entrypoint to mint a self-signed certificate on first start when none is mounted.
# The stock 'node' user (uid 1000) is removed so the only non-root account is our uid 10001.
# npm/corepack/yarn are deleted: the server has no dependencies and they are pure attack surface.
RUN set -eux; \
    apk upgrade --no-cache; \
    apk add --no-cache tini openssl ca-certificates; \
    deluser --remove-home node 2>/dev/null || true; \
    addgroup -S -g 10001 youheal; \
    adduser -S -D -H -u 10001 -G youheal -h /data -s /sbin/nologin youheal; \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg; \
    mkdir -p /data /app; \
    chown 10001:10001 /data; \
    chmod 0700 /data

WORKDIR /app

# Application code is owned by root and not writable by the runtime user (CM-5, SI-7).
# .dockerignore (platform root) keeps PHI, keys, licensed PDFs and test artifacts out of the build context.
COPY --chown=root:root . /app
COPY --chown=root:root --chmod=0755 deploy/docker/entrypoint.sh /usr/local/bin/youheal-entrypoint
RUN chmod -R a+rX,go-w /app

ENV NODE_ENV=production \
    YH_HOST=0.0.0.0 \
    YH_PORT=8443 \
    YH_DATA_DIR=/data \
    YH_CATALOG_DIR=/app/data/catalog \
    YH_TRUST_PROXY=0 \
    YH_HEALTH_SCHEME=https \
    HOME=/tmp

# /data is the ONLY writable path (database, keys, backups, generated TLS). Mount a named volume here;
# run the container with --read-only (compose.yaml does) and a tmpfs on /tmp.
VOLUME ["/data"]
EXPOSE 8443
USER 10001:10001

# No curl/wget in the image: probe with node itself (deploy/common/healthcheck.mjs, zero deps).
# HEALTHCHECK runs outside the entrypoint's environment, so the scheme comes from YH_HEALTH_SCHEME
# (set it to "http" if you run with YH_TLS_DISABLE=1 behind a TLS-terminating reverse proxy).
HEALTHCHECK --interval=30s --timeout=6s --start-period=40s --retries=3 \
  CMD ["node", "/app/deploy/common/healthcheck.mjs", "--quiet", "--timeout", "5000"]

STOPSIGNAL SIGTERM
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/youheal-entrypoint"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
