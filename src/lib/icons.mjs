/**
 * icons.mjs — Nerd Font icon loader with module-level cache.
 *
 * Reads src/data/icons.json on first call, converts hex codepoint
 * strings to Unicode characters via String.fromCodePoint(), and
 * caches the result for subsequent calls.
 *
 * Unknown icon names return '' (empty string) — never crashes.
 * Malformed JSON returns {} — HUD renders without icons rather
 * than crashing (Pitfall P16 prevention).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let _icons = null;

/**
 * Get the Unicode character for a named Nerd Font icon.
 * @param {string} name  Icon key (e.g. 'wrench', 'timer')
 * @returns {string}  Unicode character or '' if not found
 */
export function getIcon(name) {
  if (!_icons) {
    _icons = loadIcons();
  }
  return _icons[name] || '';
}

/**
 * Load and convert icons from JSON.
 * @returns {Object<string, string>}  Map of name -> Unicode char
 */
function loadIcons() {
  try {
    const raw = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'data', 'icons.json'), 'utf8')
    );
    const result = {};
    for (const [key, hex] of Object.entries(raw)) {
      result[key] = String.fromCodePoint(parseInt(hex, 16));
    }
    return result;
  } catch {
    return {};
  }
}
