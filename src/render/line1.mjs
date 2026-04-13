/**
 * line1.mjs -- Line 1 renderer: Identity bar.
 *
 * Displays model identity, thinking/permission state, CWD, git status,
 * OMC version, worktree, vim mode, and session name.
 *
 * Layout (segments joined by dim '|' separator):
 *   [claude_icon model] [thinking?] [APPROVE?] | [folder dirname] | [git branch status] | [omc ver] | [worktree] [vim] [session]
 */

import { fg256, bold, dim, RESET } from '../lib/ansi.mjs';
import { getIcon } from '../lib/icons.mjs';
import { basename } from 'node:path';
import { execFileSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Claude Code version (cached — never changes during a session)
// ---------------------------------------------------------------------------
let _claudeVersion = null;

function getClaudeVersion() {
  if (_claudeVersion !== null) return _claudeVersion;
  try {
    const raw = execFileSync('claude', ['--version'], { timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
    // "2.1.94 (Claude Code)" -> "2.1.94"
    _claudeVersion = raw.split(/\s/)[0] || '';
  } catch {
    _claudeVersion = '';
  }
  return _claudeVersion;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SEP = dim('|');

/** Model tier -> 256-color code */
const TIER_COLORS = {
  opus: 171,    // magenta
  sonnet: 81,   // cyan
  haiku: 114,   // green
};

// ---------------------------------------------------------------------------
// Segment builders
// ---------------------------------------------------------------------------

/**
 * Model identity segment: icon + model name, colored by tier.
 * @param {object} ctx
 * @returns {string}
 */
function modelSegment(ctx) {
  const icon = getIcon('claude');
  const color = TIER_COLORS[ctx.modelTier] || 81;
  return bold(fg256(color, `${icon} ${ctx.model}`));
}

/**
 * Thinking indicator (shown when extended thinking is active).
 * @param {object} ctx
 * @returns {string}
 */
function thinkingSegment(ctx) {
  if (!ctx.thinkingState) return '';
  return fg256(171, getIcon('thinking'));
}

/**
 * Permission approval indicator.
 * @param {object} ctx
 * @returns {string}
 */
function approveSegment(ctx) {
  if (!ctx.pendingPermission) return '';
  return bold(fg256(226, `${getIcon('lock')} APPROVE?`));
}

/**
 * Current working directory basename.
 * @param {object} ctx
 * @returns {string}
 */
function cwdSegment(ctx) {
  if (!ctx.cwd) return '';
  const dir = basename(ctx.cwd);
  return `${fg256(75, `${getIcon('folder')} ${dir}`)}`;
}

/**
 * Git branch + status counts.
 * @param {object} ctx
 * @returns {string}
 */
function gitSegment(ctx) {
  if (!ctx.gitBranch) return '';

  const s = ctx.gitStatus;
  const dirty = s && (s.staged > 0 || s.modified > 0 || s.untracked > 0);
  let out = fg256(226, `${getIcon('git_branch')} ${ctx.gitBranch}${dirty ? '*' : ''}`);

  if (s) {
    const counts = [];
    if (s.staged > 0) counts.push(fg256(114, `+${s.staged}`));
    if (s.modified > 0) counts.push(fg256(208, `!${s.modified}`));
    if (s.untracked > 0) counts.push(fg256(245, `?${s.untracked}`));
    if (s.ahead > 0) counts.push(fg256(114, `up${s.ahead}`));
    if (s.behind > 0) counts.push(fg256(196, `dn${s.behind}`));
    if (counts.length > 0) {
      out += ` ${counts.join(' ')}`;
    }
  }

  return out;
}

/**
 * OMC version segment (with optional update indicator).
 * @param {object} ctx
 * @returns {string}
 */
function omcSegment(ctx) {
  const parts = [];

  // Claude Code version
  const ccVer = getClaudeVersion();
  if (ccVer) {
    parts.push(fg256(245, `${getIcon('terminal')} ${ccVer}`));
  }

  // OMC version
  if (ctx.omcVersion) {
    if (ctx.omcUpdateAvailable) {
      parts.push(fg256(226, `${getIcon('update')} ${ctx.omcVersion}\u2192${ctx.omcUpdateAvailable}`));
    } else {
      parts.push(fg256(81, `${getIcon('omc')} ${ctx.omcVersion}`));
    }
  }

  return parts.join('  ');
}

/**
 * Worktree name segment.
 * @param {object} ctx
 * @returns {string}
 */
function worktreeSegment(ctx) {
  if (!ctx.worktree) return '';
  return fg256(75, `${getIcon('worktree')} ${ctx.worktree}`);
}

/**
 * Vim mode segment.
 * @param {object} ctx
 * @returns {string}
 */
function vimSegment(ctx) {
  if (!ctx.vimMode) return '';
  const color = ctx.vimMode === 'INSERT' ? 208 : 114;
  return fg256(color, `${getIcon('vim')} ${ctx.vimMode}`);
}

/**
 * Session name segment.
 * @param {object} ctx
 * @returns {string}
 */
function sessionSegment(ctx) {
  if (!ctx.sessionName) return '';
  return fg256(245, `${getIcon('session')} ${ctx.sessionName}`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render Line 1: Identity bar.
 *
 * Shows model name with icon, thinking/permission state, CWD, git info,
 * OMC version, worktree, vim mode, and session name -- all joined by
 * dim '|' separators. Empty segments are omitted.
 *
 * @param {import('../data/context.mjs').RenderContext} ctx
 * @returns {string}
 */
export function renderLine1(ctx) {
  // Group 1: Model identity block (no separator between sub-parts)
  const identity = [
    modelSegment(ctx),
    thinkingSegment(ctx),
  ].filter(Boolean).join(' ');

  // Group 2: Location
  const cwd = cwdSegment(ctx);

  // Group 3: Git + Worktree (related — worktree after branch)
  const git = [
    gitSegment(ctx),
    worktreeSegment(ctx),
  ].filter(Boolean).join(' ');

  // Group 4: OMC
  const omc = omcSegment(ctx);

  // Group 5: Environment extras (joined by space, not separator)
  // Note: vim mode moved to Line 3 (first element)
  const extras = [
    sessionSegment(ctx),
  ].filter(Boolean).join(' ');

  // Join non-empty groups with separator
  const groups = [identity, cwd, git, omc, extras].filter(Boolean);
  return groups.join(` ${SEP} `);
}
