/**
 * line2.mjs — Line 2 renderer: context gradient bar, token usage,
 * session cost, call counts, background tasks, and todo progress.
 *
 * Ported from prototype dokalab_omc_hud.mjs (lines 163-199, 664-678, 791-819).
 * Uses project ansi.mjs primitives where applicable, with raw escapes
 * for combined fg+bg bar characters (RESET sandwich still honored).
 */

import { RESET, fg256, bold, dim } from '../lib/ansi.mjs';
import { fmtTokens, formatCost } from '../lib/format.mjs';
import { getIcon } from '../lib/icons.mjs';

// ─── Gradient Bar Constants ──────────────────────────────────────────────────

/** Foreground gradient: cyan -> green -> yellow -> orange -> red (20 steps) */
const BAR_GRADIENT = [51, 50, 49, 48, 47, 46, 82, 118, 154, 190, 226, 226, 220, 214, 214, 208, 208, 202, 196, 196];

/** Empty block foreground color (dim gray) */
const EMPTY_COLOR = 237;

const BAR_WIDTH = 20;

// ─── Internal: buildBar ──────────────────────────────────────────────────────

/**
 * Build a 20-block 256-color gradient context bar with embedded percentage text.
 * @param {number} pct  0-100 context percentage
 * @returns {string}  ANSI-colored bar string
 */
function buildBar(pct) {
  const filledTenths = Math.floor((pct * BAR_WIDTH * 10) / 100);
  const fullBlocks = Math.floor(filledTenths / 10);
  const frac = filledTenths % 10;

  const pctText = `${pct}%`;
  const textStart = Math.floor((BAR_WIDTH - pctText.length) / 2);
  const textEnd = textStart + pctText.length;

  let bar = '';
  for (let i = 0; i < BAR_WIDTH; i++) {
    const isFilled = i < fullBlocks || (i === fullBlocks && frac > 0);
    const isText = i >= textStart && i < textEnd;

    if (isText) {
      const ch = pctText[i - textStart];
      if (isFilled) {
        // Black text on colored BG (filled region)
        const bgColor = BAR_GRADIENT[i] || BAR_GRADIENT[BAR_GRADIENT.length - 1];
        bar += `\x1b[48;5;${bgColor}m\x1b[1m\x1b[30m${ch}${RESET}`;
      } else {
        // White text on gray BG (empty region)
        bar += `\x1b[48;5;${EMPTY_COLOR}m\x1b[1m\x1b[97m${ch}${RESET}`;
      }
    } else {
      const colorCode = BAR_GRADIENT[i] || BAR_GRADIENT[BAR_GRADIENT.length - 1];
      if (i < fullBlocks) {
        bar += `\x1b[38;5;${colorCode}m\u2588${RESET}`;
      } else if (i === fullBlocks && frac >= 5) {
        bar += `\x1b[38;5;${colorCode}m\u258C${RESET}`;
      } else {
        bar += `\x1b[38;5;${EMPTY_COLOR}m\u2591${RESET}`;
      }
    }
  }

  return bar;
}

// ─── Internal: renderTodos ───────────────────────────────────────────────────

/**
 * Render todo progress segment.
 * @param {Array<{content: string, status: string}>} todos
 * @returns {string}  Formatted todo string
 */
function renderTodos(todos) {
  const icon = getIcon('todo');

  if (!todos || !todos.length) {
    return `${fg256(81, icon)} ${fg256(81, '0/0')}`;
  }

  // [omc-lens #2 sync] Filter null and non-object entries before reading
  // status so malformed transcript tails cannot throw here.
  const safe = (todos ?? []).filter(t => t && typeof t === 'object');

  if (!safe.length) {
    return `${fg256(81, icon)} ${fg256(81, '0/0')}`;
  }

  const done = safe.filter(t => t.status === 'completed').length;
  const inProgress = safe.filter(t => t.status === 'in_progress').length;
  const total = safe.length;

  // Color: all done = green(114), in_progress > 0 = cyan(81), else yellow(226)
  const colorCode = done === total ? 114 : inProgress > 0 ? 81 : 226;

  let str = `${fg256(colorCode, icon)} ${fg256(255, `${done}/${total}`)}`;

  // Show first in-progress todo label (max 30 chars)
  const current = safe.find(t => t.status === 'in_progress');
  if (current?.content) {
    const label = current.content.slice(0, 30);
    const suffix = current.content.length > 30 ? '\u2026' : '';
    str += ` ${fg256(245, `${label}${suffix}`)}`;
  }

  return str;
}

