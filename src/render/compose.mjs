/**
 * compose.mjs — Line composer and output assembler.
 *
 * Combines rendered line strings into final HUD output.
 * Handles terminal width truncation (CJK-aware via omc-bridge),
 * max line limits, and context warning banners.
 *
 * Requirements: COMP-01, COMP-02, COMP-03, COMP-04
 */

import { RESET, fg256, bold, ansiSafeTruncate } from '../lib/ansi.mjs';
import { stringWidth, truncateToWidth } from '../lib/omc-bridge.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum output lines before truncation (prevents input field shrinkage). */
const MAX_LINES = 6;

/** Separator between inline segments. */
const SEP_CHAR = ' | ';

/** Context percentage threshold for warning banner. */
const CONTEXT_WARNING_THRESHOLD = 85;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Join segments into a single line, truncating at terminal width.
 *
 * Segments are joined with " | " separator. If the result exceeds
 * termWidth, it is truncated at the last complete separator boundary
 * that fits, with "..." appended. Falls back to hard truncation if
 * even the first segment is too wide.
 *
 * @param {string[]} segments  Array of pre-rendered ANSI strings
 * @param {number} termWidth   Terminal width in columns
 * @returns {string}  Composed line fitting within termWidth
 */
export function composeLine(segments, termWidth) {
  if (!segments || segments.length === 0) return '';
  if (!termWidth || termWidth <= 0) termWidth = 120;

  // Fast path: join and check if it fits
  const joined = segments.join(SEP_CHAR);
  const joinedWidth = stringWidth(joined);

  if (joinedWidth <= termWidth) {
    return joined;
  }

  // Slow path: find the last separator boundary that fits
  let result = '';
  let resultWidth = 0;
  const sepWidth = stringWidth(SEP_CHAR);
  const ellipsisWidth = 3; // "..."

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const segWidth = stringWidth(seg);
    const addedWidth = i === 0 ? segWidth : sepWidth + segWidth;

    if (resultWidth + addedWidth + ellipsisWidth > termWidth && i > 0) {
      // This segment would overflow -- stop here
      break;
    }

    if (i > 0) {
      result += SEP_CHAR;
      resultWidth += sepWidth;
    }
    result += seg;
    resultWidth += segWidth;
  }

  // If even the first segment is too wide, hard truncate
  // [omc-lens #2 sync] Route overflow truncation through ansiSafeTruncate so
  // mid-escape cuts no longer let the terminal swallow downstream content.
  if (resultWidth > termWidth) {
    return ansiSafeTruncate(result, termWidth, '...');
  }

  return result;
}

/**
 * Compose final HUD output from rendered lines.
 *
 * @param {Object} options
 * @param {string[]} options.lines          Array of rendered line strings (line1, line2, line3)
 * @param {string[]} [options.agentLines]   Agent tree lines (variable count)
 * @param {number}   [options.contextPercent]  Context window usage percentage
 * @param {number}   [options.termWidth]    Terminal width for truncation
 * @returns {string}  Final output string (newline-terminated)
 */
export function composeOutput({ lines, agentLines = [], contextPercent = 0, termWidth = 120 }) {
  const outputLines = [];

  // Add main lines (truncated to terminal width)
  // [omc-lens #2 sync] Route overflow truncation through ansiSafeTruncate so
  // mid-escape cuts no longer let the terminal swallow downstream content.
  for (const line of lines) {
    if (line) {
      const w = stringWidth(line);
      if (w > termWidth) {
        outputLines.push(ansiSafeTruncate(line, termWidth, '...'));
      } else {
        outputLines.push(line);
      }
    }
  }

  // Add agent tree lines
  for (const agentLine of agentLines) {
    if (agentLine) {
      outputLines.push(agentLine);
    }
  }

  // Context warning banner (COMP-04)
  if (contextPercent >= CONTEXT_WARNING_THRESHOLD) {
    const warningColor = contextPercent >= 90 ? 196 : 208; // red or orange
    outputLines.push(
      bold(fg256(warningColor, `\u26a0 Context ${contextPercent}% \u2014 consider /compact to free space`))
    );
  }

  // Enforce max line limit (COMP-03)
  if (outputLines.length > MAX_LINES) {
    const truncated = outputLines.length - MAX_LINES + 1;
    outputLines.length = MAX_LINES - 1;
    outputLines.push(`\x1b[90m... (+${truncated} lines)${RESET}`);
  }

  return outputLines.join('\n') + '\n';
}
