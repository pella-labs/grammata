/**
 * grammata
 *
 * Read and aggregate coding agent usage data from local directories.
 *
 * Supports:
 * - Claude Code (~/.claude/projects/) — JSONL session files
 * - Codex (~/.codex/sessions/) — JSONL rollout files + SQLite metadata
 * - Cursor (state.vscdb) — SQLite composer + bubble + tab stats
 * - Goose (~/.local/share/goose/sessions/sessions.db) — any-provider sessions
 *
 * Usage:
 *   import { readClaude, readCodex, readCursor, readGoose, readAll } from 'grammata';
 *
 *   const claude = await readClaude();
 *   const codex  = await readCodex();
 *   const goose  = await readGoose();
 *   const all    = await readAll();
 *
 * For cross-source per-session analysis, use `mergeAll` from the
 * `grammata/merge` entry point to get a deduplicated UnifiedSession[] with
 * normalized tool names and source/provider breakdowns.
 */

export { readClaude } from './claude.js';
export type { ClaudeSession, ClaudeSummary } from './claude.js';
export { readCodex } from './codex.js';
export type { CodexSession, CodexSummary } from './codex.js';
export { readCursor } from './cursor.js';
export type { CursorSession, CursorSummary } from './cursor.js';
export { readGoose } from './goose.js';
export type { GooseSession, GooseSummary } from './goose.js';
export { mergeAll, mapCodexTools, mapCursorTools } from './merge.js';
export type { UnifiedSession, MergedUsage, SourceType, SourceStats } from './merge.js';
export {
  classifySession,
  computeCostTrend,
  computeBranchCosts,
  computeCacheStats,
  computeCostVelocity,
  computeRetryStats,
  buildAnalytics,
} from './analytics.js';
export type {
  ActivityCategory,
  CostTrend,
  BranchCost,
  CacheStats,
  CostVelocityPoint,
  RetryStats,
  DailyCost,
  ModelBreakdown,
  ProjectBreakdown,
  CategoryBreakdown,
  ToolUsage,
  AnalyticsData,
} from './analytics.js';
export {
  CLAUDE_PRICING,
  CODEX_PRICING,
  CURSOR_PRICING,
  getClaudePricing,
  getCodexPricing,
  getCursorPricing,
} from './pricing.js';
export type { ModelPricing, CodexModelPricing, CursorModelPricing } from './pricing.js';
export { formatTokens, formatCost, formatDuration } from './format.js';

import { buildAnalytics, classifySession, type ActivityCategory, type AnalyticsData } from './analytics.js';
import { mergeAll } from './merge.js';

/**
 * One-call pipeline: read every supported source, merge into a unified
 * session array, and compute the full analytics object in one go.
 *
 *   import { analyze } from 'grammata';
 *   const data = await analyze();
 *   console.log(data.totalCost, data.retryStats.firstTryRate);
 */
export async function analyze(): Promise<AnalyticsData> {
  const [claude, codex, cursor, goose] = await Promise.all([
    (await import('./claude.js')).readClaude(),
    (await import('./codex.js')).readCodex(),
    (await import('./cursor.js')).readCursor(),
    (await import('./goose.js')).readGoose(),
  ]);
  return buildAnalytics(mergeAll(claude, codex, cursor, goose));
}

const CATEGORY_DESCRIPTIONS: Record<ActivityCategory, string> = {
  Building: 'High Edit + Write activity — creating new code',
  Investigating: 'High Read + Grep, few edits — exploring code',
  Debugging: 'Edits + Bash runs — fixing issues',
  Testing: 'Heavy Bash usage — running test suites',
  Refactoring: 'Balanced Read + Edit — restructuring code',
  Other: 'Mixed activity patterns',
};

