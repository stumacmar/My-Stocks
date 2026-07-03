/**
 * Five-pillar percentile scoring engine.
 *
 * Each stock is ranked against the S&P 500 universe on individual metrics,
 * yielding a 0–100 percentile for each metric. Metrics are aggregated within
 * pillars (equally weighted unless overridden). Pillars combine into a
 * composite 0–100 score using pillar weights from the active preset.
 *
 * Missing data: excluded from percentile distribution; reported as coverage.
 * Sector-relative mode: percentiles computed within the same GICS sector.
 *
 * Returns:
 *   {
 *     composite:   0–100,
 *     pillars:     { quality, value, growth, safety, momentum },  // 0–100 each
 *     percentiles: Map<metricId, 0–100>,
 *     rawValues:   Map<metricId, number|null>,
 *     flags:       { id, label, fired }[],
 *     coverage:    Map<pillarId, '3 of 4 inputs'>,
 *     scoredAt:    ISO string,
 *   }
 */

import { evaluateFlags } from './flags.js';

// ---------------------------------------------------------------------------
// Metric definitions
// ---------------------------------------------------------------------------

export const METRICS = {
  // Quality
  roic:                { pillar: 'quality',   lowerIsBetter: false },
  grossMarginStability:{ pillar: 'quality',   lowerIsBetter: false },
  fcfConversion:       { pillar: 'quality',   lowerIsBetter: false },
  assetTurnover:       { pillar: 'quality',   lowerIsBetter: false },

  // Value
  fcfYield:            { pillar: 'value',     lowerIsBetter: false },
  evToEbit:            { pillar: 'value',     lowerIsBetter: true  },
  peVs5yAvg:           { pillar: 'value',     lowerIsBetter: true  },
  shareholderYield:    { pillar: 'value',     lowerIsBetter: false },

  // Growth
  revenueCagr5y:       { pillar: 'growth',    lowerIsBetter: false },
  fcfPerShareCagr:     { pillar: 'growth',    lowerIsBetter: false },
  marginTrajectory:    { pillar: 'growth',    lowerIsBetter: false },

  // Safety
  netDebtToEbitda:     { pillar: 'safety',    lowerIsBetter: true  },
  interestCover:       { pillar: 'safety',    lowerIsBetter: false },
  epsVariability:      { pillar: 'safety',    lowerIsBetter: true  },
  downsideBeta:        { pillar: 'safety',    lowerIsBetter: true  },

  // Momentum
  rs6m:                { pillar: 'momentum',  lowerIsBetter: false },
  rs12m:               { pillar: 'momentum',  lowerIsBetter: false },
  distFrom52wHigh:     { pillar: 'momentum',  lowerIsBetter: true  },
};

const PILLAR_IDS = ['quality', 'value', 'growth', 'safety', 'momentum'];

// ---------------------------------------------------------------------------
// Percentile computation
// ---------------------------------------------------------------------------

/**
 * Given a Map<ticker, number|null> of metric values across the universe,
 * return a Map<ticker, 0–100> percentile for each stock.
 * Null values are excluded from the distribution.
 */
export function computePercentiles(metricValues) {
  const entries    = [...metricValues.entries()];
  const validPairs = entries.filter(([, v]) => v != null && isFinite(v));

  if (validPairs.length === 0) {
    return new Map(entries.map(([t]) => [t, null]));
  }

  // Sort ascending by value
  const sorted  = [...validPairs].sort((a, b) => a[1] - b[1]);
  const n       = sorted.length;

  // Build percentile lookup by ticker
  const pctMap  = new Map();
  sorted.forEach(([ticker], i) => {
    // Percentile rank: proportion of stocks with lower value
    pctMap.set(ticker, n > 1 ? Math.round((i / (n - 1)) * 100) : 50);
  });

  // Nulls get null percentile
  return new Map(entries.map(([ticker]) => [ticker, pctMap.get(ticker) ?? null]));
}

// ---------------------------------------------------------------------------
// Raw metric extraction from FMP data
// ---------------------------------------------------------------------------

function _safeDiv(a, b) {
  if (b == null || b === 0) return null;
  const v = (a ?? null) / b;
  return isFinite(v) ? v : null;
}

function _cagr(newest, oldest, years) {
  if (!newest || !oldest || oldest <= 0 || years <= 0) return null;
  const v = Math.pow(newest / oldest, 1 / years) - 1;
  return isFinite(v) ? v : null;
}

