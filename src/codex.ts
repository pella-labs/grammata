/**
 * Reads Codex session data from ~/.codex/sessions/ JSONL rollout files.
 * Each session has per-turn token breakdowns (input, cached, output, reasoning).
 * Falls back to SQLite threads table for session metadata (title, cwd, git branch).
 */
import { readdir, readFile, lstat } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { CODEX_PRICING, getCodexPricing } from './pricing.js';

export { CODEX_PRICING };

const execFileAsync = promisify(execFile);
const MAX_FILE_SIZE = 50 * 1024 * 1024;

export interface CodexSession {
  sessionId: string;
  sessionName: string;
  project: string;
  model: string;
  modelProvider: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number;
  createdAt: string;
  updatedAt: string;
  durationMs: number;
  source: string;
  gitBranch: string;
  toolBreakdown: Record<string, number>;
  reasoningBlocks: number;
  messageCount: number;
  webSearches: number;
}

export interface CodexSummary {
  sessions: CodexSession[];
  totalCost: number;
  totalInputTokens: number;
  totalCachedInputTokens: number;
  totalOutputTokens: number;
  toolBreakdown: Record<string, number>;
  totalReasoningBlocks: number;
  totalWebSearches: number;
  totalTasks: number;
}

interface ThreadMetaEntry {
  title: string;
  firstMessage: string;
  cwd: string;
  source: string;
  gitBranch: string;
}

interface ThreadRow {
  id: string;
  title?: string;
  first_user_message?: string;
  cwd?: string;
  source?: string;
  git_branch?: string;
}

interface ParsedSessionData {
  sessionId: string;
  model: string;
  cwd: string;
  source: string;
  firstTimestamp: string;
  lastTimestamp: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  toolBreakdown: Record<string, number>;
  reasoningBlocks: number;
  messageCount: number;
  webSearches: number;
}

async function loadThreadMeta(
  codexDir: string,
): Promise<Map<string, ThreadMetaEntry>> {
  const meta = new Map<string, ThreadMetaEntry>();

  const stateFiles = [
    'state_5.sqlite',
    'state_4.sqlite',
    'state_3.sqlite',
    'state.sqlite',
  ];
  let dbPath = '';
  for (const f of stateFiles) {
    const p = join(codexDir, f);
    if (existsSync(p)) {
      dbPath = p;
      break;
    }
  }
  if (!dbPath) return meta;

  try {
    const { stdout } = await execFileAsync(
      'sqlite3',
      [
        '-json',
        dbPath,
        `SELECT id, substr(title, 1, 100) as title,
              substr(first_user_message, 1, 200) as first_user_message,
              substr(cwd, 1, 300) as cwd, source, git_branch
       FROM threads`,
      ],
      { encoding: 'utf-8', timeout: 15000 },
    );
    const rows = JSON.parse(stdout) as ThreadRow[];
    for (const row of rows) {
      meta.set(row.id, {
        title: row.title || '',
        firstMessage: (row.first_user_message || '').slice(0, 200),
        cwd: row.cwd || '',
        source: row.source || 'cli',
        gitBranch: row.git_branch || '',
      });
    }
  } catch {
    // SQLite unavailable
  }

  return meta;
}

function projectName(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean);
  return parts[parts.length - 1] || cwd;
}

async function parseSessionFile(
  filePath: string,
): Promise<ParsedSessionData | null> {
  try {
    const fileInfo = await lstat(filePath);
    if (fileInfo.isSymbolicLink() || fileInfo.size > MAX_FILE_SIZE)
      return null;

    const content = await readFile(filePath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim());

    let model = '';
    let sessionId = '';
    let cwd = '';
    let source = '';
    let firstTs = '';
    let lastTs = '';
    let inputTokens = 0;
    let cachedInputTokens = 0;
    let outputTokens = 0;
    const toolBreakdown: Record<string, number> = {};
    let reasoningBlocks = 0;
    let messageCount = 0;
    let webSearches = 0;

    for (const line of lines) {
      try {
        const d = JSON.parse(line) as Record<string, unknown>;

        if (d.timestamp) {
          if (!firstTs) firstTs = d.timestamp as string;
          lastTs = d.timestamp as string;
        }

        if (d.type === 'session_meta') {
          const payload = d.payload as Record<string, unknown> | undefined;
          sessionId = (payload?.id as string) || '';
          cwd = (payload?.cwd as string) || '';
          source =
            (payload?.source as string) ||
            (payload?.originator as string) ||
            '';
        }

        if (d.type === 'turn_context') {
          const payload = d.payload as Record<string, unknown> | undefined;
          const m = payload?.model as string | undefined;
          if (m) model = m;
        }

        if (
          d.type === 'event_msg' &&
          (d.payload as Record<string, unknown>)?.type === 'token_count' &&
          (d.payload as Record<string, unknown>)?.info
        ) {
          const info = (d.payload as Record<string, unknown>).info as Record<
            string,
            unknown
          >;
          const usage = info.last_token_usage as Record<string, number> | undefined;
          if (usage) {
            inputTokens += usage.input_tokens || 0;
            cachedInputTokens += usage.cached_input_tokens || 0;
            outputTokens += usage.output_tokens || 0;
          }
        }

        // Tool calls
        if (d.type === 'response_item') {
          const payload = d.payload as Record<string, unknown> | undefined;
          const pt = (payload?.type as string) || '';
          if (pt === 'function_call') {
            const name = (payload?.name as string) || 'unknown';
            toolBreakdown[name] = (toolBreakdown[name] || 0) + 1;
          } else if (pt === 'custom_tool_call') {
            const name = (payload?.name as string) || 'unknown';
            toolBreakdown[name] = (toolBreakdown[name] || 0) + 1;
          } else if (pt === 'reasoning') {
            reasoningBlocks++;
          } else if (pt === 'message') {
            messageCount++;
          } else if (pt === 'web_search_call') {
            webSearches++;
          }
        }
      } catch {
        // Skip malformed lines
      }
    }

    if (inputTokens === 0 && outputTokens === 0) return null;

    return {
      sessionId,
      model: model || 'unknown',
      cwd,
      source,
      firstTimestamp: firstTs,
      lastTimestamp: lastTs,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      toolBreakdown,
      reasoningBlocks,
      messageCount,
      webSearches,
    };
  } catch {
    return null;
  }
}

