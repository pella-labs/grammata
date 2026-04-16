#!/usr/bin/env node
import {
  readClaude,
  readCodex,
  readCursor,
  readAll,
  formatCost,
  formatTokens,
  formatDuration,
} from './index.js';
import type { ClaudeSummary } from './claude.js';
import type { CodexSummary } from './codex.js';
import type { CursorSummary } from './cursor.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';

// ── Onboarding: check cleanupPeriodDays ──────────────────

async function checkClaudeRetention(): Promise<void> {
  if (jsonMode) return;

  const settingsPath = join(homedir(), '.claude', 'settings.json');
  const markerPath = join(homedir(), '.claude', '.grammata-onboarded');

  // Skip if already onboarded
  if (existsSync(markerPath)) return;

  // Skip if no Claude Code installation
  if (!existsSync(settingsPath)) return;

  try {
    const settings = JSON.parse(
      readFileSync(settingsPath, 'utf-8'),
    ) as Record<string, unknown>;
    const current = settings.cleanupPeriodDays as
      | number
      | undefined;

    // Already configured to something > 30
    if (current && current > 30) {
      writeFileSync(markerPath, new Date().toISOString());
      return;
    }

    console.log('');
    console.log(
      '  \x1B[33m\u26A0\x1B[0m  \x1B[1mClaude Code log retention\x1B[0m',
    );
    console.log('');
    console.log(
      '  Claude Code deletes session logs after \x1B[1m30 days\x1B[0m by default.',
    );
    console.log(
      '  This means grammata can only show the last 30 days of usage.',
    );
    console.log('');
    console.log(
      '  To keep your full history, grammata can set \x1B[36mcleanupPeriodDays\x1B[0m',
    );
    console.log(
      '  to \x1B[1m365 days\x1B[0m in ~/.claude/settings.json.',
    );
    console.log('');

    const answer = await ask(
      '  Extend log retention to 365 days? \x1B[90m(y/n)\x1B[0m ',
    );

    if (
      answer.toLowerCase() === 'y' ||
      answer.toLowerCase() === 'yes'
    ) {
      settings.cleanupPeriodDays = 365;
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      console.log('');
      console.log(
        '  \x1B[32m\u2714\x1B[0m  Set cleanupPeriodDays to 365 in ~/.claude/settings.json',
      );
      console.log(
        '     Your session history will now be retained for a full year.',
      );
    } else {
      console.log('');
      console.log(
        '  \x1B[90m  Skipped. You can change this later in ~/.claude/settings.json\x1B[0m',
      );
    }

    // Mark as onboarded so we don't ask again
    writeFileSync(markerPath, new Date().toISOString());
    console.log('');
  } catch {
    // Settings file unreadable — skip silently
  }
}

function ask(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer: string) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ── Animated loader ──────────────────────────────────────

const FRAMES = ['\u28BE', '\u28BD', '\u28BB', '\u28BF', '\u28BF', '\u28DF', '\u28EF', '\u28F7'];

class Spinner {
  private frame = 0;
  private interval: ReturnType<typeof setInterval> | null = null;
  private startTime = 0;

  start(): void {
    if (jsonMode) return;
    this.startTime = Date.now();
    this.frame = 0;
    process.stdout.write('\x1B[?25l');
    this.interval = setInterval(() => {
      const elapsed = (
        (Date.now() - this.startTime) /
        1000
      ).toFixed(1);
      const f = FRAMES[this.frame % FRAMES.length];
      process.stdout.write(
        `\r  \x1B[36m${f}\x1B[0m \x1B[1mgrammata\x1B[0m \x1B[90m${elapsed}s\x1B[0m\x1B[K`,
      );
      this.frame++;
    }, 80);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      const elapsed = (
        (Date.now() - this.startTime) /
        1000
      ).toFixed(1);
      process.stdout.write(
        `\r  \x1B[32m\u2714\x1B[0m \x1B[1mgrammata\x1B[0m \x1B[90m${elapsed}s\x1B[0m\x1B[K\n`,
      );
      process.stdout.write('\x1B[?25h');
    }
  }
}

const spinner = new Spinner();

const args = process.argv.slice(2);

const COMMANDS = new Set([
  'summary',
  'claude',
  'cc',
  'codex',
  'cx',
  'cursor',
  'cu',
  'sessions',
  'models',
  'tools',
  'tokens',
  'cost',
  'daily',
  'hours',
  'pharos',
  'help',
]);

const command =
  args.find((a) => COMMANDS.has(a)) ||
  (args.some((a) => a === '--help' || a === '-h') ? 'help' : 'summary');
const flags = new Set(args.slice(1));
const jsonMode = flags.has('--json') || flags.has('-j');

// Parse --since and --until date flags

function getFlag(name: string): string | undefined {
  for (const a of args) {
    if (a.startsWith(`--${name}=`)) return a.split('=')[1];
  }
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];

  // Short flags
  const short =
    name === 'since' ? '-s' : name === 'until' ? '-u' : '';
  if (short) {
    const si = args.indexOf(short);
    if (si !== -1 && args[si + 1]) return args[si + 1];
  }

  return undefined;
}

const sinceStr = getFlag('since');
const untilStr = getFlag('until');
const sinceDate = sinceStr ? new Date(sinceStr) : null;
const untilDate = untilStr ? new Date(untilStr + 'T23:59:59') : null;

function inRange(dateStr: string): boolean {
  if (!sinceDate && !untilDate) return true;
  if (!dateStr) return false;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return false;
  if (sinceDate && d < sinceDate) return false;
  if (untilDate && d > untilDate) return false;
  return true;
}

