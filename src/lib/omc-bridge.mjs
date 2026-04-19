/**
 * OMC Bridge Module
 *
 * Dynamically imports OMC dist modules for HUD data collection.
 * Resolves the latest OMC version via semver-sorted directory scan.
 * Falls back to inline implementations or null returns when OMC is absent.
 *
 * Modules bridged:
 *   - utils/string-width.js  (Phase 1 — string width utilities)
 *   - hud/stdin.js           (stdin JSON parsing)
 *   - hud/transcript.js      (transcript JSONL parsing)
 *   - hud/state.js           (HUD state + background tasks)
 *   - hud/omc-state.js       (ralph/ultrawork/autopilot/prd state)
 *   - hud/usage-api.js       (rate limit usage via OAuth API)
 *
 * CRITICAL: Uses homedir() for OMC path construction, NEVER import.meta.url.
 * CRITICAL: Uses pathToFileURL().href for dynamic import() calls.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readdirSync, existsSync, readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// 1. Version Resolution (sync, runs at module load time)
// ---------------------------------------------------------------------------

const OMC_CACHE_DIR = join(
  homedir(),
  '.claude',
  'plugins',
  'cache',
  'omc',
  'oh-my-claudecode',
);

/**
 * Scan the OMC plugin cache and return the absolute path to the latest
 * version's `dist/` directory.  Returns `null` when OMC is not installed.
 *
 * If the OMC_PLUGIN_ROOT environment variable is set to a non-empty path
 * and that path contains a `dist/` directory, it takes priority over the
 * plugin cache (fallback-entry semantics, matching omc-hud.mjs L99-113).
 */
function resolveOmcDistPath() {
  // [omc-hud v4.12.1 sync] OMC_PLUGIN_ROOT fallback-entry — mirrors omc-hud.mjs L99-113
  // Purpose: honor user-supplied plugin root as highest-priority resolver, fall through on failure
  try {
    const envRoot = process.env.OMC_PLUGIN_ROOT;
    if (envRoot && envRoot.trim().length > 0) {
      const envDist = join(envRoot.trim(), 'dist');
      if (existsSync(envDist)) return envDist;
    }
  } catch {
    // fall through to plugin cache lookup
  }

  try {
    if (!existsSync(OMC_CACHE_DIR)) return null;

    const versions = readdirSync(OMC_CACHE_DIR)
      .filter((entry) => /^\d+\.\d+\.\d+/.test(entry));

    if (versions.length === 0) return null;

    // Numeric semver sort (descending) -- NOT string sort.
    versions.sort((a, b) => {
      const pa = a.split('.').map(Number);
      const pb = b.split('.').map(Number);
      for (let i = 0; i < 3; i++) {
        if ((pa[i] || 0) !== (pb[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
      }
      return 0;
    });

    return join(OMC_CACHE_DIR, versions[0], 'dist');
  } catch {
    return null;
  }
}

/** Resolved once at module load. */
const OMC_DIST = resolveOmcDistPath();

// ---------------------------------------------------------------------------
// 2. Dynamic Import Helper (async)
// ---------------------------------------------------------------------------

/**
 * Dynamically import an OMC dist module by its relative path inside `dist/`.
 *
 * @param {string} modulePath  e.g. 'utils/string-width.js'
 * @returns {Promise<object|null>}  The module namespace, or null on failure.
 */
export async function importOmcModule(modulePath) {
  if (OMC_DIST === null) return null;

  const fullPath = join(OMC_DIST, modulePath);

  try {
    // CRITICAL: Convert to file:// URL for cross-platform dynamic import.
    const mod = await import(pathToFileURL(fullPath).href);
    if (!mod || Object.keys(mod).length === 0) return null;
    return mod;
  } catch {
    return null;
  }
}

/**
 * Return the resolved OMC dist path (for external modules to reuse).
 * @returns {string|null}
 */
export function getOmcDistPath() {
  return OMC_DIST;
}

/**
 * Return the resolved OMC version string (e.g. '4.11.1').
 *
 * When OMC_PLUGIN_ROOT is in use the dist path has no version segment, so we
 * read the version from plugin.json or package.json inside the plugin root.
 * Falls back to parsing the directory name for the standard cache layout.
 *
 * @returns {string|null}
 */
export function getOmcVersion() {
  if (OMC_DIST === null) return null;

  // When OMC_PLUGIN_ROOT is set, OMC_DIST === {OMC_PLUGIN_ROOT}/dist.
  // The parent directory is the plugin root — read the version from metadata.
  const envRoot = process.env.OMC_PLUGIN_ROOT;
  if (envRoot && envRoot.trim().length > 0) {
    const root = envRoot.trim();
    try {
      const pluginJsonPath = join(root, 'plugin.json');
      if (existsSync(pluginJsonPath)) {
        const data = JSON.parse(readFileSync(pluginJsonPath, 'utf8'));
        if (typeof data.version === 'string') return data.version;
      }
    } catch {
      // ignore
    }
    try {
      const pkgJsonPath = join(root, 'package.json');
      if (existsSync(pkgJsonPath)) {
        const data = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
        if (typeof data.version === 'string') return data.version;
      }
    } catch {
      // ignore
    }
    return null;
  }

  // Standard cache layout: .../oh-my-claudecode/4.11.1/dist
  const parts = OMC_DIST.split('/');
  // The version is the second-to-last segment (before 'dist')
  return parts[parts.length - 2] || null;
}

// ---------------------------------------------------------------------------
// 3. String-Width: Lazy Import + Re-export
// ---------------------------------------------------------------------------

/** @type {object|null} Cached string-width module (OMC or fallback). */
let _stringWidth = null;

// ---- Inline Fallback (used when OMC plugin is absent) ---------------------

const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

function fallbackStripAnsi(str) {
  return str.replace(ANSI_RE, '');
}

function fallbackIsCJK(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x9fff) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe6f) ||
    (cp >= 0xff01 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x2fa1f) ||
    (cp >= 0x3000 && cp <= 0x303f) ||
    (cp >= 0x3040 && cp <= 0x30ff) ||
    (cp >= 0x3130 && cp <= 0x318f) ||
    (cp >= 0x31f0 && cp <= 0x31ff) ||
    (cp >= 0x3200 && cp <= 0x33ff)
  );
}

