#!/usr/bin/env node

/**
 * cache-snapshot.mjs — Stop hook script
 *
 * Captures the last assistant message's cache metrics from the transcript
 * and saves them as a snapshot for the statusline renderer to compute
 * per-turn deltas.
 *
 * Invoked by Claude Code on every Stop event. Never throws.
 */

import { readFileSync, writeFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TAIL_BYTES = 256 * 1024; // read last 256KB of transcript

try {
  const input = readFileSync(0, 'utf8'); // stdin
  const payload = JSON.parse(input);
  const sessionId = payload.session_id;
  const transcriptPath = payload.transcript_path;

  if (!sessionId || !transcriptPath) process.exit(0);

  // Read tail of transcript to find the last assistant message with usage
  let lines;
  try {
    const stat = statSync(transcriptPath);
    if (stat.size > TAIL_BYTES) {
      const fd = openSync(transcriptPath, 'r');
      const buf = Buffer.alloc(TAIL_BYTES);
      readSync(fd, buf, 0, TAIL_BYTES, stat.size - TAIL_BYTES);
      closeSync(fd);
      lines = buf.toString('utf8').split('\n');
      lines.shift(); // drop partial first line
    } else {
      lines = readFileSync(transcriptPath, 'utf8').split('\n');
    }
  } catch {
    process.exit(0);
  }

  // Walk backwards to find the last assistant message with usage
  let usage = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'assistant' && entry.message?.usage) {
        usage = entry.message.usage;
        break;
      }
    } catch { /* skip */ }
  }

  if (!usage) process.exit(0);

  const read = usage.cache_read_input_tokens || 0;
  const created = usage.cache_creation_input_tokens || 0;
  const fresh = usage.input_tokens || 0;
  const denom = read + created + fresh;
  const writeReadSum = read + created;

  const hr = denom > 0 ? read / denom : 0;
  const ef = writeReadSum > 0 ? read / writeReadSum : 0;

  const snapshotPath = join(tmpdir(), `omc-lens-cache-snapshot-${sessionId}.json`);
  writeFileSync(snapshotPath, JSON.stringify({ hr, ef, ts: new Date().toISOString() }), 'utf8');
} catch {
  // Non-fatal — never block the hook chain
  process.exit(0);
}
