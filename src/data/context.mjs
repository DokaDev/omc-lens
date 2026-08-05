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
import { calculateCostByModel, getModelTier } from './cost.mjs';
import { checkOmcVersion, checkLensVersion } from './version-check.mjs';
import { getScopedWeeklyLimits } from './usage-direct.mjs';
import {
  readFileSync, writeFileSync, statSync, openSync, readSync, closeSync,
  existsSync, renameSync, unlinkSync, readdirSync,
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
// Incremental transcript scan
// ---------------------------------------------------------------------------

/**
 * Path of the resume record for one transcript under one kind of scan.
 *
 * A fresh process runs on every statusline repaint, so this state has to live
 * on disk to be worth anything — an in-process cache would never be read.
 *
 * @param {string} kind            Namespace, so two scans never share a record
 * @param {string} transcriptPath
 * @returns {string}
 */
function scanRecordPath(kind, transcriptPath) {
  const key = createHash('sha256').update(transcriptPath).digest('hex').slice(0, 16);
  return join(tmpdir(), `omc-lens-scan-${kind}-${key}.json`);
}

/**
 * @param {string} recordPath
 * @param {number} ino  Current inode of the transcript
 * @returns {{ino: number, offset: number, data: object}|null}
 */
function readScanRecord(recordPath, ino) {
  try {
    if (!existsSync(recordPath)) return null;
    const r = JSON.parse(readFileSync(recordPath, 'utf8'));
    if (!Number.isInteger(r?.offset) || r.offset < 0) return null;
    if (typeof r.data !== 'object' || r.data === null) return null;
    // A different inode behind the same path means the transcript was replaced
    // rather than appended to, so the state describes a file that is no longer
    // there and cannot be carried forward.
    if (r.ino !== ino) return null;
    return r;
  } catch {
    return null;
  }
}

/** Write via temp file + rename so a concurrent render never reads a torn record. */
function writeScanRecord(recordPath, record) {
  const tmpPath = `${recordPath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify(record), 'utf8');
    renameSync(tmpPath, recordPath);
  } catch {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Nothing left to clean up.
    }
  }
}

/**
 * Fold over a transcript's entries, resuming where the previous render stopped.
 *
 * Both things this file needs from a transcript — cumulative cache tokens and
 * the task list — are left folds over the entries in order, so neither can be
 * taken from a tail slice: the token totals would undercount, and the task list
 * would miss its TaskCreate entries entirely, since tasks are created at the
 * start of a work block and updated throughout it. Instead the fold state is
 * stored with the byte offset it was computed through, and each render folds in
 * only the newly appended bytes. A multi-tens-of-MB transcript costs one full
 * pass on a session's first render and a few KB on every render after.
 *
 * @template T
 * @param {string} transcriptPath
 * @param {string} kind                              Record namespace
 * @param {() => T} seed                             Fresh state when starting over
 * @param {(state: T, entry: object) => void} apply  Called per entry, in order
 * @returns {T|null} the fold state, or null when the transcript is unreadable
 */
function scanTranscript(transcriptPath, kind, seed, apply) {
  try {
    const stat = statSync(transcriptPath);
    const recordPath = scanRecordPath(kind, transcriptPath);

    let record = readScanRecord(recordPath, stat.ino);
    // A file shorter than where the last pass stopped was truncated or rewritten
    // in place, so the stored offset no longer points where it claims to.
    if (record && record.offset > stat.size) record = null;

    const offset = record ? record.offset : 0;
    const data = record ? record.data : seed();

    const appended = foldAppended(transcriptPath, offset, stat.size, data, apply);
    if (appended !== null) {
      // Offset and state are written as a single record, so whichever of two
      // concurrent renders writes last, the pair stays internally consistent
      // and the next render resumes from a matching offset.
      writeScanRecord(recordPath, { ino: stat.ino, offset: appended, data });
    }
    return data;
  } catch {
    return null;
  }
}

/**
 * Apply `fold` to every complete entry appended to a file since `offset`.
 *
 * Shared by the transcript scan and the subagent-usage scan so the one subtle
 * part — where it is safe to stop — has a single implementation.
 *
 * @param {string} path
 * @param {number} offset  Byte offset the previous pass stopped at
 * @param {number} size    Current file size, already stat'd by the caller
 * @param {object} state   Fold state, mutated in place
 * @param {(state: object, entry: object) => void} fold
 * @returns {number|null}  New offset, or null when nothing whole was consumed
 */
function foldAppended(path, offset, size, state, fold) {
  if (size <= offset) return null;
  let fd = null;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(size - offset);
    const bytesRead = readSync(fd, buf, 0, buf.length, offset);
    closeSync(fd);
    fd = null;

    // Stop at the final newline. The transcript is appended to while we read
    // it, so the tail is routinely a half-written line; consuming it would
    // both mis-parse and advance the offset past an entry that would then
    // never be seen again. A newline byte never appears inside a multi-byte
    // UTF-8 sequence either, so cutting there always leaves a decodable
    // slice — and the offset consequently always sits at a line boundary.
    const chunk = buf.subarray(0, bytesRead);
    const lastNewline = chunk.lastIndexOf(0x0a);
    if (lastNewline < 0) return null;

    const text = chunk.subarray(0, lastNewline + 1).toString('utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        fold(state, JSON.parse(line));
      } catch { /* skip malformed line */ }
    }
    return offset + lastNewline + 1;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Already closed.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Cumulative session statistics
// ---------------------------------------------------------------------------

/** Tool names that spawn a classic subagent. */
const CLASSIC_AGENT_TOOLS = new Set(['Task', 'proxy_Task', 'Agent', 'proxy_Agent']);
const SKILL_TOOLS = new Set(['Skill', 'proxy_Skill']);

/** Key for usage whose entry names no model; priced at the default tier. */
const UNKNOWN_MODEL = '';

/**
 * Add one usage record to a per-model breakdown.
 *
 * Cost has to be summed per model rather than applied to a session total,
 * because the rate that applies to a token is the rate of the model that spent
 * it — not the rate of whatever model is selected when the HUD repaints. The
 * short keys keep the scan record small, since it is rewritten every render.
 *
 * @param {Record<string, {i: number, o: number, cc: number, cr: number}>} byModel
 * @param {unknown} model
 * @param {object} usage
 */
function addUsageByModel(byModel, model, usage) {
  const key = typeof model === 'string' && model !== '' ? model : UNKNOWN_MODEL;
  const slot = byModel[key] || (byModel[key] = { i: 0, o: 0, cc: 0, cr: 0 });
  slot.i += usage.input_tokens || 0;
  slot.o += usage.output_tokens || 0;
  slot.cc += usage.cache_creation_input_tokens || 0;
  slot.cr += usage.cache_read_input_tokens || 0;
}

/**
 * Re-key usage that named no model onto `model`, in place.
 *
 * Assistant entries in a current transcript all carry `message.model`, but the
 * synthetic entries the CLI injects do not, and neither do older formats.
 * Billing those at the default tier would silently misprice them; the model in
 * use now is the better guess, and is what this figure used for everything
 * before it became per-model.
 *
 * @param {Record<string, {i: number, o: number, cc: number, cr: number}>} byModel
 * @param {string} model
 */
function billUnknownAs(byModel, model) {
  const orphan = byModel[UNKNOWN_MODEL];
  if (!orphan || model === UNKNOWN_MODEL) return byModel;
  delete byModel[UNKNOWN_MODEL];
  return mergeByModel(byModel, { [model]: orphan });
}

/** Merge one per-model breakdown into another, in place. */
function mergeByModel(into, from) {
  if (!from) return into;
  for (const [model, t] of Object.entries(from)) {
    const slot = into[model] || (into[model] = { i: 0, o: 0, cc: 0, cr: 0 });
    slot.i += t.i || 0;
    slot.o += t.o || 0;
    slot.cc += t.cc || 0;
    slot.cr += t.cr || 0;
  }
  return into;
}

/**
 * Session-cumulative token usage and call counts, folded over the transcript.
 *
 * Two separate defects are corrected here and they share a shape: a number
 * that reads as "this session" but is not.
 *
 * The stdin `context_window` fields are not cumulative despite their names —
 * `total_input_tokens` is the size of the current prompt (it tracks the CTX
 * gauge exactly: 810.7k against a 1M window reads 81%) and
 * `total_output_tokens` is the last response alone.
 *
 * OMC's parseTranscript does count tool, skill and agent calls, but reads only
 * a 4MB tail, so once a session outgrows that the oldest calls fall out of the
 * window and the counts silently shrink — measured at 185 of 245 real tool
 * calls on a 5.3MB transcript, by which point the session's one Skill call had
 * already dropped out and the counter read 0.
 *
 * Both are avoided by folding over the whole transcript incrementally. Usage
 * and counts share one pass so that adding the counts costs no extra read.
 *
 * @param {string|null} transcriptPath
 * @returns {{cuRead: number, cuCreated: number, cuFresh: number, cuOutput: number,
 *            cuHitRate: number, toolCalls: number, skillCalls: number, agentCalls: number}}
 */
function parseSessionStatsFromTranscript(transcriptPath) {
  const result = {
    cuRead: 0, cuCreated: 0, cuFresh: 0, cuOutput: 0, cuHitRate: 0,
    toolCalls: 0, skillCalls: 0, agentCalls: 0, byModel: {},
  };
  if (!transcriptPath) return result;

  // The record namespace is versioned: an older record predates these fields,
  // and resuming from one would leave every total short by everything that
  // came before this release.
  const data = scanTranscript(
    transcriptPath,
    'stats2',
    () => ({
      cuRead: 0, cuCreated: 0, cuFresh: 0, cuOutput: 0,
      toolCalls: 0, skillCalls: 0, agentCalls: 0, byModel: {},
    }),
    (acc, entry) => {
      const usage = entry.type === 'assistant' ? entry.message?.usage : null;
      if (usage) {
        acc.cuRead += usage.cache_read_input_tokens || 0;
        acc.cuCreated += usage.cache_creation_input_tokens || 0;
        acc.cuFresh += usage.input_tokens || 0;
        acc.cuOutput += usage.output_tokens || 0;
        addUsageByModel(acc.byModel, entry.message?.model, usage);
      }
      const content = entry.message?.content;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (block?.type !== 'tool_use') continue;
        acc.toolCalls++;
        if (SKILL_TOOLS.has(block.name)) acc.skillCalls++;
        else if (CLASSIC_AGENT_TOOLS.has(block.name)) acc.agentCalls++;
      }
    },
  );
  if (!data) return result;

  result.cuRead = data.cuRead;
  result.cuCreated = data.cuCreated;
  result.cuFresh = data.cuFresh;
  result.cuOutput = data.cuOutput;
  result.toolCalls = data.toolCalls;
  result.skillCalls = data.skillCalls;
  result.agentCalls = data.agentCalls;
  result.byModel = data.byModel || {};
  const denom = data.cuRead + data.cuCreated + data.cuFresh;
  result.cuHitRate = denom > 0 ? data.cuRead / denom : 0;
  return result;
}

/**
 * Subagents spawned through the Workflow tool.
 *
 * These never appear as agent tool calls: one Workflow call fans out to many
 * agents, so counting its tool_use blocks reports 2 where 23 ran, and the
 * agents themselves run in their own transcripts. The run's artifacts are the
 * real ledger — each agent leaves an `agent-<id>.jsonl` beside the workflow
 * journal — so this reads the directory rather than the transcript.
 *
 * @param {string|null} transcriptPath
 * @returns {number}
 */
function countWorkflowAgents(transcriptPath) {
  if (!transcriptPath) return 0;
  try {
    const root = join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents', 'workflows');
    if (!existsSync(root)) return 0;
    let count = 0;
    for (const run of readdirSync(root, { withFileTypes: true })) {
      if (!run.isDirectory()) continue;
      for (const file of readdirSync(join(root, run.name))) {
        if (file.startsWith('agent-') && file.endsWith('.jsonl')) count++;
      }
    }
    return count;
  } catch {
    return 0;
  }
}

/**
 * Runaway guard, not a real ceiling — the busiest session in the local corpus
 * spawned 332 subagents. Hitting this would undercount cost silently, so it is
 * set far above any plausible run.
 */
const SUBAGENT_SCAN_LIMIT = 2000;

/** Every `.jsonl` beneath a session's `subagents/` tree, at any depth. */
function subagentTranscripts(transcriptPath) {
  const out = [];
  const stack = [join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents')];
  while (stack.length > 0 && out.length < SUBAGENT_SCAN_LIMIT) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // Not a directory, or gone since the parent was listed.
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.name.endsWith('.jsonl')) out.push(path);
    }
  }
  return out;
}

/**
 * Per-model token usage spent by this session's subagents.
 *
 * Subagents bill to the session but write to their own transcripts, so a fold
 * over the main transcript alone misses every token they spent. Measured across
 * the local corpus that is a 19% understatement in aggregate, and far worse on
 * delegation-heavy sessions: one showed $14.83 while its 332 agents had spent
 * $807.45. They also run on their own models — haiku and sonnet alongside the
 * main thread's opus — which is why this returns a per-model breakdown rather
 * than a total.
 *
 * One record holds every file's offset, so a repaint costs a stat() per
 * subagent transcript and reads only what has been appended. Per-file totals
 * are kept separately so a rewritten file can be recomputed without having to
 * unpick its old contribution from a shared sum.
 *
 * @param {string|null} transcriptPath
 * @returns {Record<string, {i: number, o: number, cc: number, cr: number}>}
 */
function scanSubagentUsage(transcriptPath) {
  if (!transcriptPath) return {};
  try {
    const paths = subagentTranscripts(transcriptPath);
    if (paths.length === 0) return {};

    const recordPath = scanRecordPath('subusage1', transcriptPath);
    let previous = {};
    try {
      const raw = JSON.parse(readFileSync(recordPath, 'utf8'));
      if (raw && raw.files && typeof raw.files === 'object') previous = raw.files;
    } catch {
      // No usable record: every file is read from the start this once.
    }

    const files = {};
    let changed = Object.keys(previous).length !== paths.length;

    for (const path of paths) {
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      const prior = previous[path];
      // Same inode and an offset still inside the file means the stored totals
      // describe a prefix of what is there now, so they can be resumed.
      const resumable = prior && prior.ino === stat.ino && prior.offset <= stat.size;
      if (!resumable) changed = true;
      const entry = resumable
        ? { ino: prior.ino, offset: prior.offset, byModel: prior.byModel || {} }
        : { ino: stat.ino, offset: 0, byModel: {} };

      const advanced = foldAppended(path, entry.offset, stat.size, entry, (acc, line) => {
        if (line.type !== 'assistant') return;
        const usage = line.message?.usage;
        if (usage) addUsageByModel(acc.byModel, line.message?.model, usage);
      });
      if (advanced !== null) {
        entry.offset = advanced;
        changed = true;
      }
      files[path] = entry;
    }

    if (changed) writeScanRecord(recordPath, { files });

    const total = {};
    for (const entry of Object.values(files)) mergeByModel(total, entry.byModel);
    return total;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Task list (TaskCreate / TaskUpdate)
// ---------------------------------------------------------------------------

const TASK_CREATE_TOOLS = new Set(['TaskCreate', 'proxy_TaskCreate']);
const TASK_UPDATE_TOOLS = new Set(['TaskUpdate', 'proxy_TaskUpdate']);
/** A TaskCreate's result announces the number the task was actually given. */
const TASK_NUMBER_RE = /Task #(\d+) created/;
/** Cap on creates still awaiting a result, so the record cannot grow unbounded. */
const MAX_PENDING_CREATES = 100;

/**
 * Flatten a tool_result's content, which is either a plain string or blocks.
 * @param {unknown} content
 * @returns {string}
 */
function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => (typeof b === 'string' ? b : b?.text || '')).join(' ');
  }
  return '';
}

/**
 * Apply one TaskUpdate to the task map.
 *
 * @param {{tasks: object}} state
 * @param {object} input  The tool_use input
 */
function applyTaskUpdate(state, input) {
  // The wire field is `taskId`. `id` is accepted only so that a renamed or
  // older shape degrades instead of silently updating nothing — which is
  // exactly how this parser used to fail: it read `id`, the field never
  // existed, and every task stayed pending for the life of the session.
  const num = input?.taskId ?? input?.id;
  // Not every TaskUpdate carries a status: `{taskId, metadata}` and
  // `{taskId, addBlockedBy}` are both real shapes and must leave status alone.
  if (num == null || !input?.status) return;

  const key = String(Number(num));
  if (!Object.prototype.hasOwnProperty.call(state.tasks, key)) return;

  if (input.status === 'deleted') {
    delete state.tasks[key];
    return;
  }
  state.tasks[key].status =
    input.status === 'completed' ? 'completed'
      : input.status === 'in_progress' ? 'in_progress'
        : 'pending';
}

/**
 * Fold one transcript entry into the task state.
 *
 * A TaskCreate call does not carry the task's number — it comes back in the
 * result a couple of lines later ("Task #3 created successfully: …"), keyed by
 * tool_use_id. A create is therefore staged by its tool_use_id and becomes a
 * task only once its result names the number. That number is authoritative;
 * inferring it from creation order breaks the moment any create is missed.
 *
 * @param {{maxNum: number, tasks: object, pending: object}} state
 * @param {object} entry
 */
function applyTaskEntry(state, entry) {
  const content = entry.message?.content;
  if (!Array.isArray(content)) return;

  for (const block of content) {
    if (block?.type === 'tool_use') {
      if (TASK_CREATE_TOOLS.has(block.name)) {
        if (block.id && block.input?.subject) {
          const staged = Object.keys(state.pending);
          if (staged.length >= MAX_PENDING_CREATES) delete state.pending[staged[0]];
          state.pending[block.id] = block.input.subject;
        }
      } else if (TASK_UPDATE_TOOLS.has(block.name)) {
        applyTaskUpdate(state, block.input);
      }
      continue;
    }

    if (block?.type !== 'tool_result') continue;
    const subject = state.pending[block.tool_use_id];
    if (subject === undefined) continue;
    delete state.pending[block.tool_use_id];

    const matched = TASK_NUMBER_RE.exec(toolResultText(block.content));
    if (!matched) continue;
    const num = Number(matched[1]);

    // Numbering restarts when the task list is reset mid-session (one observed
    // transcript runs 1..28 and then starts over at 1). A number at or below
    // the running high-water mark means a new generation, so the old list is
    // gone rather than something to merge into.
    if (num <= state.maxNum) {
      state.tasks = {};
      state.maxNum = 0;
    }
    state.maxNum = Math.max(state.maxNum, num);
    state.tasks[String(num)] = { content: subject, status: 'pending' };
  }
}

/**
 * Build the task list from a transcript's TaskCreate/TaskUpdate calls.
 *
 * Despite how it is wired up, this is not a fallback: OMC's parseTranscript
 * populates todos only from TodoWrite, which nothing calls in practice, so this
 * is the sole source for the Line 2 counter.
 *
 * @param {string|null} transcriptPath
 * @returns {Array<{content: string, status: string}>}
 */
function parseTasksFromTranscript(transcriptPath) {
  if (!transcriptPath) return [];

  const data = scanTranscript(
    transcriptPath,
    'tasks',
    () => ({ maxNum: 0, tasks: {}, pending: {} }),
    applyTaskEntry,
  );
  if (!data) return [];

  return Object.keys(data.tasks)
    .map(Number)
    .sort((a, b) => a - b)
    .map((n) => ({ content: data.tasks[n].content, status: data.tasks[n].status }));
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
 * @property {number} tokens.inputTokens         Session-cumulative fresh (uncached) input tokens
 * @property {number} tokens.outputTokens        Session-cumulative output tokens
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
  // Counts and token totals both come from our own full-transcript fold rather
  // than from OMC, which reads a 4MB tail and therefore reports counts that
  // shrink as the oldest calls slide out of its window.
  const stats = parseSessionStatsFromTranscript(transcriptPath);
  const toolCallCount = stats.toolCalls;
  const skillCallCount = stats.skillCalls;
  // Workflow subagents are invisible to any transcript-based count — see
  // countWorkflowAgents for why they have to be counted from the run's files.
  const agentCallCount = stats.agentCalls + countWorkflowAgents(transcriptPath);
  const lastToolName = txData?.lastToolName || null;
  const thinkingState = txData?.thinkingState || undefined;
  const pendingPermission = txData?.pendingPermission || undefined;
  const sessionStart = txData?.sessionStart || undefined;
  const lastRequestTokenUsage = txData?.lastRequestTokenUsage || null;
  const sessionTotalTokens = txData?.sessionTotalTokens || null;

  // ── Token Breakdown ────────────────────────────────────────────────────
  // Despite their names, neither stdin field is session-cumulative:
  //   context_window.total_input_tokens  = size of the CURRENT prompt. It
  //     tracks the CTX gauge exactly — 810.7k against a 1M window reads 81%.
  //   context_window.total_output_tokens = the LAST response alone.
  //   context_window.current_usage       = per-request cache breakdown.
  // Only the transcript scan yields real per-session totals, so the ↓/↑/Σ
  // readout and the cost both come from there.
  const ctxWindow = stdin?.context_window;
  const currentUsage = ctxWindow?.current_usage;
  const promptTokens = ctxWindow?.total_input_tokens || 0;
  const cacheCreate = currentUsage?.cache_creation_input_tokens || 0;
  const cacheRead = currentUsage?.cache_read_input_tokens || 0;
  // The prompt total already contains the cache reads and writes, so it is the
  // hit-rate denominator on its own. Adding the cache terms to it counted them
  // a second time and pinned the rate at roughly half its true value — a 100%
  // cached request reported 50%. Fall back to the cache terms alone when the
  // field is missing, which degrades the rate to the efficiency figure rather
  // than to zero.
  const cacheDenom = promptTokens || (cacheRead + cacheCreate);
  const cacheWriteReadSum = cacheRead + cacheCreate;
  const tokens = {
    inputTokens: stats.cuFresh,
    outputTokens: stats.cuOutput,
    reasoningTokens: lastRequestTokenUsage?.reasoningTokens || null,
    // Clamped: a prompt total that lags the current_usage snapshot by a
    // request would otherwise read above 100%.
    cacheHitRate: cacheDenom > 0 ? Math.min(1, cacheRead / cacheDenom) : 0,
    cacheEfficiency: cacheWriteReadSum > 0 ? cacheRead / cacheWriteReadSum : 0,
    cacheCumulativeHitRate: stats.cuHitRate,
    ...readCacheSnapshot(stdin?.session_id),
    sessionTotal:
      (stats.cuFresh + stats.cuOutput + stats.cuRead + stats.cuCreated)
      || sessionTotalTokens
      || 0,
  };

  // ── Cost ───────────────────────────────────────────────────────────────
  // Every term is a session total from the transcript. Passing the stdin
  // fields here billed the current prompt as if it were fresh input — the
  // same tokens the cache-read term already covers, at ten times the rate —
  // while billing only the last response's output.
  //
  // Cost is summed per model over the main thread *and* every subagent, which
  // is deliberately wider than the ↓/↑/Σ readout above. Those describe this
  // conversation's own token flow, and folding subagents into them would make
  // the hr/cu rates beside them meaningless — they would average cache
  // behaviour across models that never shared a cache. Cost has no such
  // problem: it is the one figure where the question is simply what the
  // session spent, and a subagent's tokens are spent just the same.
  //
  // Merging into a fresh object rather than into stats.byModel matters: the
  // slot objects there belong to the scan record's fold state, and adding the
  // subagent totals to them in place would double them on the next render.
  const costByModel = mergeByModel({}, stats.byModel);
  mergeByModel(costByModel, scanSubagentUsage(transcriptPath));
  billUnknownAs(costByModel, model);
  const cost = calculateCostByModel(costByModel);

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
