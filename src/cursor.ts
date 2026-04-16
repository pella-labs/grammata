/**
 * Reads Cursor AI session data from the Cursor SQLite database.
 * Cursor stores data in a VSCode-based state DB at:
 *   macOS:   ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
 *   Windows: ~/AppData/Roaming/Cursor/User/globalStorage/state.vscdb
 *   Linux:   ~/.config/Cursor/User/globalStorage/state.vscdb
 *
 * Data sources within the DB:
 *   - cursorDiskKV 'composerData:*'       — full session data (model, messages, lines changed)
 *   - ItemTable 'composer.composerHeaders' — workspace/project mapping for recent sessions
 *   - ItemTable 'aiCodeTracking.dailyStats.*' — daily tab/composer lines suggested/accepted
 *
 * Note: Cursor does NOT expose per-message token counts (always 0/0),
 * so cost is estimated from message counts and model pricing.
 */
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface CursorSession {
  sessionId: string;
  sessionName: string;
  project: string;
  mode: string; // 'agent' | 'chat'
  model: string;
  createdAt: string;
  messageCount: number;
  linesAdded: number;
  linesRemoved: number;
  /** Cursor doesn't expose token counts — always 0 */
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface CursorDailyStats {
  date: string;
  tabSuggestedLines: number;
  tabAcceptedLines: number;
  composerSuggestedLines: number;
  composerAcceptedLines: number;
}

export interface CursorDailyActivity {
  date: string;
  messages: number;
  toolCalls: number;
}

export interface CursorSummary {
  sessions: CursorSession[];
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalMessages: number;
  totalLinesAdded: number;
  totalLinesRemoved: number;
  totalFilesCreated: number;
  models: Record<string, { sessions: number; cost: number }>;
  toolBreakdown: Record<string, number>;
  totalToolCalls: number;
  thinkingTimeMs: number;
  turnTimeMs: number;
  dailyActivity: CursorDailyActivity[];
  dailyStats: CursorDailyStats[];
  totalTabSuggestedLines: number;
  totalTabAcceptedLines: number;
  totalComposerSuggestedLines: number;
  totalComposerAcceptedLines: number;
}

function getDbPath(): string | null {
  const home = homedir();
  const platform = process.platform;

  let dbPath: string;
  if (platform === 'darwin') {
    dbPath = join(
      home,
      'Library',
      'Application Support',
      'Cursor',
      'User',
      'globalStorage',
      'state.vscdb',
    );
  } else if (platform === 'win32') {
    dbPath = join(
      home,
      'AppData',
      'Roaming',
      'Cursor',
      'User',
      'globalStorage',
      'state.vscdb',
    );
  } else {
    dbPath = join(
      home,
      '.config',
      'Cursor',
      'User',
      'globalStorage',
      'state.vscdb',
    );
  }

  return existsSync(dbPath) ? dbPath : null;
}

interface KVRow {
  key: string;
  value: string;
}

interface ComposerRow {
  id: string;
  created: number;
  mode: string;
  model: string;
  lines_added: number;
  lines_removed: number;
  msg_count: number;
}

interface DailyStatsData {
  date: string;
  tabSuggestedLines?: number;
  tabAcceptedLines?: number;
  composerSuggestedLines?: number;
  composerAcceptedLines?: number;
}

async function queryJson<T>(dbPath: string, sql: string): Promise<T | null> {
  try {
    const { stdout } = await execFileAsync(
      'sqlite3',
      ['-json', dbPath, sql],
      { encoding: 'utf-8', timeout: 30000, maxBuffer: 50 * 1024 * 1024 },
    );
    if (!stdout.trim()) return null;
    return JSON.parse(stdout) as T;
  } catch {
    return null;
  }
}

function projectFromPath(fsPath: string): string {
  const parts = fsPath.split('/').filter(Boolean);
  return parts[parts.length - 1] || fsPath;
}

export async function readCursor(dbPathOverride?: string): Promise<CursorSummary> {
  const result: CursorSummary = {
    sessions: [],
    totalCost: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalMessages: 0,
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    totalFilesCreated: 0,
    models: {},
    toolBreakdown: {},
    totalToolCalls: 0,
    thinkingTimeMs: 0,
    turnTimeMs: 0,
    dailyActivity: [],
    dailyStats: [],
    totalTabSuggestedLines: 0,
    totalTabAcceptedLines: 0,
    totalComposerSuggestedLines: 0,
    totalComposerAcceptedLines: 0,
  };

  const dbPath = dbPathOverride || getDbPath();
  if (!dbPath) return result;

  // Run all queries in parallel
  const [composerRows, headerWorkspaces, statsRows, toolRows, timingRows, filesCreated, dailyActivityRows] = await Promise.all([
    // 1. All sessions from composerData — uses json_extract for speed
    //    (SQLite does the parsing, no need to ship 465 full JSON blobs to Node)
    queryJson<ComposerRow[]>(
      dbPath,
      `SELECT
         json_extract(value, '$.composerId') as id,
         json_extract(value, '$.createdAt') as created,
         COALESCE(json_extract(value, '$.unifiedMode'), 'agent') as mode,
         COALESCE(json_extract(value, '$.modelConfig.modelName'), 'unknown') as model,
         COALESCE(json_extract(value, '$.totalLinesAdded'), 0) as lines_added,
         COALESCE(json_extract(value, '$.totalLinesRemoved'), 0) as lines_removed,
         COALESCE(json_array_length(json_extract(value, '$.fullConversationHeadersOnly')), 0) as msg_count
       FROM cursorDiskKV
       WHERE key LIKE 'composerData:%'
       ORDER BY json_extract(value, '$.createdAt') DESC`,
    ),

    // 2. Workspace/project mapping from composerData entries that have it +
    //    from composer.composerHeaders (for recent sessions)
    queryJson<Array<{ id: string; ws: string }>>(
      dbPath,
      `SELECT
         json_extract(value, '$.composerId') as id,
         json_extract(value, '$.workspaceIdentifier') as ws
       FROM cursorDiskKV
       WHERE key LIKE 'composerData:%'
       AND value LIKE '%workspaceIdentifier%'`,
    ),

    // 3. Daily code tracking stats
    queryJson<KVRow[]>(
      dbPath,
      `SELECT key, value FROM ItemTable WHERE key LIKE 'aiCodeTracking.dailyStats.%'`,
    ),

    // 4. Tool calls — aggregated by tool name (only completed)
    queryJson<Array<{ tool_name: string; cnt: number }>>(
      dbPath,
      `SELECT
         json_extract(CAST(value AS TEXT), '$.toolFormerData.name') as tool_name,
         COUNT(*) as cnt
       FROM cursorDiskKV
       WHERE key LIKE 'bubbleId:%'
       AND CAST(value AS TEXT) LIKE '%toolFormerData%'
       AND json_extract(CAST(value AS TEXT), '$.toolFormerData.status') = 'completed'
       GROUP BY tool_name
       ORDER BY cnt DESC`,
    ),

    // 5. Timing — aggregate thinking + turn duration
    queryJson<Array<{ total_thinking_ms: number; total_turn_ms: number }>>(
      dbPath,
      `SELECT
         COALESCE(SUM(json_extract(CAST(value AS TEXT), '$.thinkingDurationMs')), 0) as total_thinking_ms,
         COALESCE(SUM(json_extract(CAST(value AS TEXT), '$.turnDurationMs')), 0) as total_turn_ms
       FROM cursorDiskKV
       WHERE key LIKE 'bubbleId:%'
       AND (CAST(value AS TEXT) LIKE '%thinkingDurationMs%'
            OR CAST(value AS TEXT) LIKE '%turnDurationMs%')`,
    ),

    // 6. Files created — from composerData
    queryJson<Array<{ total: number }>>(
      dbPath,
      `SELECT
         COALESCE(SUM(json_array_length(
           COALESCE(json_extract(value, '$.newlyCreatedFiles'), '[]')
         )), 0) as total
       FROM cursorDiskKV WHERE key LIKE 'composerData:%'`,
    ),

    // 7. Daily activity — messages and tool calls per day from bubble timestamps
    queryJson<Array<{ day: string; msgs: number; tools: number }>>(
      dbPath,
      `SELECT
         substr(json_extract(CAST(value AS TEXT), '$.createdAt'), 1, 10) as day,
         COUNT(*) as msgs,
         SUM(CASE WHEN CAST(value AS TEXT) LIKE '%toolFormerData%'
             AND json_extract(CAST(value AS TEXT), '$.toolFormerData.status') = 'completed'
             THEN 1 ELSE 0 END) as tools
       FROM cursorDiskKV
       WHERE key LIKE 'bubbleId:%'
       AND json_extract(CAST(value AS TEXT), '$.createdAt') IS NOT NULL
       GROUP BY day
       ORDER BY day`,
    ),
  ]);

  if (!composerRows || composerRows.length === 0) return result;

  // ── Build workspace mapping ──────────────────────────────
  const projectMap = new Map<string, string>();

  // From composerData workspaceIdentifier
  if (headerWorkspaces) {
    for (const row of headerWorkspaces) {
      if (!row.ws) continue;
      try {
        const ws = JSON.parse(row.ws) as {
          uri?: { fsPath?: string };
        };
        if (ws.uri?.fsPath) {
          projectMap.set(row.id, projectFromPath(ws.uri.fsPath));
        }
      } catch { /* skip */ }
    }
  }

  // Also merge from composer.composerHeaders (may have more workspace info)
  try {
    const { stdout } = await execFileAsync(
      'sqlite3',
      [
        dbPath,
        "SELECT value FROM ItemTable WHERE key = 'composer.composerHeaders'",
      ],
      { encoding: 'utf-8', timeout: 10000 },
    );
    if (stdout.trim()) {
      const headers = JSON.parse(stdout.trim()) as {
        allComposers: Array<{
          composerId: string;
          workspaceIdentifier?: { uri?: { fsPath?: string } };
        }>;
      };
      for (const h of headers.allComposers || []) {
        if (!projectMap.has(h.composerId) && h.workspaceIdentifier?.uri?.fsPath) {
          projectMap.set(
            h.composerId,
            projectFromPath(h.workspaceIdentifier.uri.fsPath),
          );
        }
      }
    }
  } catch { /* skip */ }

  // ── Build sessions ───────────────────────────────────────
  for (const row of composerRows) {
    // Skip empty sessions (no messages)
    if (row.msg_count === 0) continue;

    const model = row.model || 'unknown';
    const createdAt = row.created
      ? new Date(row.created).toISOString()
      : '';

    const session: CursorSession = {
      sessionId: row.id,
      sessionName: row.id.slice(0, 8),
      project: projectMap.get(row.id) || '',
      mode: row.mode,
      model,
      createdAt,
      messageCount: row.msg_count,
      linesAdded: row.lines_added,
      linesRemoved: row.lines_removed,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };

    result.sessions.push(session);
    result.totalMessages += row.msg_count;
    result.totalLinesAdded += row.lines_added;
    result.totalLinesRemoved += row.lines_removed;

    const modelEntry = result.models[model] || { sessions: 0, cost: 0 };
    modelEntry.sessions++;
    result.models[model] = modelEntry;
  }

  // ── Tool breakdown ────────────────────────────────────────
  if (toolRows) {
    for (const row of toolRows) {
      if (row.tool_name) {
        result.toolBreakdown[row.tool_name] = row.cnt;
        result.totalToolCalls += row.cnt;
      }
    }
  }

  // ── Timing data ──────────────────────────────────────────
  if (timingRows && timingRows[0]) {
    result.thinkingTimeMs = timingRows[0].total_thinking_ms || 0;
    result.turnTimeMs = timingRows[0].total_turn_ms || 0;
  }

  // ── Files created ────────────────────────────────────────
  if (filesCreated && filesCreated[0]) {
    result.totalFilesCreated = filesCreated[0].total || 0;
  }

  // ── Daily activity ────────────────────────────────────────
  if (dailyActivityRows) {
    for (const row of dailyActivityRows) {
      if (row.day) {
        result.dailyActivity.push({
          date: row.day,
          messages: row.msgs,
          toolCalls: row.tools,
        });
      }
    }
  }

  // ── Parse daily code tracking stats ──────────────────────
  if (statsRows) {
    for (const row of statsRows) {
      try {
        const data = JSON.parse(row.value) as DailyStatsData;
        const stats: CursorDailyStats = {
          date: data.date || '',
          tabSuggestedLines: data.tabSuggestedLines || 0,
          tabAcceptedLines: data.tabAcceptedLines || 0,
          composerSuggestedLines: data.composerSuggestedLines || 0,
          composerAcceptedLines: data.composerAcceptedLines || 0,
        };
        result.dailyStats.push(stats);
        result.totalTabSuggestedLines += stats.tabSuggestedLines;
        result.totalTabAcceptedLines += stats.tabAcceptedLines;
        result.totalComposerSuggestedLines += stats.composerSuggestedLines;
        result.totalComposerAcceptedLines += stats.composerAcceptedLines;
      } catch {
        // Skip malformed
      }
    }
    result.dailyStats.sort((a, b) => a.date.localeCompare(b.date));
  }

  return result;
}
