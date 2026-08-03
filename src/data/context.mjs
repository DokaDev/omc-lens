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
import { getScopedWeeklyLimits } from './usage-direct.mjs';
import {
  readFileSync, writeFileSync, statSync, openSync, readSync, closeSync,
  existsSync, renameSync, unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Cache snapshot reader (reads Stop-hook snapshot for per-turn deltas)
// ---------------------------------------------------------------------------

/**
 * Read the cache snapshot saved by the Stop hook and compute deltas.
 * Returns fields to spread into the tokens object.
 * @param {string|null} sessionId
 * @returns {{ prevCacheHitRate: number|null, prevCacheEfficiency: number|null }}
 */
function readCacheSnapshot(sessionId) {
  const empty = { prevCacheHitRate: null, prevCacheEfficiency: null };
  if (!sessionId) return empty;
  try {
    const p = join(tmpdir(), `omc-lens-cache-snapshot-${sessionId}.json`);
    if (!existsSync(p)) return empty;
    const data = JSON.parse(readFileSync(p, 'utf8'));
    return {
      prevCacheHitRate: typeof data.hr === 'number' ? data.hr : null,
      prevCacheEfficiency: typeof data.ef === 'number' ? data.ef : null,
    };
  } catch {
    return empty;
  }
}

// ---------------------------------------------------------------------------
// Cumulative cache accounting (incremental transcript scan)
// ---------------------------------------------------------------------------

/**
 * Path of the running-totals record for one transcript.
 *
 * A fresh process runs on every statusline repaint, so this state has to live
 * on disk to be worth anything — an in-process cache would never be read.
 *
 * @param {string} transcriptPath
 * @returns {string}
 */
function cumulativeCachePath(transcriptPath) {
  const key = createHash('sha256').update(transcriptPath).digest('hex').slice(0, 16);
  return join(tmpdir(), `omc-lens-cumcache-${key}.json`);
}

/**
 * @param {string} cachePath
 * @param {number} ino  Current inode of the transcript
 * @returns {{ino: number, offset: number, cuRead: number, cuCreated: number, cuFresh: number}|null}
 */
function readCumulativeState(cachePath, ino) {
  try {
    if (!existsSync(cachePath)) return null;
    const s = JSON.parse(readFileSync(cachePath, 'utf8'));
    if (!Number.isInteger(s?.offset) || s.offset < 0) return null;
    // A different inode behind the same path means the transcript was replaced
    // rather than appended to, so the totals describe a file that is no longer
    // there and cannot be carried forward.
    if (s.ino !== ino) return null;
    for (const k of ['cuRead', 'cuCreated', 'cuFresh']) {
      if (!Number.isFinite(s[k]) || s[k] < 0) return null;
    }
    return s;
  } catch {
    return null;
  }
}

/** Write via temp file + rename so a concurrent render never reads a torn record. */
function writeCumulativeState(cachePath, state) {
  const tmpPath = `${cachePath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify(state), 'utf8');
    renameSync(tmpPath, cachePath);
  } catch {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Nothing left to clean up.
    }
  }
}

/**
 * Cumulative cache tokens for the session, summed over every assistant message
 * in the transcript.
 *
 * The total is genuinely session-wide, so unlike parseTasksFromTranscript —
 * which only needs the latest task state and can therefore read a tail slice —
 * it cannot be capped without undercounting. Instead the running totals are
 * stored alongside the byte offset they were computed through, and each render
 * folds in only the newly appended bytes. A multi-tens-of-MB transcript costs
 * one full pass on a session's first render and a few KB on every render after.
 *
 * @param {string|null} transcriptPath
 * @returns {{ cuRead: number, cuCreated: number, cuFresh: number, cuHitRate: number }}
 */
function parseCumulativeCacheFromTranscript(transcriptPath) {
  const result = { cuRead: 0, cuCreated: 0, cuFresh: 0, cuHitRate: 0 };
  if (!transcriptPath) return result;

  let fd = null;
  try {
    const stat = statSync(transcriptPath);
    const cachePath = cumulativeCachePath(transcriptPath);

    let state = readCumulativeState(cachePath, stat.ino);
    // A file shorter than where the last pass stopped was truncated or rewritten
    // in place, so the stored offset no longer points where it claims to.
    if (state && state.offset > stat.size) state = null;

    let offset = state ? state.offset : 0;
    let cuRead = state ? state.cuRead : 0;
    let cuCreated = state ? state.cuCreated : 0;
    let cuFresh = state ? state.cuFresh : 0;

    if (stat.size > offset) {
      fd = openSync(transcriptPath, 'r');
      const buf = Buffer.alloc(stat.size - offset);
      const bytesRead = readSync(fd, buf, 0, buf.length, offset);
      closeSync(fd);
      fd = null;

      // Stop at the final newline. The transcript is appended to while we read
      // it, so the tail is routinely a half-written line; consuming it would
      // both mis-parse and advance the offset past an entry that would then
      // never be counted. A newline byte never appears inside a multi-byte
      // UTF-8 sequence either, so cutting there always leaves a decodable
      // slice — and the offset consequently always sits at a line boundary.
      const chunk = buf.subarray(0, bytesRead);
      const lastNewline = chunk.lastIndexOf(0x0a);

      if (lastNewline >= 0) {
        const text = chunk.subarray(0, lastNewline + 1).toString('utf8');
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            if (entry.type !== 'assistant') continue;
            const u = entry.message?.usage;
            if (!u) continue;
            cuRead += u.cache_read_input_tokens || 0;
            cuCreated += u.cache_creation_input_tokens || 0;
            cuFresh += u.input_tokens || 0;
          } catch { /* skip malformed line */ }
        }
        offset += lastNewline + 1;
        // Offset and totals are written as a single record, so whichever of two
        // concurrent renders writes last, the pair stays internally consistent
        // and the next render resumes from a matching offset.
        writeCumulativeState(cachePath, { ino: stat.ino, offset, cuRead, cuCreated, cuFresh });
      }
    }

    result.cuRead = cuRead;
    result.cuCreated = cuCreated;
    result.cuFresh = cuFresh;
    const denom = cuRead + cuCreated + cuFresh;
    result.cuHitRate = denom > 0 ? cuRead / denom : 0;
  } catch {
    /* file read error — return zeros */
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Already closed.
      }
    }
  }
  return result;
}

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
 * @property {string} modelTier                  'fable'|'opus'|'sonnet'|'haiku'
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
  const cacheCreate = currentUsage?.cache_creation_input_tokens || 0;
  const cacheRead = currentUsage?.cache_read_input_tokens || 0;
  const cacheDenom = cacheRead + cacheCreate + totalInput;
  const cacheWriteReadSum = cacheRead + cacheCreate;
  // Cumulative cache totals across the full transcript — required so that
  // cost and sessionTotal align in units with totalInput/totalOutput
  // (which are already session-cumulative). current_usage is a per-request
  // snapshot and must not be fed into a cumulative cost formula.
  const cumulativeCache = parseCumulativeCacheFromTranscript(transcriptPath);
  const tokens = {
    inputTokens: totalInput,
    outputTokens: totalOutput,
    reasoningTokens: lastRequestTokenUsage?.reasoningTokens || null,
    cacheCreateTokens: cacheCreate,
    cacheReadTokens: cacheRead,
    cacheHitRate: cacheDenom > 0 ? cacheRead / cacheDenom : 0,
    cacheEfficiency: cacheWriteReadSum > 0 ? cacheRead / cacheWriteReadSum : 0,
    cacheCumulativeHitRate: cumulativeCache.cuHitRate,
    ...readCacheSnapshot(stdin?.session_id),
    sessionTotal:
      (totalInput + totalOutput + cumulativeCache.cuRead + cumulativeCache.cuCreated)
      || sessionTotalTokens
      || 0,
  };

  // ── Cost ───────────────────────────────────────────────────────────────
  // Use cumulative cache totals so every term in the cost formula is in the
  // same "session cumulative" unit as inputTokens/outputTokens.
  const cost = calculateSessionCost(model, {
    inputTokens: totalInput,
    outputTokens: totalOutput,
    cacheCreateTokens: cumulativeCache.cuCreated,
    cacheReadTokens: cumulativeCache.cuRead,
  });

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

  // ── Rate Limits (throttled fetch + file-based cache) ───────────────────
  // The usage API has its own rate limit — calling it every ~300ms render
  // cycle quickly exhausts it. Only fetch when cache is stale (>60s).
  let rateLimits = null;
  let rateLimitError = undefined;
  const _rlCachePath = join(tmpdir(), `omc-lens-ratelimit-cache-${stdin?.session_id || 'default'}.json`);
  const _rlCacheTtlMs = 60 * 1000; // 60 seconds
  let _rlCacheHit = false;
  try {
    if (existsSync(_rlCachePath)) {
      const _rlStat = statSync(_rlCachePath);
      const _rlAge = Date.now() - _rlStat.mtimeMs;
      if (_rlAge < _rlCacheTtlMs) {
        rateLimits = JSON.parse(readFileSync(_rlCachePath, 'utf8'));
        _rlCacheHit = true;
      }
    }
  } catch {}
  if (!_rlCacheHit) {
    try {
      const usageResult = await getUsage();
      rateLimits = usageResult.rateLimits || null;
      rateLimitError = usageResult.error || undefined;
    } catch {
      rateLimitError = 'fetch_error';
    }
    // Model-scoped weekly windows (Fable/Sonnet/Opus). OMC still reads the
    // legacy seven_day_<model> keys, which Anthropic now returns null for
    // after moving those windows into the response's `limits` array, so it no
    // longer produces these buckets. Fetch them separately and let anything
    // OMC did produce win — an OMC release that learns `limits[]` then takes
    // over silently, with no change needed here.
    try {
      const scoped = await getScopedWeeklyLimits();
      if (scoped) rateLimits = { ...scoped, ...(rateLimits || {}) };
    } catch {
      // Scoped segments simply do not render.
    }
    if (rateLimits) {
      try { writeFileSync(_rlCachePath, JSON.stringify(rateLimits), 'utf8'); } catch {}
    }
    // Fallback: read stale cache if fetch failed
    if (!rateLimits) {
      try {
        if (existsSync(_rlCachePath)) {
          rateLimits = JSON.parse(readFileSync(_rlCachePath, 'utf8'));
        }
      } catch {}
    }
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
