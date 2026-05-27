# Config Detail — Meridian Agent

## Format File: `user-config.json`

```json
{
  "global": {
    "risk": { ... },
    "screening": { ... },
    "management": { ... },
    "schedule": { ... },
    "llm": { ... }
  },
  "wallets": {
    "<wallet-address>": {
      "risk": { ... },
      "screening": { ... },
      "management": { ... }
    }
  },
  "hiveMindUrl": "",
  "jupiter": { ... },
  "llmBaseUrl": "https://api.deepseek.com/v1",
  "agentId": "..."
}
```

### Per-Wallet Override

Setiap wallet mendapat `WALLET_ID` (public key address) saat di-spawn via dashboard. `config.js` membaca `process.env.WALLET_ID` dan melakukan merge:

```
final section = global.<section> → override wallets[WALLET_ID].<section>
```

**Contoh:** Jika `global.risk.maxPositions = 2`, tapi wallet `4ugbHCd...` punya override `wallets["4ugbHCd..."].risk.maxPositions = 1`, maka wallet itu hanya boleh buka MAX 1 posisi — wallet lain tetap mengikuti global (2).

**Reset ke global:** Kirim config kosong via POST `/api/wallets/:id/config` → override dihapus → wallet kembali ke nilai global.

### Backward Compatibility

Format lama (section di root tanpa wrapper `global`) masih terbaca:
```
u.risk → fallback jika u.global.risk belum ada
```
File otomatis migrate ke format baru seiring waktu saat config ditulis ulang dari dashboard.

---

## Sections & Keys

### `risk` — Batas Risiko per Wallet

| Key | Default | Deskripsi |
|---|---|---|
| `maxPositions` | `3` | **MAKSIMAL POSISI BUKA per wallet** — bukan global. Tiap wallet punya batasannya sendiri. Contoh: jika `maxPositions=2`, wallet itu hanya boleh punya 2 posisi buka sekaligus. Wallet lain tidak terpengaruh. |
| `maxDeployAmount` | `1.5` | Maks SOL yang bisa dideploy dalam satu kali (per wallet) |
| `maxSwapSol` | `2` | Maks SOL untuk swap/close posisi |
| `hardStopLossPct` | `-25` | Stop-loss keras (%) dari entry price — otomatis close |
| `dailyMaxDrawdownSol` | `3` | Maks kerugian harian (SOL) — screening berhenti setelah ini |

### `screening` — Filter Token

| Key | Default | Deskripsi |
|---|---|---|
| `minTvl` | `10_000` | Min TVL (USD) pool |
| `maxTvl` | `200_000` | Max TVL — terlalu besar = lambat gerak |
| `minTokenFeesSol` | `40` | Min fee 24h (SOL) |
| `minHolders` | `500` | Min jumlah holder |
| `minOrganic` | `65` | Min organic holder score |
| `minQuoteOrganic` | `65` | Min organic holder score untuk quote token |
| `maxTop10Pct` | `55` | Maks % supply di top 10 holder |
| `maxBundlePct` | `25` | Maks % bundled supply |
| `maxBotHoldersPct` | `25` | Maks % bot holder |

### `management` — Manajemen Posisi

| Key | Default | Deskripsi |
|---|---|---|
| `stopLossPct` | `-15` | Stop-loss (%) dari entry |
| `takeProfitPct` | `8` | Take-profit (%) dari entry |
| `trailingTakeProfit` | `true` | Enable trailing TP — kunci profit saat harga naik |
| `trailingTriggerPct` | `4` | Aktifkan trailing setelah profit X% |
| `trailingDropPct` | `2` | Close saat trailing turun X% dari peak |
| `outOfRangeWaitMinutes` | `15` | Tunggu OOR selama ini sebelum close |
| `oorCooldownTriggerCount` | `2` | OOR trigger count sebelum cooldown |
| `oorCooldownHours` | `24` | Cooldown duration (jam) setelah OOR |
| `minSolToOpen` | `0.7` | Min wallet balance SOL untuk buka posisi |
| `deployAmountSol` | `0.5` | Default SOL deploy per posisi |
| `gasReserve` | `0.3` | SOL cadangan untuk gas/fee |
| `positionSizePct` | `0.25` | Posisi = fraction dari deployable SOL |

### `schedule` — Jadwal

| Key | Default | Deskripsi |
|---|---|---|
| `deployHoursStart` | `8` | Jam mulai deploy window (UTC) |
| `deployHoursEnd` | `20` | Jam akhir deploy window |
| `managementIntervalMin` | `10` | Interval manajemen posisi (menit) |
| `screeningIntervalMin` | `10` | Interval screening token baru (menit) |
| `healthCheckIntervalMin` | `60` | Interval health check (menit) |

### `llm` — Model LLM per Wallet

| Key | Default | Deskripsi |
|---|---|---|
| `model` | `"deepseek-chat"` | Model ID yang dipakai |
| `temperature` | `0.1` | LLM temperature — rendah untuk decision konsisten |
| `maxTokens` | `16000` | Max output tokens |
| `maxRetriesBeforeCooldownHours` | `24` | Cooldown setelah max retry |

### `jupiter` — Jupiter DEX

| Key | Default | Deskripsi |
|---|---|---|
| `slippageBps` | `200` | Slippage tolerance (bps) = 2% |
| `excludedSources` | `["Whirlpool"]` | Sumber likuiditas yang dihindari |
| `onlyDirectRoutes` | `false` | Hanya direct routes |
| `asLegacyTransaction` | `false` | Format transaksi legacy vs v0 |

### `hiveMind` — Shared Intelligence

| Key | Default | Deskripsi |
|---|---|---|
| `enabled` | `false` | Aktifkan hive-mind sharing |
| `url` | `""` | URL hive-mind server |
| `syncIntervalMin` | `15` | Interval sync (menit) |

---

## Mengubah Config

### Via Dashboard UI
1. Klik **⚙ config** di baris wallet yang mau diubah
2. Edit field risk/screening/management yang diinginkan
3. Kosongkan = pakai nilai global
4. **Save** → override disimpan di `user-config.json` untuk wallet itu saja
5. **Reset to Global** → hapus semua override, kembali ke global

### Via API
```bash
# Baca config wallet
GET /api/wallets/:id/config

# Ubah override
POST /api/wallets/:id/config
{
  "config": {
    "risk": { "maxPositions": 1 },
    "screening": { "minTvl": 30000 },
    "management": { "stopLossPct": -20 }
  },
  "reason": "wallet butuh lebih konservatif"
}

# Reset ke global (hapus override)
POST /api/wallets/:id/config
{ "config": {} }
```

### Global Config
Edit di dashboard → Configuration section, atau langsung edit `user-config.json` bagian `global`.

---

## Notes Penting

- **`maxPositions` adalah batas PER WALLET**, bukan global. Setiap wallet punya batasannya sendiri dari config masing-masing.
- `config.js` membaca config sekali saat module load. Perubahan via dashboard otomatis apply ke runtime agent aktif.
- `lessons.js` evolveThresholds() hanya mengubah `global.screening` — evolution berlaku ke semua wallet.
- Wallet tanpa override = membaca 100% dari `global`.
- Primary wallet (`_env` / Fifb) juga bisa punya override via `wallets[<primary-address>]`.
