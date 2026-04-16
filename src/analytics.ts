/**
 * Derived metrics that sit on top of UnifiedSession[] — the same
 * computations Pharos's dashboard performs, extracted so any consumer
 * can reuse them without rebuilding the aggregation logic.
 */
import type { UnifiedSession } from './merge.js';

export type ActivityCategory =
  | 'Building'
  | 'Investigating'
  | 'Debugging'
  | 'Testing'
  | 'Refactoring'
  | 'Other';

export interface CostTrend {
  currentWeekCost: number;
  previousWeekCost: number;
  changePercent: number;
}

export interface BranchCost {
  branch: string;
  project: string;
  cost: number;
  sessions: number;
  tokens: number;
}

export interface CacheStats {
  hitRate: number;
  totalCacheRead: number;
  totalInput: number;
  savingsUsd: number;
  cacheWriteTokens: number;
}

export interface CostVelocityPoint {
  date: string;
  cost: number;
  hours: number;
  costPerHour: number;
}

export interface RetryStats {
  firstTryRate: number;
  totalEditTurns: number;
  retriedTurns: number;
  retryCostUsd: number;
  trendPct: number;
  perTool: Array<{ tool: string; total: number; firstTry: number; rate: number }>;
  mostRetriedTool: string | null;
  mostRetriedFile: string | null;
  worstSession: { id: string; name: string; date: string; retryCostUsd: number } | null;
}

function dateKey(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return 'unknown';
    return d.toLocaleDateString('en-CA');
  } catch {
    return 'unknown';
  }
}

// Heuristic thresholds derived from sampling ~200 Claude Code sessions.
// Checked in order — first match wins.
export function classifySession(toolBreakdown: Record<string, number>): ActivityCategory {
  const read =
    (toolBreakdown['Read'] || 0) + (toolBreakdown['Grep'] || 0) + (toolBreakdown['Glob'] || 0);
  const write = (toolBreakdown['Edit'] || 0) + (toolBreakdown['Write'] || 0);
  const bash = toolBreakdown['Bash'] || 0;
  const total = Object.values(toolBreakdown).reduce((s, v) => s + v, 0);

  if (total === 0) return 'Building';

  const readRatio = read / total;
  const writeRatio = write / total;
  const bashRatio = bash / total;

  if (writeRatio > 0.3) return 'Building';
  if (readRatio > 0.6 && writeRatio < 0.15) return 'Investigating';
  if (bashRatio > 0.3 && writeRatio > 0.1) return 'Debugging';
  if (bashRatio > 0.4) return 'Testing';
  if (writeRatio > 0.2 && readRatio > 0.3) return 'Refactoring';
  return 'Building';
}

export function computeCostTrend(sessions: UnifiedSession[]): CostTrend {
  const now = new Date();
  const oneWeekAgo = new Date(now);
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
  const twoWeeksAgo = new Date(now);
  twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);

  let currentWeekCost = 0;
  let previousWeekCost = 0;

  for (const s of sessions) {
    const d = new Date(s.date);
    if (d >= oneWeekAgo) currentWeekCost += s.cost;
    else if (d >= twoWeeksAgo) previousWeekCost += s.cost;
  }

  const changePercent =
    previousWeekCost > 0 ? ((currentWeekCost - previousWeekCost) / previousWeekCost) * 100 : 0;

  return { currentWeekCost, previousWeekCost, changePercent };
}

export function computeBranchCosts(sessions: UnifiedSession[]): BranchCost[] {
  const branchMap = new Map<string, BranchCost>();
  for (const s of sessions) {
    const branch = s.gitBranch || '(no branch)';
    const key = `${s.project}::${branch}`;
    const entry = branchMap.get(key) || {
      branch,
      project: s.project,
      cost: 0,
      sessions: 0,
      tokens: 0,
    };
    entry.cost += s.cost;
    entry.sessions += 1;
    entry.tokens += s.totalTokens;
    branchMap.set(key, entry);
  }
  return Array.from(branchMap.values()).sort((a, b) => b.cost - a.cost);
}

