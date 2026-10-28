#!/usr/bin/env bash
# Run Slither over the production contracts using the sanitized scope.
# See docs/security/static-analysis.md for why the scope copy is needed.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCOPE="${TMPDIR:-/tmp}/tyrian-slither-scope"

bash "$REPO_ROOT/scripts/static-analysis-scope.sh" "$SCOPE"
cp "$REPO_ROOT/contracts/slither.config.json" "$SCOPE/slither.config.json"

cd "$SCOPE"
# --fail-high keeps CI green on the triaged low/medium backlog while still
# failing the job if a new high-impact finding appears.
slither . --config-file slither.config.json --fail-high "$@"