function dateRangeLabel(): string {
  if (sinceStr && untilStr) return ` (${sinceStr} to ${untilStr})`;
  if (sinceStr) return ` (since ${sinceStr})`;
  if (untilStr) return ` (until ${untilStr})`;
  return ' (all time)';
}

function printHelp(): void {
  console.log(`
  @pella-labs/grammata \u2014 coding agent usage analytics

  USAGE
    grammata <command> [options]

  COMMANDS
    summary          Overview of all sources (default)
    claude           Claude Code details
    codex            Codex details
    cursor           Cursor AI details
    sessions         List all sessions across sources
    models           Model breakdown with costs
    tools            Tool usage ranking (Claude Code only)
    tokens           Token breakdown by source
    cost             Cost summary
    daily            Daily cost breakdown
    hours            Activity by hour of day
    pharos           Generate a shareable stats card

  OPTIONS
    --json, -j       Output as JSON
    --since, -s      Filter from date (YYYY-MM-DD)
    --until, -u      Filter until date (YYYY-MM-DD)

  EXAMPLES
    grammata                    # full summary (all time)
    grammata --since 2026-04-01 # this month only
    grammata --since 2026-03-01 --until 2026-03-31  # March only
    grammata claude             # Claude Code details
    grammata codex              # Codex details
    grammata cursor             # Cursor AI details
    grammata sessions           # all sessions
    grammata models --json      # model breakdown as JSON
    grammata cost               # cost summary
    grammata tools              # tool usage ranking
    grammata daily              # day-by-day costs
    grammata hours              # activity heatmap by hour
    grammata pharos --token <token>  # generate shareable stats card
`);
}

// Build a summary object matching readAll() shape from filtered data

interface FilteredSummary {
  claude: {
    sessions: number;
    cost: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreateTokens: number;
    cacheSavingsUsd: number;
    models: Record<string, { sessions: number; cost: number }>;
    topTools: Array<{ name: string; count: number }>;
    hourDistribution: number[];
    activeDays: number;
  };
  codex: {
    sessions: number;
    cost: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    models: Record<string, { sessions: number; cost: number }>;
  };
  cursor: {
    sessions: number;
    cost: number;
    inputTokens: number;
    outputTokens: number;
    models: Record<string, { sessions: number; cost: number }>;
  };
  combined: {
    totalCost: number;
    totalSessions: number;
    totalInputTokens: number;
    totalOutputTokens: number;
  };
}

function buildSummary(
  claude: ClaudeSummary,
  codex: CodexSummary,
  cursor?: CursorSummary,
): FilteredSummary {
  const claudeModels: Record<
    string,
    { sessions: number; cost: number }
  > = {};
  for (const s of claude.sessions) {
    const e = claudeModels[s.model] || { sessions: 0, cost: 0 };
    e.sessions++;
    e.cost += s.costUsd;
    claudeModels[s.model] = e;
  }

  const codexModels: Record<
    string,
    { sessions: number; cost: number }
  > = {};
  for (const s of codex.sessions) {
    const e = codexModels[s.model] || { sessions: 0, cost: 0 };
    e.sessions++;
    e.cost += s.costUsd;
    codexModels[s.model] = e;
  }

  const topTools = Object.entries(claude.toolBreakdown)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
  const activeDays = new Set(
    claude.sessions.map((s) => s.firstTimestamp.slice(0, 10)),
  ).size;

  const cursorCost = cursor?.totalCost || 0;
  const cursorSessions = cursor?.sessions.length || 0;
  const cursorInput = cursor?.totalInputTokens || 0;
  const cursorOutput = cursor?.totalOutputTokens || 0;

  return {
    claude: {
      sessions: claude.sessions.length,
      cost: claude.totalCost,
      inputTokens: claude.totalInputTokens,
      outputTokens: claude.totalOutputTokens,
      cacheReadTokens: claude.totalCacheReadTokens,
      cacheCreateTokens: claude.totalCacheCreateTokens,
      cacheSavingsUsd: claude.cacheSavingsUsd,
      models: claudeModels,
      topTools,
      hourDistribution: claude.hourDistribution,
      activeDays,
    },
    codex: {
      sessions: codex.sessions.length,
      cost: codex.totalCost,
      inputTokens: codex.totalInputTokens,
      cachedInputTokens: codex.totalCachedInputTokens,
      outputTokens: codex.totalOutputTokens,
      models: codexModels,
    },
    cursor: {
      sessions: cursorSessions,
      cost: cursorCost,
      inputTokens: cursorInput,
      outputTokens: cursorOutput,
      models: cursor?.models || {},
    },
    combined: {
      totalCost: claude.totalCost + codex.totalCost + cursorCost,
      totalSessions:
        claude.sessions.length + codex.sessions.length + cursorSessions,
      totalInputTokens:
        claude.totalInputTokens + codex.totalInputTokens + cursorInput,
      totalOutputTokens:
        claude.totalOutputTokens + codex.totalOutputTokens + cursorOutput,
    },
  };
}

// Filtered readers

async function getFilteredClaude(): Promise<ClaudeSummary> {
  const data = await readClaude();
  if (!sinceDate && !untilDate) return data;

  const sessions = data.sessions.filter((s) =>
    inRange(s.firstTimestamp),
  );
  let totalCost = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheCreate = 0;
  const toolBreakdown: Record<string, number> = {};
  const hourDist = new Array(24).fill(0) as number[];

  for (const s of sessions) {
    totalCost += s.costUsd;
    totalInput += s.inputTokens;
    totalOutput += s.outputTokens;
    totalCacheRead += s.cacheReadTokens;
    totalCacheCreate += s.cacheCreateTokens;
    for (const [t, c] of Object.entries(s.toolBreakdown))
      toolBreakdown[t] = (toolBreakdown[t] || 0) + c;
    hourDist[s.startHour]++;
  }

  return {
    ...data,
    sessions,
    totalCost,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    totalCacheReadTokens: totalCacheRead,
    totalCacheCreateTokens: totalCacheCreate,
    toolBreakdown,
    hourDistribution: hourDist,
    cacheSavingsUsd: 0,
  };
}

