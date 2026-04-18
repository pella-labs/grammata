/**
 * Reads Claude Code session JSONL files from ~/.claude/projects/
 * and aggregates token usage, cost, and model data.
 */
import { lstat, readdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { CLAUDE_PRICING, getClaudePricing } from './pricing.js';
import { streamJsonLines } from './jsonl.js';

export { CLAUDE_PRICING };

export interface ClaudeSession {
  sessionId: string;
  sessionName: string;
  project: string;
  firstTimestamp: string;
  lastTimestamp: string;
  durationMs: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  costUsd: number;
  turnCount: number;
  toolCalls: number;
  toolBreakdown: Record<string, number>;
  startHour: number;
  gitBranch: string;
  prLinks: string[];
  version: string;
  entrypoint: string;
  // Retry detection — a file edited more than once in a session counts as (edits - 1) retries.
  retryCount: number;
  totalEditTurns: number;
  mostRetriedFile: string | null;
  perToolCounts: Record<string, { total: number; retried: number }>;
}

export interface ClaudeSummary {
  sessions: ClaudeSession[];
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreateTokens: number;
  cacheSavingsUsd: number;
  toolBreakdown: Record<string, number>;
  hourDistribution: number[];
}

interface ToolUseBlock {
  type?: string;
  name?: string;
  input?: { file_path?: string };
}

interface AssistantMessage {
  type: string;
  requestId?: string;
  message: {
    id?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    content?: ToolUseBlock[];
  };
}

function isAssistantWithUsage(d: unknown): d is AssistantMessage {
  const obj = d as Record<string, unknown>;
  return (
    obj?.type === 'assistant' &&
    typeof obj?.message === 'object' &&
    obj.message !== null
  );
}

async function parseSessionFile(
  filePath: string,
  projectName: string,
): Promise<ClaudeSession | null> {
  try {
    const fileInfo = await lstat(filePath);
    if (fileInfo.isSymbolicLink()) return null;

    let model = 'unknown';
    // B2 fix: Claude Code writes multiple assistant records for the same turn
    // (mid-stream partial + final). They share `message.id` / `requestId` but
    // the usage counters on the later record reflect the full turn, not a
    // delta. Naive summation double-counts every turn's cache tokens. We
    // dedup by message.id (fallback: requestId; fallback: uuid) and take
    // max-per-field so the larger final record wins without adding to the
    // partial.
    const usageByKey = new Map<
      string,
      {
        input: number;
        output: number;
        cacheRead: number;
        cacheCreate: number;
      }
    >();
    let turnCount = 0;
    let toolCalls = 0;
    const toolBreakdown: Record<string, number> = {};
    const editsByToolAndFile: Record<string, Record<string, number>> = {};
    let firstTs = '';
    let lastTs = '';
    let sessionName = '';
    let gitBranch = '';
    const prLinks: string[] = [];
    let version = '';
    let entrypoint = '';

    await streamJsonLines(filePath, (line) => {
      try {
        const d = JSON.parse(line) as Record<string, unknown>;

        if (d.timestamp) {
          if (!firstTs) firstTs = d.timestamp as string;
          lastTs = d.timestamp as string;
        }

        if (!sessionName && d.type === 'queue-operation' && d.content) {
          const text =
            typeof d.content === 'string' ? d.content : '';
          sessionName = text
            .replace(/^-\n?/, '')
            .trim()
            .slice(0, 80);
        }

        if (typeof d.gitBranch === 'string' && !gitBranch) gitBranch = d.gitBranch;
        if (typeof d.version === 'string' && !version) version = d.version;
        if (typeof d.entrypoint === 'string' && !entrypoint) entrypoint = d.entrypoint;

        if (d.type === 'pr-link' && typeof d.prUrl === 'string' && !prLinks.includes(d.prUrl)) {
          prLinks.push(d.prUrl);
        }

        if (isAssistantWithUsage(d)) {
          const usage = d.message.usage;
          if (usage) {
            const key =
              d.message.id ||
              d.requestId ||
              (d as unknown as { uuid?: string }).uuid ||
              `anon-${usageByKey.size}`;
            const prev = usageByKey.get(key);
            const next = {
              input: Math.max(prev?.input ?? 0, usage.input_tokens || 0),
              output: Math.max(prev?.output ?? 0, usage.output_tokens || 0),
              cacheRead: Math.max(
                prev?.cacheRead ?? 0,
                usage.cache_read_input_tokens || 0,
              ),
              cacheCreate: Math.max(
                prev?.cacheCreate ?? 0,
                usage.cache_creation_input_tokens || 0,
              ),
            };
            usageByKey.set(key, next);
            if (!prev) turnCount++;
          }

          if (d.message.model && d.message.model !== '<synthetic>') {
            model = d.message.model;
          }

          if (d.message.content) {
            for (const c of d.message.content) {
              if (c && typeof c === 'object' && c.type === 'tool_use') {
                toolCalls++;
                const toolName = c.name || 'unknown';
                toolBreakdown[toolName] =
                  (toolBreakdown[toolName] || 0) + 1;
                if (toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit') {
                  const toolFilePath = c.input?.file_path;
                  if (toolFilePath) {
                    const byFile = editsByToolAndFile[toolName] || {};
                    byFile[toolFilePath] = (byFile[toolFilePath] || 0) + 1;
                    editsByToolAndFile[toolName] = byFile;
                  }
                }
              }
            }
          }
        }
      } catch {
        // Skip malformed lines
      }
    });

    if (turnCount === 0) return null;

    let totalInput = 0;
    let totalOutput = 0;
    let cacheRead = 0;
    let cacheCreate = 0;
    for (const v of usageByKey.values()) {
      totalInput += v.input;
      totalOutput += v.output;
      cacheRead += v.cacheRead;
      cacheCreate += v.cacheCreate;
    }

    const pricing = getClaudePricing(model);
    const costUsd =
      (totalInput * pricing.input +
        totalOutput * pricing.output +
        cacheRead * pricing.cacheRead +
        cacheCreate * pricing.cacheWrite) /
      1_000_000;

    const sessionId =
      filePath.split('/').pop()?.replace('.jsonl', '') || '';
    const startHour = firstTs ? new Date(firstTs).getHours() : 0;

    let retryCount = 0;
    let totalEditTurns = 0;
    let mostRetriedFile: string | null = null;
    let mostRetriedFileRetries = 0;
    const perToolCounts: Record<string, { total: number; retried: number }> = {};
    for (const [tool, fileMap] of Object.entries(editsByToolAndFile)) {
      let total = 0;
      let retried = 0;
      for (const [file, count] of Object.entries(fileMap)) {
        total += count;
        if (count > 1) {
          const fileRetries = count - 1;
          retried += fileRetries;
          if (fileRetries > mostRetriedFileRetries) {
            mostRetriedFileRetries = fileRetries;
            mostRetriedFile = file;
          }
        }
      }
      perToolCounts[tool] = { total, retried };
      totalEditTurns += total;
      retryCount += retried;
    }

    const durationMs =
      firstTs && lastTs
        ? Math.max(new Date(lastTs).getTime() - new Date(firstTs).getTime(), 0)
        : 0;

    return {
      sessionId,
      sessionName: sessionName || sessionId.slice(0, 8),
      project: projectName,
      firstTimestamp: firstTs,
      lastTimestamp: lastTs,
      durationMs,
      model,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cacheReadTokens: cacheRead,
      cacheCreateTokens: cacheCreate,
      costUsd,
      turnCount,
      toolCalls,
      toolBreakdown,
      startHour,
      gitBranch,
      prLinks,
      version,
      entrypoint,
      retryCount,
      totalEditTurns,
      mostRetriedFile,
      perToolCounts,
    };
  } catch {
    return null;
  }
}

export async function readClaude(dir?: string): Promise<ClaudeSummary> {
  const claudeDir = dir || join(homedir(), '.claude', 'projects');
  const result: ClaudeSummary = {
    sessions: [],
    totalCost: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreateTokens: 0,
    cacheSavingsUsd: 0,
    toolBreakdown: {},
    hourDistribution: new Array(24).fill(0) as number[],
  };

  try {
    const projects = await readdir(claudeDir);
    for (const project of projects) {
      const projectDir = join(claudeDir, project);
      try {
        const dirInfo = await lstat(projectDir);
        if (dirInfo.isSymbolicLink()) continue;
      } catch {
        continue;
      }

      let files: string[];
      try {
        files = (await readdir(projectDir)).filter((f) =>
          f.endsWith('.jsonl'),
        );
      } catch {
        continue;
      }

      const BATCH_SIZE = 50;
      for (let i = 0; i < files.length; i += BATCH_SIZE) {
        const batch = files.slice(i, i + BATCH_SIZE);
        const sessions = await Promise.all(
          batch.map((f) =>
            parseSessionFile(join(projectDir, f), project),
          ),
        );
        for (const session of sessions) {
          if (session) {
            result.sessions.push(session);
            result.totalCost += session.costUsd;
            result.totalInputTokens += session.inputTokens;
            result.totalOutputTokens += session.outputTokens;
            result.totalCacheReadTokens += session.cacheReadTokens;
            result.totalCacheCreateTokens += session.cacheCreateTokens;
            for (const [tool, count] of Object.entries(
              session.toolBreakdown,
            )) {
              result.toolBreakdown[tool] =
                (result.toolBreakdown[tool] || 0) + count;
            }
            result.hourDistribution[session.startHour]++;
          }
        }
      }
    }

    for (const session of result.sessions) {
      const pricing = getClaudePricing(session.model);
      const savingsPerToken =
        (pricing.input - pricing.cacheRead) / 1_000_000;
      result.cacheSavingsUsd += session.cacheReadTokens * savingsPerToken;
    }

    result.sessions.sort(
      (a, b) =>
        new Date(b.firstTimestamp).getTime() -
        new Date(a.firstTimestamp).getTime(),
    );
  } catch {
    // Directory doesn't exist or is unreadable
  }

  return result;
}
