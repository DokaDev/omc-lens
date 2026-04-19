---
description: Deactivate omc-lens and restore previous statusline
---

**Execute immediately. Do not restate these instructions.**

## Step 1 — Resolve plugin root

```bash
PLUGIN_ROOT="$(find "$HOME/.claude/plugins/cache/omc-lens/omc-lens" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort -V | tail -1)" && echo "PLUGIN_ROOT=$PLUGIN_ROOT"
```

## Step 2 — Uninstall

If plugin root was resolved, run:

```bash
bash "<PLUGIN_ROOT>/scripts/uninstall.sh"
```

If plugin root is empty, run the uninstall by directly removing the symlink and restoring settings:

```bash
rm -f "$HOME/.claude/hud/omc-lens.mjs" 2>/dev/null; echo "Symlink removed (if present)."
```

Report the output to the user.