async function getFilteredCodex(): Promise<CodexSummary> {
  const data = await readCodex();
  if (!sinceDate && !untilDate) return data;

  const sessions = data.sessions.filter((s) =>
    inRange(s.createdAt),
  );
  let totalCost = 0;
  let totalInput = 0;
  let totalCached = 0;
  let totalOutput = 0;

  for (const s of sessions) {
    totalCost += s.costUsd;
    totalInput += s.inputTokens;
    totalCached += s.cachedInputTokens;
    totalOutput += s.outputTokens;
  }

  return {
    ...data,
    sessions,
    totalCost,
    totalInputTokens: totalInput,
    totalCachedInputTokens: totalCached,
    totalOutputTokens: totalOutput,
  };
}

async function getFilteredCursor(): Promise<CursorSummary> {
  const data = await readCursor();
  if (!sinceDate && !untilDate) return data;

  const sessions = data.sessions.filter((s) =>
    inRange(s.createdAt),
  );
  let totalCost = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalMessages = 0;
  let totalLinesAdded = 0;
  let totalLinesRemoved = 0;
  const models: Record<string, { sessions: number; cost: number }> = {};

  for (const s of sessions) {
    totalCost += s.costUsd;
    totalInput += s.inputTokens;
    totalOutput += s.outputTokens;
    totalMessages += s.messageCount;
    totalLinesAdded += s.linesAdded || 0;
    totalLinesRemoved += s.linesRemoved || 0;
    const e = models[s.model] || { sessions: 0, cost: 0 };
    e.sessions++;
    e.cost += s.costUsd;
    models[s.model] = e;
  }

  // Filter daily stats by date range too
  const dailyStats = data.dailyStats.filter((d) => inRange(d.date));

  return {
    ...data,
    sessions,
    totalCost,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    totalMessages,
    totalLinesAdded,
    totalLinesRemoved,
    models,
    dailyStats,
    totalTabSuggestedLines: dailyStats.reduce((s, d) => s + d.tabSuggestedLines, 0),
    totalTabAcceptedLines: dailyStats.reduce((s, d) => s + d.tabAcceptedLines, 0),
    totalComposerSuggestedLines: dailyStats.reduce((s, d) => s + d.composerSuggestedLines, 0),
    totalComposerAcceptedLines: dailyStats.reduce((s, d) => s + d.composerAcceptedLines, 0),
  };
}

async function cmdSummary(): Promise<void> {
  const [claude, codex, cursor] = await Promise.all([
    getFilteredClaude(),
    getFilteredCodex(),
    getFilteredCursor(),
  ]);

  // Build model breakdowns
  const claudeModels: Record<
    string,
    { sessions: number; cost: number }
  > = {};
  for (const s of claude.sessions) {
    const e = claudeModels[s.model] || { sessions: 0, cost: 0 };
    e.sessions++;
    e.cost += s.costUsd;
    claudeModels[s.model] = e;
  }

  const codexModels: Record<
    string,
    { sessions: number; cost: number }
  > = {};
  for (const s of codex.sessions) {
    const e = codexModels[s.model] || { sessions: 0, cost: 0 };
    e.sessions++;
    e.cost += s.costUsd;
    codexModels[s.model] = e;
  }

  const cursorModels: Record<
    string,
    { sessions: number; cost: number }
  > = {};
  for (const s of cursor.sessions) {
    const e = cursorModels[s.model] || { sessions: 0, cost: 0 };
    e.sessions++;
    e.cost += s.costUsd;
    cursorModels[s.model] = e;
  }

  const topTools = Object.entries(claude.toolBreakdown)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
  const activeDays = new Set(
    claude.sessions.map((s) => s.firstTimestamp.slice(0, 10)),
  ).size;
  const combined = {
    totalCost: claude.totalCost + codex.totalCost + cursor.totalCost,
    totalSessions:
      claude.sessions.length + codex.sessions.length + cursor.sessions.length,
  };

  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          claude: {
            sessions: claude.sessions.length,
            cost: claude.totalCost,
            models: claudeModels,
          },
          codex: {
            sessions: codex.sessions.length,
            cost: codex.totalCost,
            models: codexModels,
          },
          cursor: {
            sessions: cursor.sessions.length,
            cost: cursor.totalCost,
            models: cursorModels,
          },
          combined,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log('');
  console.log(`  @pella-labs/grammata${dateRangeLabel()}`);
  console.log(
    '  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
  );
  console.log('');

  if (claude.sessions.length > 0) {
    console.log('  Claude Code');
    console.log(`    Sessions:       ${claude.sessions.length}`);
    console.log(
      `    Cost:           ${formatCost(claude.totalCost)}`,
    );
    console.log(
      `    Input tokens:   ${formatTokens(claude.totalInputTokens)}`,
    );
    console.log(
      `    Output tokens:  ${formatTokens(claude.totalOutputTokens)}`,
    );
    console.log(
      `    Cache read:     ${formatTokens(claude.totalCacheReadTokens)}`,
    );
    console.log(`    Active days:    ${activeDays}`);
    console.log(
      `    Top tools:      ${topTools
        .slice(0, 5)
        .map((t) => `${t.name}(${t.count})`)
        .join(', ')}`,
    );
    console.log('');

    console.log('    Models:');
    for (const [model, info] of Object.entries(claudeModels).sort(
      (a, b) => b[1].cost - a[1].cost,
    )) {
      console.log(
        `      ${model.padEnd(30)} ${formatCost(info.cost).padStart(10)}  (${info.sessions} sessions)`,
      );
    }
    console.log('');
  }

  if (codex.sessions.length > 0) {
    console.log('  Codex');
    console.log(`    Sessions:       ${codex.sessions.length}`);
    console.log(
      `    Cost:           ${formatCost(codex.totalCost)}`,
    );
    console.log(
      `    Input tokens:   ${formatTokens(codex.totalInputTokens)}`,
    );
    console.log(
      `    Cached input:   ${formatTokens(codex.totalCachedInputTokens)}`,
    );
    console.log(
      `    Output tokens:  ${formatTokens(codex.totalOutputTokens)}`,
    );
    console.log('');

    console.log('    Models:');
    for (const [model, info] of Object.entries(codexModels).sort(
      (a, b) => b[1].cost - a[1].cost,
    )) {
      console.log(
        `      ${model.padEnd(30)} ${formatCost(info.cost).padStart(10)}  (${info.sessions} sessions)`,
      );
    }
    console.log('');
  }

  if (cursor.sessions.length > 0) {
    console.log('  Cursor');
    console.log(`    Sessions:       ${cursor.sessions.length}`);
    console.log(`    Messages:       ${cursor.totalMessages}`);
    console.log(`    Lines changed:  +${cursor.totalLinesAdded} / -${cursor.totalLinesRemoved}`);
    if (cursor.totalTabSuggestedLines > 0) {
      const tabRate = Math.round(
        (cursor.totalTabAcceptedLines / cursor.totalTabSuggestedLines) * 100,
      );
      console.log(
        `    Tab completions: ${cursor.totalTabAcceptedLines}/${cursor.totalTabSuggestedLines} (${tabRate}%)`,
      );
    }
    console.log('');

    console.log('    Models:');
    for (const [model, info] of Object.entries(cursorModels).sort(
      (a, b) => b[1].sessions - a[1].sessions,
    )) {
      console.log(
        `      ${model.padEnd(30)} ${String(info.sessions).padStart(6)} sessions`,
      );
    }
    console.log('');
  }

  console.log(
    '  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
  );
  console.log(
    `  Combined:   ${formatCost(combined.totalCost)}  (${combined.totalSessions} sessions)`,
  );
  console.log('');
}

