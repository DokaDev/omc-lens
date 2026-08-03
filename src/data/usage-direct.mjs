/**
 * usage-direct.mjs — Model-scoped weekly rate limits, read straight from the
 * Anthropic usage endpoint.
 *
 * Why this module exists
 * ----------------------
 * Anthropic moved the per-model weekly windows off the legacy top-level
 * `seven_day_<model>` keys (which now come back null) and into a `limits`
 * array: each row is `kind: "weekly_scoped"` and names its model through
 * `scope.model.display_name`. OMC's `hud/usage-api.js` still reads only the
 * legacy keys, so `getUsage()` stopped returning the Sonnet/Opus buckets and
 * has never returned Fable. It parses the response internally and exports
 * neither the raw body, the fetch helper, nor the credential reader, so there
 * is no way to recover the `limits` array through its public surface — hence
 * this second, deliberately narrow reader.
 *
 * Deliberate limits of this module:
 *
 *  - It NEVER refreshes an OAuth token. OMC owns credential write-back, and
 *    two writers racing on `.credentials.json` is how a login gets lost. An
 *    expired token here yields null, the scoped segments drop out for a render
 *    or two, and OMC's own poll refreshes the token for both of us.
 *  - Its cache is machine-wide rather than per-session, and longer-lived than
 *    the caller's, because `/api/oauth/usage` rate-limits aggressively and we
 *    are now the second caller on this machine. A 429 we cause would degrade
 *    OMC's numbers too, not just ours.
 *  - It never throws. Every failure path returns null and the HUD simply
 *    renders without the scoped segments.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';
const FETCH_TIMEOUT_MS = 3000;
const KEYCHAIN_TIMEOUT_MS = 2000;

// Machine-wide on purpose — see the module header. Every session shares one
// entry so N concurrent sessions still cost one request per TTL, not N.
const CACHE_FILE = join(tmpdir(), 'omc-lens-scoped-limits.json');
const CACHE_TTL_MS = 5 * 60 * 1000;
// Failures are cached too, so a revoked token or a 429 does not make every
// render retry. Shorter than the success TTL so recovery stays quick.
const CACHE_TTL_FAILURE_MS = 60 * 1000;

/**
 * `scope.model.display_name` -> field prefix. Anthropic keys these rows by
 * display name, so a model absent from this map is skipped rather than
 * rendered under a guessed key. Supporting a new model is one entry here plus
 * one block in the Line 3 rate-limit renderer.
 */
const SCOPED_MODELS = {
  Fable: 'fable',
  Sonnet: 'sonnet',
  Opus: 'opus',
};

// ---------------------------------------------------------------------------
// Credentials (read-only — never refreshed, never written back)
// ---------------------------------------------------------------------------

/**
 * Keychain service name, matching Claude Code's own scheme.
 * The hash is taken over the raw CLAUDE_CONFIG_DIR value rather than the
 * expanded filesystem path, so `~`-prefixed profiles keep resolving to the
 * same Keychain item Claude Code wrote.
 * @returns {string}
 */
function keychainServiceName() {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  if (configDir) {
    const hash = createHash('sha256').update(configDir).digest('hex').slice(0, 8);
    return `Claude Code-credentials-${hash}`;
  }
  return 'Claude Code-credentials';
}

/**
 * Reduce either credential shape (bare, or wrapped in `claudeAiOauth`) to the
 * two fields this module needs.
 * @param {unknown} raw
 * @returns {{accessToken: string, expiresAt: number|null}|null}
 */
function normalizeCreds(raw) {
  const creds = raw?.claudeAiOauth || raw;
  if (!creds?.accessToken) return null;
  return {
    accessToken: creds.accessToken,
    expiresAt: typeof creds.expiresAt === 'number' ? creds.expiresAt : null,
  };
}

function isExpired(creds) {
  return creds.expiresAt != null && creds.expiresAt <= Date.now();
}

/**
 * Read one Keychain item. This is the same `/usr/bin/security` call OMC
 * already makes, so it introduces no access prompt the user has not seen.
 * @param {string} service
 * @param {string|undefined} account
 * @returns {{accessToken: string, expiresAt: number|null}|null}
 */
