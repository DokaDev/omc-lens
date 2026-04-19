// [omc-hud v4.12.1 sync] Semver parser — mirrors omc-hud.mjs L126-152
// Purpose: unified version comparison with stable > pre-release priority

/**
 * Parse a semver string into a structured object.
 *
 * Tolerates a leading `v` prefix (e.g. `v4.12.0`), ignores build metadata
 * (`+build.abc`), and fills in any missing minor/patch segments as 0.
 *
 * @param {string} str  Version string to parse.
 * @returns {{ major: number, minor: number, patch: number, prerelease: string, isStable: boolean } | null}
 *   Parsed version object, or null when the string cannot be parsed.
 */
export function parseSemver(str) {
  if (typeof str !== 'string') return null;

  // Strip leading `v` and build metadata
  const cleaned = str.trim().replace(/^v/, '').replace(/\+[^-]*$/, '');

  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-(.+))?$/.exec(cleaned);
  if (!match) return null;

  const major = Number(match[1]);
  const minor = match[2] !== undefined ? Number(match[2]) : 0;
  const patch = match[3] !== undefined ? Number(match[3]) : 0;
  const prerelease = match[4] || '';
  const isStable = prerelease === '';

  return { major, minor, patch, prerelease, isStable };
}

/**
 * Compare two version strings in descending order (newest first).
 *
 * Stable versions outrank pre-releases with the same numeric triplet
 * (e.g. `4.12.0` sorts before `4.12.0-rc1`).  Pre-release segments are
 * compared dot-by-dot; purely numeric segments are compared numerically.
 *
 * Returns a negative number when `a` should sort before `b` (i.e. `a` is
 * newer), a positive number when `b` is newer, and 0 when equal.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareSemverDesc(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);

  // Push un-parseable entries to the end
  if (!pa && !pb) return 0;
  if (!pa) return 1;
  if (!pb) return -1;

  // Compare major.minor.patch (descending)
  if (pa.major !== pb.major) return pb.major - pa.major;
  if (pa.minor !== pb.minor) return pb.minor - pa.minor;
  if (pa.patch !== pb.patch) return pb.patch - pa.patch;

  // Same numeric triplet: stable > pre-release
  if (pa.isStable !== pb.isStable) return pa.isStable ? -1 : 1;

  // Both pre-release: compare segment by segment
  if (!pa.isStable) {
    const segsA = pa.prerelease.split('.');
    const segsB = pb.prerelease.split('.');
    const len = Math.max(segsA.length, segsB.length);
    for (let i = 0; i < len; i++) {
      const sa = segsA[i] ?? '';
      const sb = segsB[i] ?? '';
      if (sa === sb) continue;
      const na = Number(sa);
      const nb = Number(sb);
      if (!Number.isNaN(na) && !Number.isNaN(nb)) return nb - na;
      // Descending locale compare
      return sb.localeCompare(sa);
    }
  }

  return 0;
}
