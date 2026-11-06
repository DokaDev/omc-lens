/**
 * Transcript scan: budgeted, checkpointed, resumable.
 *
 * Run: node --test test/
 *
 * The synthetic transcript defaults to 32MB so the suite stays quick; set
 * OMC_LENS_TEST_TRANSCRIPT_MB=110 to exercise the size the bug was seen at.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync, mkdirSync, openSync, writeSync, closeSync, appendFileSync,
  readFileSync, writeFileSync, existsSync, statSync, rmSync, copyFileSync, utimesSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const CONTEXT_URL = pathToFileURL(join(SRC, 'data', 'context.mjs')).href;
const { renderLine2 } = await import(pathToFileURL(join(SRC, 'render', 'line2.mjs')).href);

const {
  createScanBudget,
  parseSessionStatsFromTranscript,
  parseTasksFromTranscript,
  scanSubagentUsage,
  sweepStaleScanTemps,
} = await import(CONTEXT_URL);

const TARGET_MB = Number(process.env.OMC_LENS_TEST_TRANSCRIPT_MB) || 32;
const ORIGINAL_TMPDIR = process.env.TMPDIR;

let root;
let bigPath;

/** Point os.tmpdir() — and so every scan record — at a fresh directory. */
function freshRecordDir(label) {
  const dir = join(root, `rec-${label}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir);
  process.env.TMPDIR = dir;
  return dir;
}

function recordPath(kind, transcriptPath) {
  const key = createHash('sha256').update(transcriptPath).digest('hex').slice(0, 16);
  return join(tmpdir(), `omc-lens-scan-${kind}-${key}.json`);
}

function recordOffset(kind, transcriptPath) {
  const p = recordPath(kind, transcriptPath);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')).offset : 0;
}

/**
 * Deterministic transcript lines: usage on several models, tool/skill/agent
 * calls, TaskCreate/TaskUpdate with their numbered results, multibyte text,
 * malformed and blank lines.
 */
function* syntheticLines(pad) {
  const models = ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5', undefined];
  let task = 0;
  for (let i = 0; ; i++) {
    const content = [{ type: 'text', text: `${pad} 한글✓ #${i}` }];
    const tool = i % 7;
    if (tool === 1) content.push({ type: 'tool_use', id: `b${i}`, name: 'Bash', input: {} });
    if (tool === 2) content.push({ type: 'tool_use', id: `s${i}`, name: 'Skill', input: {} });
    if (tool === 3) content.push({ type: 'tool_use', id: `a${i}`, name: 'Agent', input: {} });
    if (tool === 4) content.push({ type: 'tool_use', id: `c${i}`, name: 'TaskCreate', input: { subject: `task ${i}` } });
    if (tool === 5 && task > 0) {
      content.push({ type: 'tool_use', id: `u${i}`, name: 'TaskUpdate', input: { taskId: String(1 + (i % task)), status: i % 2 ? 'completed' : 'in_progress' } });
    }
    yield JSON.stringify({
      type: 'assistant',
      message: {
        model: models[i % models.length],
        usage: {
          input_tokens: (i % 13) + 1,
          output_tokens: (i % 101) + 3,
          cache_creation_input_tokens: (i % 17) * 11,
          cache_read_input_tokens: (i % 23) * 1000,
        },
        content,
      },
    });
    if (tool === 4) {
      task = (task % 40) + 1; // numbering restarts now and then, like real lists
      yield JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: `c${i}`, content: `Task #${task} created successfully` }] },
      });
    }
    if (i % 997 === 0) yield '{not json';
    if (i % 1009 === 0) yield '';
  }
}