async function cmdClaude(): Promise<void> {
  const claude = await getFilteredClaude();

  if (jsonMode) {
    console.log(JSON.stringify(claude, null, 2));
    return;
  }

  console.log('');
  console.log('  Claude Code');
  console.log(
    '  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
  );
  console.log(`  Sessions:          ${claude.sessions.length}`);
  console.log(
    `  Total cost:        ${formatCost(claude.totalCost)}`,
  );
  console.log(
    `  Input tokens:      ${formatTokens(claude.totalInputTokens)}`,
  );
  console.log(
    `  Output tokens:     ${formatTokens(claude.totalOutputTokens)}`,
  );
  console.log(
    `  Cache read:        ${formatTokens(claude.totalCacheReadTokens)}`,
  );
  console.log(
    `  Cache create:      ${formatTokens(claude.totalCacheCreateTokens)}`,
  );
  console.log(
    `  Cache savings:     ${formatCost(claude.cacheSavingsUsd)}`,
  );
  console.log('');

  // Model breakdown
  const models: Record<
    string,
    { sessions: number; cost: number }
  > = {};
  for (const s of claude.sessions) {
    const e = models[s.model] || { sessions: 0, cost: 0 };
    e.sessions++;
    e.cost += s.costUsd;
    models[s.model] = e;
  }

  console.log('  Models:');
  for (const [m, info] of Object.entries(models).sort(
    (a, b) => b[1].cost - a[1].cost,
  )) {
    console.log(
      `    ${m.padEnd(32)} ${formatCost(info.cost).padStart(10)}  (${info.sessions} sessions)`,
    );
  }

  // Top tools
  const tools = Object.entries(claude.toolBreakdown).sort(
    (a, b) => b[1] - a[1],
  );
  if (tools.length > 0) {
    console.log('');
    console.log('  Tools:');
    for (const [name, count] of tools.slice(0, 15)) {
      const bar = '\u2588'.repeat(
        Math.min(
          Math.round((count / tools[0][1]) * 30),
          30,
        ),
      );
      console.log(
        `    ${name.padEnd(20)} ${String(count).padStart(6)}  ${bar}`,
      );
    }
  }

  // Projects
  const projects: Record<
    string,
    { sessions: number; cost: number }
  > = {};
  for (const s of claude.sessions) {
    const e = projects[s.project] || { sessions: 0, cost: 0 };
    e.sessions++;
    e.cost += s.costUsd;
    projects[s.project] = e;
  }

  console.log('');
  console.log('  Top projects:');
  for (const [p, info] of Object.entries(projects)
    .sort((a, b) => b[1].cost - a[1].cost)
    .slice(0, 10)) {
    const name = p.length > 35 ? '...' + p.slice(-32) : p;
    console.log(
      `    ${name.padEnd(36)} ${formatCost(info.cost).padStart(10)}  (${info.sessions} sessions)`,
    );
  }
  console.log('');
}

