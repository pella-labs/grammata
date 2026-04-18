/**
 * Merges Claude Code, Codex, Cursor, and Goose sessions into a unified
 * per-session array. Deduplicates by sessionId (priority: Claude JSONL >
 * Codex > Cursor > Goose DB — Claude ships the richest data), and
 * normalizes provider-specific tool names to Claude-style names so
 * downstream consumers can aggregate across sources.
 */
import type { ClaudeSummary } from './claude.js';
import type { CodexSummary } from './codex.js';
import type { CursorSummary } from './cursor.js';
import type { GooseSummary } from './goose.js';

export type SourceType = 'claude-code' | 'codex' | 'cursor' | 'goose';

export interface UnifiedSession {
  id: string;
  name: string;
  project: string;
  date: string;
  durationMs: number;
  model: string;
  source: SourceType;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
  messageCount: number;
  toolCalls: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  toolBreakdown: Record<string, number>;
  startHour: number;
  gitBranch: string;
  prLinks: string[];
  version: string;
  entrypoint: string;
  retryCount: number;
  totalEditTurns: number;
  mostRetriedFile: string | null;
  perToolCounts: Record<string, { total: number; retried: number }>;
}

export interface SourceStats {
  sessions: number;
  cost: number;
  tokens: number;
}

export interface MergedUsage {
  sessions: UnifiedSession[];
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  cacheSavingsUsd: number;
  totalCacheReadTokens: number;
  toolBreakdown: Record<string, number>;
  hourDistribution: number[];
  sourceStats: Record<SourceType, SourceStats>;
  providerStats: Record<string, SourceStats>;
}

export function mapCodexTools(tools: Record<string, number>): Record<string, number> {
  const mapped: Record<string, number> = {};
  for (const [tool, count] of Object.entries(tools)) {
    if (
      tool === 'exec_command' ||
      tool === 'shell_command' ||
      tool === 'shell' ||
      tool === 'write_stdin'
    ) {
      mapped['Bash'] = (mapped['Bash'] || 0) + count;
    } else if (tool === 'apply_patch') {
      mapped['Edit'] = (mapped['Edit'] || 0) + count;
    } else if (tool === 'update_plan') {
      mapped['Agent'] = (mapped['Agent'] || 0) + count;
    } else if (tool === 'request_user_input') {
      mapped['AskUserQuestion'] = (mapped['AskUserQuestion'] || 0) + count;
    } else if (tool === 'view_image') {
      mapped['Read'] = (mapped['Read'] || 0) + count;
    } else {
      mapped[tool] = (mapped[tool] || 0) + count;
    }
  }
  return mapped;
}

export function mapCursorTools(tools: Record<string, number>): Record<string, number> {
  const mapped: Record<string, number> = {};
  for (const [tool, count] of Object.entries(tools)) {
    if (tool === 'read_file_v2' || tool === 'read_lints') {
      mapped['Read'] = (mapped['Read'] || 0) + count;
    } else if (tool === 'edit_file_v2') {
      mapped['Edit'] = (mapped['Edit'] || 0) + count;
    } else if (tool === 'run_terminal_command_v2') {
      mapped['Bash'] = (mapped['Bash'] || 0) + count;
    } else if (tool === 'ripgrep_raw_search' || tool === 'semantic_search_full') {
      mapped['Grep'] = (mapped['Grep'] || 0) + count;
    } else if (tool === 'glob_file_search') {
      mapped['Glob'] = (mapped['Glob'] || 0) + count;
    } else if (tool === 'delete_file') {
      mapped['Write'] = (mapped['Write'] || 0) + count;
    } else {
      mapped[tool] = (mapped[tool] || 0) + count;
    }
  }
  return mapped;
}

function emptySourceStats(): Record<SourceType, SourceStats> {
  return {
    'claude-code': { sessions: 0, cost: 0, tokens: 0 },
    codex: { sessions: 0, cost: 0, tokens: 0 },
    cursor: { sessions: 0, cost: 0, tokens: 0 },
    goose: { sessions: 0, cost: 0, tokens: 0 },
  };
}

