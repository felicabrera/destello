# syntax=docker/dockerfile:1
# Frontend release image: Caddy with the production Caddyfile and the built frontend. The build context is a
# staging directory that holds `dist/` (pnpm build) and `Caddyfile` (a copy of deploy/Caddyfile.prod); see the
# deploy workflow. The path /srv/frontend/current is the root used by Caddyfile.prod.
FROM caddy:2@sha256:ce773ec7a742ce15ee6bf2bb5f65882b9e2a4487b10733e6f1484f86e6b5d8bc
COPY Caddyfile /etc/caddy/Caddyfile
COPY dist /srv/frontend/current
