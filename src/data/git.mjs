/**
 * Git Branch and Status Collector
 *
 * Collects git branch name and status counts (staged, modified, untracked,
 * ahead, behind) using array-form execFileSync for shell-injection safety.
 * Results are cached for 30 seconds to avoid redundant process spawning.
 *
 * CRITICAL: Uses execFileSync with array arguments, NEVER execSync with
 * string commands. Array-form passes args directly to the kernel without
 * shell interpretation, preventing injection attacks.
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 30_000; // 30 seconds

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/** @type {Map<string, { value: string|null, expiresAt: number }>} */
const branchCache = new Map();

/** @type {Map<string, { value: object|null, expiresAt: number }>} */
const statusCache = new Map();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the current git branch name.
 *
 * @param {string} [cwd]  Working directory (defaults to process.cwd())
 * @returns {string|null}  Branch name, or null if not in a git repo.
 */
export function getGitBranch(cwd) {
  const key = cwd ? resolve(cwd) : process.cwd();

  // Check cache
  const cached = branchCache.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }

  let value = null;
  try {
    const result = execFileSync('git', ['branch', '--show-current'], {
      cwd: key,
      encoding: 'utf-8',
      timeout: 1000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    value = result || null;
  } catch {
    // Not a git repo, git not installed, or other error -- return null
    value = null;
  }

  branchCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/**
 * Get git status counts: staged, modified, untracked, ahead, behind.
 *
 * @param {string} [cwd]  Working directory (defaults to process.cwd())
 * @returns {{ staged: number, modified: number, untracked: number, ahead: number, behind: number }|null}
 *   Status counts object, or null if not in a git repo.
 */
export function getGitStatusCounts(cwd) {
  const key = cwd ? resolve(cwd) : process.cwd();

  // Check cache
  const cached = statusCache.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }

  let value = null;
  try {
    const output = execFileSync('git', ['status', '--porcelain', '-b'], {
      cwd: key,
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const lines = output.split('\n');
    let staged = 0;
    let modified = 0;
    let untracked = 0;
    let ahead = 0;
    let behind = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;

      if (i === 0 && line.startsWith('##')) {
        // Branch line: ## main...origin/main [ahead 3, behind 1]
        const aheadMatch = line.match(/\bahead (\d+)/);
        const behindMatch = line.match(/\bbehind (\d+)/);
        if (aheadMatch) ahead = parseInt(aheadMatch[1], 10);
        if (behindMatch) behind = parseInt(behindMatch[1], 10);
        continue;
      }

      // File status entries (2-char status code + space + path)
      if (line.length < 2) continue;

      const x = line[0]; // Index (staging area) status
      const y = line[1]; // Working tree status

      if (x === '?') {
        untracked++;
      } else {
        // Staged: any non-space, non-? in index position
        if (x !== ' ' && x !== '?') {
          staged++;
        }
        // Modified in working tree
        if (y === 'M' || y === 'D') {
          modified++;
        }
      }
    }

    value = { staged, modified, untracked, ahead, behind };
  } catch {
    // Not a git repo or other error -- cache null to avoid repeated failures
    value = null;
  }

  statusCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/**
 * Clear both branch and status caches.
 * Useful for testing and forced refresh scenarios.
 */
export function clearGitCache() {
  branchCache.clear();
  statusCache.clear();
}
