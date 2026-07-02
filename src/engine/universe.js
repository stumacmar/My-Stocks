/**
 * Universe-level pillar computation.
 *
 * The per-stock scorer in scoring.js recomputes percentile distributions for
 * every stock — fine for one stock, O(n²) for a whole run. This module does
 * the whole-universe pass the right way: extract raw metrics for every
 * ticker, sort each metric's distribution ONCE, then read every stock's
 * percentile off the sorted ranks.
 *
 * Two data paths feed it:
 *   - a live run (each scored stock carries its fundamentals in memory)
 *   - the LRU cache (fundamentals persisted from a previous run) — this lets
 *     an old results list be enriched with pillars using zero API calls.
 */

import { METRICS, extractMetrics, computePercentiles } from './scoring.js';

export const PILLAR_IDS = ['quality', 'value', 'growth', 'safety', 'momentum'];

/**
 * Compute pillar scores (0–100 each) for every ticker in a universe.
 *
 * @param {Map<string, { fundamentals: object, priceHistory: object[]|null }>} fundMap
 * @returns {Map<string, { quality, value, growth, safety, momentum }>}
 *          Pillars with no valid inputs are null.
 */
export function computeUniversePillars(fundMap) {
  const out = new Map();
  if (!fundMap || fundMap.size === 0) return out;

  // 1. Extract raw metrics per ticker
  const rawByTicker = new Map();
  for (const [ticker, { fundamentals, priceHistory }] of fundMap) {
    try {
      rawByTicker.set(ticker, extractMetrics(fundamentals || {}, priceHistory || null, null));
    } catch {
      rawByTicker.set(ticker, new Map());
    }
  }

  // 2. One percentile pass per metric across the whole universe
  const pctByMetric = new Map();  // metricId → Map<ticker, pct|null>
  for (const [metricId, def] of Object.entries(METRICS)) {
    const values = new Map();
    for (const [ticker, raw] of rawByTicker) {
      values.set(ticker, raw.get(metricId) ?? null);
    }
    const pcts = computePercentiles(values);
    if (def.lowerIsBetter) {
      for (const [t, p] of pcts) {
        if (p != null) pcts.set(t, 100 - p);
      }
    }
    pctByMetric.set(metricId, pcts);
  }

  // 3. Aggregate percentiles into pillars per ticker
  const metricsByPillar = {};
  for (const pid of PILLAR_IDS) {
    metricsByPillar[pid] = Object.entries(METRICS)
      .filter(([, def]) => def.pillar === pid)
      .map(([id]) => id);
  }

  for (const ticker of rawByTicker.keys()) {
    const pillars = {};
    for (const pid of PILLAR_IDS) {
      const vals = metricsByPillar[pid]
        .map(id => pctByMetric.get(id)?.get(ticker))
        .filter(v => v != null);
      pillars[pid] = vals.length > 0
        ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length)
        : null;
    }
    out.set(ticker, pillars);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Cache reconstruction
// ---------------------------------------------------------------------------

// Must match the key sanitisation in src/data/fmp.js
function _sanitize(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
}

const CACHE_ENDPOINTS = {
  profile:    'profile',
  keymetrics: 'keyMetrics',
  income:     'income',
  cashflow:   'cashFlow',
  balance:    'balance',
  price:      'priceHistory',
};

/**
 * Rebuild a fundMap from the persisted LRU cache blob.
 *
 * Cache keys look like `fmp_income_AAPL` (tickers sanitised, so BRK.B is
 * stored as BRK_B). The universe list resolves sanitised names back to real
 * tickers. TTL is deliberately ignored — for charting, stale beats missing.
 *
 * @param {object} stockCache - the raw cache blob ({ key: { v, ... } })
 * @param {string[]} universe - real ticker symbols to look for
 * @returns {Map<string, { fundamentals, priceHistory }>}
 */
export function fundMapFromCache(stockCache, universe) {
  const out = new Map();
  if (!stockCache || !universe?.length) return out;

  const bySanitized = new Map(universe.map(t => [_sanitize(t), t]));
  const collected   = new Map();  // realTicker → { profile, keyMetrics, ... }

  for (const [key, entry] of Object.entries(stockCache)) {
    if (!key.startsWith('fmp_') || entry?.v == null) continue;
    const rest = key.slice(4);  // e.g. "income_BRK_B"
    const sep  = rest.indexOf('_');
    if (sep < 0) continue;
    const endpoint = rest.slice(0, sep);
    const field    = CACHE_ENDPOINTS[endpoint];
    if (!field) continue;
    const ticker = bySanitized.get(rest.slice(sep + 1));
    if (!ticker) continue;

    if (!collected.has(ticker)) collected.set(ticker, {});
    collected.get(ticker)[field] = entry.v;
  }

  for (const [ticker, parts] of collected) {
    // Need at least a statement to derive anything meaningful
    if (!parts.income && !parts.balance && !parts.keyMetrics) continue;
    out.set(ticker, {
      fundamentals: {
        profile:    parts.profile    || {},
        keyMetrics: parts.keyMetrics || {},
        income:     parts.income     || [],
        cashFlow:   parts.cashFlow   || [],
        balance:    parts.balance    || [],
      },
      priceHistory: parts.priceHistory || null,
    });
  }

  return out;
}
