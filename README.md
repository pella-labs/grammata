# grammata

Read and aggregate coding agent usage data from your local machine. Parses session data from **Claude Code** (`~/.claude/`), **Codex** (`~/.codex/`), **Cursor** (SQLite DB), and **Goose** (`~/.local/share/goose/`) to give you accurate cost, token, and activity breakdowns.

Zero external dependencies. Reads session files and databases directly from disk.

Powers [**Pellametric**](https://www.pellametric.com) — the stats-card backend — but usable standalone. Follow [@pellametric](https://x.com/pellametric) for updates.

> **v0.3** adds a Goose DB reader, cross-source deduplication (`mergeAll`), retry / branch / cost-velocity analytics, and a one-call `analyze()` that returns a full dashboard object in one pass.

Part of the [Pella Labs](https://github.com/pella-labs) ecosystem. See also [@pella-labs/pinakes](https://www.npmjs.com/package/@pella-labs/pinakes) for building knowledge graphs over your codebase.

## Install

```bash
npm install grammata
```

## Quick Start

**Dashboard in one call** — same shape a UI would render:

```typescript
import { analyze } from 'grammata';

const data = await analyze();

console.log(`Sessions:        ${data.totalSessions}`);
console.log(`Total cost:      $${data.totalCost.toFixed(2)}`);
console.log(`Cache savings:   $${data.cacheSavingsUsd.toFixed(2)}`);
console.log(`First-try rate:  ${(data.retryStats.firstTryRate * 100).toFixed(1)}%`);
console.log(`Peak hour:       ${data.peakHour}`);
console.log(`Favorite model:  ${data.favoriteModel}`);
console.log(`Top branch:      ${data.branchCosts[0]?.project}@${data.branchCosts[0]?.branch}`);
```

**Per-source summaries** — if you only want totals:

```typescript
import { readAll } from 'grammata';

const data = await readAll();

console.log(`Total cost: $${data.combined.totalCost.toFixed(2)}`);
console.log(`Sessions:   ${data.combined.totalSessions}`);
console.log(`Claude:     $${data.claude.cost.toFixed(2)} (${data.claude.sessions} sessions)`);
console.log(`Codex:      $${data.codex.cost.toFixed(2)} (${data.codex.sessions} sessions)`);
console.log(`Cursor:     ${data.cursor.sessions} sessions, ${data.cursor.totalMessages} messages`);
console.log(`Goose:      $${data.goose.cost.toFixed(2)} (${data.goose.sessions} sessions)`);
```

## API

### `readAll()`

Returns a combined summary across all sources.

```typescript
const data = await readAll();

data.claude.sessions        // number of Claude Code sessions
data.claude.cost            // total cost in USD
data.claude.inputTokens     // total input tokens
data.claude.outputTokens    // total output tokens
data.claude.cacheReadTokens // total cache read tokens
data.claude.cacheSavingsUsd // how much caching saved you
data.claude.models          // { 'claude-opus-4-6': { sessions: 100, cost: 500 } }
data.claude.topTools        // [{ name: 'Bash', count: 14877 }, ...]
data.claude.hourDistribution // 24-element array, index = hour
data.claude.activeDays      // number of unique days with sessions

data.codex.sessions         // number of Codex sessions
data.codex.cost             // total cost in USD
data.codex.inputTokens      // total input tokens (includes cached)
data.codex.cachedInputTokens // cached portion of input
data.codex.outputTokens     // total output tokens
data.codex.models           // { 'gpt-5.3-codex': { sessions: 47, cost: 558 } }

data.cursor.sessions        // number of Cursor sessions
data.cursor.totalMessages   // total messages across all sessions
data.cursor.totalToolCalls  // total tool calls (read, edit, terminal, grep, etc.)
data.cursor.topTools        // [{ name: 'read_file_v2', count: 10466 }, ...]
data.cursor.totalLinesAdded // lines of code added
data.cursor.totalLinesRemoved // lines of code removed
data.cursor.totalFilesCreated // new files created
data.cursor.thinkingTimeMs  // total AI thinking time in milliseconds
data.cursor.turnTimeMs      // total AI response time in milliseconds
data.cursor.models          // { 'claude-4.5-sonnet': { sessions: 42, cost: 0 } }
data.cursor.dailyActivity   // [{ date, messages, toolCalls }, ...]

data.combined.totalCost     // claude + codex + cursor
data.combined.totalSessions // claude + codex + cursor
```

### `readClaude(dir?)`

Read only Claude Code data. Optionally pass a custom directory (defaults to `~/.claude/projects`).

```typescript
import { readClaude } from 'grammata';

const claude = await readClaude();

for (const session of claude.sessions) {
  console.log(session.sessionName, session.model, `$${session.costUsd.toFixed(2)}`);
}
```

**Session fields:** `sessionId`, `sessionName`, `project`, `model`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreateTokens`, `costUsd`, `turnCount`, `toolCalls`, `toolBreakdown`, `startHour`, `firstTimestamp`, `lastTimestamp`, `gitBranch`, `prLinks`, `version`, `entrypoint`, `retryCount`, `totalEditTurns`, `mostRetriedFile`, `perToolCounts`

### `readCodex(dir?)`

Read only Codex data. Optionally pass a custom directory (defaults to `~/.codex`).

```typescript
import { readCodex } from 'grammata';

const codex = await readCodex();

for (const session of codex.sessions) {
  console.log(session.model, `$${session.costUsd.toFixed(2)}`, session.project);
}
```

**Session fields:** `sessionId`, `sessionName`, `firstMessage`, `project`, `model`, `modelProvider`, `inputTokens`, `cachedInputTokens`, `outputTokens`, `costUsd`, `durationMs`, `createdAt`, `updatedAt`, `source`, `gitBranch`, `approvalMode`, `toolBreakdown`, `reasoningBlocks`, `messageCount`, `webSearches`

### `readCursor(dbPath?)`

Read only Cursor data. Optionally pass a custom path to `state.vscdb`.

```typescript
import { readCursor } from 'grammata';

const cursor = await readCursor();

console.log(`Sessions: ${cursor.sessions.length}`);
console.log(`Messages: ${cursor.totalMessages}`);
console.log(`Tool calls: ${cursor.totalToolCalls}`);
console.log(`Lines: +${cursor.totalLinesAdded} / -${cursor.totalLinesRemoved}`);

for (const [tool, count] of Object.entries(cursor.toolBreakdown)) {
  console.log(`  ${tool}: ${count}`);
}
```

**Session fields:** `sessionId`, `sessionName`, `project`, `mode`, `model`, `createdAt`, `messageCount`, `linesAdded`, `linesRemoved`

**Summary fields:** `totalMessages`, `totalToolCalls`, `toolBreakdown`, `totalLinesAdded`, `totalLinesRemoved`, `totalFilesCreated`, `thinkingTimeMs`, `turnTimeMs`, `dailyActivity`, `dailyStats` (tab/composer completions)

> **Note:** Cursor does not expose token counts or cost data in its local database. All billing happens server-side. grammata tracks sessions, messages, tool usage, lines changed, timing, and code completion stats instead.

### `readGoose(dbPath?)`

Read sessions from the Goose backend SQLite database. Defaults to `~/.local/share/goose/sessions/sessions.db`. Covers any provider Goose was configured with — Anthropic API, OpenRouter, Ollama, direct OpenAI — filling the gap left by the Claude-Code-only and Codex-only readers.

```typescript
import { readGoose } from 'grammata';

const goose = await readGoose();

for (const session of goose.sessions) {
  console.log(session.providerName, session.model, `$${session.costUsd.toFixed(2)}`);
}
```

**Session fields:** `sessionId`, `sessionName`, `project`, `providerName`, `model`, `inputTokens`, `outputTokens`, `createdAt`, `updatedAt`, `durationMs`, `messageCount`, `sessionType`, `costUsd`

**Summary fields:** `sessions`, `totalCost`, `totalInputTokens`, `totalOutputTokens`

> Requires `sqlite3` in PATH.

### `analyze()`

One call, everything. Reads all four sources in parallel, deduplicates sessions across them, and computes the full analytics object the Bematist dashboard renders.

```typescript
import { analyze } from 'grammata';

const data = await analyze();

data.totalSessions          // total across all sources
data.totalCost              // total across all sources
data.cacheSavingsUsd        // what caching saved
data.costTrend              // { currentWeekCost, previousWeekCost, changePercent }

data.dailyCosts             // [{ date, cost, tokens, sessions }, ...]
data.modelBreakdowns        // [{ model, provider, cost, sessionCount, ... }, ...]
data.sessionRows            // UnifiedSession[] — deduped across sources
data.toolUsage              // [{ name, count }, ...]
data.projectBreakdowns      // [{ project, cost, sessions, sources }, ...]
data.categoryBreakdowns     // [{ category: 'Building' | 'Investigating' | ..., sessions, cost }, ...]
data.hourDistribution       // number[24]

data.branchCosts            // [{ project, branch, cost, sessions, tokens }, ...]
data.cacheStats             // { hitRate, savingsUsd, cacheWriteTokens, ... }
data.costVelocity           // [{ date, cost, hours, costPerHour }, ...]
data.retryStats             // { firstTryRate, retryCostUsd, mostRetriedTool, mostRetriedFile, worstSession, perTool, ... }

data.sourceStats            // { 'claude-code': {...}, codex: {...}, cursor: {...}, goose: {...} }
data.providerStats          // { anthropic: {...}, openai: {...}, ... }

data.peakHour               // 0–23
data.mostExpensiveSession   // UnifiedSession | null
data.favoriteModel          // e.g. 'claude-opus-4-6'
data.favoriteTool           // e.g. 'Bash'
```

### `mergeAll(claude, codex, cursor, goose)`

Lower-level primitive: takes the four per-source summaries and returns a deduplicated `UnifiedSession[]` with normalized tool names and source/provider breakdowns. Use this if you want per-session access without running the full analytics aggregation.

```typescript
import { readClaude, readCodex, readCursor, readGoose, mergeAll } from 'grammata';

const merged = mergeAll(
  await readClaude(),
  await readCodex(),
  await readCursor(),
  await readGoose(),
);

for (const session of merged.sessions) {
  console.log(session.source, session.project, session.model, `$${session.cost.toFixed(2)}`);
}
```

**Priority** when the same `sessionId` appears in multiple sources: Claude JSONL > Codex > Cursor > Goose (Claude ships the richest per-session data). Goose sessions flagged as `claude-code` / `claude-acp` are skipped — they're already captured by the JSONL reader.

**Tool name normalization**: Codex `exec_command`/`shell*` → `Bash`, `apply_patch` → `Edit`, etc. Cursor `read_file_v2` → `Read`, `edit_file_v2` → `Edit`, etc. This lets consumers aggregate tool usage across sources without re-learning each agent's naming.

### `buildAnalytics(merged)`

Takes a `MergedUsage` from `mergeAll` and computes the same dashboard object `analyze()` returns. Useful if you already have merged sessions (e.g. from a cached read) and just want the compute.

```typescript
import { mergeAll, buildAnalytics } from 'grammata';

const data = buildAnalytics(mergeAll(claude, codex, cursor, goose));
```

### Analytics helpers

All exported individually — use them if you want just one metric without the full dashboard.

```typescript
import {
  classifySession,       // ToolBreakdown → 'Building' | 'Investigating' | 'Debugging' | 'Testing' | 'Refactoring' | 'Other'
  computeCostTrend,      // UnifiedSession[] → { currentWeekCost, previousWeekCost, changePercent }
  computeBranchCosts,    // UnifiedSession[] → BranchCost[]
  computeCacheStats,     // (sessions, cacheSavingsUsd) → { hitRate, totalCacheRead, ... }
  computeCostVelocity,   // UnifiedSession[] → CostVelocityPoint[]
  computeRetryStats,     // UnifiedSession[] → { firstTryRate, retryCostUsd, perTool, ... }
} from 'grammata';
```

Retry detection works off of Claude's `editsByToolAndFile` tracking: if a file is edited more than once in a session, `(edits - 1)` count as retries. Codex / Cursor / Goose sessions currently don't expose per-file edit history, so they contribute 0 retries — `firstTryRate` reflects Claude Code sessions only.

### Formatting Helpers

```typescript
import { formatCost, formatTokens, formatDuration } from 'grammata';

formatCost(4382.95)        // "$4383"
formatCost(42.5)           // "$42.50"
formatCost(0.003)          // "$0.0030"

formatTokens(6_771_925_747) // "6.8B"
formatTokens(2_300_000)     // "2.3M"
formatTokens(45_000)        // "45.0K"

formatDuration(5_400_000)   // "1.5h"
formatDuration(300_000)     // "5m"
```

### Pricing Tables

Access the pricing tables directly if you need custom cost calculations:

```typescript
import { CLAUDE_PRICING, CODEX_PRICING, getClaudePricing, getCodexPricing } from 'grammata';

// Per-million-token rates
const opus = getClaudePricing('claude-opus-4-6');
// { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }

const codex = getCodexPricing('gpt-5.3-codex');
// { input: 1.75, output: 14, cachedInput: 0.175 }
```

## CLI

```bash
npx grammata                    # full summary (default)
npx grammata analytics          # full dashboard (retry, branches, velocity, cache, categories)
npx grammata a                  # alias for analytics
npx grammata claude             # Claude Code: cost, tokens, models, tools, projects
npx grammata codex              # Codex: cost, tokens, models, projects
npx grammata cursor             # Cursor: sessions, messages, tools, lines, timing
npx grammata sessions           # list all sessions (most recent first)
npx grammata models             # model breakdown across all sources
npx grammata tools              # tool usage ranking with bar chart
npx grammata tokens             # token breakdown by source
npx grammata cost               # cost summary + cache savings
npx grammata daily              # day-by-day costs with chart
npx grammata hours              # activity by hour of day
npx grammata <token>            # submit a stats card (e.g. npx grammata bm_abc-123-xyz)
npx pellametric <token>         # same, hits https://www.pellametric.com/api
npx bematist <token>            # same, hits https://bematist.dev/api
npx grammata <token> --api-url http://localhost:3000/api   # override ingest URL
```

All commands support `--json` for machine-readable output and `--since`/`--until` for date filtering:

```bash
npx grammata cost --json
npx grammata models --json
npx grammata daily --since 2026-04-01
npx grammata cursor --json
```

Example output (`npx grammata`):

```
  grammata
  ─────────────────────────────────────

  Claude Code
    Sessions:       3145
    Cost:           $7866
    Input tokens:   2.4M
    Output tokens:  28.2M
    Cache read:     11.0B
    Active days:    35
    Top tools:      Bash(16312), Read(14683), Edit(8195), Grep(3555), Write(3108)

    Models:
      claude-opus-4-6                     $7618  (1547 sessions)
      claude-haiku-4-5-20251001          $94.53  (1352 sessions)
      claude-sonnet-4-6                  $24.64  (75 sessions)

  Codex
    Sessions:       80
    Cost:           $698.25
    Input tokens:   2.3B
    Cached input:   2.2B
    Output tokens:  9.1M

    Models:
      gpt-5.3-codex                     $558.32  (47 sessions)
      gpt-5.2-codex                      $66.24  (7 sessions)
      gpt-5.4                            $56.41  (12 sessions)

  Cursor
    Sessions:       221
    Messages:       46,783
    Lines changed:  +24,843 / -8,659
    Tab completions: 423/1887 (22%)

    Models:
      default                           113 sessions
      claude-4.5-sonnet                  42 sessions
      composer-1                         39 sessions

  ─────────────────────────────────────
  Combined:   $8564  (3446 sessions)
```

Example output (`npx grammata analytics`):

```
  grammata analytics
  ────────────────────────────────────────

  Sessions:        3455
  Total cost:      $8675
  Cache savings:   $49833
  Input tokens:    2.3B   Output: 37.7M

  Week over week:  84.6%
    current week:  $2268   prev: $1228

  Sources
    claude-code     3153 sessions   $7975
    codex             81 sessions   $699.88
    cursor           221 sessions   $0.0000

  Activity
    Building        2798 sessions   $3609
    Investigating    215 sessions   $342.25
    Debugging        213 sessions   $3705
    Testing          166 sessions   $262.18
    Refactoring       63 sessions   $755.95

  Retry stats
    First-try rate:  44.6%
    Edit turns:      11421   retried: 6325
    Retry cost:      $4451
    Most-retried tool: Edit
    Most-retried file: src/components/card/CardPage.tsx

  Branches (top 5 by cost)
    Landing@master                        $631.68   5 sessions
    v2@master                             $623.21   63 sessions
    chatbox@feat/tutormeai-apps           $484.34   7 sessions
    ...

  Cache
    Hit rate:        83.4%
    Cache read:      13.4B
    Cache write:     336.1M

  Velocity (last 7 days)
    2026-04-10    $312.94   44.5h   $7.03/hr
    2026-04-11    $509.89  162.7h   $3.13/hr
    ...

  Peak hour:       12 PM
  Favorite model:  claude-opus-4-6
  Favorite tool:   Bash
  Priciest session: $398.02 — Landing (claude-opus-4-6)
```

Example output (`npx grammata cursor`):

```
  Cursor
  ─────────────────────────────────────
  Sessions:          221
  Messages:          46808
  Tool calls:        30786
  Lines changed:     +24843 / -8659
  Files created:     439
  Thinking time:     8.1h
  Response time:     28.9h

  Modes:
    agent                162 sessions
    debug                28 sessions
    chat                 27 sessions
    plan                 4 sessions

  Models:
    default                             114 sessions
    claude-4.5-sonnet                    42 sessions
    composer-1                           39 sessions

  Tools:
    read_file_v2                  10466  ██████████████████████████████
    edit_file_v2                   9470  ███████████████████████████
    ripgrep_raw_search             4064  ████████████
    run_terminal_command_v2        2924  ████████
    todo_write                     1276  ████
    glob_file_search                816  ██

  Daily Activity:
    Date             Msgs    Tools  Chart
    ──────────── ──────── ────────  ────────────────────
    2026-02-17      15186     8885  ████████████████████
    2026-02-18       5583     3146  ███████
    2026-02-22       5626     2400  ███████
    ...
```

## How It Works

### Claude Code

Reads JSONL session files from `~/.claude/projects/<project>/<session-id>.jsonl`. Each file contains per-turn `assistant` messages with token usage breakdowns:

- `input_tokens` — direct input tokens
- `output_tokens` — model output tokens
- `cache_read_input_tokens` — tokens served from prompt cache
- `cache_creation_input_tokens` — tokens written to prompt cache

Cost is calculated as: `(input * input_price + output * output_price + cache_read * cache_read_price + cache_create * cache_write_price) / 1M`

### Codex

Reads JSONL rollout files from `~/.codex/sessions/YYYY/MM/DD/<rollout>.jsonl`. Each file contains `token_count` events with per-turn usage:

- `input_tokens` — total input (includes cached)
- `cached_input_tokens` — cached portion
- `output_tokens` — model output
- `reasoning_output_tokens` — chain-of-thought tokens

Cost is calculated as: `(uncached_input * input_price + cached * cached_price + output * output_price) / 1M`

Model names come from `turn_context` events. Session metadata (title, cwd, git branch) comes from the SQLite threads table as a fallback.

### Cursor

Reads the Cursor SQLite database (`state.vscdb`) at platform-specific paths:

- **macOS:** `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`
- **Windows:** `~/AppData/Roaming/Cursor/User/globalStorage/state.vscdb`
- **Linux:** `~/.config/Cursor/User/globalStorage/state.vscdb`

Data is extracted from multiple tables via `sqlite3` CLI:

- **`composerData:*`** — session metadata (model, mode, lines changed, message counts, files created)
- **`bubbleId:*`** — tool call details (`toolFormerData`), thinking/turn durations, timestamps for daily activity
- **`aiCodeTracking.dailyStats.*`** — tab completion and composer edit acceptance rates

Cursor does not store token counts or cost data locally. All 7 queries run in parallel using `json_extract` for fast extraction without loading full JSON blobs.

### Goose

Reads the Goose backend SQLite database at `~/.local/share/goose/sessions/sessions.db` via the `sqlite3` CLI. Query pulls:

- `accumulated_input_tokens` / `accumulated_output_tokens` (falling back to `input_tokens` / `output_tokens`)
- `provider_name`, `working_dir`, `model_config_json`
- `created_at`, `updated_at`, `message_count`, `session_type`

Model name is extracted from `model_config_json.model_name`. Cost is computed via grammata's Claude / Codex pricing tables when the model matches a known name (heuristic: model contains `claude`/`opus`/`sonnet`/`haiku` → Claude pricing; contains `gpt`/`o3`/`o4`/`codex` → Codex pricing); otherwise falls back to per-provider defaults (`anthropic` and `openrouter` → $3/$15, `openai` → $2.50/$10, `ollama` → free).

`mergeAll` automatically skips Goose sessions where `providerName === 'claude-code'` or `'claude-acp'` to avoid double-counting with the JSONL reader.

### Cross-source merge

`mergeAll()` deduplicates sessions across all four readers (priority: Claude > Codex > Cursor > Goose), normalizes tool names to a common vocabulary (Codex `exec_command` → `Bash`, Cursor `edit_file_v2` → `Edit`, etc.), and produces `UnifiedSession[]` with `sourceStats` / `providerStats` breakdowns. Retry detection, branch costs, cost velocity, and cost trend compute off this unified array.

### Pricing

Pricing tables are sourced from [LiteLLM](https://github.com/BerriAI/litellm) and official pricing pages. Supported models:

| Model | Input | Output | Cache Read | Cache Write |
|-------|------:|-------:|-----------:|------------:|
| claude-opus-4-6 | $5.00 | $25.00 | $0.50 | $6.25 |
| claude-sonnet-4-6 | $3.00 | $15.00 | $0.30 | $3.75 |
| claude-haiku-4-5 | $1.00 | $5.00 | $0.10 | $1.25 |
| gpt-5.3-codex | $1.75 | $14.00 | $0.175 | — |
| gpt-5.2-codex | $1.75 | $14.00 | $0.175 | — |
| gpt-5.1-codex | $1.25 | $10.00 | $0.125 | — |
| gpt-5.1-codex-mini | $0.25 | $2.00 | $0.025 | — |
| gpt-5.4 | $2.50 | $15.00 | $0.25 | — |

Unknown models fall back to Sonnet pricing (Claude) or gpt-5.2-codex pricing (Codex).

## Requirements

- Node.js 18+
- `sqlite3` CLI tool in PATH (for Codex session metadata, Cursor data, and Goose sessions; all Claude data works without it)

## Related

- [@pella-labs/pinakes](https://www.npmjs.com/package/@pella-labs/pinakes) — Build knowledge graphs over your codebase

## License

MIT
