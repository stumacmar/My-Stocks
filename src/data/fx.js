/**
 * FX rate fetch and USD→GBP conversion.
 * Uses FMP /fx/GBPUSD. Cached via the central store only (scV3.fx).
 */

import { getState, dispatch, ACTIONS } from '../state/store.js';
import { recordCalls, wouldExceedBudget } from './budget.js';
import { TTL } from './cache.js';

const BASE = 'https://financialmodelingprep.com/stable';

export function isMarketHours() {
  const now = new Date();
  const day = now.getUTCDay();
  const min = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (day === 0 || day === 6) return false;
  return min >= 13 * 60 + 30 && min < 20 * 60;
}

export async function getFXRate(apiKey) {
  // Check store for a fresh rate
  const stored = getState().fx;
  if (stored?.rate && stored.fetchedAt) {
    const age = Date.now() - new Date(stored.fetchedAt).getTime();
    if (age < TTL.FX) {
      return { rate: stored.rate, fetchedAt: stored.fetchedAt, fromCache: true, error: null };
    }
  }

  if (!apiKey) {
    return { rate: null, fetchedAt: null, fromCache: false, error: 'No API key configured' };
  }

  if (wouldExceedBudget(1)) {
    if (stored?.rate) {
      return { rate: stored.rate, fetchedAt: stored.fetchedAt, fromCache: true, error: 'Budget exceeded — using stale rate' };
    }
    return { rate: null, fetchedAt: null, fromCache: false, error: 'Daily call budget exceeded' };
  }

  try {
    // Same endpoint the V12/V13 app uses: quote for the GBPUSD pair.
    // price = USD per 1 GBP (~1.26); our stored rate is USD→GBP (~0.79).
    const url = `${BASE}/quote?symbol=GBPUSD&apikey=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    recordCalls(1);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const item = Array.isArray(json) ? json[0] : json;
    const usdPerGbp = typeof item?.price === 'number' ? item.price : (typeof item?.bid === 'number' ? item.bid : null);
    if (!usdPerGbp || usdPerGbp <= 0) {
      throw new Error('Unexpected FX response shape');
    }
    const rate      = 1 / usdPerGbp;
    const fetchedAt = new Date().toISOString();
    dispatch(ACTIONS.SET_FX, { rate, fetchedAt });
    return { rate, fetchedAt, fromCache: false, error: null };
  } catch (err) {
    if (stored?.rate) {
      return { rate: stored.rate, fetchedAt: stored.fetchedAt, fromCache: true, error: `Using cached rate — ${err.message}` };
    }
    return { rate: null, fetchedAt: null, fromCache: false, error: err.message };
  }
}

export function convertUSDtoGBP(usd, fxObj) {
  if (usd == null || !fxObj?.rate) {
    return { gbp: null, rate: null, fetchedAt: null, stale: true };
  }
  const age   = fxObj.fetchedAt ? Date.now() - new Date(fxObj.fetchedAt).getTime() : Infinity;
  const stale = age > TTL.FX;
  return { gbp: usd * fxObj.rate, rate: fxObj.rate, fetchedAt: fxObj.fetchedAt, stale };
}
