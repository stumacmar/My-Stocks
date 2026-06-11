/**
 * Portfolio CRUD operations and return calculations.
 *
 * All mutations go through the central store → auto-persisted to localStorage.
 */

import { getState, dispatch, ACTIONS } from '../state/store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

export function ragFromScore7(score) {
  if (score == null) return null;
  if (score === 7)   return 'hot';
  if (score >= 6)    return 'strong';
  if (score >= 4)    return 'watch';
  return 'avoid';
}

export const RAG_LABELS = { hot: '★ Hot', strong: 'Strong', watch: 'Watch', avoid: 'Avoid' };
export const RAG_COLORS = { hot: '#f5c518', strong: '#2ecc71', watch: '#f59e0b', avoid: '#f87171' };

// ---------------------------------------------------------------------------
// Portfolio CRUD
// ---------------------------------------------------------------------------

export function getPortfolios() {
  return getState().portfolios || [];
}

export function createPortfolio(name, currency = 'GBP') {
  const p = {
    id:        uuid(),
    name:      name.trim() || 'My Portfolio',
    currency,
    holdings:  [],
    createdAt: new Date().toISOString(),
  };
  dispatch(ACTIONS.SET_PORTFOLIOS, [...getPortfolios(), p]);
  return p;
}

export function deletePortfolio(id) {
  dispatch(ACTIONS.SET_PORTFOLIOS, getPortfolios().filter(p => p.id !== id));
}

export function renamePortfolio(id, name) {
  dispatch(ACTIONS.SET_PORTFOLIOS,
    getPortfolios().map(p => p.id === id ? { ...p, name: name.trim() } : p)
  );
}

// ---------------------------------------------------------------------------
// Holding CRUD
// ---------------------------------------------------------------------------

/**
 * @param {string} portfolioId
 * @param {{
 *   ticker: string,
 *   name?: string,
 *   type?: 'stock'|'fund'|'etf'|'cash',
 *   shares: number,
 *   entryPrice: number,
 *   entryCurrency?: 'GBP'|'USD',
 *   entryDate?: string,
 *   entryScore?: number|null,
 *   accountType?: 'ISA'|'SIPP'|'GIA'|'Other',
 *   notes?: string,
 * }} data
 */
export function addHolding(portfolioId, data) {
  const holding = {
    id:            uuid(),
    ticker:        (data.ticker || '').toUpperCase().trim(),
    name:          data.name || data.ticker || '',
    type:          data.type || 'stock',
    shares:        Number(data.shares) || 0,
    entryPrice:    Number(data.entryPrice) || 0,
    entryCurrency: data.entryCurrency || 'USD',
    entryDate:     data.entryDate || new Date().toISOString().slice(0, 10),
    entryScore:    data.entryScore ?? null,   // Classic 7 (0–7), captured at add time
    accountType:   data.accountType || 'GIA',
    notes:         data.notes || '',
    addedAt:       new Date().toISOString(),
  };

  dispatch(ACTIONS.SET_PORTFOLIOS,
    getPortfolios().map(p => {
      if (p.id !== portfolioId) return p;
      return { ...p, holdings: [...(p.holdings || []), holding] };
    })
  );

  return holding;
}

export function updateHolding(portfolioId, holdingId, updates) {
  dispatch(ACTIONS.SET_PORTFOLIOS,
    getPortfolios().map(p => {
      if (p.id !== portfolioId) return p;
      return { ...p, holdings: p.holdings.map(h => h.id === holdingId ? { ...h, ...updates } : h) };
    })
  );
}

export function removeHolding(portfolioId, holdingId) {
  dispatch(ACTIONS.SET_PORTFOLIOS,
    getPortfolios().map(p => {
      if (p.id !== portfolioId) return p;
      return { ...p, holdings: p.holdings.filter(h => h.id !== holdingId) };
    })
  );
}

// ---------------------------------------------------------------------------
// Return calculations
// ---------------------------------------------------------------------------

/**
 * Calculate return for a single holding.
 *
 * FX note: the stored `fxObj.rate` from fx.js = USD→GBP rate (≈0.79).
 * - USD to GBP: price * rate
 * - GBP to USD: price / rate
 *
 * @param {object}  holding
 * @param {number|null} currentPriceUSD  - current price in USD from FMP
 * @param {{ rate: number }|null} fxObj
 * @param {'GBP'|'USD'} displayCurrency
 * @returns {{ value, costBasis, returnAbs, returnPct }|null}
 */
export function holdingReturn(holding, currentPriceUSD, fxObj, displayCurrency = 'GBP') {
  const { shares, entryPrice, entryCurrency } = holding;
  if (!shares || currentPriceUSD == null) return null;

  const rate = fxObj?.rate || null;

  // Convert entry price to USD
  let entryPriceUSD;
  if (entryCurrency === 'GBP') {
    if (!rate) return null;  // can't convert without FX
    entryPriceUSD = entryPrice / rate;  // GBP / (USD→GBP rate) = GBP * (GBP→USD rate) ... wait
    // rate ≈ 0.794 (USD→GBP): 1 USD * 0.794 = £0.794
    // GBP to USD: £1 / 0.794 ≈ $1.26
    entryPriceUSD = entryPrice / rate;  // £ / 0.794 ≈ $ ✓
  } else {
    entryPriceUSD = entryPrice;
  }

  const costBasisUSD    = entryPriceUSD * shares;
  const currentValueUSD = currentPriceUSD * shares;

  // Convert to display currency
  const factor    = displayCurrency === 'GBP' ? (rate ?? 1) : 1;
  const costBasis = costBasisUSD    * factor;
  const value     = currentValueUSD * factor;
  const returnAbs = value - costBasis;
  const returnPct = costBasis > 0 ? (returnAbs / costBasis) * 100 : null;

  return { value, costBasis, returnAbs, returnPct };
}

// ---------------------------------------------------------------------------
// Household aggregation
// ---------------------------------------------------------------------------

/**
 * Aggregate return across all portfolios.
 * @param {Map<string, { price: number }>} quoteMap  ticker → { price (USD) }
 * @param {{ rate: number }|null} fxObj
 * @param {'GBP'|'USD'} displayCurrency
 */
export function getHouseholdSummary(quoteMap, fxObj, displayCurrency = 'GBP') {
  const portfolios = getPortfolios();
  let totalValue   = 0;
  let totalCost    = 0;
  let holdingCount = 0;
  let pricedCount  = 0;

  for (const p of portfolios) {
    for (const h of (p.holdings || [])) {
      holdingCount++;
      const entry = quoteMap?.get(h.ticker);
      const price = entry?.price ?? null;
      if (price == null) continue;
      const ret = holdingReturn(h, price, fxObj, displayCurrency);
      if (!ret) continue;
      totalValue += ret.value;
      totalCost  += ret.costBasis;
      pricedCount++;
    }
  }

  const returnAbs = totalValue - totalCost;
  const returnPct = totalCost > 0 ? (returnAbs / totalCost) * 100 : null;

  return {
    totalValue, totalCost, returnAbs, returnPct,
    holdingCount, pricedCount,
    portfolioCount: portfolios.length,
  };
}