async function cmdCodex(): Promise<void> {
  const codex = await getFilteredCodex();

  if (jsonMode) {
    console.log(JSON.stringify(codex, null, 2));
    return;
  }

  console.log('');
  console.log('  Codex');
  console.log(
    '  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
  );
  console.log(`  Sessions:          ${codex.sessions.length}`);
  console.log(
    `  Total cost:        ${formatCost(codex.totalCost)}`,
  );
  console.log(
    `  Input tokens:      ${formatTokens(codex.totalInputTokens)}`,
  );
  console.log(
    `  Cached input:      ${formatTokens(codex.totalCachedInputTokens)}`,
  );
  console.log(
    `  Output tokens:     ${formatTokens(codex.totalOutputTokens)}`,
  );
  console.log('');

  const models: Record<
    string,
    { sessions: number; cost: number }
  > = {};
  for (const s of codex.sessions) {
    const e = models[s.model] || { sessions: 0, cost: 0 };
    e.sessions++;
    e.cost += s.costUsd;
    models[s.model] = e;
  }

  console.log('  Models:');
  for (const [m, info] of Object.entries(models).sort(
    (a, b) => b[1].cost - a[1].cost,
  )) {
    console.log(
      `    ${m.padEnd(32)} ${formatCost(info.cost).padStart(10)}  (${info.sessions} sessions)`,
    );
  }

  // Projects
  const projects: Record<
    string,
    { sessions: number; cost: number }
  > = {};
  for (const s of codex.sessions) {
    const e = projects[s.project] || { sessions: 0, cost: 0 };
    e.sessions++;
    e.cost += s.costUsd;
    projects[s.project] = e;
  }

  if (Object.keys(projects).length > 0) {
    console.log('');
    console.log('  Top projects:');
    for (const [p, info] of Object.entries(projects)
      .sort((a, b) => b[1].cost - a[1].cost)
      .slice(0, 10)) {
      console.log(
        `    ${p.padEnd(36)} ${formatCost(info.cost).padStart(10)}  (${info.sessions} sessions)`,
      );
    }
  }
  console.log('');
}

async function cmdCursor(): Promise<void> {
  const cursor = await getFilteredCursor();

  if (jsonMode) {
    console.log(JSON.stringify(cursor, null, 2));
    return;
  }

  console.log('');
  console.log('  Cursor');
  console.log(
    '  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
  );
  console.log(`  Sessions:          ${cursor.sessions.length}`);
  console.log(`  Messages:          ${cursor.totalMessages}`);
  console.log(`  Tool calls:        ${cursor.totalToolCalls}`);
  console.log(`  Lines changed:     +${cursor.totalLinesAdded} / -${cursor.totalLinesRemoved}`);
  console.log(`  Files created:     ${cursor.totalFilesCreated}`);
  if (cursor.thinkingTimeMs > 0 || cursor.turnTimeMs > 0) {
    console.log(
      `  Thinking time:     ${formatDuration(cursor.thinkingTimeMs)}`,
    );
    console.log(
      `  Response time:     ${formatDuration(cursor.turnTimeMs)}`,
    );
  }
  console.log('');

  // Mode breakdown
  const modes: Record<string, number> = {};
  for (const s of cursor.sessions) {
    modes[s.mode] = (modes[s.mode] || 0) + 1;
  }
  if (Object.keys(modes).length > 0) {
    console.log('  Modes:');
    for (const [mode, count] of Object.entries(modes).sort(
      (a, b) => b[1] - a[1],
    )) {
      console.log(`    ${mode.padEnd(20)} ${count} sessions`);
    }
    console.log('');
  }

  // Model breakdown
  const models: Record<string, number> = {};
  for (const s of cursor.sessions) {
    models[s.model] = (models[s.model] || 0) + 1;
  }

  console.log('  Models:');
  for (const [m, count] of Object.entries(models).sort(
    (a, b) => b[1] - a[1],
  )) {
    console.log(
      `    ${m.padEnd(32)} ${String(count).padStart(6)} sessions`,
    );
  }
  console.log('');

  // Tool breakdown
  const tools = Object.entries(cursor.toolBreakdown).sort(
    (a, b) => b[1] - a[1],
  );
  if (tools.length > 0) {
    const max = tools[0][1];
    console.log('  Tools:');
    for (const [name, count] of tools) {
      const bar = '\u2588'.repeat(
        Math.min(Math.round((count / max) * 30), 30),
      );
      console.log(
        `    ${name.padEnd(28)} ${String(count).padStart(6)}  ${bar}`,
      );
    }
    console.log('');
  }

  // Projects
  const projects: Record<string, number> = {};
  for (const s of cursor.sessions) {
    if (s.project) projects[s.project] = (projects[s.project] || 0) + 1;
  }
  if (Object.keys(projects).length > 0) {
    console.log('  Projects:');
    for (const [p, count] of Object.entries(projects)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)) {
      console.log(`    ${p.padEnd(32)} ${String(count).padStart(6)} sessions`);
    }
    console.log('');
  }

  // Daily code tracking
  if (cursor.dailyStats.length > 0) {
    const tabAcceptRate =
      cursor.totalTabSuggestedLines > 0
        ? Math.round(
            (cursor.totalTabAcceptedLines / cursor.totalTabSuggestedLines) * 100,
          )
        : 0;
    console.log('  Code Tracking:');
    console.log(
      `    Tab completions:    ${cursor.totalTabAcceptedLines} accepted / ${cursor.totalTabSuggestedLines} suggested (${tabAcceptRate}%)`,
    );
    console.log(
      `    Composer edits:     ${cursor.totalComposerAcceptedLines} accepted / ${cursor.totalComposerSuggestedLines} suggested`,
    );
    console.log(`    Tracking days:      ${cursor.dailyStats.length}`);
    console.log('');
  }

  // Daily activity breakdown
  if (cursor.dailyActivity.length > 0) {
    const maxMsgs = Math.max(
      ...cursor.dailyActivity.map((d) => d.messages),
      1,
    );

    console.log('  Daily Activity:');
    console.log(
      `    ${'Date'.padEnd(12)} ${'Msgs'.padStart(8)} ${'Tools'.padStart(8)}  Chart`,
    );
    console.log(
      `    ${'\u2500'.repeat(12)} ${'\u2500'.repeat(8)} ${'\u2500'.repeat(8)}  ${'\u2500'.repeat(20)}`,
    );
    for (const d of cursor.dailyActivity) {
      const bar = '\u2588'.repeat(
        Math.min(Math.round((d.messages / maxMsgs) * 20), 20),
      );
      console.log(
        `    ${d.date.padEnd(12)} ${String(d.messages).padStart(8)} ${String(d.toolCalls).padStart(8)}  ${bar}`,
      );
    }
    console.log('');
  }
}

