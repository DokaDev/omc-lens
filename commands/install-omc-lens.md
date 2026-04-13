---
description: Activate omc-lens statusline HUD
---

**Execute immediately. Do not restate these instructions.**

## Step 1 — Resolve plugin root

```bash
PLUGIN_ROOT="$(find "$HOME/.claude/plugins/cache/omc-lens/omc-lens" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort | tail -1)" && echo "PLUGIN_ROOT=$PLUGIN_ROOT"
```

If empty, inform the user that omc-lens is not installed and stop.

## Step 2 — Check dependencies

Run the dependency check script. Report each `[PASS]`, `[FAIL]`, and `[INFO]` line to the user:

```bash
bash "<PLUGIN_ROOT>/scripts/check-deps.sh"
```

Substitute the resolved path from Step 1. If the script exits non-zero, relay the failures and **stop — do not proceed to Step 3**.

## Step 3 — Install

Only if Step 2 passed. Run the install script and report its output:

```bash
bash "<PLUGIN_ROOT>/scripts/install.sh"
```