export function computeCacheStats(
  sessions: UnifiedSession[],
  cacheSavingsUsd: number,
): CacheStats {
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalInputForCache = 0;
  for (const s of sessions) {
    totalCacheRead += s.cacheReadTokens;
    totalCacheWrite += s.cacheCreateTokens;
    totalInputForCache += s.inputTokens + s.cacheReadTokens + s.cacheCreateTokens;
  }
  return {
    hitRate: totalInputForCache > 0 ? totalCacheRead / totalInputForCache : 0,
    totalCacheRead,
    totalInput: totalInputForCache,
    savingsUsd: cacheSavingsUsd,
    cacheWriteTokens: totalCacheWrite,
  };
}

export function computeCostVelocity(sessions: UnifiedSession[]): CostVelocityPoint[] {
  const velocityMap = new Map<string, { cost: number; durationMs: number }>();
  for (const s of sessions) {
    const key = dateKey(s.date);
    const entry = velocityMap.get(key) || { cost: 0, durationMs: 0 };
    entry.cost += s.cost;
    entry.durationMs += s.durationMs;
    velocityMap.set(key, entry);
  }
  return Array.from(velocityMap.entries())
    .map(([date, v]) => {
      const hours = Math.max(v.durationMs / 3_600_000, 0.01);
      return { date, cost: v.cost, hours, costPerHour: v.cost / hours };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function computeRetryStats(sessions: UnifiedSession[]): RetryStats {
  let totalEditTurns = 0;
  let retriedTurns = 0;
  let retryCostUsd = 0;
  const perToolAgg = new Map<string, { total: number; retried: number }>();
  const fileAgg = new Map<string, number>();
  let worstSession: RetryStats['worstSession'] = null;

  const now = new Date();
  const oneWeekAgo = new Date(now);
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
  const twoWeeksAgo = new Date(now);
  twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
  let curEdits = 0;
  let curRetries = 0;
  let prevEdits = 0;
  let prevRetries = 0;

  for (const s of sessions) {
    if (s.totalEditTurns === 0) continue;
    totalEditTurns += s.totalEditTurns;
    retriedTurns += s.retryCount;
    const sessionRetryCost = s.totalEditTurns > 0 ? s.cost * (s.retryCount / s.totalEditTurns) : 0;
    retryCostUsd += sessionRetryCost;

    for (const [tool, counts] of Object.entries(s.perToolCounts)) {
      const entry = perToolAgg.get(tool) || { total: 0, retried: 0 };
      entry.total += counts.total;
      entry.retried += counts.retried;
      perToolAgg.set(tool, entry);
    }

    if (s.mostRetriedFile && s.retryCount > 0) {
      fileAgg.set(s.mostRetriedFile, (fileAgg.get(s.mostRetriedFile) || 0) + s.retryCount);
    }

    if (!worstSession || sessionRetryCost > worstSession.retryCostUsd) {
      worstSession = {
        id: s.id,
        name: s.name,
        date: s.date,
        retryCostUsd: sessionRetryCost,
      };
    }

    const d = new Date(s.date);
    if (d >= oneWeekAgo) {
      curEdits += s.totalEditTurns;
      curRetries += s.retryCount;
    } else if (d >= twoWeeksAgo) {
      prevEdits += s.totalEditTurns;
      prevRetries += s.retryCount;
    }
  }

  const firstTryRate = totalEditTurns > 0 ? 1 - retriedTurns / totalEditTurns : 0;
  const curRate = curEdits > 0 ? 1 - curRetries / curEdits : 0;
  const prevRate = prevEdits > 0 ? 1 - prevRetries / prevEdits : 0;
  const trendPct = prevEdits > 0 ? (curRate - prevRate) * 100 : 0;

  const perTool = Array.from(perToolAgg.entries())
    .map(([tool, v]) => ({
      tool,
      total: v.total,
      firstTry: v.total - v.retried,
      rate: v.total > 0 ? (v.total - v.retried) / v.total : 0,
    }))
    .sort((a, b) => b.total - a.total);

  const mostRetriedTool =
    Array.from(perToolAgg.entries())
      .filter(([, v]) => v.retried > 0)
      .sort((a, b) => b[1].retried - a[1].retried)[0]?.[0] ?? null;

  const mostRetriedFile = Array.from(fileAgg.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  if (worstSession && worstSession.retryCostUsd === 0) worstSession = null;

  return {
    firstTryRate,
    totalEditTurns,
    retriedTurns,
    retryCostUsd,
    trendPct,
    perTool,
    mostRetriedTool,
    mostRetriedFile,
    worstSession,
  };
}