async function cmdSessions(): Promise<void> {
  const [claude, codex, cursor] = await Promise.all([
    getFilteredClaude(),
    getFilteredCodex(),
    getFilteredCursor(),
  ]);

  interface SessionRow {
    source: string;
    name: string;
    model: string;
    cost: number;
    tokens: number;
    date: string;
    duration: number;
  }

  const rows: SessionRow[] = [];
  for (const s of claude.sessions) {
    rows.push({
      source: 'claude',
      name: s.sessionName,
      model: s.model,
      cost: s.costUsd,
      tokens: s.inputTokens + s.outputTokens,
      date: s.firstTimestamp,
      duration: 0,
    });
  }
  for (const s of codex.sessions) {
    rows.push({
      source: 'codex',
      name: s.sessionName,
      model: s.model,
      cost: s.costUsd,
      tokens: s.inputTokens + s.outputTokens,
      date: s.createdAt,
      duration: s.durationMs,
    });
  }
  for (const s of cursor.sessions) {
    rows.push({
      source: 'cursor',
      name: s.sessionName,
      model: s.model,
      cost: s.costUsd,
      tokens: s.inputTokens + s.outputTokens,
      date: s.createdAt,
      duration: 0,
    });
  }
  rows.sort(
    (a, b) =>
      new Date(b.date).getTime() - new Date(a.date).getTime(),
  );

  if (jsonMode) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  console.log('');
  console.log(
    `  ${'Source'.padEnd(8)} ${'Date'.padEnd(12)} ${'Model'.padEnd(24)} ${'Cost'.padStart(10)} ${'Tokens'.padStart(10)}  Name`,
  );
  console.log(
    `  ${'\u2500'.repeat(8)} ${'\u2500'.repeat(12)} ${'\u2500'.repeat(24)} ${'\u2500'.repeat(10)} ${'\u2500'.repeat(10)}  ${'\u2500'.repeat(30)}`,
  );

  for (const r of rows.slice(0, 50)) {
    const date = r.date ? r.date.slice(0, 10) : 'unknown';
    const model =
      r.model.length > 23
        ? r.model.slice(0, 22) + '\u2026'
        : r.model;
    const name =
      r.name.length > 40
        ? r.name.slice(0, 39) + '\u2026'
        : r.name;
    console.log(
      `  ${r.source.padEnd(8)} ${date.padEnd(12)} ${model.padEnd(24)} ${formatCost(r.cost).padStart(10)} ${formatTokens(r.tokens).padStart(10)}  ${name}`,
    );
  }

  if (rows.length > 50) {
    console.log(`  ... and ${rows.length - 50} more sessions`);
  }

  console.log(
    `\n  Total: ${rows.length} sessions, ${formatCost(rows.reduce((s, r) => s + r.cost, 0))}`,
  );
  console.log('');
}

async function cmdModels(): Promise<void> {
  const [cc, cx, cu] = await Promise.all([
    getFilteredClaude(),
    getFilteredCodex(),
    getFilteredCursor(),
  ]);
  const data = buildSummary(cc, cx, cu);

  const all: Record<
    string,
    { source: string; sessions: number; cost: number }
  > = {};
  for (const [m, info] of Object.entries(data.claude.models)) {
    all[m] = { source: 'claude', ...info };
  }
  for (const [m, info] of Object.entries(data.codex.models)) {
    all[m] = { source: 'codex', ...info };
  }
  for (const [m, info] of Object.entries(data.cursor.models)) {
    const e = all[m] || { source: 'cursor', sessions: 0, cost: 0 };
    e.sessions += info.sessions;
    e.cost += info.cost;
    if (e.source !== 'cursor') e.source += '+cursor';
    all[m] = e;
  }

  if (jsonMode) {
    console.log(JSON.stringify(all, null, 2));
    return;
  }

  console.log('');
  console.log(
    `  ${'Model'.padEnd(32)} ${'Source'.padEnd(8)} ${'Cost'.padStart(10)} ${'Sessions'.padStart(10)}`,
  );
  console.log(
    `  ${'\u2500'.repeat(32)} ${'\u2500'.repeat(8)} ${'\u2500'.repeat(10)} ${'\u2500'.repeat(10)}`,
  );

  for (const [m, info] of Object.entries(all).sort(
    (a, b) => b[1].cost - a[1].cost,
  )) {
    console.log(
      `  ${m.padEnd(32)} ${info.source.padEnd(8)} ${formatCost(info.cost).padStart(10)} ${String(info.sessions).padStart(10)}`,
    );
  }

  console.log(
    `\n  Total: ${formatCost(data.combined.totalCost)}`,
  );
  console.log('');
}

