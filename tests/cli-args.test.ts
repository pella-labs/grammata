import { describe, expect, it } from 'vitest';
import { getPositionalArgs, isSubmitToken, resolveCliArgs } from '../src/cli-args.js';

const COMMANDS = new Set([
  'summary',
  'submit',
  'claude',
  'codex',
  'cursor',
  'analytics',
  'pharos',
  'help',
]);

describe('CLI arg parsing', () => {
  it('keeps top-level flags from becoming commands', () => {
    expect(resolveCliArgs(['--json'], COMMANDS).command).toBe('summary');
    expect(getPositionalArgs(['--json', '--since', '2026-04-01'])).toEqual([]);
  });

  it('routes prefixed bare tokens to submit', () => {
    const parsed = resolveCliArgs(['bematist_launch-123'], COMMANDS);
    expect(parsed.command).toBe('submit');
    expect(parsed.bareToken).toBe('bematist_launch-123');
  });

  it('rejects unknown commands instead of treating them as tokens', () => {
    const parsed = resolveCliArgs(['analytcs'], COMMANDS);
    expect(parsed.command).toBe('unknown');
    expect(parsed.unknownCommand).toBe('analytcs');
  });

  it('validates submit token prefixes', () => {
    expect(isSubmitToken('bm_launch-123')).toBe(true);
    expect(isSubmitToken('bematist_launch-123')).toBe(true);
    expect(isSubmitToken('pharos_launch-123')).toBe(true);
    expect(isSubmitToken('launch-123')).toBe(false);
  });
});
