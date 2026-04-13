/**
 * agents.mjs — Agent tree renderer.
 *
 * STUB: Will be replaced with full implementation from 03-02.
 * Renders running agents as a tree with model tier color coding.
 *
 * Requirements: AGENT-01, AGENT-02
 */

import { fg256, dim, RESET } from '../lib/ansi.mjs';
import { formatDuration } from '../lib/format.mjs';

// Model tier display codes and 256-color mappings
const MODEL_TIER = { opus: 'O', sonnet: 's', haiku: 'h' };
const MODEL_COLOR = { opus: 207, sonnet: 51, haiku: 46 };

/** Default max agent lines before "+N more" truncation. */
const MAX_AGENT_LINES = 4;

/**
 * Render agent tree lines.
 *
 * @param {import('../data/context.mjs').RenderContext} ctx
 * @param {number} [maxLines=4]  Maximum visible agent lines
 * @returns {string[]}  Array of rendered tree lines (may be empty)
 */
export function renderAgentTree(ctx, maxLines = MAX_AGENT_LINES) {
  const agents = ctx.agents || [];
  const running = agents.filter(a => a.status === 'running');

  if (running.length === 0) return [];

  const lines = [];
  const shown = running.slice(0, maxLines);

  for (let i = 0; i < shown.length; i++) {
    const a = shown[i];
    const isLast = i === shown.length - 1 && running.length <= maxLines;
    const prefix = isLast ? '\u2514\u2500' : '\u251c\u2500';
    const tier = MODEL_TIER[a.model] || 's';
    const color = MODEL_COLOR[a.model] || 51;
    const dur = a.startTime
      ? formatDuration(Date.now() - new Date(a.startTime).getTime())
      : '';
    const desc = (a.description || a.type || '').slice(0, 40);

    lines.push(
      `\x1b[90m${prefix}\x1b[0m ${fg256(color, tier)} \x1b[97m${desc}\x1b[0m ${dim(dur)}`
    );
  }

  if (running.length > maxLines) {
    lines.push(`\x1b[90m\u2514\u2500 +${running.length - maxLines} more\x1b[0m`);
  }

  return lines;
}