async function cmdTools(): Promise<void> {
  const claude = await getFilteredClaude();

  if (jsonMode) {
    console.log(JSON.stringify(claude.toolBreakdown, null, 2));
    return;
  }

  const tools = Object.entries(claude.toolBreakdown).sort(
    (a, b) => b[1] - a[1],
  );
  const max = tools[0]?.[1] || 1;

  console.log('');
  console.log('  Tool Usage (Claude Code)');
  console.log(
    '  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
  );

  for (const [name, count] of tools) {
    const bar = '\u2588'.repeat(
      Math.min(Math.round((count / max) * 40), 40),
    );
    console.log(
      `  ${name.padEnd(22)} ${String(count).padStart(6)}  ${bar}`,
    );
  }

  console.log(
    `\n  Total: ${tools.reduce((s, t) => s + t[1], 0)} tool calls`,
  );
  console.log('');
}

async function cmdTokens(): Promise<void> {
  const [cc, cx, cu] = await Promise.all([
    getFilteredClaude(),
    getFilteredCodex(),
    getFilteredCursor(),
  ]);
  const data = buildSummary(cc, cx, cu);

  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          claude: {
            input: data.claude.inputTokens,
            output: data.claude.outputTokens,
            cacheRead: data.claude.cacheReadTokens,
            cacheCreate: data.claude.cacheCreateTokens,
          },
          codex: {
            input: data.codex.inputTokens,
            cached: data.codex.cachedInputTokens,
            output: data.codex.outputTokens,
          },
          cursor: {
            input: data.cursor.inputTokens,
            output: data.cursor.outputTokens,
          },
          combined: {
            input: data.combined.totalInputTokens,
            output: data.combined.totalOutputTokens,
          },
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log('');
  console.log('  Token Breakdown');
  console.log(
    '  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
  );
  console.log('');
  console.log('  Claude Code:');
  console.log(
    `    Input:           ${formatTokens(data.claude.inputTokens)}`,
  );
  console.log(
    `    Output:          ${formatTokens(data.claude.outputTokens)}`,
  );
  console.log(
    `    Cache read:      ${formatTokens(data.claude.cacheReadTokens)}`,
  );
  console.log(
    `    Cache create:    ${formatTokens(data.claude.cacheCreateTokens)}`,
  );
  console.log('');
  console.log('  Codex:');
  console.log(
    `    Input (total):   ${formatTokens(data.codex.inputTokens)}`,
  );
  console.log(
    `    Cached input:    ${formatTokens(data.codex.cachedInputTokens)}`,
  );
  console.log(
    `    Output:          ${formatTokens(data.codex.outputTokens)}`,
  );
  console.log('');
  console.log('  Cursor:');
  console.log(
    `    Input:           ${formatTokens(data.cursor.inputTokens)}`,
  );
  console.log(
    `    Output:          ${formatTokens(data.cursor.outputTokens)}`,
  );
  console.log('');
  console.log('  Combined:');
  console.log(
    `    Input:           ${formatTokens(data.combined.totalInputTokens)}`,
  );
  console.log(
    `    Output:          ${formatTokens(data.combined.totalOutputTokens)}`,
  );
  console.log('');
}

async function cmdCost(): Promise<void> {
  const [cc, cx, cu] = await Promise.all([
    getFilteredClaude(),
    getFilteredCodex(),
    getFilteredCursor(),
  ]);
  const data = buildSummary(cc, cx, cu);

  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          claude: data.claude.cost,
          codex: data.codex.cost,
          cursor: data.cursor.cost,
          combined: data.combined.totalCost,
          cacheSavings: data.claude.cacheSavingsUsd,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log('');
  console.log('  Cost Summary');
  console.log(
    '  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
  );
  console.log(
    `  Claude Code:       ${formatCost(data.claude.cost)}`,
  );
  console.log(
    `  Codex:             ${formatCost(data.codex.cost)}`,
  );
  console.log(
    `  Cursor:            ${formatCost(data.cursor.cost)}`,
  );
  console.log(
    '  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
  );
  console.log(
    `  Total:             ${formatCost(data.combined.totalCost)}`,
  );
  console.log('');
  console.log(
    `  Cache savings:     ${formatCost(data.claude.cacheSavingsUsd)}`,
  );
  console.log(
    `  (without caching you would have spent ${formatCost(data.combined.totalCost + data.claude.cacheSavingsUsd)})`,
  );
  console.log('');
}

