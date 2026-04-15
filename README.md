# grammata

Read and aggregate coding agent usage data from your local machine. Parses session files from **Claude Code** (`~/.claude/`) and **Codex** (`~/.codex/`) to give you accurate cost, token, and activity breakdowns.

Zero external dependencies. Reads session JSONL files directly from disk for accurate cost and token breakdowns.

Part of the [Pella Labs](https://github.com/pella-labs) ecosystem. See also [@pella-labs/pinakes](https://www.npmjs.com/package/@pella-labs/pinakes) for building knowledge graphs over your codebase.

## Install

```bash
npm install grammata
```

## Quick Start

```typescript
import { readAll } from 'grammata';

const data = await readAll();

console.log(`Total cost: $${data.combined.totalCost.toFixed(2)}`);
console.log(`Sessions:   ${data.combined.totalSessions}`);
console.log(`Claude:     $${data.claude.cost.toFixed(2)} (${data.claude.sessions} sessions)`);
console.log(`Codex:      $${data.codex.cost.toFixed(2)} (${data.codex.sessions} sessions)`);
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

data.combined.totalCost     // claude + codex
data.combined.totalSessions // claude + codex
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

**Session fields:** `sessionId`, `sessionName`, `project`, `model`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreateTokens`, `costUsd`, `turnCount`, `toolCalls`, `toolBreakdown`, `startHour`, `firstTimestamp`, `lastTimestamp`

### `readCodex(dir?)`

Read only Codex data. Optionally pass a custom directory (defaults to `~/.codex`).

```typescript
import { readCodex } from 'grammata';

const codex = await readCodex();

for (const session of codex.sessions) {
  console.log(session.model, `$${session.costUsd.toFixed(2)}`, session.project);
}
```

**Session fields:** `sessionId`, `sessionName`, `project`, `model`, `modelProvider`, `inputTokens`, `cachedInputTokens`, `outputTokens`, `costUsd`, `durationMs`, `createdAt`, `updatedAt`, `source`, `gitBranch`

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
npx grammata claude             # Claude Code: cost, tokens, models, tools, projects
npx grammata codex              # Codex: cost, tokens, models, projects
npx grammata sessions           # list all sessions (most recent first)
npx grammata models             # model breakdown across both sources
npx grammata tools              # tool usage ranking with bar chart
npx grammata tokens             # token breakdown by source
npx grammata cost               # cost summary + cache savings
npx grammata daily              # day-by-day costs with chart
npx grammata hours              # activity by hour of day
```

All commands support `--json` for machine-readable output:

```bash
npx grammata cost --json
npx grammata models --json
npx grammata daily --json
```

Example output (`npx grammata`):

```
  grammata
  ─────────────────────────────────────

  Claude Code
    Sessions:       3024
    Cost:           $6683
    Input tokens:   2.4M
    Output tokens:  23.5M
    Cache read:     9.2B
    Cache savings:  $40979
    Active days:    32
    Top tools:      Bash(14885), Read(13768), Edit(6998), Grep(3142), Write(2972)

    Models:
      claude-opus-4-6                     $6467  (1525 sessions)
      claude-haiku-4-5-20251001          $62.43  (1253 sessions)
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

  ─────────────────────────────────────
  Combined:   $7381  (3104 sessions)
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
- `sqlite3` CLI tool in PATH (for Codex session metadata; Codex token data and all Claude data work without it)

## Related

- [@pella-labs/pinakes](https://www.npmjs.com/package/@pella-labs/pinakes) — Build knowledge graphs over your codebase

## License

MIT
