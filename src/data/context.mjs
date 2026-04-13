/**
 * Context Assembler
 *
 * Orchestrates all data collection into a single RenderContext object.
 * Each data source is independently try/catch wrapped so one failure
 * does not block others. The resulting object contains everything
 * Phase 3 renderers need to produce the HUD output.
 */

import {
  initBridge,
  readStdin as omcReadStdin,
  getContextPercent,
  getModelName,
  stabilizeContextPercent,
  parseTranscript,
  readHudState,
  getBackgroundTaskCount,
  readRalphStateForHud,
  readUltraworkStateForHud,
  readAutopilotStateForHud,
  readPrdStateForHud,
  getUsage,
  getOmcVersion,
} from '../lib/omc-bridge.mjs';

import { getGitBranch, getGitStatusCounts } from './git.mjs';
import { calculateSessionCost, getModelTier } from './cost.mjs';
import { checkOmcVersion, checkLensVersion } from './version-check.mjs';
import { readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';

// ---------------------------------------------------------------------------
// TaskCreate/TaskUpdate parser (fallback when OMC TodoWrite is empty)
// ---------------------------------------------------------------------------
const MAX_TASK_TAIL = 512 * 1024;

/**
 * Parse TaskCreate/TaskUpdate from transcript JSONL to build a task list.
 * Only used as fallback when OMC's TodoWrite-based todos are empty.
 *
 * @param {string|null} transcriptPath
 * @returns {Array<{content: string, status: string}>}
 */
function parseTasksFromTranscript(transcriptPath) {
  if (!transcriptPath) return [];
  try {
    const stat = statSync(transcriptPath);
    let lines;
    if (stat.size > MAX_TASK_TAIL) {
      const startOffset = Math.max(0, stat.size - MAX_TASK_TAIL);
      const fd = openSync(transcriptPath, 'r');
      const buf = Buffer.alloc(stat.size - startOffset);
      readSync(fd, buf, 0, buf.length, startOffset);
      closeSync(fd);
      lines = buf.toString('utf8').split('\n');
      if (startOffset > 0) lines.shift();
    } else {
      lines = readFileSync(transcriptPath, 'utf8').split('\n');
    }

    const taskMap = new Map(); // id -> {content, status}

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        const content = entry.message?.content;
        if (!Array.isArray(content)) continue;

        for (const block of content) {
          if (block.type !== 'tool_use') continue;

          if (block.name === 'TaskCreate' || block.name === 'proxy_TaskCreate') {
            const input = block.input;
            if (input?.subject) {
              taskMap.set(block.id, {
                content: input.subject,
                status: 'pending',
              });
            }
          }

          if (block.name === 'TaskUpdate' || block.name === 'proxy_TaskUpdate') {
            const input = block.input;
            if (input?.id && input?.status) {
              // Find existing task by matching — TaskUpdate uses numeric IDs
              // but TaskCreate block.id is different. Match via iteration.
              for (const [key, task] of taskMap) {
                // TaskUpdate input.id is a number like "1", "2"
                // We track creation order implicitly
                if (task._taskNum === String(input.id)) {
                  task.status = input.status === 'completed' ? 'completed'
                    : input.status === 'in_progress' ? 'in_progress'
                    : 'pending';
                }
              }
            }
          }
        }
      } catch {
        // skip malformed lines
      }
    }

    // Assign task numbers by creation order
    let num = 1;
    for (const task of taskMap.values()) {
      task._taskNum = String(num++);
    }

    // Re-parse for TaskUpdate now that we have task numbers
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        const content = entry.message?.content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          if (block.type === 'tool_use' && (block.name === 'TaskUpdate' || block.name === 'proxy_TaskUpdate')) {
            const input = block.input;
            if (input?.id && input?.status) {
              for (const task of taskMap.values()) {
                if (task._taskNum === String(input.id)) {
                  task.status = input.status === 'completed' ? 'completed'
                    : input.status === 'in_progress' ? 'in_progress'
                    : 'pending';
                }
              }
            }
          }
        }
      } catch { /* skip */ }
    }

    return Array.from(taskMap.values()).map(t => ({
      content: t.content,
      status: t.status,
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Previous stdin reference (for stabilizeContextPercent across calls)
// ---------------------------------------------------------------------------

let _previousStdin = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} RenderContext
 * @property {string} model                     Model display name
 * @property {string} modelTier                  'opus'|'sonnet'|'haiku'
 * @property {number} contextPercent             Context window usage 0-100
 * @property {number|null} contextWindowSize     Context window size in tokens
 * @property {string|null} cwd                   Current working directory
 * @property {string|null} transcriptPath        Path to transcript JSONL
 * @property {Object} tokens                     Token breakdown
 * @property {number} tokens.inputTokens         Current request input tokens
 * @property {number} tokens.outputTokens        Current request output tokens
 * @property {number|null} tokens.reasoningTokens  Reasoning tokens (if any)
 * @property {number|null} tokens.sessionTotal   Session total tokens (if available)
 * @property {number} cost                       Session cost in USD
 * @property {Array} agents                      Active/recent agents
 * @property {Array} todos                       Current todo items
 * @property {Object|undefined} lastActivatedSkill  Last skill invocation
 * @property {number} toolCallCount              Total tool calls
 * @property {number} agentCallCount             Total agent calls
 * @property {number} skillCallCount             Total skill calls
 * @property {string|null} lastToolName          Last tool name used
 * @property {Object|undefined} thinkingState    Extended thinking state
 * @property {Object|undefined} pendingPermission  Pending permission approval
 * @property {Object|null} ralph                 Ralph loop state
 * @property {Object|null} ultrawork             Ultrawork state
 * @property {Object|null} autopilot             Autopilot state
 * @property {Object|null} prd                   PRD story state
 * @property {Object|null} rateLimits            Rate limit usage data
 * @property {string|undefined} rateLimitError   Rate limit fetch error
 * @property {Object} backgroundTasks            {running: number, max: number}
 * @property {string|null} gitBranch             Current git branch
 * @property {Object|null} gitStatus             Git status counts
 * @property {Date|undefined} sessionStart       Session start time
 * @property {Object|null} lastRequestTokenUsage Last request token usage
 * @property {string|null} omcVersion            OMC plugin version
 * @property {boolean} omcAvailable              Whether OMC modules loaded
 */

/**
 * Assemble all HUD data into a single render context.
 *
 * @param {Object} [options]
 * @param {Object} [options.stdin]  Pre-read stdin data (for testing or --watch mode)
 * @returns {Promise<RenderContext>}
 */
export async function assembleContext(options = {}) {
  // Initialize bridge (loads all OMC modules)
  let omcAvailable = false;
  try {
    omcAvailable = await initBridge();
  } catch {
    // Bridge init failed -- continue with defaults
  }

  const omcVersion = getOmcVersion();

  // ── Stdin ──────────────────────────────────────────────────────────────
  let stdin = options.stdin || null;
  if (!stdin) {
    try {
      stdin = await omcReadStdin();
    } catch {
      stdin = null;
    }
  }

  // Stabilize context percent across transient drops
  if (stdin) {
    try {
      stdin = stabilizeContextPercent(stdin, _previousStdin);
      _previousStdin = stdin;
    } catch {
      // Stabilization failed -- use raw stdin
    }
  }

  const model = stdin ? safeCall(() => getModelName(stdin), 'Unknown') : 'Unknown';
  const modelTier = getModelTier(model);
  const contextPercent = stdin ? safeCall(() => getContextPercent(stdin), 0) : 0;
  const contextWindowSize = stdin?.context_window?.context_window_size || null;
  const cwd = stdin?.cwd || process.cwd();
  const transcriptPath = stdin?.transcript_path || null;

  // ── Transcript ─────────────────────────────────────────────────────────
  let txData = null;
  try {
    txData = await parseTranscript(transcriptPath);
  } catch {
    txData = null;
  }

  const agents = txData?.agents || [];
  let todos = txData?.todos || [];

  // Fallback: if OMC TodoWrite-based todos are empty, try TaskCreate/TaskUpdate
  if (todos.length === 0 && transcriptPath) {
    todos = parseTasksFromTranscript(transcriptPath);
  }
  const lastActivatedSkill = txData?.lastActivatedSkill || undefined;
  const toolCallCount = txData?.toolCallCount || 0;
  const agentCallCount = txData?.agentCallCount || 0;
  const skillCallCount = txData?.skillCallCount || 0;
  const lastToolName = txData?.lastToolName || null;
  const thinkingState = txData?.thinkingState || undefined;
  const pendingPermission = txData?.pendingPermission || undefined;
  const sessionStart = txData?.sessionStart || undefined;
  const lastRequestTokenUsage = txData?.lastRequestTokenUsage || null;
  const sessionTotalTokens = txData?.sessionTotalTokens || null;

  // ── Token Breakdown ────────────────────────────────────────────────────
  // stdin context_window.total_input_tokens / total_output_tokens = session cumulative
  // stdin context_window.current_usage = per-request snapshot (cache breakdown)
  // sessionTotalTokens = cumulative from OMC parseTranscript (fallback)
  const ctxWindow = stdin?.context_window;
  const currentUsage = ctxWindow?.current_usage;
  const totalInput = ctxWindow?.total_input_tokens || 0;
  const totalOutput = ctxWindow?.total_output_tokens || 0;
  const tokens = {
    inputTokens: totalInput,
    outputTokens: totalOutput,
    reasoningTokens: lastRequestTokenUsage?.reasoningTokens || null,
    cacheCreateTokens: currentUsage?.cache_creation_input_tokens || 0,
    cacheReadTokens: currentUsage?.cache_read_input_tokens || 0,
    sessionTotal: (totalInput + totalOutput) || sessionTotalTokens || 0,
  };

  // ── Cost ───────────────────────────────────────────────────────────────
  const cost = calculateSessionCost(model, tokens);

  // ── OMC Orchestration State ────────────────────────────────────────────
  const ralph = safeCall(() => readRalphStateForHud(cwd), null);
  const ultrawork = safeCall(() => readUltraworkStateForHud(cwd), null);
  const autopilot = safeCall(() => readAutopilotStateForHud(cwd), null);
  const prd = safeCall(() => readPrdStateForHud(cwd), null);

  // ── HUD State (Background Tasks) ──────────────────────────────────────
  // Running agents from transcript (foreground + background)
  const runningAgentCount = agents.filter(a => a.status === 'running').length;

  // OMC-tracked background tasks from hud-state.json
  let omcBackgroundCount = 0;
  try {
    const hudState = readHudState(cwd);
    if (hudState) {
      const count = getBackgroundTaskCount(hudState);
      omcBackgroundCount = typeof count === 'number' ? count : (count?.running ?? 0);
    }
  } catch {
    // Use default
  }

  // Combined: running agents + OMC background (deduplicated via max)
  const activeTaskCount = Math.max(runningAgentCount, omcBackgroundCount);

  // ── Rate Limits ────────────────────────────────────────────────────────
  let rateLimits = null;
  let rateLimitError = undefined;
  try {
    const usageResult = await getUsage();
    rateLimits = usageResult.rateLimits || null;
    rateLimitError = usageResult.error || undefined;
  } catch {
    rateLimitError = 'fetch_error';
  }

  // ── Git ────────────────────────────────────────────────────────────────
  const gitBranch = safeCall(() => getGitBranch(cwd), null);
  const gitStatus = safeCall(() => getGitStatusCounts(cwd), null);

  // ── OMC Version Check ─────────────────────────────────────────────────
  let omcVersionCheck = { local: null, remote: null, updateAvailable: false, error: null };
  try {
    omcVersionCheck = await checkOmcVersion();
  } catch {
    // Non-fatal — use defaults
  }
  const omcUpdateAvailable = omcVersionCheck.updateAvailable ? omcVersionCheck.remote : null;

  // ── omc-lens Version Check ──────────────────────────────────────────
  let lensVersionCheck = { local: null, remote: null, updateAvailable: false, error: null };
  try {
    lensVersionCheck = await checkLensVersion();
  } catch {
    // Non-fatal — use defaults
  }
  const lensUpdateAvailable = lensVersionCheck.updateAvailable ? lensVersionCheck.remote : null;
  const lensVersion = lensVersionCheck.local || null;

  // ── Stdin extras (worktree, vim, session name) ────────────────────────
  const worktree = stdin?.worktree?.name || null;
  const vimMode = stdin?.vim?.mode || null;
  const sessionName = stdin?.session_name || null;

  // ── Assemble ───────────────────────────────────────────────────────────
  return {
    model,
    modelTier,
    contextPercent,
    contextWindowSize,
    cwd,
    transcriptPath,
    tokens,
    cost,
    agents,
    todos,
    lastActivatedSkill,
    toolCallCount,
    agentCallCount,
    skillCallCount,
    lastToolName,
    thinkingState,
    pendingPermission,
    ralph,
    ultrawork,
    autopilot,
    prd,
    rateLimits,
    rateLimitError,
    activeTaskCount,
    runningAgentCount,
    gitBranch,
    gitStatus,
    sessionStart,
    lastRequestTokenUsage,
    omcVersion,
    omcAvailable,
    omcVersionCheck,
    omcUpdateAvailable,
    lensVersion,
    lensUpdateAvailable,
    worktree,
    vimMode,
    sessionName,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Call a function and return its result, or fallback on any error.
 * @template T
 * @param {() => T} fn
 * @param {T} fallback
 * @returns {T}
 */
function safeCall(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