/** Write ~`mb` megabytes of transcript, including one line wider than a read chunk. */
function writeTranscript(path, mb, { trailingPartial = true } = {}) {
  const fd = openSync(path, 'w');
  const target = mb * 1024 * 1024;
  let written = 0;
  let batch = [];
  let batchBytes = 0;
  let wroteHuge = false;
  for (const line of syntheticLines('x'.repeat(900))) {
    batch.push(line);
    batchBytes += line.length + 1;
    if (!wroteHuge && written > target / 3) {
      // A 3MB entry, as an inline image would make, forces the reader to widen.
      batch.push(JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-7', usage: { output_tokens: 7 }, content: [{ type: 'text', text: 'y'.repeat(3 * 1024 * 1024) }] } }));
      wroteHuge = true;
    }
    if (batchBytes > 1 << 20) {
      written += writeSync(fd, batch.join('\n') + '\n');
      batch = [];
      batchBytes = 0;
      if (written >= target) break;
    }
  }
  // A half-written final line: never consumed, never advanced past.
  if (trailingPartial) writeSync(fd, '{"type":"assistant","message":{"usage":{"output_tokens":99');
  closeSync(fd);
}

/** Run budgeted scans until one finishes, checking each one advanced. */
function scanToCompletion(scan, kind, transcriptPath, budgetMs) {
  let runs = 0;
  let last = recordOffset(kind, transcriptPath);
  for (;;) {
    const budget = createScanBudget(budgetMs);
    const result = scan(transcriptPath, budget);
    runs++;
    if (!budget.cut) return { result, runs };
    const now = recordOffset(kind, transcriptPath);
    assert.ok(now > last, `run ${runs} made no progress (${last} -> ${now})`);
    last = now;
    assert.ok(runs < 10000, 'scan never completed');
  }
}

let baselineStats;
let baselineTasks;

before(() => {
  root = mkdtempSync(join(ORIGINAL_TMPDIR || tmpdir(), 'omc-lens-test-'));
  bigPath = join(root, 'big.jsonl');
  writeTranscript(bigPath, TARGET_MB);

  freshRecordDir('baseline');
  baselineStats = parseSessionStatsFromTranscript(bigPath);
  baselineTasks = parseTasksFromTranscript(bigPath);
  assert.ok(baselineStats.toolCalls > 0 && baselineStats.skillCalls > 0 && baselineStats.agentCalls > 0);
  assert.ok(baselineTasks.length > 0);
});

after(() => {
  process.env.TMPDIR = ORIGINAL_TMPDIR;
  if (ORIGINAL_TMPDIR === undefined) delete process.env.TMPDIR;
  rmSync(root, { recursive: true, force: true });
});

test('an uninterrupted scan stops before the half-written tail', () => {
  freshRecordDir('tail');
  parseSessionStatsFromTranscript(bigPath);
  const bytes = readFileSync(bigPath);
  // Exactly through the last newline: past the 3MB line, short of the tail.
  assert.equal(recordOffset('stats2', bigPath), bytes.lastIndexOf(0x0a) + 1);
  assert.ok(bytes.lastIndexOf(0x0a) + 1 < bytes.length);
});

test('budget-cut runs each advance and converge on the uninterrupted totals', () => {
  freshRecordDir('budget');
  const stats = scanToCompletion(parseSessionStatsFromTranscript, 'stats2', bigPath, 25);
  assert.ok(stats.runs >= 2, `expected the budget to cut at least once, got ${stats.runs} run(s)`);
  assert.deepEqual(stats.result, baselineStats);

  const tasks = scanToCompletion(parseTasksFromTranscript, 'tasks', bigPath, 25);
  assert.ok(tasks.runs >= 2);
  assert.deepEqual(tasks.result, baselineTasks);
});

test('a spent budget reads nothing and reports the cut', () => {
  freshRecordDir('spent');
  const budget = createScanBudget(0);
  const result = parseSessionStatsFromTranscript(bigPath, budget);
  assert.equal(budget.cut, true);
  assert.equal(result.toolCalls, 0);
  assert.equal(recordOffset('stats2', bigPath), 0);
});

test('a run killed mid-scan leaves a usable checkpoint the next run resumes from', () => {
  const dir = freshRecordDir('killed');
  // The child folds with the real stats fold and SIGKILLs itself partway
  // through — no chance to write a final record, exactly like a cancelled
  // statusline command.
  const child = `
    const m = await import(${JSON.stringify(CONTEXT_URL)});
    let n = 0;
    m.scanTranscript(process.env.T, 'stats2', m.seedSessionStats, (acc, entry) => {
      m.applySessionStatsEntry(acc, entry);
      if (++n === Number(process.env.KILL_AT)) process.kill(process.pid, 'SIGKILL');
    });
  `;
  const linesApprox = Math.floor((TARGET_MB * 1024 * 1024) / 1100);
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', child], {
    env: { ...process.env, TMPDIR: dir, T: bigPath, KILL_AT: String(Math.floor(linesApprox * 0.6)), OMC_LENS_SCAN_CHECKPOINT_MS: '0' },
    encoding: 'utf8',
  });
  assert.equal(res.signal, 'SIGKILL', res.stderr);

  const offset = recordOffset('stats2', bigPath);
  assert.ok(offset > 0, 'no checkpoint survived the kill');
  assert.ok(offset < statSync(bigPath).size, 'checkpoint claims the whole file');
  assert.equal(readFileSync(recordPath('stats2', bigPath), 'utf8').length > 0, true);

  const resumed = scanToCompletion(parseSessionStatsFromTranscript, 'stats2', bigPath, 1000);
  assert.deepEqual(resumed.result, baselineStats);
});