function fallbackIsZeroWidth(cp) {
  return (
    cp === 0x200b ||
    cp === 0x200c ||
    cp === 0x200d ||
    cp === 0xfeff ||
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe20 && cp <= 0xfe2f)
  );
}

function fallbackGetCharWidth(char) {
  const cp = char.codePointAt(0);
  if (cp === undefined) return 0;
  if (fallbackIsZeroWidth(cp)) return 0;
  if (fallbackIsCJK(cp)) return 2;
  return 1;
}

function fallbackStringWidth(str) {
  if (!str) return 0;
  const stripped = fallbackStripAnsi(str);
  let width = 0;
  for (const char of stripped) {
    width += fallbackGetCharWidth(char);
  }
  return width;
}

function fallbackTruncateToWidth(str, maxWidth, suffix = '...') {
  if (!str || maxWidth <= 0) return '';
  const strWidth = fallbackStringWidth(str);
  if (strWidth <= maxWidth) return str;

  const suffixWidth = fallbackStringWidth(suffix);
  const targetWidth = maxWidth - suffixWidth;
  if (targetWidth <= 0) {
    return _truncateNoSuffix(str, maxWidth);
  }
  return _truncateNoSuffix(str, targetWidth) + suffix;
}

function _truncateNoSuffix(str, maxWidth) {
  let width = 0;
  let result = '';
  for (const char of str) {
    const cw = fallbackGetCharWidth(char);
    if (width + cw > maxWidth) break;
    result += char;
    width += cw;
  }
  return result;
}

function fallbackPadToWidth(str, targetWidth, padChar = ' ') {
  const currentWidth = fallbackStringWidth(str);
  if (currentWidth >= targetWidth) return str;
  return str + padChar.repeat(targetWidth - currentWidth);
}

function fallbackSliceByWidth(str, startWidth, endWidth) {
  if (!str) return '';
  let currentWidth = 0;
  let result = '';
  let started = false;

  for (const char of str) {
    const cw = fallbackGetCharWidth(char);
    if (!started) {
      if (currentWidth >= startWidth) {
        started = true;
      } else if (currentWidth + cw > startWidth) {
        started = true;
        result += ' ';
        currentWidth += cw;
        continue;
      }
    }
    if (endWidth !== undefined && currentWidth >= endWidth) break;
    if (started) {
      if (endWidth !== undefined && currentWidth + cw > endWidth) break;
      result += char;
    }
    currentWidth += cw;
  }
  return result;
}

const FALLBACK_MODULE = {
  stringWidth: fallbackStringWidth,
  stripAnsi: fallbackStripAnsi,
  truncateToWidth: fallbackTruncateToWidth,
  padToWidth: fallbackPadToWidth,
  sliceByWidth: fallbackSliceByWidth,
  getCharWidth: fallbackGetCharWidth,
};

