/**
 * Version Check Module
 *
 * Compares locally installed versions against the latest GitHub release
 * for both OMC and omc-lens. Uses a 6-hour cache per target to avoid
 * hammering the network on every HUD render.
 *
 * Safe by design: never throws — always returns a result object.
 */

import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const FETCH_TIMEOUT_MS = 5000;

const OMC_CACHE_DIR = join(homedir(), '.claude', 'plugins', 'cache', 'omc', 'oh-my-claudecode');
const OMC_REMOTE_URL = 'https://raw.githubusercontent.com/Yeachan-Heo/oh-my-claudecode/main/.claude-plugin/plugin.json';
const OMC_CACHE_FILE = join(tmpdir(), 'omc-lens-version-check.json');

const LENS_CACHE_DIR = join(homedir(), '.claude', 'plugins', 'cache', 'omc-lens', 'omc-lens');
const LENS_REMOTE_URL = 'https://raw.githubusercontent.com/DokaDev/omc-lens/main/.claude-plugin/plugin.json';
const LENS_CACHE_FILE = join(tmpdir(), 'omc-lens-self-version-check.json');

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function getLocalVersion(cacheDir) {
  try {
    if (!existsSync(cacheDir)) return null;
    const entries = readdirSync(cacheDir).filter((e) => /^\d+\.\d+\.\d+/.test(e));
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

function readCache(cacheFile) {
  try {
    if (!existsSync(cacheFile)) return null;
    const raw = readFileSync(cacheFile, 'utf8');
    const data = JSON.parse(raw);
    if (!data.checkedAt) return null;
    const age = Date.now() - new Date(data.checkedAt).getTime();
    if (age > CACHE_TTL_MS) return null;
    return data;
  } catch {
    return null;
  }
}

function writeCache(cacheFile, remote, local) {
  try {
    writeFileSync(cacheFile, JSON.stringify({ remote, local, checkedAt: new Date().toISOString() }), 'utf8');
  } catch {
    // non-fatal
  }
}

async function fetchRemoteVersion(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, { signal: controller.signal });
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
// Generic check
// ---------------------------------------------------------------------------

async function checkVersion(cacheDir, remoteUrl, cacheFile) {
  const local = getLocalVersion(cacheDir);

  const cached = readCache(cacheFile);
  if (cached) {
    const remote = cached.remote || null;
    const cmp = local && remote ? compareSemver(remote, local) : null;
    return { local, remote, updateAvailable: cmp === 1, error: null };
  }

  const remote = await fetchRemoteVersion(remoteUrl);
  const error = remote === null ? 'fetch failed' : null;
  writeCache(cacheFile, remote, local);

  const cmp = local && remote ? compareSemver(remote, local) : null;
  return { local, remote, updateAvailable: cmp === 1, error };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function checkOmcVersion() {
  return checkVersion(OMC_CACHE_DIR, OMC_REMOTE_URL, OMC_CACHE_FILE);
}

export async function checkLensVersion() {
  return checkVersion(LENS_CACHE_DIR, LENS_REMOTE_URL, LENS_CACHE_FILE);
}
