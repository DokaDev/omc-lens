/**
 * format.mjs — Token, duration, cost, and reset-time formatters.
 *
 * Pure formatting functions with no external dependencies.
 * Migrated from existing draft dokalab_omc_hud.mjs (lines 93-124).
 */

/**
 * Format token count with k/M suffix.
 * @param {number} n  Token count
 * @returns {string}  e.g. '500', '1.2k', '3.4M'
 */
export function fmtTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}

/**
 * Format millisecond duration to human-readable string.
 * @param {number} ms  Duration in milliseconds
 * @returns {string}  e.g. '45m', '2h3m', '1d12h'
 */
export function formatDuration(ms) {
  const totalMins = Math.floor(ms / 60000);
  if (totalMins < 60) return `${totalMins}m`;
  const totalHours = Math.floor(totalMins / 60);
  if (totalHours < 24) {
    const m = totalMins % 60;
    return m > 0 ? `${totalHours}h${m}m` : `${totalHours}h`;
  }
  const d = Math.floor(totalHours / 24);
  const h = totalHours % 24;
  return h > 0 ? `${d}d${h}h` : `${d}d`;
}

/**
 * Format USD cost with adaptive precision.
 * @param {number} usd  Cost in USD
 * @returns {string}  e.g. '$0.0010', '$0.123', '$5.68'
 */
export function formatCost(usd) {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * Format time remaining until rate limit reset.
 * Handles past reset times by advancing to next cycle.
 * @param {string} isoString  ISO 8601 reset timestamp
 * @param {string} cycleName  Cycle type: '5h', 'wk', or 'mo'
 * @returns {string}  Formatted duration or '' on error
 */
export function formatResetIn(isoString, cycleName) {
  try {
    let resetAt = new Date(isoString).getTime();
    const now = Date.now();
    if (resetAt <= now) {
      const cycleMs =
        cycleName === 'wk'
          ? 7 * 24 * 60 * 60 * 1000
          : cycleName === 'mo'
            ? 30 * 24 * 60 * 60 * 1000
            : 5 * 60 * 60 * 1000;
      while (resetAt <= now) resetAt += cycleMs;
    }
    return formatDuration(resetAt - now);
  } catch {
    return '';
  }
}