// ─── Export: renderLine2 ─────────────────────────────────────────────────────

const SEP = dim('|');

/**
 * Render Line 2: context bar, token usage, cost, call counts,
 * background tasks, and todo progress.
 *
 * @param {object} ctx  RenderContext
 * @returns {string}  Fully formatted ANSI string
 */
export function renderLine2(ctx) {
  // [omc-lens #2 sync] Per-segment try/catch — a single segment's failure
  // no longer erases downstream Line 2 content. Errors stay silent unless
  // OMC_LENS_DEBUG=1 is set, in which case they surface on stderr.
  const debug = process.env.OMC_LENS_DEBUG === '1';

  function trySegment(name, fn) {
    try {
      return fn();
    } catch (err) {
      if (debug) process.stderr.write(`[omc-lens line2:${name}] ${err.message}\n`);
      return '';
    }
  }

  const pct = ctx.contextPercent || 0;

  const seg1 = trySegment('ctx-bar', () => {
    const bar = buildBar(pct);
    let pctSuffix = '';
    if (pct >= 90) {
      pctSuffix = ` ${bold(fg256(196, 'CRITICAL'))}`;
    } else if (pct >= 80) {
      pctSuffix = ` ${fg256(226, 'COMPRESS?')}`;
    }
    return `${fg256(255, 'CTX')} [${bar}]${pctSuffix}`;
  });

  const seg2 = trySegment('tokens', () => {
    const tokens = ctx.tokens || {};
    const inputT = fmtTokens(tokens.inputTokens || 0);
    const outputT = fmtTokens(tokens.outputTokens || 0);
    const sessionT = fmtTokens(tokens.sessionTotal || 0);
    let s = `${fg256(255, getIcon('token'))} ${fg256(81, '\u2193')}${fg256(255, inputT)} ${fg256(171, '\u2191')}${fg256(255, outputT)} ${fg256(114, '\u03A3')}${fg256(255, sessionT)}`;
    if (tokens.reasoningTokens) {
      s += ` ${fg256(208, `R${fmtTokens(tokens.reasoningTokens)}`)}`;
    }
    return s;
  });

  const seg3 = trySegment('cost', () =>
    `${fg256(226, getIcon('cost'))} ${fg256(255, formatCost(ctx.cost || 0))}`
  );

  const seg4 = trySegment('counters', () => {
    let s = `${fg256(208, getIcon('wrench'))} ${fg256(255, String(ctx.toolCallCount || 0))}`;
    s += ` ${fg256(81, getIcon('robot'))} ${fg256(255, String(ctx.agentCallCount || 0))}`;
    s += ` ${fg256(171, getIcon('flash'))} ${fg256(255, String(ctx.skillCallCount || 0))}`;
    if (ctx.lastActivatedSkill) {
      s += ` ${fg256(171, ctx.lastActivatedSkill.name)}`;
    }
    return s;
  });

  const seg5 = trySegment('background', () => {
    const activeCount = ctx.activeTaskCount || 0;
    return `${fg256(81, getIcon('progress'))} ${fg256(255, String(activeCount))}`;
  });

  const seg6 = trySegment('todos', () => renderTodos(ctx.todos));

  return [seg1, seg2, seg3, seg4, seg5, seg6]
    .filter(s => s && s.length > 0)
    .join(` ${SEP} `);
}
