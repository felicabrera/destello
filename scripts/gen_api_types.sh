#!/usr/bin/env bash
# Generate TypeScript types from the OpenAPI schema of the running API.
# Usage: scripts/gen_api_types.sh [API_BASE_URL] (default http://localhost:8000)
# Output: frontend/src/lib/api-types.ts (generated, never edit by hand).
set -euo pipefail

API="${1:-http://localhost:8000}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${ROOT}/frontend/src/lib/api-types.ts"

curl -fsS "${API}/api/v1/openapi.json" -o "${ROOT}/scratch-openapi.json" \
  || curl -fsS "${API}/openapi.json" -o "${ROOT}/scratch-openapi.json"
trap 'rm -f "${ROOT}/scratch-openapi.json"' EXIT
(cd "${ROOT}/frontend" && pnpm dlx openapi-typescript@7.4.4 "${ROOT}/scratch-openapi.json" -o "${OUT}")
echo "Wrote ${OUT}"
