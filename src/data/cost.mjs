/**
 * Session Cost Calculator
 *
 * Calculates session cost in USD based on model-specific pricing.
 * This is a DokaLab-exclusive feature -- OMC does not provide cost calculation.
 *
 * Pricing source: Anthropic API pricing (per 1M tokens)
 */

// ---------------------------------------------------------------------------
// Pricing (USD per 1M tokens)
// ---------------------------------------------------------------------------

/**
 * Cache rates are a fixed ratio of a model's input rate on every model, so they
 * are derived rather than stored. Keeping them as independent numbers is what
 * let them drift: every tier in the previous table had a cache rate that no
 * longer matched its own input rate.
 *
 * The write ratio is for the 5-minute TTL, which is the default. A 1-hour TTL
 * costs 2x instead, but a transcript does not record which TTL a request used,
 * so the default is the only assumption available.
 */
const CACHE_WRITE_RATIO = 1.25;
const CACHE_READ_RATIO = 0.1;

/**
 * Per-family rates, ordered newest first. A row applies to versions >= its
 * `from`, and the first matching row wins.
 *
 * The version dimension is the point of this table. Anthropic prices per model
 * version, not per family — Opus dropped from 15/75 to 5/25 partway through the
 * 4.x line. A single row per family cannot express that, which is how this file
 * came to bill an Opus 5 session at Opus 4.1 rates.
 *
 * @type {Record<string, Array<{from: number, input: number, output: number}>>}
 */
const RATES = {
  fable: [
    { from: 0, input: 10, output: 50 },
  ],
  opus: [
    { from: 4.5, input: 5, output: 25 },
    { from: 0, input: 15, output: 75 },
  ],
  sonnet: [
    { from: 0, input: 3, output: 15 },
  ],
  haiku: [
    { from: 4, input: 1, output: 5 },
    { from: 0, input: 0.8, output: 4 },
  ],
};

// Sonnet rates when the model cannot be identified — the middle of the range,
// so an unknown model is wrong by the least in either direction.
const DEFAULT_FAMILY = 'sonnet';

// ---------------------------------------------------------------------------
// Model identification
// ---------------------------------------------------------------------------

/**
 * Determine model family from display name or model ID.
 *
 * @param {string} modelName  e.g. 'Claude Sonnet 4', 'claude-3-5-haiku-20241022'
 * @returns {'fable'|'opus'|'sonnet'|'haiku'}
 */
export function getModelTier(modelName) {
  if (typeof modelName !== 'string' || modelName === '') return DEFAULT_FAMILY;
  const lower = modelName.toLowerCase();
  // Mythos is Fable's Project Glasswing sibling and shares its rates.
  if (lower.includes('fable') || lower.includes('mythos')) return 'fable';
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('haiku')) return 'haiku';
  // Sonnet is the default -- covers 'sonnet' and unknown models
  return DEFAULT_FAMILY;
}

/**
 * Extract a model's version as `major.minor`, so 'Opus 4.6' and
 * 'claude-opus-4-6' both yield 4.6 and 'Opus 5' yields 5.
 *
 * The minor group is capped at two digits and must not be followed by another
 * digit, so the date suffix in an ID like 'claude-opus-4-20250514' is not read
 * as a minor version — that would score the model far above every threshold
 * and price an Opus 4 at Opus 5 rates.
 *
 * @param {string} modelName
 * @returns {number|null}  null when the name carries no version
 */
function parseModelVersion(modelName) {
  if (typeof modelName !== 'string') return null;
  const m = modelName.match(/(\d+)(?:[.-](\d{1,2})(?!\d))?/);
  if (!m) return null;
  const major = Number(m[1]);
  const minor = m[2] === undefined ? 0 : Number(m[2]);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
  return major + minor / 10;
}

/**
 * Resolve the full rate card for a model, deriving the cache rates.
 *
 * @param {string} modelName
 * @returns {{input: number, output: number, cacheCreate: number, cacheRead: number}}
 */
export function getRates(modelName) {
  const rows = RATES[getModelTier(modelName)] || RATES[DEFAULT_FAMILY];
  const version = parseModelVersion(modelName);
  // An unversioned or unparseable name takes the newest row: such a name is far
  // more likely to be a model newer than this table than an ancient one.
  const row =
    version === null
      ? rows[0]
      : rows.find((r) => version >= r.from) || rows[rows.length - 1];

  return {
    input: row.input,
    output: row.output,
    cacheCreate: row.input * CACHE_WRITE_RATIO,
    cacheRead: row.input * CACHE_READ_RATIO,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Calculate session cost in USD.
 *
 * @param {string} modelName  Model display name or ID
 * @param {Object} tokens     Token breakdown
 * @param {number} [tokens.inputTokens=0]
 * @param {number} [tokens.outputTokens=0]
 * @param {number} [tokens.cacheCreateTokens=0]
 * @param {number} [tokens.cacheReadTokens=0]
 * @returns {number} Cost in USD
 */
export function calculateSessionCost(modelName, tokens) {
  const rates = getRates(modelName);

  const input = tokens.inputTokens || 0;
  const output = tokens.outputTokens || 0;
  const cacheCreate = tokens.cacheCreateTokens || 0;
  const cacheRead = tokens.cacheReadTokens || 0;

  return (
    (input * rates.input +
      output * rates.output +
      cacheCreate * rates.cacheCreate +
      cacheRead * rates.cacheRead) /
    1_000_000
  );
}

/**
 * Sum cost over a per-model token breakdown.
 *
 * Charging a whole session at whichever model happens to be selected right now
 * reprices every token already spent the moment the model changes. Across the
 * local corpus that moved a session from $1204 to $710 (-41%) and another from
 * $31 to $45 (+44%). It only bites when the two models sit in different rate
 * rows — Opus 4.7 and 4.8 both bill at 5/25, so switching between them is free
 * of error, while Fable (10/50) against Opus (5/25) is a 2x swing.
 *
 * The per-model shape uses short keys because it is written to the scan record
 * on every render.
 *
 * @param {Record<string, {i?: number, o?: number, cc?: number, cr?: number}>|null} byModel
 * @returns {number} Cost in USD
 */
export function calculateCostByModel(byModel) {
  if (!byModel || typeof byModel !== 'object') return 0;
  let total = 0;
  for (const [modelName, t] of Object.entries(byModel)) {
    if (!t) continue;
    total += calculateSessionCost(modelName, {
      inputTokens: t.i,
      outputTokens: t.o,
      cacheCreateTokens: t.cc,
      cacheReadTokens: t.cr,
    });
  }
  return total;
}