export interface UsageSummary {
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
    totalToolCalls: number;
    hourDistribution: number[];
    activeDays: number;
    projects: Array<{ name: string; sessions: number; cost: number }>;
  };
  codex: {
    sessions: number;
    cost: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    models: Record<string, { sessions: number; cost: number }>;
    activeDays: number;
    projects: Array<{ name: string; sessions: number; cost: number }>;
    topTools: Array<{ name: string; count: number }>;
    totalToolCalls: number;
    totalReasoningBlocks: number;
    totalWebSearches: number;
  };
  cursor: {
    sessions: number;
    cost: number;
    inputTokens: number;
    outputTokens: number;
    models: Record<string, { sessions: number; cost: number }>;
    topTools: Array<{ name: string; count: number }>;
    totalToolCalls: number;
    activeDays: number;
    projects: Array<{ name: string; sessions: number }>;
    totalMessages: number;
    totalLinesAdded: number;
    totalLinesRemoved: number;
    totalFilesCreated: number;
    thinkingTimeMs: number;
    turnTimeMs: number;
    dailyActivity: Array<{ date: string; messages: number; toolCalls: number }>;
    totalTabSuggestedLines: number;
    totalTabAcceptedLines: number;
    totalComposerSuggestedLines: number;
    totalComposerAcceptedLines: number;
  };
  goose: {
    sessions: number;
    cost: number;
    inputTokens: number;
    outputTokens: number;
    models: Record<string, { sessions: number; cost: number }>;
    providers: Record<string, { sessions: number; cost: number }>;
    activeDays: number;
    projects: Array<{ name: string; sessions: number; cost: number }>;
  };
  combined: {
    totalCost: number;
    totalSessions: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalActiveDays: number;
    dailyDistribution: Array<{
      date: string;
      sessions: number;
      cost: number;
      claudeSessions: number;
      codexSessions: number;
      cursorSessions: number;
      gooseSessions: number;
    }>;
  };
  highlights: {
    favoriteModel: string;
    favoriteTool: string;
    peakHour: number;
    peakHourLabel: string;
    personality: string;
    totalToolCalls: number;
    cacheHitRate: number;
    longestStreak: number;
    mostExpensiveSession: {
      cost: number;
      model: string;
      project: string;
      date: string;
    } | null;
    avgCostPerSession: number;
    avgSessionsPerDay: number;
    mcpServers: Array<{
      name: string;
      totalCalls: number;
      tools: Array<{ name: string; count: number }>;
    }>;
    totalMcpCalls: number;
    skillInvocations: number;
    builtinTools: Array<{ name: string; count: number }>;
    readWriteRatio: {
      reads: number;
      writes: number;
      ratio: string;
    };
    costWithoutCache: number;
    activityCategories: Array<{
      category: string;
      description: string;
      sessions: number;
      cost: number;
      sessionPct: number;
      costPct: number;
    }>;
  };
}