test('a corrupt or mismatched checkpoint falls back to a full scan', () => {
  const size = statSync(bigPath).size;
  const ino = statSync(bigPath).ino;
  const bad = [
    'garbage \x00\xff',
    '{"ino":1,"offset":12,"da', // torn write
    JSON.stringify({ ino, offset: -5, data: {} }),
    JSON.stringify({ ino, offset: 'x', data: {} }),
    JSON.stringify({ ino, offset: 100, data: null }),
    JSON.stringify({ ino, offset: size + 10, data: { cuRead: 1 } }),
    JSON.stringify({ ino: ino + 1, offset: 100, data: { cuRead: 1 } }),
  ];
  for (const content of bad) {
    freshRecordDir('corrupt');
    writeFileSync(recordPath('stats2', bigPath), content);
    // A temp file left by a write that was killed before its rename.
    writeFileSync(`${recordPath('stats2', bigPath)}.99999.tmp`, '{"ino":');
    assert.deepEqual(parseSessionStatsFromTranscript(bigPath), baselineStats, `record: ${content.slice(0, 40)}`);
  }
});

test('incremental appends to a normal-size transcript match a one-shot scan', () => {
  const small = join(root, 'small.jsonl');
  const full = join(root, 'small-full.jsonl');
  writeTranscript(full, 1, { trailingPartial: false });
  const bytes = readFileSync(full);
  // Split mid-line so the first pass sees a half-written tail.
  const cut = bytes.indexOf(0x0a, Math.floor(bytes.length / 2)) - 20;

  freshRecordDir('oneshot');
  copyFileSync(full, small);
  const oneShot = parseSessionStatsFromTranscript(small);
  const oneShotTasks = parseTasksFromTranscript(small);

  freshRecordDir('incremental');
  writeFileSync(small, bytes.subarray(0, cut));
  const budget = createScanBudget();
  parseSessionStatsFromTranscript(small, budget);
  parseTasksFromTranscript(small, budget);
  assert.equal(budget.cut, false);
  appendFileSync(small, bytes.subarray(cut));
  assert.deepEqual(parseSessionStatsFromTranscript(small, createScanBudget()), oneShot);
  assert.deepEqual(parseTasksFromTranscript(small, createScanBudget()), oneShotTasks);
});

