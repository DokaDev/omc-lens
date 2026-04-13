#!/usr/bin/env node
/**
 * hud.mjs — DokaLab HUD entry point.
 *
 * Orchestrates the full HUD pipeline:
 *   1. assembleContext() — collect all data via OMC bridge
 *   2. renderLine1/2/3() — render each line
 *   3. renderAgentTree() — render agent tree
 *   4. composeOutput() — combine, truncate, add warnings
 *   5. stdout — write final output
 *
 * Never crashes — outputs a minimal fallback on any error.
 */

import { assembleContext } from './data/context.mjs';
import { renderLine1 } from './render/line1.mjs';
import { renderLine2 } from './render/line2.mjs';
import { renderLine3 } from './render/line3.mjs';
import { renderAgentTree } from './render/agents.mjs';
import { composeOutput } from './render/compose.mjs';

// ---------------------------------------------------------------------------
// Terminal Width Detection
// ---------------------------------------------------------------------------

/**
 * Determine terminal width.
 * Priority: stderr columns (live TTY) > stdout columns > $COLUMNS env > default 120.
 * Same approach as OMC's index.ts (lines 273-280).
 *
 * @returns {number}
 */
function getTermWidth() {
  return (
    process.stderr.columns ||
    process.stdout.columns ||
    parseInt(process.env.COLUMNS || '0', 10) ||
    120
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  try {
    const ctx = await assembleContext();

    const termWidth = getTermWidth();

    // Render each line
    const line1 = renderLine1(ctx);
    const line2 = renderLine2(ctx);
    const line3 = renderLine3(ctx);
    const agentLines = renderAgentTree(ctx);

    // Compose and output
    const output = composeOutput({
      lines: [line1, line2, line3],
      agentLines,
      contextPercent: ctx.contextPercent,
      termWidth,
    });

    process.stdout.write(output);
  } catch (err) {
    // Never crash — output minimal fallback
    process.stdout.write(`\x1b[90mHUD error: ${err.message || 'unknown'}\x1b[0m\n`);
  }
}

main();