function _stdDev(values) {
  const n = values.length;
  if (n < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  return Math.sqrt(variance);
}

/**
 * Extract all scoring metrics from raw FMP data for a single stock.
 * Returns Map<metricId, number|null>.
 */
export function extractMetrics(fundamentals, priceHistory, spyHistory) {
  const { income = [], cashFlow = [], balance = [], keyMetrics = {}, profile = {} } = fundamentals;

  const raw = new Map();

  // --- QUALITY ---

  // ROIC = NOPAT / Invested Capital
  const latestIncome  = income[0] || {};
  const latestBalance = balance[0] || {};
  const nopat         = (latestIncome.operatingIncome || null) !== null
    ? latestIncome.operatingIncome * (1 - 0.21) : null;
  const investedCap   = latestBalance.totalEquity != null
    ? latestBalance.totalEquity + (latestBalance.totalDebt || 0) - (latestBalance.cashAndShortTermInvestments || 0)
    : null;
  raw.set('roic', _safeDiv(nopat, investedCap));

  // Gross margin stability = 1 - StdDev(gross margins over 3 years)
  const grossMargins = income.slice(0, 4).map(i =>
    i.revenue ? _safeDiv(i.grossProfit, i.revenue) : null
  ).filter(v => v !== null);
  const gmStd = _stdDev(grossMargins);
  raw.set('grossMarginStability', gmStd !== null ? Math.max(0, 1 - gmStd * 10) : null);

  // FCF conversion = FCF / Net income
  const latestCF = cashFlow[0] || {};
  const fcf      = latestCF.operatingCashFlow != null
    ? latestCF.operatingCashFlow - Math.abs(latestCF.capitalExpenditure || 0) : null;
  const netInc   = latestIncome.netIncome || null;
  raw.set('fcfConversion', _safeDiv(fcf, netInc));

  // Asset turnover
  raw.set('assetTurnover', _safeDiv(latestIncome.revenue, latestBalance.totalAssets));

  // --- VALUE ---

  // FCF yield = FCF per share / price
  const shares = latestIncome.weightedAverageShsOut || null;
  const price  = profile.price || null;
  const fcfPs  = _safeDiv(fcf, shares);
  raw.set('fcfYield', _safeDiv(fcfPs, price));

  // EV/EBIT
  const mktCap = profile.mktCap || null;
  const ev     = mktCap != null
    ? mktCap + (latestBalance.totalDebt || 0) - (latestBalance.cashAndShortTermInvestments || 0)
    : null;
  raw.set('evToEbit', _safeDiv(ev, latestIncome.operatingIncome));

  // P/E vs 5y avg P/E (ratio: current / 5y avg — lower is better, so "cheap vs history")
  const currentPE = keyMetrics.peRatioTTM || null;
  const eps5y     = income.slice(0, 5).map(i => i.eps).filter(e => e != null);
  const avgEps5y  = eps5y.length ? eps5y.reduce((a, b) => a + b, 0) / eps5y.length : null;
  const pe5yAvg   = _safeDiv(price, avgEps5y);
  raw.set('peVs5yAvg', (currentPE != null && pe5yAvg != null) ? currentPE / pe5yAvg : null);

  // Shareholder yield = FCF yield + buyback yield
  const buybackYield = keyMetrics.buybackYieldTTM || 0;
  const fcfYieldVal  = raw.get('fcfYield');
  raw.set('shareholderYield', fcfYieldVal != null ? fcfYieldVal + buybackYield : null);

  // --- GROWTH ---

  // Revenue CAGR 5y
  const rev5  = income[4]?.revenue;
  const rev0  = income[0]?.revenue;
  raw.set('revenueCagr5y', _cagr(rev0, rev5, 5));

  // FCF/share CAGR 3y
  const fcf0ps = _safeDiv(fcf, shares);
  const fcf3   = cashFlow[3];
  const inc3   = income[3];
  const fcf3ps = fcf3 && inc3
    ? _safeDiv(
        (fcf3.operatingCashFlow || 0) - Math.abs(fcf3.capitalExpenditure || 0),
        inc3.weightedAverageShsOut
      )
    : null;
  raw.set('fcfPerShareCagr', _cagr(fcf0ps, fcf3ps, 3));

  // Margin trajectory = change in operating margin over 3 years
  const om0 = _safeDiv(latestIncome.operatingIncome, latestIncome.revenue);
  const inc3op = income[3];
  const om3 = inc3op ? _safeDiv(inc3op.operatingIncome, inc3op.revenue) : null;
  raw.set('marginTrajectory', om0 != null && om3 != null ? om0 - om3 : null);

  // --- SAFETY ---

  // Net Debt / EBITDA
  const ebitda   = latestIncome.ebitda || null;
  const netDebt  = latestBalance.totalDebt != null
    ? latestBalance.totalDebt - (latestBalance.cashAndShortTermInvestments || 0) : null;
  raw.set('netDebtToEbitda', _safeDiv(netDebt, ebitda));

  // Interest cover = EBIT / Interest expense
  const intExp = Math.abs(latestIncome.interestExpense || 0);
  raw.set('interestCover', _safeDiv(latestIncome.operatingIncome, intExp || null));

  // EPS variability = coefficient of variation of EPS
  const epsVals = income.slice(0, 5).map(i => i.eps).filter(e => e != null);
  if (epsVals.length >= 3) {
    const mean   = epsVals.reduce((a, b) => a + b, 0) / epsVals.length;
    const stddev = _stdDev(epsVals);
    raw.set('epsVariability', mean !== 0 && stddev !== null ? Math.abs(stddev / mean) : null);
  } else {
    raw.set('epsVariability', null);
  }

  // Downside beta — uses price history vs SPY
  if (priceHistory?.length && spyHistory?.length) {
    raw.set('downsideBeta', _computeDownsideBeta(priceHistory, spyHistory));
  } else {
    raw.set('downsideBeta', null);
  }

  // --- MOMENTUM ---

  if (priceHistory?.length) {
    const spyMap  = spyHistory ? _buildPriceMap(spyHistory) : null;
    const stockMap = _buildPriceMap(priceHistory);
    const latest   = priceHistory[0]?.date;

    raw.set('rs6m',  latest ? _relativeStrength(stockMap, spyMap, latest, 126) : null);
    raw.set('rs12m', latest ? _relativeStrength(stockMap, spyMap, latest, 252) : null);
    raw.set('distFrom52wHigh', _distFrom52wHigh(priceHistory));
  } else {
    raw.set('rs6m',  null);
    raw.set('rs12m', null);
    raw.set('distFrom52wHigh', null);
  }

  return raw;
}

// ---------------------------------------------------------------------------
// Price history helpers
// ---------------------------------------------------------------------------

function _buildPriceMap(history) {
  const m = new Map();
  for (const { date, adjClose, close } of history) {
    m.set(date, adjClose ?? close);
  }
  return m;
}

function _approxDateBefore(priceMap, refDate, daysBack) {
  const target = new Date(refDate);
  target.setDate(target.getDate() - daysBack);
  // Walk forward from target until we find a date in the map
  for (let d = 0; d < 10; d++) {
    const key = new Date(target.getTime() + d * 86400_000).toISOString().slice(0, 10);
    if (priceMap.has(key)) return priceMap.get(key);
  }
  return null;
}

function _relativeStrength(stockMap, spyMap, refDate, daysBack) {
  const stockNow  = stockMap.get(refDate);
  const stockPast = _approxDateBefore(stockMap, refDate, daysBack);
  if (!stockNow || !stockPast || stockPast <= 0) return null;
  const stockRet = (stockNow - stockPast) / stockPast;

  if (!spyMap) return stockRet;

  const spyNow  = spyMap.get(refDate);
  const spyPast = _approxDateBefore(spyMap, refDate, daysBack);
  if (!spyNow || !spyPast || spyPast <= 0) return stockRet;
  const spyRet  = (spyNow - spyPast) / spyPast;

  return stockRet - spyRet;
}

function _distFrom52wHigh(history) {
  const recent = history.slice(0, 252);
  const high   = Math.max(...recent.map(h => h.adjClose ?? h.close ?? 0));
  const curr   = recent[0]?.adjClose ?? recent[0]?.close;
  if (!curr || high <= 0) return null;
  return (high - curr) / high;  // positive = distance below high (lower is better)
}

function _computeDownsideBeta(stockHistory, spyHistory) {
  const stockMap = _buildPriceMap(stockHistory);
  const spyMap   = _buildPriceMap(spyHistory);
  const dates    = [...stockMap.keys()].sort().slice(-252);

  const pairs = [];
  for (let i = 1; i < dates.length; i++) {
    const sRet = _safeDiv(stockMap.get(dates[i]) - stockMap.get(dates[i-1]), stockMap.get(dates[i-1]));
    const bRet = _safeDiv(spyMap.get(dates[i]) - spyMap.get(dates[i-1]), spyMap.get(dates[i-1]));
    if (sRet !== null && bRet !== null && bRet < 0) {
      pairs.push([sRet, bRet]);
    }
  }
  if (pairs.length < 20) return null;

  const cov  = pairs.reduce((a, [s, b]) => a + s * b, 0) / pairs.length;
  const varB = pairs.reduce((a, [, b]) => a + b * b, 0) / pairs.length;
  return varB > 0 ? cov / varB : null;
}

// ---------------------------------------------------------------------------
// Main scoring function
// ---------------------------------------------------------------------------

/**
 * Score a single stock against a universe of pre-computed percentiles.
 *
 * @param {object} fundamentals - { income, cashFlow, balance, keyMetrics, profile }
 * @param {object[]} priceHistory - FMP daily price history array
 * @param {object[]} spyHistory   - SPY daily price history (for RS and beta)
 * @param {Map<metricId, Map<ticker, number>>} universeMetrics - pre-computed universe raw values per metric
 * @param {string} ticker - symbol being scored
 * @param {object} options - { pillarWeights, sectorRelative, sector }
 * @returns {ScoringResult}
 */
export function scoreSingleStock(fundamentals, priceHistory, spyHistory, universeMetrics, ticker, options = {}) {
  const {
    pillarWeights = DEFAULT_PILLAR_WEIGHTS,
    sectorRelative = false,
    sector = null,
  } = options;

  const rawValues = extractMetrics(fundamentals, priceHistory, spyHistory);

  // For each metric, compute this stock's percentile against the universe
  const percentiles = new Map();

  for (const [metricId, metaDef] of Object.entries(METRICS)) {
    const stockVal = rawValues.get(metricId);
    if (stockVal == null) {
      percentiles.set(metricId, null);
      continue;
    }

    // Universe distribution for this metric
    const univMetricMap = universeMetrics?.get(metricId);
    if (!univMetricMap || univMetricMap.size === 0) {
      percentiles.set(metricId, null);
      continue;
    }

    // Use only same-sector peers if sectorRelative
    let peerMap = univMetricMap;
    if (sectorRelative && sector) {
      peerMap = new Map([...univMetricMap].filter(([t]) => {
        const peerSector = options.sectorMap?.get(t);
        return !peerSector || peerSector === sector;
      }));
    }

    const pctMap    = computePercentiles(peerMap);
    let   pct       = pctMap.get(ticker);

    if (pct == null) {
      // Ticker not in universe map — interpolate
      const values  = [...peerMap.values()].filter(v => v != null && isFinite(v)).sort((a, b) => a - b);
      const rank    = values.filter(v => v < stockVal).length;
      pct           = values.length > 1 ? Math.round((rank / (values.length - 1)) * 100) : 50;
    }

    // Invert for "lower is better" metrics
    if (metaDef.lowerIsBetter) pct = 100 - pct;

    percentiles.set(metricId, pct);
  }

  // Aggregate percentiles into pillars
  const pillars  = {};
  const coverage = new Map();

  for (const pillarId of PILLAR_IDS) {
    const pillarMetrics = Object.entries(METRICS)
      .filter(([, def]) => def.pillar === pillarId)
      .map(([id]) => id);

    const validPcts = pillarMetrics
      .map(id => percentiles.get(id))
      .filter(v => v != null);

    coverage.set(pillarId, `${validPcts.length} of ${pillarMetrics.length} inputs`);

    pillars[pillarId] = validPcts.length > 0
      ? Math.round(validPcts.reduce((a, b) => a + b, 0) / validPcts.length)
      : null;
  }

  // Weighted composite
  const totalWeight = PILLAR_IDS.reduce((sum, id) => {
    if (pillars[id] != null) sum += (pillarWeights[id] || 0);
    return sum;
  }, 0);

  const composite = totalWeight > 0
    ? Math.round(
        PILLAR_IDS.reduce((sum, id) => {
          if (pillars[id] != null) sum += pillars[id] * (pillarWeights[id] || 0);
          return sum;
        }, 0) / totalWeight
      )
    : null;

  const flags = evaluateFlags(fundamentals);

  return {
    composite,
    pillars,
    percentiles,
    rawValues,
    flags,
    coverage,
    scoredAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Default pillar weights (BALANCED preset values)
// ---------------------------------------------------------------------------

export const DEFAULT_PILLAR_WEIGHTS = {
  quality:  0.25,
  value:    0.25,
  growth:   0.20,
  safety:   0.15,
  momentum: 0.15,
};
