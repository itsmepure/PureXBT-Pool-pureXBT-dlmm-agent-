# Meridian

**Autonomous Meteora DLMM liquidity management agent for Solana, powered by LLMs.**

**Links:** [Website](https://agentmeridian.xyz) | [Telegram](https://t.me/agentmeridian) | [X](https://x.com/meridian_agent)

Meridian runs continuous screening and management cycles, deploying capital into high-quality Meteora DLMM pools and closing positions based on live PnL, yield, and range data. It learns from every position it closes.

---

## What's New (v3.5)

- **Momentum sourcing** — a fast scan loop (default every 20s, DexScreener-backed) watches the prescreened candidate universe for live breakouts (volume surge, buy pressure, price velocity, tx count → weighted entry score); hot candidates deploy immediately without waiting for the next screening cycle. A hard-AND prescreen gate (mcap band / 5m volume / tx count / LP floor) keeps junk out, with a 5-minute observability rollup in the logs. `momentum.enabled: false` by default — the classic screening loop keeps working either way, and a momentum-death signal (buys<sells or negative price move) doubles as an extra exit trigger for open positions
- **Momentum Gates panel** — all momentum/prescreen thresholds are editable live from the dashboard (new `/api/momentum` GET/POST, per-key deep-merge) and hot-reload into the running scanner within ~15s, no restart
- **Guaranteed chase #1 (reshape v2)** — the first chase is now fully blind: no market research round-trip, and pool screening thresholds are bypassed via a one-shot in-process grant that tool-calling LLMs cannot trigger; chase #2 keeps the full LLM momentum judgment
- **Upside headroom** — single-sided SOL deploys can now reserve empty bins above the active price (default `deployUpsidePct: 3`); a small continued pump no longer flags the position out-of-range instantly, while the buy ladder below is unchanged. Chase re-deploys use the same headroom (`chaseUpsidePct`)
- **IDR on realized PnL** — close notifications, the daily recap caption, and the dashboard realized-PnL panel now show Rupiah alongside SOL/USD (new `tools/fx.js`, 6h-cached USD→IDR rate, fails silent — if the rate API is down you simply see SOL/USD as before)
- **Telegram send retry** — transient network blips / 5xx / 429 no longer permanently swallow notifications: text sends and PnL-card photo uploads retry twice with backoff
- **Daily PnL card accuracy fix** — every close was double-written to the decision log by two call sites, silently doubling the daily recap card's PnL, position count, and fees. The duplicate writer is removed and the daily aggregation is now duplicate-resistant, so recaps are correct even over historical log entries
- **Auto-swap after claim fix** — standalone fee claims raced the wallet-balance indexer: the just-claimed token often wasn't visible yet, so the post-claim sweep saw "0 tokens" and quietly left fee tokens sitting in the wallet. The claim path now waits for the claimed base mint to settle (same retry helper the close path already used), so both close and claim sweeps reliably convert fee tokens to SOL

---

## What's New (v3.4)

- **Two-tier chase (reshape)** — chase #1 executes immediately (deterministic close + re-deploy, ~10s end-to-end, no LLM roundtrip; the position is pure SOL so the cost of being wrong is just gas, and live executor safety checks still veto dead pools); chase #2 — when the re-deployed position pumps out *again* — goes through a full LLM momentum judgment. `chaseDeterministic: false` reverts everything to the LLM path
- **Indicator exit** — an `exitPreset` (default `bb_plus_rsi`: price at upper Bollinger + RSI overbought on 15m candles) is evaluated per open position (~60s throttle) as an overextension detector; a confirmed signal becomes a management alert the LLM can act on. Independent `exitEnabled` switch — entry confirmation stays untouched
- **Tracked cost basis** — young positions no longer wait for the indexer: PnL (and stop-loss protection) computes from the tracked deploy amount from second zero
- **Partial-deploy adoption** — wide-range deploys are non-atomic (create + multiple add-liquidity txs); if liquidity adding fails midway, the live on-chain position is now adopted into tracking (named, notified, managed) instead of becoming an orphan
- **Cleaner reshape notifications** — the chase close no longer sends a close card (the position merely moved); a card is sent only when the position truly ends (re-deploy failed or chase aborted). Outcome notifs (✅/🛑) are evidence-based
- **Config hot-reload extended** to the `chartIndicators` section; per-wallet dashboard config saves now deep-merge (custom keys survive)

---

## What's New (v3.3)

- **Hybrid LP strategy** — the LLM picks `spot` or `bid_ask` **per candidate** (hot & extended → bid_ask ladder; stable & mature → spot) and records a one-line `strategy_reason` in the deploy notification and decision log
- **Adaptive range depth** — ranges are expressed as `downside_pct` instead of raw bin counts, so depth stays consistent across pool bin steps; a deterministic executor clamp enforces per-strategy bands (spot 30–40%, bid_ask 40–60%)
- **Bin step awareness** — configurable bin-step band with LLM guidance per class (fine-grained 35–42 → concentrated spot; 43–79 → mature-token spot bias; 80–125 → standard memecoin rules)
- **Chase-up on pump OOR (reshape)** — when price pumps above the range, the position is pure SOL (zero IL); after an LLM momentum check the agent closes with reason `chase_up` (no pool cooldown) and re-deploys the same pool below the new price. Max 2 chases per pool per 6h, with dedicated RESHAPE Telegram notifications: a detection alert, then an evidence-based outcome notif (✅ re-deployed / 🛑 aborted with the momentum reason)
- **PnL close cards** — every close sends a rendered PNG card to Telegram (candlestick chart with entry/exit markers, zoomed to the position window, SOL PnL, pool stats) via `@napi-rs/canvas` — no browser needed. Plus a daily summary card on cron
- **Close reasons everywhere** — stop-loss / trailing TP / OOR / low yield / chase_up reasons now flow into Telegram notifications and the decision log
- **Config hot-reload** — edits to `user-config.json` (dashboard or manual) apply in-process within ~15 seconds, no restart required
- **Telegram quiet mode** — screening/management cycle chatter is off by default (`TG_CYCLE_NOTIFS=1` to re-enable); you only get deploys, closes, and replies to your own messages
- **PnL accuracy fixes** — young positions with partially-indexed deposits render as "warming" instead of garbage percentages; untracked positions resolve their pool name from pool memory; position cache TTL cut to 10s for a snappier dashboard

---

## What it does

- **Screens pools** — scans Meteora DLMM pools against configurable thresholds (fee/TVL ratio, organic score, holder count, mcap, bin step) and surfaces high-quality opportunities
- **Manages positions** — monitors, claims fees, and closes LP positions autonomously; decides to STAY, CLOSE, or REDEPLOY based on live data
- **Learns from performance** — studies top LPers in target pools, saves structured lessons, and evolves screening thresholds based on closed position history
- **Discord signals** — optional Discord listener watches LP Army channels for Solana token calls and queues them for screening
- **Telegram chat** — full agent chat via Telegram, plus cycle reports and OOR alerts
- **Claude Code integration** — run AI-powered screening and management directly from your terminal using Claude Code slash commands

---

## How it works

Meridian runs a **ReAct agent loop** — each cycle the LLM reasons over live data, calls tools, and acts. Two specialized agents run on independent cron schedules:

| Agent | Default interval | Role |
|---|---|---|
| **Screening Agent** | Every 30 min | Pool screening — finds and deploys into the best candidate |
| **Management Agent** | Every 10 min | Position management — evaluates each open position and acts |

### Agent harness

Meridian's agent harness is the runtime wrapper around every autonomous cycle. It gives both **main** and **experimental** agents the same control loop: load live state, inject relevant memory, expose only role-appropriate tools, execute tool calls, and return a readable cycle report.

The harness also keeps a structured decision log in `decision-log.json` for deployments, closes, skips, and no-deploy outcomes. Each entry records the actor, pool or position, summary, reason, key risks, metrics, and rejected alternatives. Recent decisions are injected back into the system prompt and are available through `get_recent_decisions`, so the agent can answer "why did you deploy?", "why did you close?", or "why did you skip?" without guessing after the fact.

**Data sources:**
- `@meteora-ag/dlmm` SDK — on-chain position data, active bin, deploy/close transactions
- Meteora DLMM PnL API — position yield, fee accrual, PnL
- OKX OnchainOS — smart money signals, token risk scoring
- Pool screening API — fee/TVL ratios, volume, organic scores, holder counts
- Jupiter API — token audit, mcap, launchpad, price stats

Agents are powered via **OpenRouter** and can be swapped for any compatible model.

---

## Requirements

- Node.js 18+
- [OpenRouter](https://openrouter.ai) API key
- Solana wallet (base58 private key)
- Solana RPC endpoint ([Helius](https://helius.xyz) recommended)
- Telegram bot token (optional)
- [Claude Code](https://claude.ai/code) CLI (optional, for terminal slash commands)

---

## Setup

### 1. Clone & install

```bash
git clone https://github.com/yunus-0x/meridian
cd meridian
npm install
```

### 2. Run the setup wizard

```bash
npm run setup
```

The wizard walks you through creating `.env` (API keys, wallet, RPC, Telegram) and `user-config.json` (risk preset, deploy size, thresholds, models). Takes about 2 minutes.

**Or set up manually:**

Create `.env`:

```env
WALLET_PRIVATE_KEY=your_base58_private_key
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
OPENROUTER_API_KEY=sk-or-...
HELIUS_API_KEY=your_helius_key          # for wallet balance lookups
TELEGRAM_BOT_TOKEN=123456:ABC...        # optional — for notifications + chat
TELEGRAM_CHAT_ID=                       # auto-filled on first message
DRY_RUN=true                            # set false for live trading
```

> Never put your private key or API keys in `user-config.json` — use `.env` only. Both files are gitignored.

Optional encrypted `.env` flow:

```bash
cp .env .env.raw
printf "replace-with-a-long-local-key\n" > .envrypt
npm run env:encrypt
```

Meridian loads envrypt-style encrypted values automatically. Keep `.env.raw` and `.envrypt` local; both are gitignored.

Copy config and edit as needed:

```bash
cp user-config.example.json user-config.json
```

See [Config reference](#config-reference) below.

### 3. Run

```bash
npm run dev    # dry run — no on-chain transactions
npm start      # live mode
```

On startup Meridian fetches your wallet balance, open positions, and top pool candidates, then begins autonomous cycles immediately.

### Run with PM2

PM2 is supported and is the recommended way to keep Telegram control online on a VPS:

```bash
npm install
npm run pm2:start
pm2 save
```

To update an existing PM2 install:

```bash
git pull
npm install
npm run pm2:restart
```

If the process restarts repeatedly after an update, inspect the app error first:

```bash
npm run pm2:logs
```

Most post-update PM2 crashes are app startup errors, commonly from skipping `npm install` after `package-lock.json` changed, starting PM2 from the wrong directory, or missing `.env` / `user-config.json` values. Avoid `nohup`; it runs outside PM2 and can leave Telegram polling in a duplicate unmanaged process.

---

## Running modes

### Autonomous agent

```bash
npm start
```

Starts the full autonomous agent with cron-based screening + management cycles and an interactive REPL. The prompt shows a live countdown to the next cycle:

```
[manage: 8m 12s | screen: 24m 3s]
>
```

REPL commands:

| Command | Description |
|---|---|
| `/status` | Wallet balance and open positions |
| `/candidates` | Re-screen and display top pool candidates |
| `/learn` | Study top LPers across all current candidate pools |
| `/learn <pool_address>` | Study top LPers for a specific pool |
| `/thresholds` | Current screening thresholds and performance stats |
| `/evolve` | Trigger threshold evolution from performance data (needs 5+ closed positions) |
| `/stop` | Graceful shutdown |
| `<anything>` | Free-form chat — ask the agent anything, request actions, analyze pools |

---

### Claude Code terminal (recommended)

Install [Claude Code](https://claude.ai/code) and use it from inside the meridian directory. Claude Code has built-in agents and slash commands that use the `meridian` CLI under the hood.

```bash
cd meridian
claude
```

#### Slash commands

| Command | What it does |
|---|---|
| `/screen` | Full AI screening cycle — checks Discord queue, reads config, fetches candidates, runs deep research, and deploys if a winner is found |
| `/manage` | Full AI management cycle — checks all positions, evaluates PnL, claims fees, closes OOR/losing positions |
| `/balance` | Check wallet SOL and token balances |
| `/positions` | List all open DLMM positions with range status |
| `/candidates` | Fetch and enrich top pool candidates (pool metrics + token audit + smart money) |
| `/study-pool` | Study top LPers on a specific pool |
| `/pool-ohlcv` | Fetch price/volume history for a pool |
| `/pool-compare` | Compare all Meteora DLMM pools for a token pair by APR, fee/TVL ratio, and volume |

#### Claude Code agents

Two specialized sub-agents run inside Claude Code:

**`screener`** — pool screening specialist. Invoke when you want to evaluate candidates, analyse token risk, or deploy a position. Has access to OKX smart money signals, full token audit pipeline, and all strategy logic.

**`manager`** — position management specialist. Invoke when reviewing open positions, assessing PnL, claiming fees, or closing positions.

To trigger an agent directly, just describe what you want:
```
> screen for new pools and deploy if you find something good
> review all my positions and close anything out of range
> what do you think of the SOL/BONK pool?
```

#### Loop mode

Run screening or management on a timer inside Claude Code:

```
/loop 30m /screen     # screen every 30 minutes
/loop 10m /manage     # manage every 10 minutes
```

---

### CLI (direct tool invocation)

The `meridian` CLI gives you direct access to every tool with JSON output — useful for scripting, debugging, or piping into other tools.

```bash
npm install -g .   # install globally (once)
meridian <command> [flags]
```

Or run without installing:

```bash
node cli.js <command> [flags]
```

**Positions & PnL**

```bash
meridian positions
meridian pnl <position_address>
meridian wallet-positions --wallet <addr>
```

**Screening**

```bash
meridian candidates --limit 5
meridian pool-detail --pool <addr> [--timeframe 5m]
meridian active-bin --pool <addr>
meridian search-pools --query <name_or_symbol>
meridian study --pool <addr> [--limit 4]
```

**Token research**

```bash
meridian token-info --query <mint_or_symbol>
meridian token-holders --mint <addr> [--limit 20]
meridian token-narrative --mint <addr>
```

**Deploy & manage**

```bash
meridian deploy --pool <addr> --amount <sol> [--bins-below 69] [--bins-above 0] [--strategy bid_ask|spot|curve] [--dry-run]
meridian claim --position <addr>
meridian close --position <addr> [--skip-swap] [--dry-run]
meridian swap --from <mint> --to <mint> --amount <n> [--dry-run]
meridian add-liquidity --position <addr> --pool <addr> [--amount-x <n>] [--amount-y <n>] [--strategy spot]
meridian withdraw-liquidity --position <addr> --pool <addr> [--bps 10000]
```

**Agent cycles**

```bash
meridian screen [--dry-run] [--silent]   # one AI screening cycle
meridian manage [--dry-run] [--silent]   # one AI management cycle
meridian start [--dry-run]               # start autonomous agent with cron jobs
```

**Config**

```bash
meridian config get
meridian config set <key> <value>
```

**Learning & memory**

```bash
meridian lessons
meridian lessons add "your lesson text"
meridian performance [--limit 200]
meridian evolve
meridian pool-memory --pool <addr>
```

**Blacklist**

```bash
meridian blacklist list
meridian blacklist add --mint <addr> --reason "reason"
```

**Discord signals**

```bash
meridian discord-signals
meridian discord-signals clear
```

**Balance**

```bash
meridian balance
```

**Flags**

| Flag | Effect |
|---|---|
| `--dry-run` | Skip all on-chain transactions |
| `--silent` | Suppress Telegram notifications for this run |

---

## Discord listener

The Discord listener watches configured channels (e.g. LP Army) for Solana token calls and queues them as signals for the screener agent.

### Setup

```bash
cd discord-listener
npm install
```

Add to your root `.env`:

```env
DISCORD_USER_TOKEN=your_discord_account_token   # from browser DevTools → Network
DISCORD_GUILD_ID=the_server_id
DISCORD_CHANNEL_IDS=channel1,channel2            # comma-separated
DISCORD_MIN_FEES_SOL=5                           # minimum pool fees to pass pre-check
```

> This uses a selfbot (personal account automation, not a bot token). Use responsibly.

### Run

```bash
cd discord-listener
npm start
```

Or run it in a separate terminal alongside the main agent. Signals are written to `discord-signals.json` and picked up automatically by `/screen` and `node cli.js screen`.

### Signal pipeline

Each incoming token address passes through a pre-check pipeline before being queued:
1. **Dedup** — ignores addresses seen in the last 10 minutes
2. **Blacklist** — rejects blacklisted token mints
3. **Pool resolution** — resolves the address to a Meteora DLMM pool
4. **Rug check** — checks deployer against `deployer-blacklist.json`
5. **Fees check** — rejects pools below `DISCORD_MIN_FEES_SOL`

Signals that pass all checks are queued with status `pending`. The screener picks up pending signals and processes them as priority candidates before running the normal screening cycle.

### Deployer blacklist

Add known rug/farm deployer wallet addresses to `deployer-blacklist.json`:

```json
{
  "_note": "Known farm/rug deployers — add addresses to auto-reject their pools",
  "addresses": [
    "WaLLeTaDDressHere"
  ]
}
```

---

## Telegram

### Setup

1. Create a bot via [@BotFather](https://t.me/BotFather) and copy the token
2. Add `TELEGRAM_BOT_TOKEN=<token>` to your `.env`
3. Start the agent, then send any message to your bot — it auto-registers your chat ID

### Notifications

Meridian sends notifications automatically for:
- Management cycle reports (reasoning + decisions)
- Screening cycle reports (what it found, whether it deployed)
- OOR alerts when a position leaves range past `outOfRangeWaitMinutes`
- Deploy: pair, amount, position address, tx hash
- Close: pair and PnL

### Telegram commands

| Command | Action |
|---|---|
| `/positions` | List open positions with progress bar |
| `/close <n>` | Close position by list index |
| `/set <n> <note>` | Set a note on a position |

You can also chat freely via Telegram using the same interface as the REPL.

---

## Config reference

All fields are optional — defaults shown. Edit `user-config.json`.

### Screening

| Field | Default | Description |
|---|---|---|
| `minFeeActiveTvlRatio` | `0.05` | Minimum fee/active-TVL ratio |
| `minTvl` | `10000` | Minimum pool TVL (USD) |
| `maxTvl` | `150000` | Maximum pool TVL (USD) |
| `minVolume` | `500` | Minimum pool volume |
| `minOrganic` | `60` | Minimum organic score (0–100) |
| `minHolders` | `500` | Minimum token holder count |
| `minMcap` | `150000` | Minimum market cap (USD) |
| `maxMcap` | `10000000` | Maximum market cap (USD) |
| `minBinStep` | `80` | Minimum bin step |
| `maxBinStep` | `125` | Maximum bin step |
| `timeframe` | `5m` | Candle timeframe for screening |
| `category` | `trending` | Pool category filter |
| `minTokenFeesSol` | `30` | Minimum all-time fees in SOL |
| `maxBundlersPct` | `30` | Maximum bundler % in top 100 holders |
| `maxTop10Pct` | `60` | Maximum top-10 holder concentration |
| `blockedLaunchpads` | `[]` | Launchpad names to never deploy into |

### Management

| Field | Default | Description |
|---|---|---|
| `deployAmountSol` | `0.5` | Base SOL per new position |
| `positionSizePct` | `0.35` | Fraction of deployable balance to use |
| `maxDeployAmount` | `50` | Maximum SOL cap per position |
| `gasReserve` | `0.2` | Minimum SOL to keep for gas |
| `minSolToOpen` | `0.55` | Minimum wallet SOL before opening |
| `outOfRangeWaitMinutes` | `30` | Minutes OOR before acting |
| `stopLossPct` | `-15` | Close position if price drops by this % |

### Schedule

| Field | Default | Description |
|---|---|---|
| `managementIntervalMin` | `10` | Management cycle frequency (minutes) |
| `screeningIntervalMin` | `30` | Screening cycle frequency (minutes) |

### Models

| Field | Default | Description |
|---|---|---|
| `managementModel` | `openai/gpt-oss-20b:free` | LLM for management cycles |
| `screeningModel` | `openai/gpt-oss-20b:free` | LLM for screening cycles |
| `generalModel` | `openai/gpt-oss-20b:free` | LLM for REPL / chat |

> Override model at runtime: `node cli.js config set screeningModel anthropic/claude-opus-4-5`

---

## Telegram

**Setup:**

1. Create a bot via [@BotFather](https://t.me/BotFather) and copy the token
2. Add `TELEGRAM_BOT_TOKEN=<token>` to your `.env`
3. Set the exact Telegram chat and allowed controller user IDs in `.env`

Meridian no longer auto-registers the first chat for safety. You must set:

```env
TELEGRAM_BOT_TOKEN=<token>
TELEGRAM_CHAT_ID=<target chat id>
TELEGRAM_ALLOWED_USER_IDS=<comma-separated Telegram user ids allowed to control the bot>
```

Security notes:
- If `TELEGRAM_CHAT_ID` is not set, inbound Telegram control is ignored.
- If the target chat is a group/supergroup and `TELEGRAM_ALLOWED_USER_IDS` is empty, inbound control is ignored.
- Notifications still go to the configured chat, but command/control is limited to the allowed user IDs.

**Notifications sent:**
- After every management cycle: full agent report (reasoning + decisions)
- After every screening cycle: full agent report (what it found, whether it deployed)
- When a position goes out of range past `outOfRangeWaitMinutes`
- On deploy: pair, amount, position address, tx hash
- On close: pair and PnL

You can also chat with the agent via Telegram using the same free-form interface as the REPL: `"check wallet 7tB8..."`, `"who are the top LPers in pool ABC..."`, `"close all positions"`, etc. Only explicitly allowed Telegram user IDs can issue commands.

---

## How it learns

### Lessons

After every closed position the agent runs `studyTopLPers` on candidate pools, analyzes on-chain behavior of top performers (hold duration, entry/exit timing, win rates), and saves concrete lessons. Lessons are injected into subsequent agent cycles as part of the system context.

Add a lesson manually:
```bash
node cli.js lessons add "Never deploy into pump.fun tokens under 2h old"
```

### Threshold evolution

After 5+ positions have been closed, run:
```bash
node cli.js evolve
```

This analyzes closed position performance (win rate, avg PnL, fee yields) and automatically adjusts screening thresholds in `user-config.json`. Changes take effect immediately.

---

## HiveMind

HiveMind sync uses Agent Meridian at `https://api.agentmeridian.xyz` by default with the built-in public key. Agents can register, pull shared lessons/presets, and push learning events without a separate registration flow.

**What you get:**
- Shared lessons from other Meridian agents
- Strategy presets and crowd performance context
- Role-aware lessons injected into future screener/manager prompts when `hiveMindPullMode` is `auto`

**What you share:**
- Lessons from `lessons.json`
- Closed-position performance events: pool, pool name, base mint, strategy, close reason, PnL, fees, and hold time
- Agent heartbeat metadata: agent ID, version, timestamp, and basic capability flags
- **Private keys and wallet balances are never sent**

HiveMind failures are non-blocking. If Agent Meridian is unavailable, the agent logs a warning and keeps running.

### Setup

No manual HiveMind registration command is required for the shared Agent Meridian setup. `agentId` is generated automatically on startup if it is missing.

To use a private HiveMind API key, check the Telegram announcement channel and set it as `hiveMindApiKey`.

Relevant config fields:

```json
{
  "agentId": "",
  "hiveMindUrl": "",
  "hiveMindApiKey": "",
  "hiveMindPullMode": "auto"
}
```

Blank `hiveMindUrl` and `hiveMindApiKey` values intentionally fall back to the Agent Meridian defaults. Set `hiveMindPullMode` to `manual` if you do not want shared lessons and presets pulled automatically.

### Disable

There is currently no empty-string disable path for HiveMind; blank values fall back to the built-in Agent Meridian defaults. A true off switch should be implemented as an explicit config flag before documenting HiveMind as disabled by clearing fields.

---

## Using a local model (LM Studio)

```env
LLM_BASE_URL=http://localhost:1234/v1
LLM_API_KEY=lm-studio
LLM_MODEL=your-local-model-name
```

Any OpenAI-compatible endpoint works.

---

## Architecture

```
index.js            Main entry: REPL + cron orchestration + Telegram bot polling
agent.js            ReAct loop: LLM → tool call → repeat
config.js           Runtime config from user-config.json + .env
prompt.js           System prompt builder (SCREENER / MANAGER / GENERAL roles)
state.js            Position registry (state.json)
decision-log.js     Structured decision log for deploy, close, skip, and no-deploy rationale
lessons.js          Learning engine: records performance, derives lessons, evolves thresholds
pool-memory.js      Per-pool deploy history + snapshots
strategy-library.js Saved LP strategies
telegram.js         Telegram bot: polling + notifications
hivemind.js         Agent Meridian HiveMind sync
smart-wallets.js    KOL/alpha wallet tracker
token-blacklist.js  Permanent token blacklist
cli.js              Direct CLI — every tool as a subcommand with JSON output

tools/
  definitions.js    Tool schemas (OpenAI format)
  executor.js       Tool dispatch + safety checks
  dlmm.js           Meteora DLMM SDK wrapper
  screening.js      Pool discovery
  wallet.js         SOL/token balances + Jupiter swap
  token.js          Token info, holders, narrative
  study.js          Top LPer study via LPAgent API

discord-listener/
  index.js          Selfbot Discord listener
  pre-checks.js     Signal pre-check pipeline

.claude/
  agents/
    screener.md     Claude Code screener sub-agent
    manager.md      Claude Code manager sub-agent
  commands/
    screen.md       /screen slash command
    manage.md       /manage slash command
    balance.md      /balance slash command
    positions.md    /positions slash command
    candidates.md   /candidates slash command
    study-pool.md   /study-pool slash command
    pool-ohlcv.md   /pool-ohlcv slash command
    pool-compare.md /pool-compare slash command
```

---

## Disclaimer

This software is provided as-is, with no warranty. Running an autonomous trading agent carries real financial risk — you can lose funds. Always start with `DRY_RUN=true` to verify behavior before going live. Never deploy more capital than you can afford to lose. This is not financial advice.

The authors are not responsible for any losses incurred through use of this software.