function readKeychainCredential(service, account) {
  try {
    const args = account
      ? ['find-generic-password', '-s', service, '-a', account, '-w']
      : ['find-generic-password', '-s', service, '-w'];
    const out = execFileSync('/usr/bin/security', args, {
      encoding: 'utf-8',
      timeout: KEYCHAIN_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (!out) return null;
    return normalizeCreds(JSON.parse(out));
  } catch {
    return null;
  }
}

/**
 * Resolve usable OAuth credentials: Keychain first (macOS), then the config
 * file. Unlike OMC we reject expired credentials outright instead of keeping
 * them as a fallback — OMC keeps them so it can refresh, and we never refresh.
 * @returns {{accessToken: string, expiresAt: number|null}|null}
 */
function readCredentials() {
  const candidates = [];

  if (process.platform === 'darwin') {
    const service = keychainServiceName();
    let username = null;
    try {
      username = userInfo().username?.trim() || null;
    } catch {
      // Best-effort only; the service-only lookup below still applies.
    }
    for (const account of username ? [username, undefined] : [undefined]) {
      const creds = readKeychainCredential(service, account);
      if (creds) candidates.push(creds);
    }
  }

  try {
    const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    const credPath = join(configDir, '.credentials.json');
    if (existsSync(credPath)) {
      const creds = normalizeCreds(JSON.parse(readFileSync(credPath, 'utf-8')));
      if (creds) candidates.push(creds);
    }
  } catch {
    // File missing or malformed — fall through.
  }

  return candidates.find((c) => !isExpired(c)) || null;
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/**
 * GET the usage endpoint. Any non-200 (including the 429 this endpoint hands
 * out freely) is treated as "no data" — we never surface a partial body.
 * @param {string} accessToken
 * @returns {Promise<object|null>}  Parsed JSON body, or null.
 */
async function fetchUsageRaw(accessToken) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': OAUTH_BETA,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/**
 * Percentages are rounded to integers so the segment width stays stable across
 * renders — Line 3 prints the number verbatim, and a value like `6.4%` would
 * jitter the layout on every refresh.
 * @param {unknown} v
 * @returns {number|null}
 */
function clampPercent(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Normalize `resets_at` to an ISO string, which is what `formatResetIn`
 * expects and what survives the caller's JSON cache round-trip.
 * @param {unknown} raw
 * @returns {string|null}
 */
function normalizeResetsAt(raw) {
  if (typeof raw !== 'string' || raw === '') return null;
  const t = new Date(raw).getTime();
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * Pull the model-scoped weekly rows out of a usage response body.
 * @param {object|null} body
 * @returns {object|null}  e.g. `{ fableWeeklyPercent: 7, fableWeeklyResetsAt: '...' }`,
 *                         or null when the body carries no recognized rows.
 */
export function parseScopedLimits(body) {
  const rows = body?.limits;
  if (!Array.isArray(rows)) return null;

  const out = {};
  for (const row of rows) {
    if (row?.kind !== 'weekly_scoped') continue;
    const key = SCOPED_MODELS[row?.scope?.model?.display_name];
    if (!key) continue;
    const percent = clampPercent(row.percent);
    if (percent === null) continue;
    out[`${key}WeeklyPercent`] = percent;
    const resetsAt = normalizeResetsAt(row.resets_at);
    if (resetsAt) out[`${key}WeeklyResetsAt`] = resetsAt;
  }
  return Object.keys(out).length > 0 ? out : null;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/**
 * @returns {{data: object|null}|null}  Cache entry if fresh, else null.
 */
function readCache() {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    const entry = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
    if (typeof entry?.checkedAt !== 'number') return null;
    const age = Date.now() - entry.checkedAt;
    // A negative age means the clock moved backwards; treat it as a miss
    // rather than trusting an entry that could now outlive its TTL.
    if (age < 0) return null;
    const ttl = entry.data ? CACHE_TTL_MS : CACHE_TTL_FAILURE_MS;
    return age > ttl ? null : entry;
  } catch {
    return null;
  }
}

/**
 * Write via temp file + rename. Concurrent sessions render constantly, and a
 * torn read would throw inside JSON.parse on someone else's next render.
 * @param {object|null} data
 */
function writeCache(data) {
  const tmpPath = `${CACHE_FILE}.${process.pid}.tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify({ checkedAt: Date.now(), data }), 'utf-8');
    renameSync(tmpPath, CACHE_FILE);
  } catch {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Nothing left to clean up.
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Model-scoped weekly rate limits, cached machine-wide.
 *
 * @returns {Promise<object|null>}  Merge-ready fields such as
 *   `fableWeeklyPercent` / `fableWeeklyResetsAt`, or null when unavailable.
 */
export async function getScopedWeeklyLimits() {
  const cached = readCache();
  if (cached) return cached.data;

  const creds = readCredentials();
  if (!creds) {
    writeCache(null);
    return null;
  }

  const body = await fetchUsageRaw(creds.accessToken);
  const scoped = parseScopedLimits(body);
  writeCache(scoped);
  return scoped;
}
