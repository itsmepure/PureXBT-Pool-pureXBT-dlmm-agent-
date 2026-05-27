# PureXBT Pool Agent

**Autonomous Meteora DLMM liquidity management agent for Solana, powered by LLMs.**

**Links:** [Website](https://purexbt.dev) | [Telegram](https://t.me/purexbt) | [X](https://x.com/purexbt)

PureXBT runs continuous screening and management cycles, deploying capital into high-quality Meteora DLMM pools and closing positions based on live PnL, yield, and range data. It learns from every position it closes.

---

## What's New (v2)

Since the initial release, PureXBT has been significantly upgraded:

### New Features
- **Two-Phase Screening** (`pool-scorer.js`) — deterministic pool scoring filters candidates before the LLM sees them. Only the top 5 reach the screener agent, cutting token cost 60-80% and improving decision quality.
- **Per-Wallet Config** — each wallet gets independent risk/screening/management/schedule config. Override or keep global defaults via the dashboard UI.
- **Dashboard Chatbox** — floating chat panel talks to the agent with full tool access (deploy, close, discover, get_positions, get_pnl, get_balance). Bilingual — understands English and Indonesian commands.
- **Position History Table** — full position history with PnL $, PnL %, fees, hold duration, peak PnL, status (OPEN/CLOSED/EXT CLOSED), and close reason. Filterable per wallet with pagination.
- **On-Chain Reconciliation** — positions closed manually via Meteora UI are automatically detected as `externally_closed`. PnL is estimated from pool-memory snapshots.
- **Feedback Injection** — pattern-aware decision summary (win rate, cumulative PnL, loss patterns) injected into the SCREENER system prompt.

### Optimizations
- **Context Compression** — raw JSON replaced with structured 1-line summaries in prompts. ~50-70% fewer tokens per ReAct step.
- **Parallelization** — pool discovery, position fetch, token enrichment, and smart-wallet queries all parallelized. Removed sequential bottlenecks.
- **State Response Cache** — `/api/state` cached 5s, cold 456ms → 2-7ms. Dashboard polling no longer hammers Meteora.
- **Stop-Loss Direct Close** — PnL poller closes at stop-loss immediately, no LLM call, no cooldown.
- **CORE_TOOLS Always-On** — deploy_position, close_position, discover_pools, get_my_positions, get_position_pnl, get_wallet_balance always available to the agent for full autonomy.
- **HiveMind Heartbeat** — reduced from 15min to 10min.

### Bug Fixes
- **Stop-loss delay** — was bottlenecked through LLM + cooldown. Now direct.
- **OOR false positives** — fixed threshold (10 bins) replaced with proportional 25% of pool range (min 5).
- **Dashboard port binding** — listens on `0.0.0.0` instead of `127.0.0.1`.
- **Nginx chatbox 504** — proxy timeout increased to 300s.
- **Agent child auto-start** — `pm_exec_path` no longer inherited, cron cycles fire immediately.
- **Per-wallet config write conflict** — unified to `user-config.json`.
- **`_env` wallet not found** — primary wallet resolved correctly.
- **LLM model override** — `user-config.json` no longer silently overrides `.env`.

> **24 optimizations total** — token (-70%), latency (parallel + cache), reliability (retry/timeout/error handling), trading logic (stop-loss/OOR/screening).

---

## What it does

- **Two-Phase Screening** — deterministic scorer pre-filters pools, then the LLM evaluates only the top 5 candidates
- **Manages positions** — monitors, claims fees, and closes LP positions autonomously; decides to STAY, CLOSE, or REDEPLOY based on live data
- **Learns from performance** — saves structured lessons, evolves screening thresholds based on closed position history
- **Per-wallet isolation** — each wallet runs with its own config, positions, and decision log. Cross-wallet contamination is prevented.
- **Dashboard UI** — web dashboard with position tracking, history, per-wallet config, live chatbox, and agent activity logs
- **Telegram notifications** — cycle reports, deploy/close alerts, OOR warnings
- **HiveMind sync** — shared lessons and performance events across agents via Agent Meridian API

---

## How it works

PureXBT runs a **ReAct agent loop** — each cycle the LLM reasons over live data, calls tools, and acts. Two specialized agents run on independent cron schedules:

| Agent | Default interval | Role |
|---|---|---|
| **Screening Agent** | Every 30 min | Two-phase: deterministic scoring → LLM evaluation → deploy |
| **Management Agent** | Every 10 min | Monitors PnL, claims fees, closes at stop-loss or OOR |

**Data sources:**
- `@meteora-ag/dlmm` SDK — on-chain position data, active bin, deploy/close transactions
- Meteora DLMM PnL API — position yield, fee accrual, PnL
- OKX OnchainOS — smart money signals, token risk scoring
- Pool screening API — fee/TVL ratios, volume, organic scores, holder counts
- Jupiter API — token audit, mcap, launchpad, price stats

Agents are LLM-agnostic — any OpenAI-compatible endpoint works (DeepSeek, Qwen, OpenRouter, LM Studio).

---

## Requirements

- Node.js 18+
- LLM API key (DeepSeek, OpenRouter, Qwen, or any OpenAI-compatible)
- Solana wallet (base58 private key)
- Solana RPC endpoint ([Helius](https://helius.xyz) recommended)
- Telegram bot token (optional)

---

## Setup

### 1. Clone & install

```bash
git clone https://github.com/itsmepure/PureXBT-Pool-pureXBT-dlmm-agent-.git
cd PureXBT-Pool-pureXBT-dlmm-agent-
npm install
```

### 2. Configure

Copy and edit the config files:

```bash
cp .env.example .env
cp user-config.example.json user-config.json
```

**`.env` — required:**

```env
WALLET_PRIVATE_KEY=your_base58_private_key
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_API_KEY=sk-your-key
LLM_MODEL=deepseek-v4-pro
HELIUS_API_KEY=your_helius_key
DASHBOARD_PASSWORD=your_password
```

> Never put your private key or API keys in `user-config.json` — use `.env` only. Both files are gitignored.

### 3. Run

```bash
npm start
```

Starts the autonomous agent with cron-based screening + management cycles. The dashboard starts automatically on port 3000.

### Run with PM2

PM2 is recommended for VPS deployment:

```bash
npm install
pm2 start ecosystem.config.cjs
pm2 save
```

To update:

```bash
git pull
npm install
pm2 restart all
```

---

## Dashboard

The web dashboard is available at `http://<host>:3000`.

**Sections:**
- **Open Positions** — live position data with PnL, fees, range status
- **Position History** — full history table with sort, filter per wallet, pagination
- **Configuration** — edit global risk/screening/management/schedule settings
- **Wallet Config** — per-wallet overrides (⚙ button per wallet)
- **Wallet List** — start/stop/configure individual wallets
- **Chatbox** — floating chat panel, talk to the agent with full tool access
- **Agent Activity** — recent decisions and log tail

---

## Config reference

All fields optional — defaults shown. Edit `user-config.json`. Full per-wallet override available via dashboard UI.

### Risk

| Field | Default | Description |
|---|---|---|
| `maxPositions` | `3` | Maximum concurrent open positions |
| `maxDeployAmount` | `50` | Maximum SOL cap per position |
| `maxSwapSol` | `2` | Maximum SOL per swap |
| `hardStopLossPct` | `-25` | Hard stop-loss (percent) |
| `dailyMaxDrawdownSol` | `3` | Maximum daily drawdown in SOL |

### Screening

| Field | Default | Description |
|---|---|---|
| `minTvl` | `10000` | Minimum pool TVL (USD) |
| `maxTvl` | `150000` | Maximum pool TVL (USD) |
| `minTokenFeesSol` | `30` | Minimum all-time fees in SOL |
| `minHolders` | `500` | Minimum token holder count |
| `minOrganic` | `60` | Minimum organic score (0–100) |
| `minQuoteOrganic` | `65` | Minimum quote token organic score |
| `maxTop10Pct` | `60` | Maximum top-10 holder concentration % |
| `maxBundlePct` | `25` | Maximum bundle holder % |
| `maxBotHoldersPct` | `25` | Maximum bot holder % |
| `minFeeActiveTvlRatio` | `0.05` | Minimum fee/active-TVL ratio |
| `minBinStep` | `80` | Minimum bin step |
| `maxBinStep` | `125` | Maximum bin step |
| `minBinsBelow` | `35` | Minimum bins below active bin |
| `maxBinsBelow` | `69` | Maximum bins below active bin |
| `blockedLaunchpads` | `[]` | Launchpad names to never deploy into |

### Management

| Field | Default | Description |
|---|---|---|
| `stopLossPct` | `-15` | Close position if PnL drops below this % |
| `takeProfitPct` | `8` | Take profit target % |
| `trailingTakeProfit` | `true` | Enable trailing take-profit |
| `trailingTriggerPct` | `4` | Trail trigger % above entry |
| `trailingDropPct` | `2` | Trail drop % from peak |
| `deployAmountSol` | `0.5` | Base SOL per new position |
| `positionSizePct` | `0.35` | Fraction of deployable balance to use |
| `gasReserve` | `0.2` | Minimum SOL to keep for gas |
| `minSolToOpen` | `0.55` | Minimum wallet SOL before opening |
| `outOfRangeWaitMinutes` | `30` | Minutes OOR before acting |
| `oorCooldownTriggerCount` | `2` | OOR events before cooldown |
| `oorCooldownHours` | `24` | Hours to cooldown pool after excessive OOR |

### Schedule

| Field | Default | Description |
|---|---|---|
| `screeningIntervalMin` | `30` | Screening cycle frequency (minutes) |
| `managementIntervalMin` | `10` | Management cycle frequency (minutes) |

### LLM

| Field | Default | Description |
|---|---|---|
| `model` | `deepseek-v4-pro` | Default LLM model |
| `screeningModel` | `deepseek-v4-pro` | LLM for screening cycles |
| `managementModel` | `deepseek-v4-pro` | LLM for management cycles |
| `generalModel` | `deepseek-v4-pro` | LLM for chat / REPL |
| `llmBaseUrl` | `https://api.deepseek.com/v1` | LLM API endpoint |
| `temperature` | `0.7` | LLM temperature |
| `maxSteps` | `15` | Max ReAct loop steps per cycle |

> Any OpenAI-compatible endpoint works. Override via `.env`: `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`.

---

## HiveMind

HiveMind sync uses Agent Meridian at `https://api.agentmeridian.xyz` by default. Agents can register, pull shared lessons/presets, and push learning events.

**What you get:** shared lessons from other agents, strategy presets, role-aware context injection.

**What you share:** lessons, closed-position performance events (PnL, fees, hold time), agent heartbeat metadata. **Private keys and wallet balances are never sent.**

HiveMind failures are non-blocking — the agent logs a warning and keeps running.

---

## Architecture

```
index.js            Main entry: cron orchestration + dashboard spawn
agent.js            ReAct loop: LLM → tool call → repeat
config.js           Runtime config with per-wallet override via WALLET_ID env
prompt.js           System prompt builder (SCREENER / MANAGER / GENERAL / CHAT)
state.js            Position registry (state.json)
decision-log.js     Structured decision log + pattern analysis (getPatternSummary)
lessons.js          Learning engine: records performance, derives lessons, evolves thresholds
pool-memory.js      Per-pool deploy history + PnL snapshots
pool-scorer.js      Two-phase deterministic pool scoring (prescreenPools)
dashboard.js        Web dashboard server — API routes, chatbox, config, state, history
dashboard-ui.html   Dashboard frontend — cyberpunk themed UI
hivemind.js         Agent Meridian HiveMind sync
smart-wallets.js    KOL/alpha wallet tracker
token-blacklist.js  Permanent token blacklist
logger.js           Daily-rotating log files + action audit trail

tools/
  definitions.js    Tool schemas (OpenAI format)
  executor.js       Tool dispatch + safety checks
  dlmm.js           Meteora DLMM SDK wrapper
  screening.js      Pool discovery + parallel fetch
  wallet.js         SOL/token balances (Helius) + Jupiter swap
  token.js          Token info, holders, narrative
  study.js          Top LPer study via LPAgent API
```

---

## Adding a New Tool

1. **`tools/definitions.js`** — Add OpenAI-format schema object to the `tools` array
2. **`tools/executor.js`** — Add `tool_name: functionImpl` to `toolMap`
3. **`agent.js`** — Add tool name to `MANAGER_TOOLS` and/or `SCREENER_TOOLS` if role-restricted
4. If the tool writes on-chain state, add it to `WRITE_TOOLS` in executor.js for safety checks

---

## Agent Roles & Tool Access

| Role | Purpose | Key Tools |
|------|---------|-----------|
| `SCREENER` | Find and deploy new positions | deploy_position, get_active_bin, get_token_holders, get_wallet_balance, get_my_positions, get_wallet_positions |
| `MANAGER` | Manage open positions | close_position, claim_fees, swap_token, get_position_pnl, get_my_positions, get_wallet_balance, get_wallet_positions |
| `GENERAL` | Chat / manual commands | All tools including CORE_TOOLS (deploy, close, discover, get_positions, get_pnl, get_balance) |

CORE_TOOLS are always available regardless of intent match — ensures full agent autonomy.

---

## Position Lifecycle

1. **Pre-screen** — pool-scorer.js deterministically ranks 15+ candidates, enriches with memory + smart-wallet data, returns top 5
2. **Screen** — LLM evaluates pre-screened candidates, calls deploy_position if a winner is found
3. **Monitor** — management cron checks PnL, OOR status, writes pool-memory snapshots
4. **Close** — stop-loss (direct, no LLM), take-profit, OOR threshold (25% of pool range, min 5 bins), or LLM decision
5. **Learn** — recordPerformance() in lessons.js, pattern summary fed back to screener

---

## Environment Variables

| Var | Required | Purpose |
|-----|----------|---------|
| `WALLET_PRIVATE_KEY` | Yes | Base58 or JSON array private key |
| `RPC_URL` | Yes | Solana RPC endpoint |
| `LLM_API_KEY` | Yes | LLM API key |
| `LLM_BASE_URL` | Yes | LLM API base URL |
| `LLM_MODEL` | No | Override default model |
| `HELIUS_API_KEY` | No | Enhanced wallet balance + token data |
| `DASHBOARD_PASSWORD` | No | Dashboard auth password |
| `DASHBOARD_PORT` | No | Dashboard port (default 3000) |
| `DASHBOARD_HOST` | No | Dashboard bind address (default 0.0.0.0) |
| `WALLET_ID` | No | Per-wallet config key (set by dashboard spawn) |
| `TELEGRAM_BOT_TOKEN` | No | Telegram notifications |
| `TELEGRAM_CHAT_ID` | No | Telegram chat target |
| `TELEGRAM_ALLOWED_USER_IDS` | No | Allowed Telegram user IDs for commands |
| `HIVE_MIND_URL` | No | HiveMind server URL |
| `HIVE_MIND_API_KEY` | No | HiveMind auth token |
| `DRY_RUN` | No | Skip all on-chain transactions |

---

## Using a local model

```env
LLM_BASE_URL=http://localhost:1234/v1
LLM_API_KEY=lm-studio
LLM_MODEL=your-local-model-name
```

Any OpenAI-compatible endpoint works.

---

## Disclaimer

This software is provided as-is, with no warranty. Running an autonomous trading agent carries real financial risk — you can lose funds. Always start with `DRY_RUN=true` to verify behavior before going live. Never deploy more capital than you can afford to lose. This is not financial advice.

The authors are not responsible for any losses incurred through use of this software.
