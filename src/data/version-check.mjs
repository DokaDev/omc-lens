/**
 * OMC Version Check Module
 *
 * Compares locally installed OMC version against the latest GitHub release.
 * Uses a 6-hour cache to avoid hammering the network on every HUD render.
 *
 * Safe by design: never throws — always returns a result object.
 */

import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OMC_CACHE_DIR = join(
  homedir(),
  '.claude',
  'plugins',
  'cache',
  'omc',
  'oh-my-claudecode',
);

const REMOTE_URL =
  'https://raw.githubusercontent.com/Yeachan-Heo/oh-my-claudecode/main/.claude-plugin/plugin.json';

const CACHE_FILE = join(tmpdir(), 'omc-lens-version-check.json');

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

const FETCH_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// Local version
// ---------------------------------------------------------------------------

/**
 * Read the locally installed OMC version from the plugin cache directory.
 * Returns null if OMC is not installed or version cannot be determined.
 * @returns {string|null}
 */
function getLocalVersion() {
  try {
    if (!existsSync(OMC_CACHE_DIR)) return null;

    const entries = readdirSync(OMC_CACHE_DIR).filter((e) =>
      /^\d+\.\d+\.\d+/.test(e),
    );
    if (entries.length === 0) return null;

    entries.sort((a, b) => {
      const pa = a.split('.').map(Number);
      const pb = b.split('.').map(Number);
      for (let i = 0; i < 3; i++) {
        if ((pa[i] || 0) !== (pb[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
      }
      return 0;
    });

    return entries[0];
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Semver comparison
// ---------------------------------------------------------------------------

/**
 * Compare two semver strings numerically.
 * Returns  1 if a > b,  -1 if a < b,  0 if equal.
 * Returns null if either string is not a valid semver.
 * @param {string} a
 * @param {string} b
 * @returns {1|-1|0|null}
 */
function compareSemver(a, b) {
  const parse = (s) => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(s);
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };

  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;

  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

/**
 * Read cached result if it exists and is within TTL.
 * @returns {{ remote: string, local: string, checkedAt: string }|null}
 */
function readCache() {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    const raw = readFileSync(CACHE_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (!data.checkedAt) return null;
    const age = Date.now() - new Date(data.checkedAt).getTime();
    if (age > CACHE_TTL_MS) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Write result to cache file. Silently ignores write errors.
 * @param {string|null} remote
 * @param {string|null} local
 */
function writeCache(remote, local) {
  try {
    const data = {
      remote,
      local,
      checkedAt: new Date().toISOString(),
    };
    writeFileSync(CACHE_FILE, JSON.stringify(data), 'utf8');
  } catch {
    // Cache write failure is non-fatal
  }
}

// ---------------------------------------------------------------------------
// Remote fetch
// ---------------------------------------------------------------------------

/**
 * Fetch the latest OMC version from GitHub. Returns null on any failure.
 * @returns {Promise<string|null>}
 */
async function fetchRemoteVersion() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let res;
    try {
      res = await fetch(REMOTE_URL, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) return null;

    const json = await res.json();
    return typeof json.version === 'string' ? json.version : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check whether an OMC update is available.
 *
 * Returns a result object — never throws.
 *
 * @returns {Promise<{
 *   local: string|null,
 *   remote: string|null,
 *   updateAvailable: boolean,
 *   error: string|null
 * }>}
 */
export async function checkOmcVersion() {
  const local = getLocalVersion();

  // Try cache first
  const cached = readCache();
  if (cached) {
    const remote = cached.remote || null;
    const cmp = local && remote ? compareSemver(remote, local) : null;
    return {
      local,
      remote,
      updateAvailable: cmp === 1,
      error: null,
    };
  }

  // Fetch from GitHub
  const remote = await fetchRemoteVersion();
  const error = remote === null ? 'fetch failed' : null;

  // Persist to cache (even partial results)
  writeCache(remote, local);

  const cmp = local && remote ? compareSemver(remote, local) : null;
  return {
    local,
    remote,
    updateAvailable: cmp === 1,
    error,
  };
}
