#!/usr/bin/env bash
set -uo pipefail

# ---------------------------------------------------------------------------
# omc-lens — Dependency Check
#
# Verifies required and optional dependencies, outputting a structured
# pass/fail line for each. Exit 0 if all required checks pass, exit 1
# if any required check fails.
# ---------------------------------------------------------------------------

FAILED=0

# 1. Node.js (required — ESM support needed, v18+)
if command -v node >/dev/null 2>&1; then
  NODE_VER=$(node -v 2>/dev/null)
  NODE_MAJOR=$(echo "$NODE_VER" | sed 's/^v//' | cut -d. -f1)
  if [ "$NODE_MAJOR" -ge 18 ] 2>/dev/null; then
    echo "[PASS] Node.js $NODE_VER"
  else
    echo "[FAIL] Node.js $NODE_VER — v18 or later required for ESM support"
    FAILED=1
  fi
else
  echo "[FAIL] Node.js not found"
  FAILED=1
fi

# 2. OMC plugin (required — data collection modules)
OMC_DIR="$HOME/.claude/plugins/cache/omc/oh-my-claudecode"
if [ -d "$OMC_DIR" ]; then
  OMC_VER=$(ls -1 "$OMC_DIR" 2>/dev/null | grep -E '^[0-9]' | sort -V | tail -1)
  echo "[PASS] OMC plugin found (${OMC_VER:-unknown version})"
else
  echo "[FAIL] OMC (oh-my-claudecode) not installed — omc-lens requires OMC's data modules"
  FAILED=1
fi

# 3. jq (optional — not used at runtime but helpful for debugging)
if command -v jq >/dev/null 2>&1; then
  echo "[PASS] jq available (optional)"
else
  echo "[INFO] jq not found (optional — not required for normal operation)"
fi

# 4. Nerd Font (cannot auto-detect — informational only)
echo "[INFO] Ensure your terminal uses a Nerd Font for correct icon rendering"

# Exit
if [ "$FAILED" -ne 0 ]; then
  echo ""
  echo "One or more required dependencies are missing. Fix the [FAIL] items above before continuing."
  exit 1
fi

exit 0
