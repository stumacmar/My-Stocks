/**
 * V2 → V3 data migration.
 *
 * Strategy:
 *   1. Detect V2 data (presence of legacy keys)
 *   2. Offer JSON backup download before touching anything
 *   3. Migrate portfolios, watchlist, API key, per-stock cache → scV3.* namespace
 *   4. Leave all V2 keys intact for 30 days (do not delete)
 *   5. Write scV3.schemaVersion = 1 to mark completion
 *
 * Idempotent: if schemaVersion is already set, returns immediately.
 */

import { KEYS, CURRENT_SCHEMA } from './schema.js';

const V2_KEY_API        = 'fmp_api_key';
const V2_KEY_PORTFOLIOS = 'portfolios';
const V2_KEY_WATCHLIST  = 'watchlist';
const V2_KEY_PER_STOCK  = 'per_stock_cache';
const V2_KEY_RUN_CACHE  = 'run_cache';

function readJSON(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/**
 * Snapshot every V2 key that exists into a single object for backup.
 */
function snapshotV2() {
  const snap = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || k.startsWith('scV3.')) continue;
    snap[k] = localStorage.getItem(k);
  }
  return snap;
}

/**
 * Trigger a JSON file download in the browser.
 */
function downloadBackup(snapshot) {
  try {
    const blob = new Blob(
      [JSON.stringify(snapshot, null, 2)],
      { type: 'application/json' }
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `stock-compass-v2-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch {
    // non-fatal: backup is nice-to-have
  }
}

/**
 * Migrate V2 portfolio array → V3 portfolios array.
 * V2 portfolio entries already have the right shape; we wrap them in
 * an outer array if they aren't already (V2 stored a flat array of holdings).
 */
function migratePortfolios(v2Portfolios) {
  if (!Array.isArray(v2Portfolios)) return [];

  // V2 may have stored a flat array of holdings (single portfolio)
  // or an array of portfolio objects. Detect by checking first element.
  const first = v2Portfolios[0];
  if (!first) return [];

  if (first.holdings) {
    // Already wrapped: array of { name, holdings, ... }
    return v2Portfolios.map((p, i) => ({
      id:        p.id   || `portfolio_${i}`,
      name:      p.name || `Portfolio ${i + 1}`,
      currency:  p.currency || 'GBP',
      holdings:  Array.isArray(p.holdings) ? p.holdings : [],
      createdAt: p.createdAt || new Date().toISOString(),
    }));
  } else {
    // Flat array of holdings → single portfolio
    return [{
      id:        'portfolio_0',
      name:      'My Portfolio',
      currency:  'GBP',
      holdings:  v2Portfolios,
      createdAt: new Date().toISOString(),
    }];
  }
}

/**
 * Main entry point. Call once at app startup.
 * Returns true if migration ran, false if already done or nothing to migrate.
 */
export function runMigrationIfNeeded({ offerBackupDownload = true } = {}) {
  // Already migrated
  const existing = readJSON(KEYS.SCHEMA_VERSION);
  if (existing && existing >= CURRENT_SCHEMA) return false;

  // Nothing to migrate (fresh install)
  const hasV2 = Boolean(
    localStorage.getItem(V2_KEY_API) ||
    localStorage.getItem(V2_KEY_PORTFOLIOS) ||
    localStorage.getItem(V2_KEY_RUN_CACHE)
  );
  if (!hasV2) {
    writeJSON(KEYS.SCHEMA_VERSION, CURRENT_SCHEMA);
    return false;
  }

  // 1. Snapshot and offer backup
  const snapshot = snapshotV2();
  if (offerBackupDownload) {
    downloadBackup(snapshot);
  }

  // 2. Migrate API key
  const v2ApiKey = localStorage.getItem(V2_KEY_API);
  if (v2ApiKey) {
    localStorage.setItem(KEYS.API_KEY, v2ApiKey);
  }

  // 3. Migrate portfolios
  const v2Portfolios = readJSON(V2_KEY_PORTFOLIOS);
  if (v2Portfolios) {
    writeJSON(KEYS.PORTFOLIOS, migratePortfolios(v2Portfolios));
  }

  // 4. Migrate watchlist
  const v2Watchlist = readJSON(V2_KEY_WATCHLIST);
  if (v2Watchlist && Array.isArray(v2Watchlist)) {
    writeJSON(KEYS.WATCHLIST, v2Watchlist);
  }

  // 5. Migrate per-stock cache entries
  const v2PerStock = readJSON(V2_KEY_PER_STOCK);
  if (v2PerStock && typeof v2PerStock === 'object') {
    // Wrap each entry in V3 cache envelope with a 24h TTL
    const now = Date.now();
    const v3Cache = {};
    for (const [ticker, data] of Object.entries(v2PerStock)) {
      v3Cache[ticker] = {
        v:          data,
        fetchedAt:  new Date(now).toISOString(),
        ttl:        24 * 60 * 60 * 1000,  // 24h
        accessedAt: now,
      };
    }
    writeJSON(KEYS.STOCK_CACHE, v3Cache);
  }

  // 6. Stamp schema version — marks migration complete
  writeJSON(KEYS.SCHEMA_VERSION, CURRENT_SCHEMA);

  console.info('[V3 migration] completed — V2 keys left intact for 30 days');
  return true;
}

/**
 * Remove all V2 keys. Call this manually after the 30-day grace period,
 * or expose via Settings → "Clean up old data".
 */
export function purgeV2Data() {
  const toDelete = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && !k.startsWith('scV3.')) toDelete.push(k);
  }
  toDelete.forEach(k => localStorage.removeItem(k));
  return toDelete.length;
}
