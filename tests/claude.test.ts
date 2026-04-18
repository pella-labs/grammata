import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readClaude } from '../src/claude.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('Claude token counting (B2 regression)', () => {
  it('does not double-count usage when multiple assistant records share the same message.id', async () => {
    const fixtureDir = join(here, 'fixtures/claude/duplicate-message-id-home');

    const summary = await readClaude(fixtureDir);

    expect(summary.sessions.length).toBe(1);
    const session = summary.sessions[0];

    // Fixture has 4 assistant records grouped into 2 turns (2 message.ids).
    // msg_001: input=10, output=150 (final), cache_read=1000, cache_creation=500
    // msg_002: input=20, output=80  (final), cache_read=1500, cache_creation=100
    //
    // Naive sum across all 4 records:
    //   input: 10+10+20+20 = 60
    //   output: 5+150+8+80 = 243
    //   cache_read: 1000+1000+1500+1500 = 5000
    //   cache_creation: 500+500+100+100 = 1200
    //
    // Correct per-message.id max-per-field then summed:
    //   input: 10 + 20 = 30
    //   output: 150 + 80 = 230
    //   cache_read: 1000 + 1500 = 2500
    //   cache_creation: 500 + 100 = 600
    expect(session.inputTokens).toBe(30);
    expect(session.outputTokens).toBe(230);
    expect(session.cacheReadTokens).toBe(2500);
    expect(session.cacheCreateTokens).toBe(600);

    expect(summary.totalInputTokens).toBe(30);
    expect(summary.totalOutputTokens).toBe(230);
    expect(summary.totalCacheReadTokens).toBe(2500);
    expect(summary.totalCacheCreateTokens).toBe(600);
  });
});
