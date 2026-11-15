#!/usr/bin/env bash
# Fails when a tracked text file contains the em dash character (project writing rule).
# The character is built from its UTF-8 bytes so that this file does not contain it.
# Skipped: third party or generated trees (design/, demo/) and the files below, which mention the
# character on purpose (input normalisation and tests that assert its absence).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
pattern="$(printf '\342\200\224')"
allow='^(design/|demo/|backend/tests/unit/test_notebook\.py$|frontend/src/lib/coords\.ts$|frontend/src/i18n/parity\.test\.ts$|frontend/src/features/tour/tour\.test\.ts$)'
status=0
while IFS= read -r -d '' f; do
  [[ "$f" =~ $allow ]] && continue
  [[ -f "$f" ]] || continue
  if LC_ALL=C grep -nIF -e "$pattern" -- "$f"; then status=1; fi
done < <(git ls-files -z)
if [[ $status -ne 0 ]]; then
  echo "The em dash character is not allowed. Use a colon, a comma, parentheses or rewrite the sentence." >&2
  exit 1
fi
echo "no em dash found"
