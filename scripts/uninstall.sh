#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# omc-lens — Uninstall
#
# Removes the symlink and restores the previous statusLine from backup.
# ---------------------------------------------------------------------------

CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"

# 0. Node.js guard (needed for settings.json patching)
if ! command -v node >/dev/null 2>&1; then
  echo "WARNING: Node.js not found. Cannot restore settings.json automatically."
  echo "To restore manually, edit $CLAUDE_CONFIG_DIR/settings.json and remove or replace the statusLine field."
  rm -f "$CLAUDE_CONFIG_DIR/hud/omc-lens.mjs" 2>/dev/null && echo "Symlink removed."
  exit 0
fi

# 1. Remove symlink
SYMLINK_PATH="$CLAUDE_CONFIG_DIR/hud/omc-lens.mjs"
if [ -L "$SYMLINK_PATH" ] || [ -f "$SYMLINK_PATH" ]; then
  rm -f "$SYMLINK_PATH"
  echo "Removed: $SYMLINK_PATH"
else
  echo "Symlink not found (already removed)."
fi

# 2. Restore statusLine
SETTINGS_FILE="$CLAUDE_CONFIG_DIR/settings.json"
BACKUP_FILE="$CLAUDE_CONFIG_DIR/hud/.omc-lens-statusline-backup.json"

if [ -f "$SETTINGS_FILE" ]; then
  node -e '
const fs = require("fs");
const path = require("path");
const settingsPath = process.argv[1];
const backupPath = process.argv[2];
const configDir = process.argv[3];

let settings = {};
try { settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")); } catch (_) { process.exit(0); }

if (!settings.statusLine ||
    !settings.statusLine.command ||
    !settings.statusLine.command.includes("omc-lens")) {
  console.log("statusLine is not set to omc-lens — nothing to restore.");
  process.exit(0);
}

let restored = null;
try {
  restored = JSON.parse(fs.readFileSync(backupPath, "utf8"));
  console.log("Restored statusLine from backup.");
} catch (_) {
  console.log("No backup found — removing statusLine key so Claude Code uses its built-in default.");
}

if (restored) {
  settings.statusLine = restored;
} else {
  delete settings.statusLine;
}

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
try { fs.unlinkSync(backupPath); } catch (_) {}
console.log("settings.json restored.");
' "$SETTINGS_FILE" "$BACKUP_FILE" "$CLAUDE_CONFIG_DIR"
else
  echo "settings.json not found — nothing to restore."
fi

# 3. Done
echo ""
echo "omc-lens deactivated. Restart Claude Code for the change to take effect."