export async function readCodex(dir?: string): Promise<CodexSummary> {
  const codexDir = dir || join(homedir(), '.codex');
  const sessionsDir = join(codexDir, 'sessions');

  const result: CodexSummary = {
    sessions: [],
    totalCost: 0,
    totalInputTokens: 0,
    totalCachedInputTokens: 0,
    totalOutputTokens: 0,
    toolBreakdown: {},
    totalReasoningBlocks: 0,
    totalWebSearches: 0,
    totalTasks: 0,
  };

  if (!existsSync(sessionsDir)) return result;

  const threadMeta = await loadThreadMeta(codexDir);

  try {
    // Walk ~/.codex/sessions/YYYY/MM/DD/*.jsonl
    const jsonlFiles: string[] = [];

    const years = await readdir(sessionsDir);
    for (const year of years) {
      const yearDir = join(sessionsDir, year);
      try {
        const info = await lstat(yearDir);
        if (!info.isDirectory() || info.isSymbolicLink()) continue;
      } catch {
        continue;
      }

      const months = await readdir(yearDir).catch(() => [] as string[]);
      for (const month of months) {
        const monthDir = join(yearDir, month);
        try {
          const info = await lstat(monthDir);
          if (!info.isDirectory() || info.isSymbolicLink()) continue;
        } catch {
          continue;
        }

        const days = await readdir(monthDir).catch(() => [] as string[]);
        for (const day of days) {
          const dayDir = join(monthDir, day);
          try {
            const info = await lstat(dayDir);
            if (!info.isDirectory() || info.isSymbolicLink()) continue;
          } catch {
            continue;
          }

          const files = await readdir(dayDir).catch(() => [] as string[]);
          for (const f of files) {
            if (f.endsWith('.jsonl')) jsonlFiles.push(join(dayDir, f));
          }
        }
      }
    }

    const BATCH_SIZE = 50;
    for (let i = 0; i < jsonlFiles.length; i += BATCH_SIZE) {
      const batch = jsonlFiles.slice(i, i + BATCH_SIZE);
      const parsed = await Promise.all(
        batch.map((f) => parseSessionFile(f)),
      );

      for (const sess of parsed) {
        if (!sess) continue;

        const pricing = getCodexPricing(sess.model);
        const uncachedInput = sess.inputTokens - sess.cachedInputTokens;
        const costUsd =
          (uncachedInput * pricing.input +
            sess.cachedInputTokens * pricing.cachedInput +
            sess.outputTokens * pricing.output) /
          1_000_000;

        const meta = threadMeta.get(sess.sessionId);
        const durationMs =
          sess.firstTimestamp && sess.lastTimestamp
            ? new Date(sess.lastTimestamp).getTime() -
              new Date(sess.firstTimestamp).getTime()
            : 0;

        result.sessions.push({
          sessionId: sess.sessionId || '',
          sessionName:
            meta?.title ||
            meta?.firstMessage?.slice(0, 80) ||
            sess.sessionId?.slice(0, 8) ||
            '',
          project: projectName(meta?.cwd || sess.cwd || ''),
          model: sess.model,
          modelProvider: 'openai',
          inputTokens: sess.inputTokens,
          cachedInputTokens: sess.cachedInputTokens,
          outputTokens: sess.outputTokens,
          costUsd,
          createdAt: sess.firstTimestamp,
          updatedAt: sess.lastTimestamp,
          durationMs: Math.max(durationMs, 0),
          source: meta?.source || sess.source || 'cli',
          gitBranch: meta?.gitBranch || '',
          toolBreakdown: sess.toolBreakdown,
          reasoningBlocks: sess.reasoningBlocks,
          messageCount: sess.messageCount,
          webSearches: sess.webSearches,
        });

        result.totalCost += costUsd;
        result.totalInputTokens += sess.inputTokens;
        result.totalCachedInputTokens += sess.cachedInputTokens;
        result.totalOutputTokens += sess.outputTokens;
        result.totalReasoningBlocks += sess.reasoningBlocks;
        result.totalWebSearches += sess.webSearches;

        for (const [tool, count] of Object.entries(sess.toolBreakdown)) {
          result.toolBreakdown[tool] =
            (result.toolBreakdown[tool] || 0) + count;
        }
      }
    }
  } catch {
    // Directory unreadable
  }

  return result;
}
