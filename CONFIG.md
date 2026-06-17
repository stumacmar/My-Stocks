# Stock Compass V3 — Configuration Reference

## FMP API Key

Set via the Settings panel on first launch. Stored in `scV3.apiKey` (localStorage).

**Tier**: Paid/Starter (~750 calls/day). Batch endpoints reduce S&P 500 run to ~30 calls.

Default demo key: enter your own FMP API key in Settings.

---

## Daily Call Budget

Tracked in `scV3.dailyCallLog`. Default limit: **750 calls/day**.

To change the limit, call:
```js
import { DEFAULT_DAILY_LIMIT } from './src/data/budget.js';
// Override via settings:
dispatch(ACTIONS.PATCH_SETTINGS, { dailyCallLimit: 1500 });
```

---

## Cache TTLs

| Data type         | TTL                     | Key in `src/data/cache.js` |
|-------------------|-------------------------|---------------------------|
| Company profile   | 7 days                  | `TTL.PROFILE`             |
| Fundamentals      | 24 hours                | `TTL.FUNDAMENTALS`        |
| Live quote (open) | 15 minutes              | `TTL.QUOTE_MARKET`        |
| Quote (closed)    | 4 hours                 | `TTL.QUOTE_CLOSED`        |
| FX rate           | 1 hour                  | `TTL.FX`                  |
| ETF proxy         | 24 hours                | `TTL.ETF_PROXY`           |

---

## Scoring Presets

| ID                  | Quality | Value | Growth | Safety | Momentum |
|---------------------|---------|-------|--------|--------|----------|
| `BALANCED`          | 25%     | 25%   | 20%    | 15%    | 15%      |
| `QUALITY_COMPOUNDER`| 35%     | 15%   | 30%    | 15%    |  5%      |
| `DEEP_VALUE`        | 15%     | 45%   | 10%    | 25%    |  5%      |
| `CLASSIC_7`         | —  binary pass/fail, 7 criteria, 0–7 score  |

---

## localStorage Schema (V3)

All keys prefixed `scV3.*`. Schema version: **1**.

| Key                     | Type              | Notes                              |
|-------------------------|-------------------|------------------------------------|
| `scV3.schemaVersion`    | number            | Set to 1 after migration           |
| `scV3.apiKey`           | string            | FMP API key                        |
| `scV3.displayCurrency`  | `'GBP'`\|`'USD'` | UI display currency                |
| `scV3.fx`               | `{rate, fetchedAt}` | GBP/USD rate, 1h cache           |
| `scV3.portfolios`       | `Portfolio[]`     | User portfolios                    |
| `scV3.watchlist`        | `WatchlistItem[]` | Watchlist tickers                  |
| `scV3.savedFilters`     | `SavedFilter[]`   | Named filter presets               |
| `scV3.stockCache`       | `{[ticker]: CacheEntry}` | Per-stock data cache        |
| `scV3.screenResults`    | `ScreenRun`       | Last full screen run               |
| `scV3.dailyCallLog`     | `{date, count}[]` | Budget tracking, last 30 days      |
| `scV3.etfProxies`       | `{[ticker]: ETFProxy}` | ETF sector/factor breakdown   |
| `scV3.settings`         | `AppSettings`     | User preferences                   |
| `scV3.lastState`        | `ViewState`       | Restore last view on open          |

---

## DCF Settings

No hardcoded defaults. User must set in Settings → DCF Assumptions:
- **WACC** (discount rate)
- **Growth rate** (near-term FCF growth)
- **Terminal rate** (long-run perpetuity rate)

These are stored in `scV3.settings.dcfWacc`, `.dcfGrowthRate`, `.dcfTerminalRate`.

---

## Allocation Targets

No hardcoded presets. User sets target % per sector (or per position) in
Settings → Allocation Targets. Stored in `scV3.settings.allocationTargets`.

---

## V2 → V3 Migration

Migration runs once on first V3 load (`runMigrationIfNeeded()`):
1. Detects V2 keys (`fmp_api_key`, `portfolios`, `watchlist`, etc.)
2. Offers JSON backup download
3. Migrates data to `scV3.*` namespace
4. Leaves all V2 keys untouched for 30 days

To purge V2 keys after the grace period:
```js
import { purgeV2Data } from './src/state/migration.js';
purgeV2Data();
```

---

## File Structure

```
My-Stocks/
├── index.html          V12 production (do not modify for V3 work)
├── v3.html             V3 entry point / Phase 2+3 review page
├── src/
│   ├── main.js         Boot sequence
│   ├── state/
│   │   ├── schema.js   KEYS constants, CURRENT_SCHEMA
│   │   ├── migration.js V2→V3 migration
│   │   └── store.js    Central state store
│   ├── data/
│   │   ├── cache.js    localStorage cache with TTL + LRU
│   │   ├── budget.js   Daily call counter
│   │   ├── fx.js       FX rate + USD→GBP conversion
│   │   └── fmp.js      FMP API client (batch-first)
│   ├── engine/
│   │   ├── scoring.js  5-pillar percentile scoring engine
│   │   ├── presets.js  Scoring presets + Classic 7
│   │   ├── flags.js    5 red flag checks
│   │   └── scoring.test.js node --test tests
│   ├── portfolio/      Phase 6 (stub)
│   └── ui/             Phase 4–5 (stub)
├── lib/                Vendored libraries (uPlot — Phase 4)
└── CONFIG.md           This file
```
