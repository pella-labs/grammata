/**
 * Model pricing tables sourced from LiteLLM / official pricing pages.
 * All values are per million tokens.
 */

// Anthropic / Claude models

export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface CodexModelPricing {
  input: number;
  output: number;
  cachedInput: number;
}

export const CLAUDE_PRICING: Record<string, ModelPricing> = {
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-5-20251101': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-sonnet-4-20250514': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'claude-haiku-3-5': { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
};

// OpenAI / Codex models

export const CODEX_PRICING: Record<string, CodexModelPricing> = {
  'gpt-5.1-codex': { input: 1.25, output: 10, cachedInput: 0.125 },
  'gpt-5.2-codex': { input: 1.75, output: 14, cachedInput: 0.175 },
  'gpt-5.3-codex': { input: 1.75, output: 14, cachedInput: 0.175 },
  'gpt-5.3-codex-spark': { input: 1.75, output: 14, cachedInput: 0.175 },
  'gpt-5.1-codex-mini': { input: 0.25, output: 2, cachedInput: 0.025 },
  'gpt-5.4': { input: 2.5, output: 15, cachedInput: 0.25 },
  'gpt-4o': { input: 2.5, output: 10, cachedInput: 1.25 },
  'gpt-4o-mini': { input: 0.15, output: 0.6, cachedInput: 0.075 },
  o3: { input: 10, output: 40, cachedInput: 2.5 },
  'o3-mini': { input: 1.1, output: 4.4, cachedInput: 0.55 },
  'o4-mini': { input: 1.1, output: 4.4, cachedInput: 0.55 },
};

export function getClaudePricing(model: string): ModelPricing {
  if (CLAUDE_PRICING[model]) return CLAUDE_PRICING[model];
  for (const [key, pricing] of Object.entries(CLAUDE_PRICING)) {
    if (model.startsWith(key.split('-').slice(0, 3).join('-')))
      return pricing;
  }
  return { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
}

export function getCodexPricing(model: string): CodexModelPricing {
  if (CODEX_PRICING[model]) return CODEX_PRICING[model];
  for (const [key, pricing] of Object.entries(CODEX_PRICING)) {
    if (model.includes(key) || key.includes(model)) return pricing;
  }
  return { input: 1.75, output: 14, cachedInput: 0.175 };
}

// Cursor models — Cursor proxies various providers (Anthropic, OpenAI, Google).
// Pricing matches the underlying model; we map known Cursor model names here.

export interface CursorModelPricing {
  input: number;
  output: number;
}

export const CURSOR_PRICING: Record<string, CursorModelPricing> = {
  // Anthropic models via Cursor
  'claude-3.5-sonnet': { input: 3, output: 15 },
  'claude-3-5-sonnet-20241022': { input: 3, output: 15 },
  'claude-sonnet-4-20250514': { input: 3, output: 15 },
  'claude-3-opus': { input: 15, output: 75 },
  'claude-3-haiku': { input: 0.25, output: 1.25 },
  // OpenAI models via Cursor
  'gpt-4': { input: 30, output: 60 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4-turbo': { input: 10, output: 30 },
  o3: { input: 10, output: 40 },
  'o3-mini': { input: 1.1, output: 4.4 },
  // Google models via Cursor
  'gemini-pro': { input: 0.5, output: 1.5 },
  'gemini-1.5-pro': { input: 3.5, output: 10.5 },
  // Cursor's own fine-tuned models
  'cursor-small': { input: 0.5, output: 1.5 },
  'cursor-fast': { input: 0.5, output: 1.5 },
};

export function getCursorPricing(model: string): CursorModelPricing {
  if (CURSOR_PRICING[model]) return CURSOR_PRICING[model];
  // Try prefix matching for versioned model names
  for (const [key, pricing] of Object.entries(CURSOR_PRICING)) {
    if (model.includes(key) || key.includes(model)) return pricing;
  }
  // Also check if it's a Claude or GPT model we already know about
  if (model.includes('claude')) {
    const cp = getClaudePricing(model);
    return { input: cp.input, output: cp.output };
  }
  if (model.includes('gpt') || model.includes('o3') || model.includes('o4')) {
    const cp = getCodexPricing(model);
    return { input: cp.input, output: cp.output };
  }
  // Default: mid-range pricing
  return { input: 3, output: 15 };
}
