/**
 * Session Cost Calculator
 *
 * Calculates session cost in USD based on model-specific pricing.
 * This is a DokaLab-exclusive feature -- OMC does not provide cost calculation.
 *
 * Pricing source: Anthropic API pricing (per 1M tokens)
 * Reference: existing draft dokalab_omc_hud.mjs line 739
 */

// ---------------------------------------------------------------------------
// Pricing Table (USD per 1M tokens)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} ModelPricing
 * @property {number} input       Input tokens per 1M
 * @property {number} output      Output tokens per 1M
 * @property {number} cacheCreate Cache creation tokens per 1M
 * @property {number} cacheRead   Cache read tokens per 1M
 */

/** @type {Record<string, ModelPricing>} */
const PRICING = {
  opus: {
    input: 15,
    output: 75,
    cacheCreate: 15,
    cacheRead: 1.875,
  },
  sonnet: {
    input: 3,
    output: 15,
    cacheCreate: 3,
    cacheRead: 0.3,
  },
  haiku: {
    input: 0.8,
    output: 4,
    cacheCreate: 0.8,
    cacheRead: 0.08,
  },
};

// Default to Sonnet pricing when model cannot be determined
const DEFAULT_TIER = 'sonnet';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Determine model tier from display name or model ID.
 *
 * @param {string} modelName  e.g. 'Claude Sonnet 4', 'claude-3-5-haiku-20241022'
 * @returns {'opus'|'sonnet'|'haiku'}
 */
export function getModelTier(modelName) {
  if (!modelName) return DEFAULT_TIER;
  const lower = modelName.toLowerCase();
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('haiku')) return 'haiku';
  // Sonnet is default -- covers 'sonnet' and unknown models
  return 'sonnet';
}

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
  const tier = getModelTier(modelName);
  const pricing = PRICING[tier];

  const input = tokens.inputTokens || 0;
  const output = tokens.outputTokens || 0;
  const cacheCreate = tokens.cacheCreateTokens || 0;
  const cacheRead = tokens.cacheReadTokens || 0;

  return (
    (input * pricing.input +
      output * pricing.output +
      cacheCreate * pricing.cacheCreate +
      cacheRead * pricing.cacheRead) /
    1_000_000
  );
}

/**
 * Get the pricing table for a model tier (for display purposes).
 *
 * @param {'opus'|'sonnet'|'haiku'} tier
 * @returns {ModelPricing}
 */
export function getPricing(tier) {
  return PRICING[tier] || PRICING[DEFAULT_TIER];
}