test('subagent usage is budgeted, resumable and recovers from a corrupt record', () => {
  const main = join(root, 'parent.jsonl');
  writeFileSync(main, '');
  const subDir = join(root, 'parent', 'subagents', 'workflows', 'run1');
  mkdirSync(subDir, { recursive: true });
  writeTranscript(join(root, 'parent', 'subagents', 'agent-a.jsonl'), Math.max(4, TARGET_MB / 4));
  writeTranscript(join(subDir, 'agent-b.jsonl'), 2);
  writeTranscript(join(subDir, 'agent-c.jsonl'), 1, { trailingPartial: false });

  freshRecordDir('sub-baseline');
  const baseline = scanSubagentUsage(main);
  assert.ok(Object.keys(baseline).length > 0);

  freshRecordDir('sub-budget');
  let runs = 0;
  let total;
  for (;;) {
    const budget = createScanBudget(10);
    total = scanSubagentUsage(main, budget);
    runs++;
    if (!budget.cut) break;
    assert.ok(runs < 10000);
  }
  assert.ok(runs >= 2, `expected the budget to cut at least once, got ${runs}`);
  assert.deepEqual(total, baseline);

  for (const content of ['nope', '{"files":{"x":', JSON.stringify({ files: { [join(subDir, 'agent-b.jsonl')]: { ino: 0, offset: 'bad' } } })]) {
    freshRecordDir('sub-corrupt');
    writeFileSync(recordPath('subusage1', main), content);
    assert.deepEqual(scanSubagentUsage(main), baseline);
  }
});

test('subagent record entries with a non-integer, negative or past-the-end offset are rescanned', () => {
  const main = join(root, 'offsets.jsonl');
  writeFileSync(main, '');
  const sub = join(root, 'offsets', 'subagents', 'agent-x.jsonl');
  mkdirSync(dirname(sub), { recursive: true });
  writeTranscript(sub, 1, { trailingPartial: false });
  const ino = statSync(sub).ino;

  freshRecordDir('offsets-baseline');
  const baseline = scanSubagentUsage(main);

  // Inflated totals make it obvious if a bad entry were resumed rather than rescanned.
  const inflated = { 'claude-opus-4-7': { i: 1e9, o: 1e9, cc: 1e9, cr: 1e9 } };
  const pastEnd = statSync(sub).size + 1000;
  for (const offset of [1.5, -10, 'bad', null, pastEnd]) {
    freshRecordDir('offsets');
    writeFileSync(recordPath('subusage1', main), JSON.stringify({ files: { [sub]: { ino, offset, byModel: inflated } } }));
    assert.deepEqual(scanSubagentUsage(main), baseline, `offset ${JSON.stringify(offset)}`);
  }
});

test('line 2 marks partial totals with a trailing ellipsis, and drops it once complete', () => {
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const ctx = {
    contextPercent: 42,
    tokens: { inputTokens: 1200, outputTokens: 3400, sessionTotal: 98765 },
    cost: 1.5,
    toolCallCount: 1,
    todos: [],
  };
  const partial = strip(renderLine2({ ...ctx, scanPartial: true }));
  const done = strip(renderLine2({ ...ctx, scanPartial: false }));
  assert.match(partial, /\u03A3\S+\u2026/, partial);
  assert.match(partial, /\$\S+\u2026/, partial);
  assert.equal((partial.match(/\u2026/g) || []).length, 2, partial);
  assert.ok(!done.includes('\u2026'), done);
  assert.ok(partial.includes('42%') && done.includes('42%'));
});

test('stale scan temp files are swept, fresh ones and other files are kept', () => {
  const dir = freshRecordDir('sweep');
  const stale = join(dir, 'omc-lens-scan-stats2-abc.json.123.tmp');
  const fresh = join(dir, 'omc-lens-scan-stats2-abc.json.456.tmp');
  const other = join(dir, 'someone-else.tmp');
  for (const p of [stale, fresh, other]) writeFileSync(p, '{');
  const old = new Date(Date.now() - 5 * 60 * 1000);
  utimesSync(stale, old, old);
  utimesSync(other, old, old);
  sweepStaleScanTemps();
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(fresh), true);
  assert.equal(existsSync(other), true);
});

