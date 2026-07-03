/**
 * FMP API client — batch-first, budget-aware.
 *
 * All public functions return:
 *   { data, error: string|null, callsUsed: number, fromCache: bool, fetchedAt: string }
 *
 * Batch endpoints chunk to at most CHUNK_SIZE symbols per request to stay
 * within FMP's URL-length limits (~50 symbols per call).
 *
 * The client checks wouldExceedBudget() before every network call and
 * returns a budget-exceeded error rather than making the call.
 */

import { get as cacheGet, set as cacheSet, TTL } from './cache.js';
import { recordCalls, wouldExceedBudget, getRemainingBudget } from './budget.js';
import { isMarketHours } from './fx.js';

const BASE       = 'https://financialmodelingprep.com/stable';
const CHUNK_SIZE = 50;
const TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function _fetch(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url.split('?')[0]}`);
  return res.json();
}

function _chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function _cacheKey(endpoint, extra = '') {
  return `fmp_${endpoint}_${extra}`.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function _now() { return new Date().toISOString(); }

function _budgetError() {
  return {
    data: null,
    error: `Daily call budget exceeded (${getRemainingBudget()} remaining today)`,
    callsUsed: 0,
    fromCache: false,
    fetchedAt: _now(),
  };
}

// ---------------------------------------------------------------------------
// Bulk quote — up to 50 symbols per call
// ---------------------------------------------------------------------------

/**
 * Fetch latest quotes for a list of symbols.
 * Returns { data: Map<ticker, quoteObj>, ... }
 */
export async function fetchBulkQuotes(symbols, apiKey) {
  if (!symbols?.length) return { data: new Map(), error: null, callsUsed: 0, fromCache: true, fetchedAt: _now() };

  const quoteTtl = isMarketHours() ? TTL.QUOTE_MARKET : TTL.QUOTE_CLOSED;
  const chunks   = _chunk(symbols, CHUNK_SIZE);
  const result   = new Map();
  let   totalCalls = 0;
  let   anyFromCache = true;
  let   fetchedAt = _now();

  for (const chunk of chunks) {
    // Check which symbols in this chunk are cached
    const uncached = chunk.filter(s => cacheGet(_cacheKey('quote', s)) === null);

    if (uncached.length === 0) {
      // All cached
      for (const s of chunk) {
        result.set(s, cacheGet(_cacheKey('quote', s)));
      }
      continue;
    }

    // Fetch uncached symbols as one batch call
    if (wouldExceedBudget(1)) return _budgetError();

    try {
      const tickers = uncached.join(',');
      const url     = `${BASE}/quote?symbols=${tickers}&apikey=${encodeURIComponent(apiKey)}`;
      const json    = await _fetch(url);

      recordCalls(1);
      totalCalls++;
      anyFromCache = false;
      fetchedAt    = _now();

      const arr = Array.isArray(json) ? json : [json];
      for (const q of arr) {
        if (!q?.symbol) continue;
        cacheSet(_cacheKey('quote', q.symbol), q, quoteTtl);
        result.set(q.symbol, q);
      }

      // For symbols in uncached that didn't come back, mark null
      for (const s of uncached) {
        if (!result.has(s)) result.set(s, null);
      }
    } catch (err) {
      return { data: result, error: err.message, callsUsed: totalCalls, fromCache: anyFromCache, fetchedAt };
    }

    // Fill remaining symbols from cache
    for (const s of chunk) {
      if (!result.has(s)) {
        result.set(s, cacheGet(_cacheKey('quote', s)));
      }
    }
  }

  return { data: result, error: null, callsUsed: totalCalls, fromCache: anyFromCache, fetchedAt };
}

// ---------------------------------------------------------------------------
// Company profile
// ---------------------------------------------------------------------------

/**
 * Fetch company profile for a single ticker.
 */
export async function fetchProfile(ticker, apiKey) {
  const cKey   = _cacheKey('profile', ticker);
  const cached = cacheGet(cKey);
  if (cached) return { data: cached, error: null, callsUsed: 0, fromCache: true, fetchedAt: cached._fetchedAt || _now() };

  if (wouldExceedBudget(1)) return _budgetError();

  try {
    const url  = `${BASE}/profile/${ticker}?apikey=${encodeURIComponent(apiKey)}`;
    const json = await _fetch(url);
    recordCalls(1);

    const item = Array.isArray(json) ? json[0] : json;
    if (!item) throw new Error('Empty profile response');

    item._fetchedAt = _now();
    cacheSet(cKey, item, TTL.PROFILE);
    return { data: item, error: null, callsUsed: 1, fromCache: false, fetchedAt: item._fetchedAt };
  } catch (err) {
    return { data: null, error: err.message, callsUsed: 1, fromCache: false, fetchedAt: _now() };
  }
}

// ---------------------------------------------------------------------------
// Key metrics (fundamentals + ratios)
// ---------------------------------------------------------------------------

/**
 * Fetch key metrics TTM for a single ticker.
 */
export async function fetchKeyMetrics(ticker, apiKey) {
  const cKey   = _cacheKey('keymetrics', ticker);
  const cached = cacheGet(cKey);
  if (cached) return { data: cached, error: null, callsUsed: 0, fromCache: true, fetchedAt: _now() };

  if (wouldExceedBudget(1)) return _budgetError();

  try {
    const url  = `${BASE}/key-metrics-ttm/${ticker}?apikey=${encodeURIComponent(apiKey)}`;
    const json = await _fetch(url);
    recordCalls(1);

    const item = Array.isArray(json) ? json[0] : json;
    if (!item) throw new Error('Empty key-metrics response');

    cacheSet(cKey, item, TTL.FUNDAMENTALS);
    return { data: item, error: null, callsUsed: 1, fromCache: false, fetchedAt: _now() };
  } catch (err) {
    return { data: null, error: err.message, callsUsed: 1, fromCache: false, fetchedAt: _now() };
  }
}

// ---------------------------------------------------------------------------
// Income statement (annual, last 5 years)
// ---------------------------------------------------------------------------

/**
 * Fetch annual income statements (last 5 years).
 */
export async function fetchIncomeStatements(ticker, apiKey, limit = 5) {
  const cKey   = _cacheKey('income', ticker);
  const cached = cacheGet(cKey);
  if (cached) return { data: cached, error: null, callsUsed: 0, fromCache: true, fetchedAt: _now() };

  if (wouldExceedBudget(1)) return _budgetError();

  try {
    const url  = `${BASE}/income-statement/${ticker}?period=annual&limit=${limit}&apikey=${encodeURIComponent(apiKey)}`;
    const json = await _fetch(url);
    recordCalls(1);

    const arr = Array.isArray(json) ? json : [];
    cacheSet(cKey, arr, TTL.FUNDAMENTALS);
    return { data: arr, error: null, callsUsed: 1, fromCache: false, fetchedAt: _now() };
  } catch (err) {
    return { data: null, error: err.message, callsUsed: 1, fromCache: false, fetchedAt: _now() };
  }
}

// ---------------------------------------------------------------------------
// Cash flow statement (annual, last 5 years)
// ---------------------------------------------------------------------------

export async function fetchCashFlowStatements(ticker, apiKey, limit = 5) {
  const cKey   = _cacheKey('cashflow', ticker);
  const cached = cacheGet(cKey);
  if (cached) return { data: cached, error: null, callsUsed: 0, fromCache: true, fetchedAt: _now() };

  if (wouldExceedBudget(1)) return _budgetError();

  try {
    const url  = `${BASE}/cash-flow-statement/${ticker}?period=annual&limit=${limit}&apikey=${encodeURIComponent(apiKey)}`;
    const json = await _fetch(url);
    recordCalls(1);

    const arr = Array.isArray(json) ? json : [];
    cacheSet(cKey, arr, TTL.FUNDAMENTALS);
    return { data: arr, error: null, callsUsed: 1, fromCache: false, fetchedAt: _now() };
  } catch (err) {
    return { data: null, error: err.message, callsUsed: 1, fromCache: false, fetchedAt: _now() };
  }
}

// ---------------------------------------------------------------------------
// Balance sheet (annual, last 5 years)
// ---------------------------------------------------------------------------

export async function fetchBalanceSheets(ticker, apiKey, limit = 5) {
  const cKey   = _cacheKey('balance', ticker);
  const cached = cacheGet(cKey);
  if (cached) return { data: cached, error: null, callsUsed: 0, fromCache: true, fetchedAt: _now() };

  if (wouldExceedBudget(1)) return _budgetError();

  try {
    const url  = `${BASE}/balance-sheet-statement/${ticker}?period=annual&limit=${limit}&apikey=${encodeURIComponent(apiKey)}`;
    const json = await _fetch(url);
    recordCalls(1);

    const arr = Array.isArray(json) ? json : [];
    cacheSet(cKey, arr, TTL.FUNDAMENTALS);
    return { data: arr, error: null, callsUsed: 1, fromCache: false, fetchedAt: _now() };
  } catch (err) {
    return { data: null, error: err.message, callsUsed: 1, fromCache: false, fetchedAt: _now() };
  }
}

// ---------------------------------------------------------------------------
// Price history (for momentum + DCF)
// ---------------------------------------------------------------------------

/**
 * Fetch daily price history.
 * @param {string} ticker
 * @param {string} apiKey
 * @param {number} days - how many days back (default 365)
 */
export async function fetchPriceHistory(ticker, apiKey, days = 365) {
  const cKey   = _cacheKey('price', ticker);
  const cached = cacheGet(cKey);
  if (cached) return { data: cached, error: null, callsUsed: 0, fromCache: true, fetchedAt: _now() };

  if (wouldExceedBudget(1)) return _budgetError();

  try {
    const from = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
    const url  = `${BASE}/historical-price-eod/full/${ticker}?from=${from}&apikey=${encodeURIComponent(apiKey)}`;
    const json = await _fetch(url);
    recordCalls(1);

    const arr = json?.historical || (Array.isArray(json) ? json : []);
    cacheSet(cKey, arr, isMarketHours() ? TTL.QUOTE_MARKET : TTL.QUOTE_CLOSED);
    return { data: arr, error: null, callsUsed: 1, fromCache: false, fetchedAt: _now() };
  } catch (err) {
    return { data: null, error: err.message, callsUsed: 1, fromCache: false, fetchedAt: _now() };
  }
}

// ---------------------------------------------------------------------------
// Bulk screener snapshot — S&P 500 fundamentals batch
// ---------------------------------------------------------------------------

/**
 * Estimate the bulk-quote call cost of a screen run before making any calls.
 * Covers only the quote phase (1 call per 50 symbols); per-ticker fundamental
 * fetches are budget-checked individually as the run progresses.
 */
export function estimateScreenCost(symbols) {
  const quoteCalls = Math.ceil(symbols.length / CHUNK_SIZE);
  return { quoteCalls, totalEstimate: quoteCalls };
}

/**
 * Fetch all data needed to score a single ticker.
 * Returns { data: { profile, keyMetrics, income, cashFlow, balance, priceHistory },
 *           error, callsUsed, fromCache, fetchedAt }
 */
export async function fetchStockData(ticker, apiKey) {
  const results = await Promise.allSettled([
    fetchProfile(ticker, apiKey),
    fetchKeyMetrics(ticker, apiKey),
    fetchIncomeStatements(ticker, apiKey),
    fetchCashFlowStatements(ticker, apiKey),
    fetchBalanceSheets(ticker, apiKey),
    fetchPriceHistory(ticker, apiKey),
  ]);

  const [profileR, metricsR, incomeR, cashR, balanceR, priceR] = results;

  let callsUsed  = 0;
  let anyError   = null;
  let fromCache  = true;

  const extract = (r, field) => {
    if (r.status === 'rejected') { anyError = r.reason?.message || 'fetch error'; return null; }
    callsUsed += r.value.callsUsed || 0;
    if (!r.value.fromCache) fromCache = false;
    if (r.value.error) anyError = r.value.error;
    return r.value.data;
  };

  return {
    data: {
      profile:      extract(profileR),
      keyMetrics:   extract(metricsR),
      income:       extract(incomeR),
      cashFlow:     extract(cashR),
      balance:      extract(balanceR),
      priceHistory: extract(priceR),
    },
    error:     anyError,
    callsUsed,
    fromCache,
    fetchedAt: _now(),
  };
}
