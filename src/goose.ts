/**
 * Reads session data from the Goose backend SQLite database at
 * ~/.local/share/goose/sessions/sessions.db.
 *
 * Covers sessions from any provider the user configured in Goose —
 * Anthropic API, OpenRouter, Ollama, direct OpenAI, etc. — which fills
 * the gap left by the Claude-Code-only and Codex-only readers.
 *
 * Uses the sqlite3 CLI to avoid native module dependencies.
 */
import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { promisify } from 'util';
import { getClaudePricing, getCodexPricing } from './pricing.js';

const execFileAsync = promisify(execFile);

export interface GooseSession {
  sessionId: string;
  sessionName: string;
  project: string;
  providerName: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  createdAt: string;
  updatedAt: string;
  durationMs: number;
  messageCount: number;
  sessionType: string;
  costUsd: number;
}

export interface GooseSummary {
  sessions: GooseSession[];
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

interface ProviderPricing {
  input: number;
  output: number;
}

const PROVIDER_FALLBACK: Record<string, ProviderPricing> = {
  anthropic: { input: 3, output: 15 },
  openrouter: { input: 3, output: 15 },
  openai: { input: 2.5, output: 10 },
  ollama: { input: 0, output: 0 },
};

function pricingFor(provider: string, model: string): ProviderPricing {
  const lower = model.toLowerCase();
  if (
    lower.includes('claude') ||
    lower.includes('opus') ||
    lower.includes('sonnet') ||
    lower.includes('haiku')
  ) {
    const p = getClaudePricing(model);
    return { input: p.input, output: p.output };
  }
  if (
    lower.includes('gpt') ||
    lower.startsWith('o3') ||
    lower.startsWith('o4') ||
    lower.includes('codex')
  ) {
    const p = getCodexPricing(model);
    return { input: p.input, output: p.output };
  }
  return PROVIDER_FALLBACK[provider] || { input: 3, output: 15 };
}

async function querySqlite(dbPath: string, query: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('sqlite3', ['-json', dbPath, query], {
      encoding: 'utf-8',
      timeout: 15000,
    });
    return stdout || '[]';
  } catch {
    return '[]';
  }
}

function projectName(workDir: string): string {
  if (!workDir) return 'unknown';
  const parts = workDir.split('/').filter(Boolean);
  return parts[parts.length - 1] || workDir;
}

interface GooseRow {
  id: string;
  name: string | null;
  working_dir: string | null;
  provider_name: string;
  model_config_json: string | null;
  input_tokens: number;
  output_tokens: number;
  created_at: string;
  updated_at: string;
  message_count: number | null;
  session_type: string | null;
}

export async function readGoose(dbPath?: string): Promise<GooseSummary> {
  const result: GooseSummary = {
    sessions: [],
    totalCost: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
  };

  const resolvedPath =
    dbPath || join(homedir(), '.local', 'share', 'goose', 'sessions', 'sessions.db');
  if (!existsSync(resolvedPath)) return result;

  const raw = await querySqlite(
    resolvedPath,
    `SELECT id, name, working_dir, provider_name, model_config_json,
            COALESCE(accumulated_input_tokens, input_tokens, 0) as input_tokens,
            COALESCE(accumulated_output_tokens, output_tokens, 0) as output_tokens,
            created_at, updated_at, message_count, session_type
     FROM sessions
     WHERE provider_name IS NOT NULL AND provider_name != ''
     ORDER BY created_at DESC`,
  );

  let rows: GooseRow[] = [];
  try {
    rows = JSON.parse(raw) as GooseRow[];
  } catch {
    return result;
  }

  for (const row of rows) {
    if (!row.input_tokens && !row.output_tokens && !row.message_count) continue;

    let model = 'unknown';
    if (row.model_config_json) {
      try {
        const config = JSON.parse(row.model_config_json) as { model_name?: string };
        model = config.model_name || 'unknown';
      } catch {
        // ignore parse errors
      }
    }

    const pricing = pricingFor(row.provider_name, model);
    const costUsd =
      (row.input_tokens * pricing.input + row.output_tokens * pricing.output) / 1_000_000;

    let createdAt: string;
    let updatedAt: string;
    try {
      createdAt = row.created_at.includes('T')
        ? row.created_at
        : new Date(row.created_at).toISOString();
      updatedAt = row.updated_at.includes('T')
        ? row.updated_at
        : new Date(row.updated_at).toISOString();
    } catch {
      continue;
    }
    const durationMs = new Date(updatedAt).getTime() - new Date(createdAt).getTime();

    result.sessions.push({
      sessionId: row.id,
      sessionName: row.name || row.id.slice(0, 8),
      project: projectName(row.working_dir || ''),
      providerName: row.provider_name,
      model,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      createdAt,
      updatedAt,
      durationMs: Math.max(durationMs, 0),
      messageCount: row.message_count || 0,
      sessionType: row.session_type || 'user',
      costUsd,
    });
    result.totalCost += costUsd;
    result.totalInputTokens += row.input_tokens;
    result.totalOutputTokens += row.output_tokens;
  }

  return result;
}