async function cmdDaily(): Promise<void> {
  const [claude, codex, cursor] = await Promise.all([
    getFilteredClaude(),
    getFilteredCodex(),
    getFilteredCursor(),
  ]);

  const days = new Map<
    string,
    { claude: number; codex: number; cursor: number; sessions: number }
  >();

  for (const s of claude.sessions) {
    const d = s.firstTimestamp.slice(0, 10);
    if (!d || d === 'unknown') continue;
    const entry = days.get(d) || {
      claude: 0,
      codex: 0,
      cursor: 0,
      sessions: 0,
    };
    entry.claude += s.costUsd;
    entry.sessions++;
    days.set(d, entry);
  }

  for (const s of codex.sessions) {
    const d = s.createdAt.slice(0, 10);
    if (!d || d === 'unknown') continue;
    const entry = days.get(d) || {
      claude: 0,
      codex: 0,
      cursor: 0,
      sessions: 0,
    };
    entry.codex += s.costUsd;
    entry.sessions++;
    days.set(d, entry);
  }

  for (const s of cursor.sessions) {
    const d = (s.createdAt || '').slice(0, 10);
    if (!d || d === 'unknown') continue;
    const entry = days.get(d) || {
      claude: 0,
      codex: 0,
      cursor: 0,
      sessions: 0,
    };
    entry.cursor += s.costUsd;
    entry.sessions++;
    days.set(d, entry);
  }

  const sorted = [...days.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  );

  if (jsonMode) {
    console.log(
      JSON.stringify(
        sorted.map(([date, v]) => ({
          date,
          ...v,
          total: v.claude + v.codex + v.cursor,
        })),
        null,
        2,
      ),
    );
    return;
  }

  console.log('');
  console.log(
    `  ${'Date'.padEnd(12)} ${'Claude'.padStart(10)} ${'Codex'.padStart(10)} ${'Cursor'.padStart(10)} ${'Total'.padStart(10)} ${'Sessions'.padStart(10)}  Chart`,
  );
  console.log(
    `  ${'\u2500'.repeat(12)} ${'\u2500'.repeat(10)} ${'\u2500'.repeat(10)} ${'\u2500'.repeat(10)} ${'\u2500'.repeat(10)} ${'\u2500'.repeat(10)}  ${'\u2500'.repeat(20)}`,
  );

  const maxCost = Math.max(
    ...sorted.map(([, v]) => v.claude + v.codex + v.cursor),
    1,
  );

  for (const [date, v] of sorted) {
    const total = v.claude + v.codex + v.cursor;
    const bar = '\u2588'.repeat(
      Math.min(Math.round((total / maxCost) * 20), 20),
    );
    console.log(
      `  ${date.padEnd(12)} ${formatCost(v.claude).padStart(10)} ${formatCost(v.codex).padStart(10)} ${formatCost(v.cursor).padStart(10)} ${formatCost(total).padStart(10)} ${String(v.sessions).padStart(10)}  ${bar}`,
    );
  }

  const grandTotal = sorted.reduce(
    (s, [, v]) => s + v.claude + v.codex + v.cursor,
    0,
  );
  console.log(
    `\n  Total: ${formatCost(grandTotal)} across ${sorted.length} days`,
  );
  console.log('');
}

async function cmdHours(): Promise<void> {
  const [cc, cx, cu] = await Promise.all([
    getFilteredClaude(),
    getFilteredCodex(),
    getFilteredCursor(),
  ]);
  const data = buildSummary(cc, cx, cu);
  const dist = data.claude.hourDistribution;

  if (jsonMode) {
    console.log(JSON.stringify(dist));
    return;
  }

  const max = Math.max(...dist, 1);

  console.log('');
  console.log('  Activity by Hour (Claude Code)');
  console.log(
    '  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
  );

  for (let h = 0; h < 24; h++) {
    const label =
      h === 0
        ? '12 AM'
        : h < 12
          ? `${h} AM`
          : h === 12
            ? '12 PM'
            : `${h - 12} PM`;
    const bar = '\u2588'.repeat(
      Math.min(Math.round((dist[h] / max) * 40), 40),
    );
    console.log(
      `  ${label.padStart(6)}  ${String(dist[h]).padStart(5)}  ${bar}`,
    );
  }
  console.log('');
}

async function cmdPharos(): Promise<void> {
  const token = getFlag('token');
  const apiUrl =
    getFlag('api-url') ||
    'https://pharos-ade.com/api';

  if (!token) {
    console.log('');
    console.log(
      '  \x1B[31m\u2717\x1B[0m  Missing --token flag.',
    );
    console.log(
      '     Generate a token at \x1B[36mhttps://pharos-ade.com\x1B[0m',
    );
    console.log('');
    process.exit(1);
  }

  // Gather stats (use readAll for full data including highlights)
  const summary = await readAll();

  // Submit to Pharos backend
  const url = `${apiUrl}/card/submit`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(summary),
    });

    if (res.ok) {
      const data = (await res.json()) as { cardUrl: string };
      console.log('');
      console.log(
        '  \x1B[32m\u2714\x1B[0m  Card generated!',
      );
      console.log(`     \x1B[36m${data.cardUrl}\x1B[0m`);
      console.log('');

      // Open in default browser
      const { exec } = await import('child_process');
      const openCmd =
        process.platform === 'darwin'
          ? 'open'
          : process.platform === 'win32'
            ? 'start'
            : 'xdg-open';
      exec(`${openCmd} ${data.cardUrl}`);
    } else if (res.status === 401) {
      console.log('');
      console.log(
        '  \x1B[31m\u2717\x1B[0m  Invalid or expired token.',
      );
      console.log(
        '     Generate a new one at \x1B[36mhttps://pharos-ade.com\x1B[0m',
      );
      console.log('');
      process.exit(1);
    } else {
      const body = await res.text();
      console.log('');
      console.log(
        `  \x1B[31m\u2717\x1B[0m  Error: ${res.status} ${body}`,
      );
      console.log('');
      process.exit(1);
    }
  } catch (err: unknown) {
    console.log('');
    console.log(
      `  \x1B[31m\u2717\x1B[0m  Error: ${err instanceof Error ? err.message : err}`,
    );
    console.log('');
    process.exit(1);
  }
}

async function run(): Promise<void> {
  switch (command) {
    case 'summary':
      return cmdSummary();
    case 'claude':
    case 'cc':
      return cmdClaude();
    case 'codex':
    case 'cx':
      return cmdCodex();
    case 'cursor':
    case 'cu':
      return cmdCursor();
    case 'sessions':
      return cmdSessions();
    case 'models':
      return cmdModels();
    case 'tools':
      return cmdTools();
    case 'tokens':
      return cmdTokens();
    case 'cost':
      return cmdCost();
    case 'daily':
      return cmdDaily();
    case 'hours':
      return cmdHours();
    case 'pharos':
      return cmdPharos();
    case 'help':
    case '--help':
    case '-h':
      return printHelp();
    default:
      console.error(`  Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

checkClaudeRetention()
  .then(() => {
    if (command !== 'help') spinner.start();
    return run();
  })
  .then(() => spinner.stop())
  .catch((err: Error) => {
    spinner.stop();
    console.error('Error:', err.message);
    process.exit(1);
  });
