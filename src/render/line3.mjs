/**
 * line3.mjs — Line 3 renderer: Orchestration, rate limits, session.
 *
 * STUB: Will be replaced with full implementation from 03-02.
 * Renders ralph/ultrawork/autopilot/prd/profile/api-key/session/rate-limit/summary.
 *
 * Requirements: REND3-01 through REND3-09
 */

import { fg256, bold, dim, RESET } from '../lib/ansi.mjs';
import { getIcon } from '../lib/icons.mjs';
import { formatDuration, formatResetIn } from '../lib/format.mjs';
import { basename, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const SEP = `\x1b[90m|\x1b[0m`;

// 14-step rate limit color gradient (cyan -> red as usage increases)
const RATE_COLORS = [
  [10, 51], [20, 50], [30, 49], [40, 48], [50, 82],
  [55, 118], [60, 154], [65, 190], [70, 226], [75, 220],
  [80, 214], [85, 208], [90, 202], [100, 196],
];

/**
 * Get 256-color code for rate limit usage percentage.
 * @param {number} u  Usage percentage 0-100
 * @returns {number}  256-color code
 */
function rateColor(u) {
  for (const [threshold, color] of RATE_COLORS) {
    if (u <= threshold) return color;
  }
  return 196;
}

/**
 * Render Line 3: Orchestration and session info.
 *
 * @param {import('../data/context.mjs').RenderContext} ctx
 * @returns {string}  Rendered ANSI line
 */
export function renderLine3(ctx) {
  const parts = [];

  // Vim mode (always first, with box-drawing separator)
  let vimPrefix = '';
  if (ctx.vimMode) {
    const vimCol = ctx.vimMode === 'INSERT' ? 114 : 171;
    vimPrefix = `${fg256(vimCol, `${getIcon('vim')} ${ctx.vimMode}`)} \x1b[90m│\x1b[0m `;
  }

  // Ralph / Ultrawork combined or separate
  if (ctx.ultrawork && ctx.ralph) {
    const count = ctx.ultrawork.reinforcement_count || 0;
    const iter = ctx.ralph.iteration || 0;
    const max = ctx.ralph.max_iterations || '?';
    parts.push(fg256(207, `\uf0e7 ultrawork+ralph:${iter}/${max} x${count}`));
  } else if (ctx.ralph) {
    const iter = ctx.ralph.iteration || 0;
    const max = ctx.ralph.max_iterations || '?';
    parts.push(fg256(226, `\u{f046e} ralph:${iter}/${max}`));
  } else if (ctx.ultrawork) {
    const count = ctx.ultrawork.reinforcement_count || 0;
    parts.push(fg256(207, `\uf0e7 ultrawork:x${count}`));
  }

  // Autopilot
  if (ctx.autopilot) {
    const phase = ctx.autopilot.phase || '';
    const iter = ctx.autopilot.iteration || 0;
    const max = ctx.autopilot.max_iterations || '?';
    const label = phase ? `Phase ${iter} ${phase}` : `${iter}/${max}`;
    parts.push(fg256(51, `\uf0144 autopilot:${label}`));
  }

  // PRD story
  if (ctx.prd) {
    const col = ctx.prd.completed === ctx.prd.total ? 46 : 51;
    let prdStr = `${getIcon('story')} ${ctx.prd.storyId || ''}`;
    if (ctx.prd.total) prdStr += ` (${ctx.prd.completed || 0}/${ctx.prd.total})`;
    parts.push(fg256(col, prdStr));
  }

  // Profile name
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  if (configDir) {
    const profileName = basename(configDir);
    parts.push(`\x1b[35m\u{f0004} \x1b[97m${profileName}\x1b[0m`);
  }

  // API key source
  const apiKey = detectApiKeySource(ctx.cwd);
  if (apiKey) {
    const keyCol = apiKey === 'oauth' ? 46 : apiKey === 'env' ? 226 : 51;
    parts.push(`${fg256(keyCol, getIcon('key'))} \x1b[97m${apiKey}\x1b[0m`);
  }

  // Session duration
  if (ctx.sessionStart) {
    const durationMs = Date.now() - new Date(ctx.sessionStart).getTime();
    const mins = Math.floor(durationMs / 60000);
    const durCol = mins >= 120 ? 196 : mins >= 60 ? 226 : 46;
    parts.push(`${fg256(durCol, getIcon('timer'))} \x1b[97m${formatDuration(durationMs)}\x1b[0m`);
  } else {
    parts.push(`\x1b[90m${getIcon('timer')} 0m\x1b[0m`);
  }

  // Rate limits
  if (ctx.rateLimits) {
    const rateParts = [];
    let maxU = 0;

    if (ctx.rateLimits.fiveHourPercent !== undefined) {
      const u = ctx.rateLimits.fiveHourPercent;
      maxU = Math.max(maxU, u);
      let s = `\x1b[97m5h ${fg256(rateColor(u), `${u}%`)}`;
      if (ctx.rateLimits.fiveHourResetsAt) {
        const resetIn = formatResetIn(ctx.rateLimits.fiveHourResetsAt, '5h');
        if (resetIn) s += `\x1b[90m(${resetIn})\x1b[0m`;
      }
      rateParts.push(s);
    }

    if (ctx.rateLimits.weeklyPercent !== undefined) {
      const u = ctx.rateLimits.weeklyPercent;
      maxU = Math.max(maxU, u);
      let s = `\x1b[97mwk ${fg256(rateColor(u), `${u}%`)}`;
      if (ctx.rateLimits.weeklyResetsAt) {
        const resetIn = formatResetIn(ctx.rateLimits.weeklyResetsAt, 'wk');
        if (resetIn) s += `\x1b[90m(${resetIn})\x1b[0m`;
      }
      rateParts.push(s);
    }

    if (ctx.rateLimits.sonnetWeeklyPercent !== undefined) {
      const u = ctx.rateLimits.sonnetWeeklyPercent;
      maxU = Math.max(maxU, u);
      let s = `\x1b[97msn ${fg256(rateColor(u), `${u}%`)}`;
      if (ctx.rateLimits.sonnetWeeklyResetsAt) {
        const resetIn = formatResetIn(ctx.rateLimits.sonnetWeeklyResetsAt, 'wk');
        if (resetIn) s += `\x1b[90m(${resetIn})\x1b[0m`;
      }
      rateParts.push(s);
    }

    if (ctx.rateLimits.opusWeeklyPercent !== undefined) {
      const u = ctx.rateLimits.opusWeeklyPercent;
      maxU = Math.max(maxU, u);
      let s = `\x1b[97mop ${fg256(rateColor(u), `${u}%`)}`;
      if (ctx.rateLimits.opusWeeklyResetsAt) {
        const resetIn = formatResetIn(ctx.rateLimits.opusWeeklyResetsAt, 'wk');
        if (resetIn) s += `\x1b[90m(${resetIn})\x1b[0m`;
      }
      rateParts.push(s);
    }

    if (ctx.rateLimits.monthlyPercent !== undefined) {
      const u = ctx.rateLimits.monthlyPercent;
      maxU = Math.max(maxU, u);
      rateParts.push(`\x1b[97mmo ${fg256(rateColor(u), `${u}%`)}`);
    }

    if (rateParts.length) {
      parts.push(`${fg256(rateColor(maxU), getIcon('speed'))} ${rateParts.join(' ')}`);
    }
  }

  // Cache hit rate & efficiency
  if (ctx.tokens) {
    const hr = ctx.tokens.cacheHitRate || 0;
    const ef = ctx.tokens.cacheEfficiency || 0;
    const hrColor = hr >= 0.85 ? 46 : hr >= 0.60 ? 226 : hr > 0 ? 196 : 245;
    const efColor = ef >= 0.85 ? 46 : ef >= 0.60 ? 226 : ef > 0 ? 196 : 245;
    const cu = ctx.tokens.cacheCumulativeHitRate || 0;
    const cuColor = cu >= 0.85 ? 46 : cu >= 0.60 ? 226 : cu > 0 ? 196 : 245;
    const hrPct = (hr * 100).toFixed(0);
    const efPct = (ef * 100).toFixed(0);
    const cuPct = (cu * 100).toFixed(0);

    // Per-turn deltas (from Stop hook snapshot)
    const prevHr = ctx.tokens.prevCacheHitRate;
    const prevEf = ctx.tokens.prevCacheEfficiency;
    let hrDelta = '';
    let efDelta = '';
    if (prevHr !== null && prevHr !== undefined) {
      const d = Math.round((hr - prevHr) * 100);
      if (d !== 0) hrDelta = fg256(d > 0 ? 46 : 196, `(${d > 0 ? '+' : ''}${d})`);
    }
    if (prevEf !== null && prevEf !== undefined) {
      const d = Math.round((ef - prevEf) * 100);
      if (d !== 0) efDelta = fg256(d > 0 ? 46 : 196, `(${d > 0 ? '+' : ''}${d})`);
    }

    parts.push(`${fg256(171, getIcon('cache'))}hr ${fg256(hrColor, `${hrPct}%`)}${hrDelta} \x1b[97mef ${fg256(efColor, `${efPct}%`)}${efDelta} \x1b[97mcu ${fg256(cuColor, `${cuPct}%`)}`);
  }

  // Session summary
  if (ctx.sessionSummary) {
    const label = ctx.sessionSummary.slice(0, 35);
    const suffix = ctx.sessionSummary.length > 35 ? '\u2026' : '';
    parts.push(`\x1b[90m${getIcon('summary')} ${label}${suffix}\x1b[0m`);
  }

  return vimPrefix + parts.join(` ${SEP} `);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Detect API key source: project config > global config > env var > oauth.
 * @param {string} cwd
 * @returns {string|null}
 */
function detectApiKeySource(cwd) {
  try {
    // 1. Project-level config
    if (cwd) {
      const projectSettings = join(cwd, '.claude', 'settings.local.json');
      if (existsSync(projectSettings)) {
        const data = JSON.parse(readFileSync(projectSettings, 'utf8'));
        if (data?.env && 'ANTHROPIC_API_KEY' in data.env) return 'project';
      }
    }
    // 2. Global config
    const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    const globalSettings = join(configDir, 'settings.json');
    if (existsSync(globalSettings)) {
      const data = JSON.parse(readFileSync(globalSettings, 'utf8'));
      if (data?.env && 'ANTHROPIC_API_KEY' in data.env) return 'global';
    }
    // 3. Environment variable
    if (process.env.ANTHROPIC_API_KEY) return 'env';
    // 4. OAuth (default for Claude Code logged-in users)
    return 'oauth';
  } catch {
    return null;
  }
}
