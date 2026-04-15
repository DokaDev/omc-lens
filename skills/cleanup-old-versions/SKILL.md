---
name: cleanup-old-versions
description: Remove inactive omc-lens plugin version directories from the Claude Code plugin cache after explicit user confirmation
---

# Cleanup Old omc-lens Versions

This skill prunes stale omc-lens version directories from
`~/.claude/plugins/cache/omc-lens/omc-lens/`. Each plugin update creates a
new version-stamped directory (e.g. `0.5.7/`, `0.5.8/`) without removing the
previous ones, so they accumulate over time.

**Always ask the user before deleting anything.** Never delete the active
version directory (the one currently targeted by the
`~/.claude/hud/omc-lens.mjs` symlink).

## Step 1 — Detect active version

```bash
ACTIVE_PATH="$(readlink "$HOME/.claude/hud/omc-lens.mjs" 2>/dev/null || true)"
ACTIVE_VERSION="$(echo "$ACTIVE_PATH" | sed -n 's#.*/cache/omc-lens/omc-lens/\([^/]*\)/.*#\1#p')"
echo "ACTIVE_VERSION=$ACTIVE_VERSION"
echo "ACTIVE_PATH=$ACTIVE_PATH"
```

If `ACTIVE_VERSION` is empty, tell the user the symlink could not be
resolved and **stop** — do not delete anything.

## Step 2 — Enumerate inactive versions and compute reclaimable size

```bash
CACHE_ROOT="$HOME/.claude/plugins/cache/omc-lens/omc-lens"
INACTIVE=()
for dir in "$CACHE_ROOT"/*/; do
  name="$(basename "$dir")"
  [ "$name" = "$ACTIVE_VERSION" ] && continue
  INACTIVE+=("$name")
done
echo "Inactive versions: ${INACTIVE[*]:-<none>}"
if [ ${#INACTIVE[@]} -gt 0 ]; then
  du -sh "${INACTIVE[@]/#/$CACHE_ROOT/}" 2>/dev/null | awk '{print $1, $2}'
  TOTAL=$(du -sk "${INACTIVE[@]/#/$CACHE_ROOT/}" 2>/dev/null | awk '{sum+=$1} END {printf "%.1f MB\n", sum/1024}')
  echo "Total reclaimable: $TOTAL"
fi
```

If `INACTIVE` is empty, tell the user "Nothing to clean up. Active version
is the only one in cache." and **stop**.

## Step 3 — Ask the user to confirm

Use `AskUserQuestion` with this exact shape:

- **Question**: "Found N inactive omc-lens version directories totaling
  ~SIZE. The active version (vACTIVE_VERSION) will not be touched. Remove
  the inactive ones?"
- **Options**:
  1. **Remove all inactive versions** — Free the listed disk space
  2. **Keep them** — Cancel cleanup, do nothing

Substitute `N`, `SIZE`, and `ACTIVE_VERSION` with the values from Step 2.

If the user picks "Keep them" or any non-removal answer, **stop** without
changes.

## Step 4 — Remove inactive directories

Only if the user explicitly chose "Remove all inactive versions":

```bash
for v in "${INACTIVE[@]}"; do
  rm -rf "$CACHE_ROOT/$v" && echo "Removed $v"
done
```

Report the removed versions and remaining active version to the user.