export async function readAll(): Promise<UsageSummary> {
  const [claude, codex, cursor, goose] = await Promise.all([
    (await import('./claude.js')).readClaude(),
    (await import('./codex.js')).readCodex(),
    (await import('./cursor.js')).readCursor(),
    (await import('./goose.js')).readGoose(),
  ]);

  // Claude model breakdown
  const claudeModels: Record<string, { sessions: number; cost: number }> =
    {};
  for (const s of claude.sessions) {
    const entry = claudeModels[s.model] || { sessions: 0, cost: 0 };
    entry.sessions++;
    entry.cost += s.costUsd;
    claudeModels[s.model] = entry;
  }

  // Claude active days
  const claudeDays = new Set(
    claude.sessions.map((s) => s.firstTimestamp.slice(0, 10)),
  );

  // Claude top tools (used for Claude-specific display)
  const topTools = Object.entries(claude.toolBreakdown)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  // All tools merged across all providers
  const allToolBreakdown: Record<string, number> = { ...claude.toolBreakdown };
  for (const [tool, count] of Object.entries(codex.toolBreakdown)) {
    allToolBreakdown[tool] = (allToolBreakdown[tool] || 0) + count;
  }
  for (const [tool, count] of Object.entries(cursor.toolBreakdown)) {
    allToolBreakdown[tool] = (allToolBreakdown[tool] || 0) + count;
  }

  // Codex model breakdown
  const codexModels: Record<string, { sessions: number; cost: number }> =
    {};
  for (const s of codex.sessions) {
    const entry = codexModels[s.model] || { sessions: 0, cost: 0 };
    entry.sessions++;
    entry.cost += s.costUsd;
    codexModels[s.model] = entry;
  }

  // Codex active days
  const codexDays = new Set(
    codex.sessions.map((s) => s.createdAt.slice(0, 10)),
  );

  // Cursor active days
  const cursorDays = new Set(
    cursor.sessions
      .filter((s) => s.createdAt)
      .map((s) => s.createdAt.slice(0, 10)),
  );

  // Goose — skip sessions already covered by Claude JSONL / Codex readers
  const gooseSessions = goose.sessions.filter(
    (s) => s.providerName !== 'claude-code' && s.providerName !== 'claude-acp',
  );
  const gooseModels: Record<string, { sessions: number; cost: number }> = {};
  const gooseProviders: Record<string, { sessions: number; cost: number }> = {};
  const gooseProjects = new Map<string, { sessions: number; cost: number }>();
  const gooseDays = new Set<string>();
  for (const s of gooseSessions) {
    const m = gooseModels[s.model] || { sessions: 0, cost: 0 };
    m.sessions++;
    m.cost += s.costUsd;
    gooseModels[s.model] = m;

    const p = gooseProviders[s.providerName] || { sessions: 0, cost: 0 };
    p.sessions++;
    p.cost += s.costUsd;
    gooseProviders[s.providerName] = p;

    const pe = gooseProjects.get(s.project) || { sessions: 0, cost: 0 };
    pe.sessions++;
    pe.cost += s.costUsd;
    gooseProjects.set(s.project, pe);

    if (s.createdAt) gooseDays.add(s.createdAt.slice(0, 10));
  }
  const gooseTotalCost = gooseSessions.reduce((s, x) => s + x.costUsd, 0);
  const gooseTotalInput = gooseSessions.reduce((s, x) => s + x.inputTokens, 0);
  const gooseTotalOutput = gooseSessions.reduce((s, x) => s + x.outputTokens, 0);

  // Claude projects
  const claudeProjects = new Map<
    string,
    { sessions: number; cost: number }
  >();
  for (const s of claude.sessions) {
    const e = claudeProjects.get(s.project) || {
      sessions: 0,
      cost: 0,
    };
    e.sessions++;
    e.cost += s.costUsd;
    claudeProjects.set(s.project, e);
  }

  // Codex projects
  const codexProjects = new Map<
    string,
    { sessions: number; cost: number }
  >();
  for (const s of codex.sessions) {
    const e = codexProjects.get(s.project) || {
      sessions: 0,
      cost: 0,
    };
    e.sessions++;
    e.cost += s.costUsd;
    codexProjects.set(s.project, e);
  }

  // Total tool calls (all providers — Goose DB doesn't expose tool breakdown)
  const claudeToolCalls = Object.values(claude.toolBreakdown).reduce(
    (s, c) => s + c,
    0,
  );
  const codexToolCalls = Object.values(codex.toolBreakdown).reduce(
    (s, c) => s + c,
    0,
  );
  const totalToolCalls = claudeToolCalls + codexToolCalls + cursor.totalToolCalls;

  // All active days combined (for streak calc)
  const allDays = new Set([...claudeDays, ...codexDays, ...cursorDays, ...gooseDays]);
  const totalActiveDays = allDays.size;

  // Longest streak
  const sortedDays = [...allDays].sort();
  let longestStreak = 0;
  let currentStreak = 1;
  for (let i = 1; i < sortedDays.length; i++) {
    const prev = new Date(sortedDays[i - 1]);
    const curr = new Date(sortedDays[i]);
    const diffMs = curr.getTime() - prev.getTime();
    if (diffMs <= 86400000) {
      // 1 day
      currentStreak++;
    } else {
      longestStreak = Math.max(longestStreak, currentStreak);
      currentStreak = 1;
    }
  }
  longestStreak = Math.max(longestStreak, currentStreak);
  if (sortedDays.length === 0) longestStreak = 0;

  // Peak hour
  const peakHour = claude.hourDistribution.indexOf(
    Math.max(...claude.hourDistribution),
  );
  const peakHourLabel =
    peakHour === 0
      ? '12 AM'
      : peakHour < 12
        ? `${peakHour} AM`
        : peakHour === 12
          ? '12 PM'
          : `${peakHour - 12} PM`;

  // Personality
  let timeType = '';
  if (peakHour >= 22 || peakHour <= 4) timeType = 'Night Owl';
  else if (peakHour >= 5 && peakHour <= 8) timeType = 'Early Bird';
  else if (peakHour >= 9 && peakHour <= 17) timeType = '9-to-5er';
  else timeType = 'Evening Coder';

  // Favorite model (by cost across all sources)
  const allModels: Record<string, { sessions: number; cost: number }> = {
    ...claudeModels,
  };
  for (const [m, info] of Object.entries(codexModels)) {
    const e = allModels[m] || { sessions: 0, cost: 0 };
    e.sessions += info.sessions;
    e.cost += info.cost;
    allModels[m] = e;
  }
  for (const [m, info] of Object.entries(cursor.models)) {
    const e = allModels[m] || { sessions: 0, cost: 0 };
    e.sessions += info.sessions;
    e.cost += info.cost;
    allModels[m] = e;
  }
  for (const [m, info] of Object.entries(gooseModels)) {
    const e = allModels[m] || { sessions: 0, cost: 0 };
    e.sessions += info.sessions;
    e.cost += info.cost;
    allModels[m] = e;
  }
  const favoriteModel =
    Object.entries(allModels).sort(
      (a, b) => b[1].cost - a[1].cost,
    )[0]?.[0] || '';

  let archetype = 'Builder';
  if (favoriteModel.includes('opus')) archetype = 'Power User';
  else if (favoriteModel.includes('haiku')) archetype = 'Speed Runner';
  else if (favoriteModel.includes('sonnet'))
    archetype = 'Balanced Builder';
  else if (
    favoriteModel.includes('5.3-codex') ||
    favoriteModel.includes('5.4')
  )
    archetype = 'Codex Pro';

  const personality = `${timeType} / ${archetype}`;

  // Favorite tool (across all providers)
  const favoriteTool =
    Object.entries(allToolBreakdown).sort(
      (a, b) => b[1] - a[1],
    )[0]?.[0] || '';

  // Cache hit rate (Cursor doesn't expose cache tokens)
  const totalCacheReads =
    claude.totalCacheReadTokens + codex.totalCachedInputTokens;
  const totalAllInput =
    claude.totalInputTokens +
    claude.totalCacheReadTokens +
    codex.totalInputTokens +
    cursor.totalInputTokens;
  const cacheHitRate =
    totalAllInput > 0
      ? Math.round((totalCacheReads / totalAllInput) * 100)
      : 0;

  // Most expensive session
  let mostExpensiveSession: {
    cost: number;
    model: string;
    project: string;
    date: string;
  } | null = null;
  for (const s of claude.sessions) {
    if (!mostExpensiveSession || s.costUsd > mostExpensiveSession.cost) {
      mostExpensiveSession = {
        cost: s.costUsd,
        model: s.model,
        project: s.project,
        date: s.firstTimestamp.slice(0, 10),
      };
    }
  }
  for (const s of codex.sessions) {
    if (!mostExpensiveSession || s.costUsd > mostExpensiveSession.cost) {
      mostExpensiveSession = {
        cost: s.costUsd,
        model: s.model,
        project: s.project,
        date: s.createdAt.slice(0, 10),
      };
    }
  }
  for (const s of cursor.sessions) {
    if (!mostExpensiveSession || s.costUsd > mostExpensiveSession.cost) {
      mostExpensiveSession = {
        cost: s.costUsd,
        model: s.model,
        project: 'cursor',
        date: (s.createdAt || '').slice(0, 10),
      };
    }
  }
  for (const s of gooseSessions) {
    if (!mostExpensiveSession || s.costUsd > mostExpensiveSession.cost) {
      mostExpensiveSession = {
        cost: s.costUsd,
        model: s.model,
        project: s.project,
        date: (s.createdAt || '').slice(0, 10),
      };
    }
  }

  const totalSessions =
    claude.sessions.length + codex.sessions.length + cursor.sessions.length + gooseSessions.length;
  const avgCostPerSession =
    totalSessions > 0
      ? (claude.totalCost + codex.totalCost + cursor.totalCost + gooseTotalCost) / totalSessions
      : 0;
  const avgSessionsPerDay =
    totalActiveDays > 0 ? totalSessions / totalActiveDays : 0;

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
      totalToolCalls,
      hourDistribution: claude.hourDistribution,
      activeDays: claudeDays.size,
      projects: [...claudeProjects.entries()]
        .map(([name, v]) => ({ name, ...v }))
        .sort((a, b) => b.cost - a.cost)
        .slice(0, 20),
    },
    codex: {
      sessions: codex.sessions.length,
      cost: codex.totalCost,
      inputTokens: codex.totalInputTokens,
      cachedInputTokens: codex.totalCachedInputTokens,
      outputTokens: codex.totalOutputTokens,
      models: codexModels,
      activeDays: codexDays.size,
      projects: [...codexProjects.entries()]
        .map(([name, v]) => ({ name, ...v }))
        .sort((a, b) => b.cost - a.cost)
        .slice(0, 20),
      topTools: Object.entries(codex.toolBreakdown)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 20),
      totalToolCalls: Object.values(codex.toolBreakdown).reduce(
        (s, c) => s + c,
        0,
      ),
      totalReasoningBlocks: codex.totalReasoningBlocks,
      totalWebSearches: codex.totalWebSearches,
    },
    cursor: {
      sessions: cursor.sessions.length,
      cost: cursor.totalCost,
      inputTokens: cursor.totalInputTokens,
      outputTokens: cursor.totalOutputTokens,
      models: cursor.models,
      topTools: Object.entries(cursor.toolBreakdown)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 20),
      totalToolCalls: cursor.totalToolCalls,
      activeDays: cursorDays.size,
      projects: (() => {
        const projects = new Map<string, { sessions: number }>();
        for (const s of cursor.sessions) {
          if (!s.project) continue;
          const e = projects.get(s.project) || { sessions: 0 };
          e.sessions++;
          projects.set(s.project, e);
        }
        return [...projects.entries()]
          .map(([name, v]) => ({ name, ...v }))
          .sort((a, b) => b.sessions - a.sessions)
          .slice(0, 20);
      })(),
      totalMessages: cursor.totalMessages,
      totalLinesAdded: cursor.totalLinesAdded,
      totalLinesRemoved: cursor.totalLinesRemoved,
      totalFilesCreated: cursor.totalFilesCreated,
      thinkingTimeMs: cursor.thinkingTimeMs,
      turnTimeMs: cursor.turnTimeMs,
      dailyActivity: cursor.dailyActivity,
      totalTabSuggestedLines: cursor.totalTabSuggestedLines,
      totalTabAcceptedLines: cursor.totalTabAcceptedLines,
      totalComposerSuggestedLines: cursor.totalComposerSuggestedLines,
      totalComposerAcceptedLines: cursor.totalComposerAcceptedLines,
    },
    goose: {
      sessions: gooseSessions.length,
      cost: gooseTotalCost,
      inputTokens: gooseTotalInput,
      outputTokens: gooseTotalOutput,
      models: gooseModels,
      providers: gooseProviders,
      activeDays: gooseDays.size,
      projects: [...gooseProjects.entries()]
        .map(([name, v]) => ({ name, ...v }))
        .sort((a, b) => b.cost - a.cost)
        .slice(0, 20),
    },
    combined: {
      totalCost: claude.totalCost + codex.totalCost + cursor.totalCost + gooseTotalCost,
      totalSessions,
      totalInputTokens:
        claude.totalInputTokens + codex.totalInputTokens + cursor.totalInputTokens + gooseTotalInput,
      totalOutputTokens:
        claude.totalOutputTokens + codex.totalOutputTokens + cursor.totalOutputTokens + gooseTotalOutput,
      totalActiveDays,
      dailyDistribution: (() => {
        const empty = () => ({
          sessions: 0,
          cost: 0,
          claudeSessions: 0,
          codexSessions: 0,
          cursorSessions: 0,
          gooseSessions: 0,
        });
        const days = new Map<string, ReturnType<typeof empty>>();
        for (const s of claude.sessions) {
          const date = s.firstTimestamp.slice(0, 10);
          if (!date) continue;
          const e = days.get(date) || empty();
          e.sessions++;
          e.cost += s.costUsd;
          e.claudeSessions++;
          days.set(date, e);
        }
        for (const s of codex.sessions) {
          const date = s.createdAt.slice(0, 10);
          if (!date) continue;
          const e = days.get(date) || empty();
          e.sessions++;
          e.cost += s.costUsd;
          e.codexSessions++;
          days.set(date, e);
        }
        for (const s of cursor.sessions) {
          const date = (s.createdAt || '').slice(0, 10);
          if (!date) continue;
          const e = days.get(date) || empty();
          e.sessions++;
          e.cost += s.costUsd;
          e.cursorSessions++;
          days.set(date, e);
        }
        for (const s of gooseSessions) {
          const date = (s.createdAt || '').slice(0, 10);
          if (!date) continue;
          const e = days.get(date) || empty();
          e.sessions++;
          e.cost += s.costUsd;
          e.gooseSessions++;
          days.set(date, e);
        }
        return [...days.entries()]
          .map(([date, v]) => ({ date, ...v }))
          .sort((a, b) => a.date.localeCompare(b.date));
      })(),
    },
    highlights: {
      favoriteModel,
      favoriteTool,
      peakHour,
      peakHourLabel,
      personality,
      totalToolCalls,
      cacheHitRate,
      longestStreak,
      mostExpensiveSession,
      avgCostPerSession,
      avgSessionsPerDay,
      // MCP breakdown
      mcpServers: (() => {
        const servers = new Map<
          string,
          { totalCalls: number; tools: Map<string, number> }
        >();
        for (const t of topTools) {
          if (!t.name.startsWith('mcp__')) continue;
          const parts = t.name.replace('mcp__', '').split('__');
          const server = parts[0];
          const tool = parts.slice(1).join('__');
          const entry = servers.get(server) || {
            totalCalls: 0,
            tools: new Map<string, number>(),
          };
          entry.totalCalls += t.count;
          entry.tools.set(
            tool,
            (entry.tools.get(tool) || 0) + t.count,
          );
          servers.set(server, entry);
        }
        return [...servers.entries()]
          .map(([name, data]) => ({
            name,
            totalCalls: data.totalCalls,
            tools: [...data.tools.entries()]
              .map(([n, c]) => ({ name: n, count: c }))
              .sort((a, b) => b.count - a.count),
          }))
          .sort((a, b) => b.totalCalls - a.totalCalls);
      })(),
      totalMcpCalls: topTools
        .filter((t) => t.name.startsWith('mcp__'))
        .reduce((s, t) => s + t.count, 0),
      skillInvocations:
        topTools.find((t) => t.name === 'Skill')?.count || 0,
      builtinTools: topTools.filter(
        (t) => !t.name.startsWith('mcp__'),
      ),
      readWriteRatio: (() => {
        const reads =
          (claude.toolBreakdown['Read'] || 0) +
          (claude.toolBreakdown['Grep'] || 0) +
          (claude.toolBreakdown['Glob'] || 0);
        const writes =
          (claude.toolBreakdown['Edit'] || 0) +
          (claude.toolBreakdown['Write'] || 0);
        const ratio =
          writes > 0
            ? (reads / writes).toFixed(1) + ':1'
            : 'read-only';
        return { reads, writes, ratio };
      })(),
      costWithoutCache:
        claude.totalCost + claude.cacheSavingsUsd + codex.totalCost + cursor.totalCost + gooseTotalCost,
      activityCategories: (() => {
        const cats = new Map<
          string,
          { sessions: number; cost: number }
        >();
        for (const s of claude.sessions) {
          const cat = classifySession(s.toolBreakdown);
          const e = cats.get(cat) || { sessions: 0, cost: 0 };
          e.sessions++;
          e.cost += s.costUsd;
          cats.set(cat, e);
        }
        // Codex sessions: map exec_command->Bash, apply_patch->Edit, shell*->Bash
        for (const s of codex.sessions) {
          const mapped: Record<string, number> = {};
          for (const [tool, count] of Object.entries(
            s.toolBreakdown,
          )) {
            if (
              tool === 'exec_command' ||
              tool === 'shell_command' ||
              tool === 'shell'
            )
              mapped['Bash'] = (mapped['Bash'] || 0) + count;
            else if (tool === 'apply_patch')
              mapped['Edit'] = (mapped['Edit'] || 0) + count;
            else if (tool === 'write_stdin')
              mapped['Bash'] = (mapped['Bash'] || 0) + count;
            else mapped[tool] = (mapped[tool] || 0) + count;
          }
          const cat = classifySession(mapped);
          const e = cats.get(cat) || { sessions: 0, cost: 0 };
          e.sessions++;
          e.cost += s.costUsd;
          cats.set(cat, e);
        }

        // Cursor sessions: map cursor tools to normalized names
        // We use the global tool breakdown since Cursor doesn't have per-session tools
        if (cursor.sessions.length > 0 && cursor.totalToolCalls > 0) {
          const cursorMapped: Record<string, number> = {};
          for (const [tool, count] of Object.entries(cursor.toolBreakdown)) {
            if (tool === 'read_file_v2' || tool === 'read_lints')
              cursorMapped['Read'] = (cursorMapped['Read'] || 0) + count;
            else if (tool === 'edit_file_v2')
              cursorMapped['Edit'] = (cursorMapped['Edit'] || 0) + count;
            else if (tool === 'run_terminal_command_v2')
              cursorMapped['Bash'] = (cursorMapped['Bash'] || 0) + count;
            else if (tool === 'ripgrep_raw_search' || tool === 'semantic_search_full')
              cursorMapped['Grep'] = (cursorMapped['Grep'] || 0) + count;
            else if (tool === 'glob_file_search')
              cursorMapped['Glob'] = (cursorMapped['Glob'] || 0) + count;
            else if (tool === 'delete_file')
              cursorMapped['Write'] = (cursorMapped['Write'] || 0) + count;
            else cursorMapped[tool] = (cursorMapped[tool] || 0) + count;
          }
          // Classify entire Cursor usage as one aggregate entry
          const cat = classifySession(cursorMapped);
          const e = cats.get(cat) || { sessions: 0, cost: 0 };
          e.sessions += cursor.sessions.length;
          cats.set(cat, e);
        }

        const totalSess =
          [...cats.values()].reduce(
            (s, v) => s + v.sessions,
            0,
          ) || 1;
        const totalCst =
          [...cats.values()].reduce((s, v) => s + v.cost, 0) || 1;

        return [...cats.entries()]
          .map(([category, v]) => ({
            category,
            description:
              CATEGORY_DESCRIPTIONS[
                category as ActivityCategory
              ],
            sessions: v.sessions,
            cost: v.cost,
            sessionPct: Math.round(
              (v.sessions / totalSess) * 100,
            ),
            costPct: Math.round((v.cost / totalCst) * 100),
          }))
          .sort((a, b) => b.sessions - a.sessions);
      })(),
    },
  };
}
