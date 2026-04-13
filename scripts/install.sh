#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# omc-lens — Install
#
# Self-locates via BASH_SOURCE so it works from any invocation context.
# Creates a symlink at ~/.claude/hud/omc-lens.mjs, backs up the current
# statusLine, and patches settings.json.
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Assumes check-deps.sh has already been run and passed.
# Guard against direct invocation without check-deps.
if ! command -v node >/dev/null 2>&1; then
  echo -e "\033[31mERROR: Node.js not found.\033[0m"
  echo "Run /install-omc-lens instead, which checks dependencies first."
  exit 1
fi

# 1. Config directory
CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"

# 2. Symlink
mkdir -p "$CLAUDE_CONFIG_DIR/hud"
ln -sf "$PLUGIN_ROOT/src/hud.mjs" "$CLAUDE_CONFIG_DIR/hud/omc-lens.mjs"
echo "Symlink: $CLAUDE_CONFIG_DIR/hud/omc-lens.mjs -> $PLUGIN_ROOT/src/hud.mjs"

# 3. Backup current statusLine and patch settings.json
SETTINGS_FILE="$CLAUDE_CONFIG_DIR/settings.json"
BACKUP_FILE="$CLAUDE_CONFIG_DIR/hud/.omc-lens-statusline-backup.json"

node -e '
const fs = require("fs");
const path = require("path");
const settingsPath = process.argv[1];
const backupPath = process.argv[2];
const configDir = process.argv[3];

let settings = {};
try { settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")); } catch (_) {}

if (settings.statusLine) {
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  fs.writeFileSync(backupPath, JSON.stringify(settings.statusLine, null, 2) + "\n", "utf8");
  console.log("Backed up current statusLine to: " + backupPath);
} else {
  console.log("No existing statusLine to back up.");
}

settings.statusLine = {
  type: "command",
  command: "node " + path.join(configDir, "hud", "omc-lens.mjs")
};

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
console.log("settings.json patched: statusLine -> omc-lens.mjs");
' "$SETTINGS_FILE" "$BACKUP_FILE" "$CLAUDE_CONFIG_DIR"

# 4. Done
echo ""
echo -e "\033[32momc-lens activated.\033[0m Restart Claude Code for the new statusline to take effect."
echo "To revert, run /uninstall-omc-lens"