// ---- Lazy Loader ----------------------------------------------------------

async function ensureStringWidth() {
  if (_stringWidth !== null) return;

  const mod = await importOmcModule('utils/string-width.js');

  // Validate OMC module before using (Pitfall P7: export signature drift)
  if (mod && typeof mod.stringWidth === 'function') {
    _stringWidth = mod;
  } else {
    // OMC unavailable or exports changed -- use inline fallback
    _stringWidth = FALLBACK_MODULE;
  }
}

// ---------------------------------------------------------------------------
// 4. Stdin Module: Lazy Import + Re-export
// ---------------------------------------------------------------------------

/** @type {object|null} Cached stdin module. */
let _stdin = null;

const FALLBACK_STDIN = {
  readStdin: async () => null,
  getContextPercent: () => 0,
  getModelName: () => 'Unknown',
  stabilizeContextPercent: (stdin) => stdin,
};

async function ensureStdin() {
  if (_stdin !== null) return;

  const mod = await importOmcModule('hud/stdin.js');
  if (mod && typeof mod.readStdin === 'function') {
    _stdin = mod;
  } else {
    _stdin = FALLBACK_STDIN;
  }
}

// ---------------------------------------------------------------------------
// 5. Transcript Module: Lazy Import + Re-export
// ---------------------------------------------------------------------------

/** @type {object|null} Cached transcript module. */
let _transcript = null;

const FALLBACK_TRANSCRIPT = {
  parseTranscript: async () => ({
    agents: [],
    todos: [],
    lastActivatedSkill: undefined,
    toolCallCount: 0,
    agentCallCount: 0,
    skillCallCount: 0,
    lastToolName: null,
  }),
};

async function ensureTranscript() {
  if (_transcript !== null) return;

  const mod = await importOmcModule('hud/transcript.js');
  if (mod && typeof mod.parseTranscript === 'function') {
    _transcript = mod;
  } else {
    _transcript = FALLBACK_TRANSCRIPT;
  }
}

// ---------------------------------------------------------------------------
// 6. State Module: Lazy Import + Re-export
// ---------------------------------------------------------------------------

/** @type {object|null} Cached state module. */
let _state = null;

const FALLBACK_STATE = {
  readHudState: () => null,
  getRunningTasks: () => [],
  getBackgroundTaskCount: () => ({ running: 0, max: 5 }),
};

async function ensureState() {
  if (_state !== null) return;

  const mod = await importOmcModule('hud/state.js');
  if (mod && typeof mod.readHudState === 'function') {
    _state = mod;
  } else {
    _state = FALLBACK_STATE;
  }
}

// ---------------------------------------------------------------------------
// 7. OMC State Module: Lazy Import + Re-export
// ---------------------------------------------------------------------------

/** @type {object|null} Cached omc-state module. */
let _omcState = null;

const FALLBACK_OMC_STATE = {
  readRalphStateForHud: () => null,
  readUltraworkStateForHud: () => null,
  readAutopilotStateForHud: () => null,
  readPrdStateForHud: () => null,
};

async function ensureOmcState() {
  if (_omcState !== null) return;

  const mod = await importOmcModule('hud/omc-state.js');
  if (mod && typeof mod.readRalphStateForHud === 'function') {
    _omcState = mod;
  } else {
    _omcState = FALLBACK_OMC_STATE;
  }
}

// ---------------------------------------------------------------------------
// 8. Usage API Module: Lazy Import + Re-export
// ---------------------------------------------------------------------------

/** @type {object|null} Cached usage-api module. */
let _usageApi = null;

const FALLBACK_USAGE_API = {
  getUsage: async () => ({ rateLimits: null, error: 'no_omc' }),
};

async function ensureUsageApi() {
  if (_usageApi !== null) return;

  const mod = await importOmcModule('hud/usage-api.js');
  if (mod && typeof mod.getUsage === 'function') {
    _usageApi = mod;
  } else {
    _usageApi = FALLBACK_USAGE_API;
  }
}

// ---------------------------------------------------------------------------
// 9. Public API — Init
// ---------------------------------------------------------------------------

/**
 * Initialize the bridge. Must be called once before using sync functions.
 * Loads all OMC modules in parallel.
 * @returns {Promise<boolean>} true if OMC modules loaded, false if using fallbacks.
 */
export async function initBridge() {
  await Promise.all([
    ensureStringWidth(),
    ensureStdin(),
    ensureTranscript(),
    ensureState(),
    ensureOmcState(),
    ensureUsageApi(),
  ]);

  // Return true if at least the core string-width module loaded from OMC
  return _stringWidth !== FALLBACK_MODULE;
}

