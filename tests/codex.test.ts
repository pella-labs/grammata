import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readCodex } from '../src/codex.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('Codex token counting (B1 regression)', () => {
  it('does not overcount tokens when token_count events are emitted multiple times per turn', async () => {
    const fixtureDir = join(here, 'fixtures/codex/multi-emission-home');

    const summary = await readCodex(fixtureDir);

    expect(summary.sessions.length).toBe(1);
    const session = summary.sessions[0];

    // Fixture has 8 token_count events across 3 logical turns.
    // total_token_usage at session end: input=600, cached=400, output=110.
    // Naive sum of last_token_usage across all 8 events would be:
    //   input: (100+100 + 200+200 + 300+300) = 1200  (2x correct)
    //   output: (20+20 + 35+35 + 55+55) = 220        (2x correct)
    // Correct session total comes from max(total_token_usage).
    expect(session.inputTokens).toBe(600);
    expect(session.cachedInputTokens).toBe(400);
    expect(session.outputTokens).toBe(110);

    // Session totals mirror the session.
    expect(summary.totalInputTokens).toBe(600);
    expect(summary.totalCachedInputTokens).toBe(400);
    expect(summary.totalOutputTokens).toBe(110);
  });

  it('does not collapse distinct turns when legacy last_token_usage values repeat', async () => {
    const fixtureDir = join(here, 'fixtures/codex/last-usage-home');

    const summary = await readCodex(fixtureDir);

    expect(summary.sessions.length).toBe(1);
    const session = summary.sessions[0];

    // Fixture has two logical turns, each emitted twice with the same
    // last_token_usage values and without total_token_usage.
    expect(session.inputTokens).toBe(200);
    expect(session.cachedInputTokens).toBe(100);
    expect(session.outputTokens).toBe(40);
  });
});