/**
 * Claude Code stores projects on disk as e.g. `-Users-san-Desktop-atlas`.
 * Strip the leading `-` and take the trailing segment so the display name
 * matches what other sources report (`atlas`).
 */
function normalizeClaudeProject(project: string): string {
  return project.replace(/^-/, '').split('-').pop() || project;
}

export function mergeAll(
  claude: ClaudeSummary | null,
  codex: CodexSummary | null,
  cursor: CursorSummary | null,
  goose: GooseSummary | null,
): MergedUsage {
  const sessionMap = new Map<string, UnifiedSession>();
  const sourceStats = emptySourceStats();
  const providerStats: Record<string, SourceStats> = {};
  const toolBreakdown: Record<string, number> = {};
  const hourDistribution = new Array(24).fill(0) as number[];
  let cacheSavingsUsd = 0;
  let totalCacheReadTokens = 0;

  // 1. Claude Code sessions (richest data → highest priority).
  if (claude) {
    for (const s of claude.sessions) {
      sessionMap.set(s.sessionId, {
        id: s.sessionId,
        name: s.sessionName,
        project: normalizeClaudeProject(s.project),
        date: s.firstTimestamp,
        durationMs: s.durationMs,
        model: s.model,
        source: 'claude-code',
        provider: 'anthropic',
        inputTokens: s.inputTokens,
        outputTokens: s.outputTokens,
        totalTokens: s.inputTokens + s.outputTokens,
        cost: s.costUsd,
        messageCount: s.turnCount,
        toolCalls: s.toolCalls,
        cacheReadTokens: s.cacheReadTokens,
        cacheCreateTokens: s.cacheCreateTokens,
        toolBreakdown: s.toolBreakdown,
        startHour: s.startHour,
        gitBranch: s.gitBranch,
        prLinks: s.prLinks,
        version: s.version,
        entrypoint: s.entrypoint,
        retryCount: s.retryCount,
        totalEditTurns: s.totalEditTurns,
        mostRetriedFile: s.mostRetriedFile,
        perToolCounts: s.perToolCounts,
      });
    }
    for (const [tool, count] of Object.entries(claude.toolBreakdown)) {
      toolBreakdown[tool] = (toolBreakdown[tool] || 0) + count;
    }
    cacheSavingsUsd += claude.cacheSavingsUsd;
    totalCacheReadTokens += claude.totalCacheReadTokens;
    for (let i = 0; i < 24; i++) hourDistribution[i] += claude.hourDistribution[i];
  }

  // 2. Codex sessions.
  if (codex) {
    for (const s of codex.sessions) {
      if (sessionMap.has(s.sessionId)) continue;
      const startHour = s.createdAt ? new Date(s.createdAt).getHours() : 0;
      const mappedTools = mapCodexTools(s.toolBreakdown || {});
      sessionMap.set(s.sessionId, {
        id: s.sessionId,
        name: s.sessionName,
        project: s.project,
        date: s.createdAt,
        durationMs: s.durationMs,
        model: s.model,
        source: 'codex',
        provider: s.modelProvider || 'openai',
        inputTokens: s.inputTokens,
        outputTokens: s.outputTokens,
        totalTokens: s.inputTokens + s.outputTokens,
        cost: s.costUsd,
        messageCount: s.messageCount,
        toolCalls: Object.values(s.toolBreakdown || {}).reduce((sum, c) => sum + c, 0),
        cacheReadTokens: s.cachedInputTokens,
        cacheCreateTokens: 0,
        toolBreakdown: mappedTools,
        startHour,
        gitBranch: s.gitBranch,
        prLinks: [],
        version: '',
        entrypoint: '',
        retryCount: s.retryCount,
        totalEditTurns: s.totalActions,
        mostRetriedFile: null,
        perToolCounts: {},
      });
      hourDistribution[startHour]++;
    }
    for (const [tool, count] of Object.entries(mapCodexTools(codex.toolBreakdown))) {
      toolBreakdown[tool] = (toolBreakdown[tool] || 0) + count;
    }
  }

  // 3. Cursor sessions.
  if (cursor) {
    for (const s of cursor.sessions) {
      if (sessionMap.has(s.sessionId)) continue;
      const startHour = s.createdAt ? new Date(s.createdAt).getHours() : 0;
      sessionMap.set(s.sessionId, {
        id: s.sessionId,
        name: s.sessionName,
        project: s.project || 'cursor',
        date: s.createdAt || '',
        durationMs: 0,
        model: s.model,
        source: 'cursor',
        provider: s.model.includes('claude') ? 'anthropic' : s.model.includes('gpt') ? 'openai' : 'cursor',
        inputTokens: s.inputTokens,
        outputTokens: s.outputTokens,
        totalTokens: s.inputTokens + s.outputTokens,
        cost: s.costUsd,
        messageCount: s.messageCount,
        toolCalls: 0,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        toolBreakdown: {},
        startHour,
        gitBranch: '',
        prLinks: [],
        version: '',
        entrypoint: '',
        retryCount: 0,
        totalEditTurns: 0,
        mostRetriedFile: null,
        perToolCounts: {},
      });
      hourDistribution[startHour]++;
    }
    for (const [tool, count] of Object.entries(mapCursorTools(cursor.toolBreakdown))) {
      toolBreakdown[tool] = (toolBreakdown[tool] || 0) + count;
    }
  }

  // 4. Goose DB sessions (broadest provider coverage, least detail).
  if (goose) {
    for (const s of goose.sessions) {
      if (sessionMap.has(s.sessionId)) continue;
      // Goose captures claude-code/claude-acp sessions too — those are
      // already covered by the JSONL reader, so skip to avoid double-counting.
      if (s.providerName === 'claude-code' || s.providerName === 'claude-acp') continue;
      const startHour = s.createdAt ? new Date(s.createdAt).getHours() : 0;
      sessionMap.set(s.sessionId, {
        id: s.sessionId,
        name: s.sessionName,
        project: s.project,
        date: s.createdAt,
        durationMs: s.durationMs,
        model: s.model,
        source: 'goose',
        provider: s.providerName,
        inputTokens: s.inputTokens,
        outputTokens: s.outputTokens,
        totalTokens: s.inputTokens + s.outputTokens,
        cost: s.costUsd,
        messageCount: s.messageCount,
        toolCalls: 0,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        toolBreakdown: {},
        startHour,
        gitBranch: '',
        prLinks: [],
        version: '',
        entrypoint: '',
        retryCount: 0,
        totalEditTurns: 0,
        mostRetriedFile: null,
        perToolCounts: {},
      });
      hourDistribution[startHour]++;
    }
  }

  const sessions = Array.from(sessionMap.values());
  let totalCost = 0;
  let totalInput = 0;
  let totalOutput = 0;

  for (const s of sessions) {
    totalCost += s.cost;
    totalInput += s.inputTokens;
    totalOutput += s.outputTokens;
    sourceStats[s.source].sessions++;
    sourceStats[s.source].cost += s.cost;
    sourceStats[s.source].tokens += s.totalTokens;
    if (!providerStats[s.provider]) {
      providerStats[s.provider] = { sessions: 0, cost: 0, tokens: 0 };
    }
    providerStats[s.provider].sessions++;
    providerStats[s.provider].cost += s.cost;
    providerStats[s.provider].tokens += s.totalTokens;
  }

  sessions.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return {
    sessions,
    totalCost,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    cacheSavingsUsd,
    totalCacheReadTokens,
    toolBreakdown,
    hourDistribution,
    sourceStats,
    providerStats,
  };
}
