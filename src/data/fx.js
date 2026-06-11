/**
 * FX rate fetch and USD → GBP conversion.
 *
 * - Uses FMP /fx/GBPUSD endpoint (stable base URL)
 * - 1-hour cache via src/data/cache.js
 * - Always returns a result object with a `stale` flag — never throws to callers
 * - Conversion always returns { gbp, rate, fetchedAt, stale, error }
 */

import { get as cacheGet, set as cacheSet, getFreshness, TTL } from './cache.js';
import { recordCalls, wouldExceedBudget } from './budget.js';
import { getState, dispatch, ACTIONS } from '../state/store.js';

const BASE         = 'https://financialmodelingprep.com/stable';
const FX_CACHE_KEY = 'fx_gbpusd';

// ---------------------------------------------------------------------------
// Market-hours helper
// ---------------------------------------------------------------------------

/**
 * Returns true if current UTC time is within approximate US market hours
 * (Mon–Fri, 13:30–20:00 UTC, which covers NYSE/NASDAQ core hours).
 */
export function isMarketHours() {
  const now  = new Date();
  const day  = now.getUTCDay();        // 0=Sun, 6=Sat
  const hour = now.getUTCHours();
  const min  = now.getUTCMinutes();
  if (day === 0 || day === 6) return false;
  const minutes = hour * 60 + min;
  return minutes >= 13 * 60 + 30 && minutes < 20 * 60;
}

// ---------------------------------------------------------------------------
// Core fetch
// ---------------------------------------------------------------------------

/**
 * Fetch the current GBP/USD rate from FMP.
 * Returns { rate: number, fetchedAt: ISO, fromCache: bool, error: string|null }.
 */
export async function getFXRate(apiKey) {
  // Check 1-hour cache first
  const cached = cacheGet(FX_CACHE_KEY);
  if (cached !== null) {
    return { rate: cached.rate, fetchedAt: cached.fetchedAt, fromCache: true, error: null };
  }

  if (!apiKey) {
    return { rate: null, fetchedAt: null, fromCache: false, error: 'No API key configured' };
  }

  if (wouldExceedBudget(1)) {
    // Return stale value from store if available
    const stale = getState().fx;
    if (stale?.rate) {
      return { rate: stale.rate, fetchedAt: stale.fetchedAt, fromCache: true, error: 'Budget exceeded — using stale rate' };
    }
    return { rate: null, fetchedAt: null, fromCache: false, error: 'Daily call budget exceeded' };
  }

  try {
    const url = `${BASE}/fx/GBPUSD?apikey=${apiKey}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });

    recordCalls(1);

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const json = await res.json();

    // FMP returns either an array or single object depending on endpoint version
    const item = Array.isArray(json) ? json[0] : json;
    if (!item || typeof item.bid !== 'number') {
      throw new Error('Unexpected FX response shape');
    }

    // GBP/USD bid = price of 1 GBP in USD → to get USD→GBP: rate = 1 / bid
    const rate = 1 / item.bid;
    const fetchedAt = new Date().toISOString();

    const fxObj = { rate, fetchedAt };
    cacheSet(FX_CACHE_KEY, fxObj, TTL.FX);
    dispatch(ACTIONS.SET_FX, fxObj);

    return { rate, fetchedAt, fromCache: false, error: null };
  } catch (err) {
    const stale = getState().fx;
    if (stale?.rate) {
      return { rate: stale.rate, fetchedAt: stale.fetchedAt, fromCache: true, error: `Using cached rate — ${err.message}` };
    }
    return { rate: null, fetchedAt: null, fromCache: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Conversion helper
// ---------------------------------------------------------------------------

/**
 * Convert a USD amount to GBP.
 * @param {number|null} usd
 * @param {{ rate: number, fetchedAt: string }|null} fxObj
 * @returns {{ gbp: number|null, rate: number|null, fetchedAt: string|null, stale: bool }}
 */
export function convertUSDtoGBP(usd, fxObj) {
  if (usd == null || !fxObj?.rate) {
    return { gbp: null, rate: null, fetchedAt: null, stale: true };
  }

  const freshness = getFreshness(FX_CACHE_KEY);
  const stale     = !freshness.fresh;

  return {
    gbp:       usd * fxObj.rate,
    rate:      fxObj.rate,
    fetchedAt: fxObj.fetchedAt,
    stale,
  };
}
