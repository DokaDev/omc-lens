/**
 * ansi.mjs — ANSI 256-color utility primitives.
 *
 * Every function follows the RESET sandwich pattern:
 * open-escape + text + RESET.  No function ever returns
 * an unclosed escape sequence.
 *
 * Domain-specific gradient functions (rate limit, context bar)
 * belong in Phase 3 renderers, NOT here (per D-03).
 */

export const RESET = '\x1b[0m';

/**
 * Wrap text with 256-color foreground.
 * @param {number} code  0-255 color index
 * @param {string} text
 * @returns {string}
 */
export function fg256(code, text) {
  return `\x1b[38;5;${code}m${text}${RESET}`;
}

/**
 * Wrap text with 256-color background.
 * @param {number} code  0-255 color index
 * @param {string} text
 * @returns {string}
 */
export function bg256(code, text) {
  return `\x1b[48;5;${code}m${text}${RESET}`;
}

/**
 * Wrap text with combined 256-color foreground + background.
 * @param {number} fgCode  0-255 foreground color index
 * @param {number} bgCode  0-255 background color index
 * @param {string} text
 * @returns {string}
 */
export function fgbg256(fgCode, bgCode, text) {
  return `\x1b[38;5;${fgCode};48;5;${bgCode}m${text}${RESET}`;
}

/**
 * Wrap text with bold modifier.
 * @param {string} text
 * @returns {string}
 */
export function bold(text) {
  return `\x1b[1m${text}${RESET}`;
}

/**
 * Wrap text with dim modifier.
 * @param {string} text
 * @returns {string}
 */
export function dim(text) {
  return `\x1b[2m${text}${RESET}`;
}

// SGR sequence pattern (Select Graphic Rendition escape codes only).
// Sticky flag so we can advance lastIndex for efficient tokenisation.
const SGR_RE = /\x1b\[[0-9;]*m/y;

/**
 * Truncate a string containing ANSI SGR escapes to at most maxWidth visible
 * columns, appending marker.  The cut never lands inside an escape sequence,
 * and any open SGR state is closed with \x1b[0m before the marker is added.
 *
 * @param {string} input     Raw ANSI string to truncate
 * @param {number} maxWidth  Maximum visible column budget (including marker)
 * @param {string} [marker]  Appended when truncation occurs (default '…')
 * @returns {string}  Truncated string, or '' when input/maxWidth is falsy
 */
export function ansiSafeTruncate(input, maxWidth, marker = '\u2026') {
  if (!input || maxWidth <= 0) return '';

  const markerWidth = [...marker].length; // marker is ASCII/single-width in practice
  const budget = maxWidth - markerWidth;

  let out = '';
  let visible = 0;
  let sgrOpen = false;
  let i = 0;

  while (i < input.length) {
    // Try to match an SGR escape at the current position
    SGR_RE.lastIndex = i;
    const m = SGR_RE.exec(input);
    if (m && m.index === i) {
      out += m[0];
      // \x1b[0m and \x1b[m are reset sequences; anything else opens colour state
      sgrOpen = m[0] !== '\x1b[0m' && m[0] !== '\x1b[m';
      i = SGR_RE.lastIndex;
      continue;
    }

    // Printable character — measure and accumulate
    // Use a simple code-point width: most chars are width 1.
    // Full CJK awareness is handled upstream (stringWidth); here we only need
    // a safe fallback that never over-counts, so 1 is correct for Latin/emoji.
    const cp = input.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const chLen = ch.length; // surrogate pairs occupy 2 UTF-16 units
    if (visible + 1 > budget) break;
    out += ch;
    visible += 1;
    i += chLen;
  }

  if (sgrOpen) out += '\x1b[0m';
  out += marker;
  return out;
}
