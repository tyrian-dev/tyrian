#!/usr/bin/env bash
# Run Aderyn over the production contracts using the sanitized scope.
# Requires `aderyn` on PATH: https://github.com/Cyfrin/aderyn/releases
# Usage: bash scripts/aderyn.sh [output-report-path]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCOPE="${TMPDIR:-/tmp}/tyrian-aderyn-scope"
OUT="${1:-$SCOPE/aderyn-report.md}"

bash "$REPO_ROOT/scripts/static-analysis-scope.sh" "$SCOPE"
cp "$REPO_ROOT/contracts/aderyn.toml" "$SCOPE/aderyn.toml"

cd "$SCOPE"
aderyn . --output "$OUT"
printf 'aderyn report: %s\n' "$OUT"