test('the default budget counts from process start, with a minimum slice', () => {
  const probe = (budgetMs) => {
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const m = await import(${JSON.stringify(CONTEXT_URL)});
      const b = m.createScanBudget();
      console.log(JSON.stringify({ fromOrigin: b.deadline - performance.timeOrigin, fromNow: b.deadline - Date.now() }));
    `], { env: { ...process.env, OMC_LENS_SCAN_BUDGET_MS: String(budgetMs) }, encoding: 'utf8' });
    return JSON.parse(res.stdout);
  };
  // Generous budget: anchored to process start, not to the call.
  const anchored = probe(60000);
  assert.ok(Math.abs(anchored.fromOrigin - 60000) < 2, JSON.stringify(anchored));
  // Budget already spent by startup: still a minimum slice from now.
  const floor = probe(1);
  assert.ok(floor.fromNow > 100 && floor.fromNow <= 150, JSON.stringify(floor));
});

test('a hung network never holds back a render, and the scan still advances', () => {
  const dir = freshRecordDir('hungnet');
  const config = join(root, 'hungnet-config');
  mkdirSync(config, { recursive: true });
  // A usable-looking token, so the usage fetches really are attempted.
  writeFileSync(join(config, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'test', expiresAt: Date.now() + 864e5 } }));
  // fetch and https.request both hang until aborted, as on a dead network.
  const preload = join(root, 'hang-network.cjs');
  writeFileSync(preload, `
    const https = require('https');
    const { EventEmitter } = require('events');
    globalThis.fetch = (u, o) => new Promise((res, rej) => { o?.signal?.addEventListener('abort', () => rej(new Error('aborted'))); });
    https.request = https.get = () => Object.assign(new EventEmitter(), { end() {}, write() {}, destroy() { return this; }, setTimeout() { return this; } });
    require('module').syncBuiltinESMExports();
  `);
  const stdin = JSON.stringify({
    session_id: 'hungnet', transcript_path: bigPath, cwd: root,
    model: { display_name: 'Opus' }, context_window: { used_percentage: 42, context_window_size: 1000000 },
  });
  const hud = join(SRC, 'hud.mjs');

  let lastOffset = 0;
  for (let run = 1; run <= 4; run++) {
    const started = Date.now();
    const res = spawnSync(process.execPath, ['--require', preload, hud], {
      input: stdin,
      encoding: 'utf8',
      timeout: 2000,
      killSignal: 'SIGKILL',
      // A 1ms budget leaves each render only the minimum scan slice, so a
      // large transcript takes several renders.
      env: { ...process.env, TMPDIR: dir, CLAUDE_CONFIG_DIR: config, OMC_LENS_SCAN_BUDGET_MS: '1' },
    });
    const elapsed = Date.now() - started;
    assert.equal(res.signal, null, `run ${run} was killed after ${elapsed}ms`);
    assert.match(res.stdout.replace(/\x1b\[[0-9;]*m/g, ''), /42%/, `run ${run} printed no CTX`);
    assert.ok(elapsed < 1500, `run ${run} took ${elapsed}ms`);
    if (run === 1) assert.ok(existsSync(join(dir, 'omc-lens-network-stalled')), 'a lost race should back the network off');

    const offset = recordOffset('stats2', bigPath);
    assert.ok(offset >= lastOffset && offset > 0, `run ${run}: scan offset ${lastOffset} -> ${offset}`);
    lastOffset = offset;
  }
  // Whatever the renders left unfinished resumes to the uninterrupted totals.
  assert.deepEqual(parseSessionStatsFromTranscript(bigPath), baselineStats);
});
