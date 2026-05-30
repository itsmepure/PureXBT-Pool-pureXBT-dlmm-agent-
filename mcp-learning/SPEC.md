# MCP Learning System — Spec (Approach 2: Hybrid)

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  VPS (meridian)                   │
│                                                   │
│  ┌──────────────┐    reads/writes    ┌─────────┐ │
│  │  Agent        │◄──────────────────►│ .json   │ │
│  │  (lessons.js, │    (unchanged)     │ files   │ │
│  │  pool-memory) │                    └────▲────┘ │
│  └──────────────┘                         │ reads │
│                                    ┌──────┴─────┐ │
│                                    │ MCP Server  │ │
│                                    │ (new)       │ │
│                                    └──┬──────┬──┘ │
│                            stdio ─────┘      └──── │
│                           (Claude Code)     HTTP   │
│                                        (Dashboard) │
└────────────────────────────────────────────────────┘
```

**Key constraint**: Agent's internal learning loop (lessons.js, pool-memory.js) stays 100% untouched. MCP server is a read-heavy external interface that reads the same JSON files and provides richer analytical access.

## Tech Stack

- **Runtime**: Node.js (matches existing meridian codebase)
- **SDK**: `@modelcontextprotocol/sdk` + `zod`
- **Transports**: stdio (Claude Code), Streamable HTTP (dashboard, remote)
- **Storage**: Reads existing files directly (lessons.json, pool-memory.json, user-config.json)
- **PM2**: New process in ecosystem.config.cjs

## MCP Resources (Read-Only)

| URI Pattern | Description |
|---|---|
| `lessons://all` | All current lessons — confidence, decay, pinned, outcome |
| `lessons://pinned` | Pinned lessons only (always injected) |
| `lessons://recent/{hours}` | Lessons from last N hours (after decay) |
| `lessons://by-outcome/{outcome}` | Filter: good / poor / bad |
| `performance://history` | All raw performance records |
| `performance://summary` | Aggregated: win_rate, avg_pnl, total_positions, by_timeframe |
| `pool-memory://list` | All tracked pools with deploy counts, cooldown status |
| `pool-memory://pool/{address}` | Full history for a specific pool |
| `thresholds://current` | Current evolved screening thresholds |
| `thresholds://evolution` | Timeline of threshold changes with reasons |

## MCP Tools (Actions)

### Query & Analysis

| Tool | Input | Output |
|---|---|---|
| `query_lessons` | `{ outcome?, minConfidence?, hours?, pool?, keyword?, limit? }` | Filtered lessons with metadata |
| `search_lessons` | `{ query }` | Full-text search across lesson content, context, notes |
| `get_performance_insights` | `{ hours?, groupBy? }` | Trend analysis: PnL over time, win rate curve, best/worst pools |
| `get_pool_insights` | `{ pool_address }` | Pool-specific: all deploys, PnL trend, cooldown status, notes |
| `get_threshold_evolution` | `{ param? }` | Timeline of how thresholds changed, what triggered each change |
| `get_learning_summary` | `{}` | High-level: total lessons, confidence distribution, top patterns, recent wins/losses |

### Mutation (Limited)

| Tool | Input | Output |
|---|---|---|
| `add_manual_lesson` | `{ content, outcome?, tags?, force? }` | Adds human-written lesson with dedup check |
| `pin_lesson` | `{ lesson_id }` | Pin (always inject into prompts) |
| `unpin_lesson` | `{ lesson_id }` | Unpin |
| `remove_lesson` | `{ lesson_id }` | Remove by ID |
| `remove_lessons_by_keyword` | `{ keyword }` | Bulk remove matching lessons |
| `add_pool_note` | `{ pool_address, note }` | Annotate a pool with human note |

## MCP Prompts (Templates)

| Prompt | Description |
|---|---|
| `lesson-review` | Structured review of recent lessons — what worked, what didn't, patterns |
| `performance-analysis` | Deep dive into performance data with trend identification |
| `pool-decision` | Context bundle for deciding whether to deploy into a specific pool |
| `learning-health` | Diagnostic: is the agent learning effectively? Are lessons decaying too fast? |

## File Structure

```
deploy/mcp-learning/
├── SPEC.md              ← this file
├── package.json
├── index.js             ← server entry, transport setup
├── resources.js         ← MCP resource handlers
├── tools.js             ← MCP tool handlers
├── prompts.js           ← MCP prompt templates
├── analytics.js         ← analytical queries (trends, correlations, insights)
└── .env                 ← MCP_LEARNING_PORT, DATA_DIR
```

## Integration Points

### PM2 (ecosystem.config.cjs)
```js
{
  name: "mcp-learning",
  script: "mcp-learning/index.js",
  env: {
    MCP_LEARNING_PORT: 3001,
    DATA_DIR: "./"
  }
}
```

### Claude Code (stdio)
Add to `.claude/settings.json` or MCP config:
```json
{
  "mcpServers": {
    "meridian-learning": {
      "command": "node",
      "args": ["deploy/mcp-learning/index.js", "--stdio"]
    }
  }
}
```

### Dashboard (HTTP)
Dashboard JS fetches from `http://localhost:3001/mcp` for learning insights.

## What This Does NOT Change

- Agent's internal learning loop (lessons.js) — untouched
- Pool-memory.js — untouched
- Performance recording — untouched
- Threshold evolution — untouched
- Dashboard UI — separate PR to add learning insights tab

## What This ADDS

- Structured query access to learning data (vs reading raw JSON)
- Analytical tools: trend analysis, correlation, pattern detection
- Claude Code integration: ask questions about agent's learning in natural language
- Foundation for dashboard learning insights (future PR)
- Prompts for common analysis patterns
