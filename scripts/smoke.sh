#!/usr/bin/env bash
# Smoke test of a deployed Destello through the public URL (Cloudflare, NGINX with the WAF, Caddy, API).
# Usage: DESTELLO_DOMAIN=destello.felicabrera.com scripts/smoke.sh
# Exit status 0 when every check passes within SMOKE_RETRIES attempts (default 12, 10 s apart).
set -euo pipefail

: "${DESTELLO_DOMAIN:?DESTELLO_DOMAIN is required}"
BASE_URL="https://${DESTELLO_DOMAIN}"
SMOKE_RETRIES="${SMOKE_RETRIES:-12}"
PRESETS=(barnard wise0855 epsindib rwaur rdra)

log() { printf '[smoke] %s\n' "$*"; }

smoke_once() {
  local slug sid targets ids
  curl -fsS --max-time 20 "${BASE_URL}/api/v1/health" > /dev/null || { log "health failed"; return 1; }
  curl -fsS --max-time 20 -o /dev/null "${BASE_URL}/" || { log "index failed"; return 1; }
  targets="$(curl -fsS --max-time 30 "${BASE_URL}/api/v1/targets")" || { log "targets failed"; return 1; }
  for slug in "${PRESETS[@]}"; do
    grep -q "\"id\": *\"${slug}\"" <<< "$targets" || { log "preset ${slug} missing from /targets"; return 1; }
    curl -fsS --max-time 20 -o /dev/null "${BASE_URL}/t/${slug}" || { log "route /t/${slug} failed"; return 1; }
  done
  # Every preset with a sequence_id must serve a manifest.
  ids="$(grep -oE '"sequence_id": *"[0-9a-f]{16}"' <<< "$targets" | grep -oE '[0-9a-f]{16}' || true)"
  [[ -n "$ids" ]] || { log "no preset has a sequence_id"; return 1; }
  for sid in $ids; do
    curl -fsS --max-time 20 -o /dev/null "${BASE_URL}/manifests/${sid}.json" || { log "manifest ${sid} failed"; return 1; }
  done
  write_endpoints_once
}

# One harmless POST to each write endpoint, through the public URL and therefore through the WAF
# (ModSecurity at paranoia level 3 has blocked a report form POST before). Every body is shaped like real
# traffic but is refused by the application without side effects (unknown sequence, bad field id, field of
# view out of range), except client-errors (one log line) and hunt/next (read only).
# 403 from the WAF (an HTML page) means ModSecurity blocked the request. 403 from the application
# (problem+json, for example a report without a verification token) is an expected refusal.
# 5xx or no answer means the application failed, with one exception that is reported as a warning:
# 503 REPORTS_UNAVAILABLE, which the API answers while the Turnstile secret is not configured.
post_json() {
  # $1 = path, $2 = body
  local out code ctype body
  body="$(mktemp)"
  out="$(curl -s --max-time 30 -o "$body" -w '%{http_code} %{content_type}' -X POST \
    -H 'Content-Type: application/json' --data "$2" "${BASE_URL}$1" || true)"
  code="${out%% *}"
  ctype="${out#* }"
  case "$code" in
    403)
      if [[ "$ctype" != application/problem+json* ]]; then
        rm -f "$body"
        log "WAF BLOCK: POST $1 answered 403. ModSecurity rejected a harmless body; read the rule hit in the audit log of the edge host and add a targeted exclusion there."
        return 1
      fi
      ;;
    503)
      if grep -q '"REPORTS_UNAVAILABLE"' "$body"; then
        rm -f "$body"
        log "WARNING: POST $1 -> 503 REPORTS_UNAVAILABLE (the Turnstile secret is not configured on the server)"
        return 0
      fi
      rm -f "$body"
      log "POST $1 failed with status ${code}"
      return 1
      ;;
    "" | 000 | 5??)
      rm -f "$body"
      log "POST $1 failed with status ${code}"
      return 1
      ;;
  esac
  rm -f "$body"
  log "POST $1 -> ${code}"
}

write_endpoints_once() {
  local sid="0000000000000000"
  local marks='[{"epoch":0,"ra_deg":269.45,"dec_deg":4.69},{"epoch":1,"ra_deg":269.46,"dec_deg":4.70}]'
  post_json /api/v1/sequences '{"ra_deg":269.45,"dec_deg":4.69,"fov_arcmin":0.01}' || return 1
  post_json "/api/v1/sequences/${sid}/astrometry" '{"ra_deg":269.45,"dec_deg":4.69}' || return 1
  post_json /api/v1/client-errors '{"kind":"error","message":"deploy smoke test","route":"/","release":"smoke"}' || return 1
  post_json /api/v1/hunt/next '{"session":"deploysmoketest0001"}' || return 1
  post_json /api/v1/hunt/votes '{"session":"deploysmoketest0001","field_id":"0000000000000000","vote_token":"000000000.0000000000000000000000000000000000000000000000000000000000000000","label":"nothing"}' || return 1
  post_json /api/v1/reports/check "{\"sequence_id\":\"${sid}\",\"marks\":${marks}}" || return 1
  post_json /api/v1/reports "{\"sequence_id\":\"${sid}\",\"marks\":${marks},\"notes\":\"Candidate moving source, visible in two epochs, about three pixels east of the field star.\"}" || return 1
}

for ((i = 1; i <= SMOKE_RETRIES; i++)); do
  if smoke_once; then log "smoke test passed"; exit 0; fi
  log "attempt ${i}/${SMOKE_RETRIES} failed"
  sleep 10
done
exit 1
