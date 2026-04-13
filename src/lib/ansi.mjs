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
