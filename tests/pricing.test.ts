import { describe, expect, it } from 'vitest';
import { getClaudePricing, getCodexPricing } from '../src/pricing.js';

describe('pricing fallbacks', () => {
  it('uses explicit Claude family fallbacks for new versioned models', () => {
    expect(getClaudePricing('claude-opus-4-7')).toEqual(
      getClaudePricing('claude-opus-4-6'),
    );
    expect(getClaudePricing('claude-sonnet-4-9')).toEqual(
      getClaudePricing('claude-sonnet-4-6'),
    );
  });

  it('prefers the longest Codex match for versioned models', () => {
    expect(getCodexPricing('gpt-5.3-codex-spark-2026-02-01')).toEqual(
      getCodexPricing('gpt-5.3-codex-spark'),
    );
    expect(getCodexPricing('gpt-4o-mini-2026-02-01')).toEqual(
      getCodexPricing('gpt-4o-mini'),
    );
  });
});