// ---------------------------------------------------------------------------
// 10. Public API — String Width (sync after init)
// ---------------------------------------------------------------------------

export function stringWidth(str) {
  if (_stringWidth === null) throw new Error('Call initBridge() first');
  return _stringWidth.stringWidth(str);
}

export function stripAnsi(str) {
  if (_stringWidth === null) throw new Error('Call initBridge() first');
  return _stringWidth.stripAnsi(str);
}

export function truncateToWidth(str, maxWidth, suffix) {
  if (_stringWidth === null) throw new Error('Call initBridge() first');
  return _stringWidth.truncateToWidth(str, maxWidth, suffix);
}

export function padToWidth(str, targetWidth) {
  if (_stringWidth === null) throw new Error('Call initBridge() first');
  return _stringWidth.padToWidth(str, targetWidth);
}

export function sliceByWidth(str, start, end) {
  if (_stringWidth === null) throw new Error('Call initBridge() first');
  return _stringWidth.sliceByWidth(str, start, end);
}

export function getCharWidth(char) {
  if (_stringWidth === null) throw new Error('Call initBridge() first');
  return _stringWidth.getCharWidth(char);
}

// ---------------------------------------------------------------------------
// 11. Public API — Stdin
// ---------------------------------------------------------------------------

/** Read and parse stdin JSON from Claude Code. */
export async function readStdin() {
  if (_stdin === null) throw new Error('Call initBridge() first');
  return _stdin.readStdin();
}

/** Get context window usage percentage from stdin data. */
export function getContextPercent(stdin) {
  if (_stdin === null) throw new Error('Call initBridge() first');
  return _stdin.getContextPercent(stdin);
}

/** Get model display name from stdin data. */
export function getModelName(stdin) {
  if (_stdin === null) throw new Error('Call initBridge() first');
  return _stdin.getModelName(stdin);
}

/** Stabilize context percent across transient snapshots. */
export function stabilizeContextPercent(stdin, previousStdin) {
  if (_stdin === null) throw new Error('Call initBridge() first');
  return _stdin.stabilizeContextPercent(stdin, previousStdin);
}

// ---------------------------------------------------------------------------
// 12. Public API — Transcript
// ---------------------------------------------------------------------------

/** Parse JSONL transcript for agents, todos, skills, tokens. */
export async function parseTranscript(transcriptPath, options) {
  if (_transcript === null) throw new Error('Call initBridge() first');
  return _transcript.parseTranscript(transcriptPath, options);
}

// ---------------------------------------------------------------------------
// 13. Public API — HUD State
// ---------------------------------------------------------------------------

/** Read HUD state (background tasks) from disk. */
export function readHudState(directory) {
  if (_state === null) throw new Error('Call initBridge() first');
  return _state.readHudState(directory);
}

/** Get running background tasks from state. */
export function getRunningTasks(state) {
  if (_state === null) throw new Error('Call initBridge() first');
  return _state.getRunningTasks(state);
}

/** Get background task count {running, max}. */
export function getBackgroundTaskCount(state) {
  if (_state === null) throw new Error('Call initBridge() first');
  return _state.getBackgroundTaskCount(state);
}

// ---------------------------------------------------------------------------
// 14. Public API — OMC Orchestration State
// ---------------------------------------------------------------------------

/** Read Ralph Loop state for HUD display. */
export function readRalphStateForHud(directory, sessionId) {
  if (_omcState === null) throw new Error('Call initBridge() first');
  return _omcState.readRalphStateForHud(directory, sessionId);
}

/** Read Ultrawork state for HUD display. */
export function readUltraworkStateForHud(directory, sessionId) {
  if (_omcState === null) throw new Error('Call initBridge() first');
  return _omcState.readUltraworkStateForHud(directory, sessionId);
}

/** Read Autopilot state for HUD display. */
export function readAutopilotStateForHud(directory, sessionId) {
  if (_omcState === null) throw new Error('Call initBridge() first');
  return _omcState.readAutopilotStateForHud(directory, sessionId);
}

/** Read PRD state for HUD display. */
export function readPrdStateForHud(directory) {
  if (_omcState === null) throw new Error('Call initBridge() first');
  return _omcState.readPrdStateForHud(directory);
}

// ---------------------------------------------------------------------------
// 15. Public API — Usage API (Rate Limits)
// ---------------------------------------------------------------------------

/** Fetch rate limit usage data (with caching). */
export async function getUsage() {
  if (_usageApi === null) throw new Error('Call initBridge() first');
  return _usageApi.getUsage();
}
