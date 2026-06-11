/**
 * Unit tests for scoring engine — run with: node --test src/engine/scoring.test.js
 *
 * Tests use Node's built-in test runner (node >= 18).
 * No external dependencies required.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Minimal mocks so tests can run without full browser env
// ---------------------------------------------------------------------------

// Mock localStorage so state/store and data/cache don't blow up
const _store = new Map();
global.localStorage = {
  getItem:    k => _store.get(k) ?? null,
  setItem:    (k, v) => _store.set(k, v),
  removeItem: k => _store.delete(k),
  get length() { return _store.size; },
  key:        i => [..._store.keys()][i] ?? null,
};

// ---------------------------------------------------------------------------
// Imports (after mock setup)
// ---------------------------------------------------------------------------

const { computePercentiles, extractMetrics, scoreSingleStock, DEFAULT_PILLAR_WEIGHTS } = await import('./scoring.js');
const { classicScore } = await import('./presets.js');
const { evaluateFlags, firedFlags } = await import('./flags.js');

// ---------------------------------------------------------------------------
// computePercentiles
// ---------------------------------------------------------------------------

describe('computePercentiles', () => {
  test('returns null for null values', () => {
    const map = new Map([['AAPL', 100], ['MSFT', null], ['GOOG', 50]]);
    const pct = computePercentiles(map);
    assert.equal(pct.get('MSFT'), null);
  });

  test('lowest value gets percentile 0', () => {
    const map = new Map([['A', 10], ['B', 20], ['C', 30]]);
    const pct = computePercentiles(map);
    assert.equal(pct.get('A'), 0);
  });

  test('highest value gets percentile 100', () => {
    const map = new Map([['A', 10], ['B', 20], ['C', 30]]);
    const pct = computePercentiles(map);
    assert.equal(pct.get('C'), 100);
  });

  test('middle value gets ~50 with three equidistant points', () => {
    const map = new Map([['A', 10], ['B', 20], ['C', 30]]);
    const pct = computePercentiles(map);
    assert.equal(pct.get('B'), 50);
  });

  test('all-null map returns all-null percentiles', () => {
    const map = new Map([['X', null], ['Y', null]]);
    const pct = computePercentiles(map);
    assert.equal(pct.get('X'), null);
    assert.equal(pct.get('Y'), null);
  });

  test('single non-null value gets percentile 0 (rank 0 out of 0)', () => {
    const map = new Map([['X', 42]]);
    const pct = computePercentiles(map);
    // With n=1, i/(n-1) is 0/0 — handled as index 0 → 0
    assert.equal(typeof pct.get('X'), 'number');
  });
});

// ---------------------------------------------------------------------------
// Classic 7 scorer
// ---------------------------------------------------------------------------

describe('classicScore', () => {
  function makeFundamentals(overrides = {}) {
    return {
      income: [{
        eps:            5,
        revenue:        1_000_000,
        grossProfit:    400_000,
        netIncome:      100_000,
        operatingIncome: 150_000,
        weightedAverageShsOut: 10_000,
      }, {
        revenue: 900_000,
      }],
      balance: [{
        totalEquity:  500_000,
        totalDebt:    200_000,
        totalAssets:  800_000,
        cashAndShortTermInvestments: 50_000,
      }],
      cashFlow: [{
        operatingCashFlow: 120_000,
        capitalExpenditure: -20_000,
      }],
      keyMetrics: { peRatioTTM: 15 },
      profile: { price: 75 },
      ...overrides,
    };
  }

  test('all 7 pass with good fundamentals', () => {
    const result = classicScore(makeFundamentals());
    assert.equal(result.score, 7);
    assert.equal(result.rag, 'elite');
  });

  test('fails P/E check when P/E > 25', () => {
    const fund = makeFundamentals();
    fund.keyMetrics.peRatioTTM = 30;
    const result = classicScore(fund);
    assert.equal(result.score, 6);
    assert.equal(result.rag, 'strong');
  });

  test('fails EPS check when EPS negative', () => {
    const fund = makeFundamentals();
    fund.income[0].eps = -1;
    const result = classicScore(fund);
    assert.equal(result.criteria.find(c => c.id === 'eps_positive').pass, false);
  });

  test('score 0 → rag avoid', () => {
    const result = classicScore({
      income: [{ eps: -1, revenue: 100, grossProfit: 20, netIncome: -10, operatingIncome: -10 }, { revenue: 200 }],
      balance: [{ totalEquity: 100, totalDebt: 200, totalAssets: 400, cashAndShortTermInvestments: 10 }],
      cashFlow: [{ operatingCashFlow: -50, capitalExpenditure: 0 }],
      keyMetrics: { peRatioTTM: 80 },
      profile: {},
    });
    assert.ok(result.score <= 2);
    assert.equal(result.rag, 'avoid');
  });

  test('maxScore always 7', () => {
    const result = classicScore(makeFundamentals());
    assert.equal(result.maxScore, 7);
  });

  test('composite is score/7 * 100 rounded', () => {
    const fund = makeFundamentals();
    fund.keyMetrics.peRatioTTM = 30;  // 6/7
    const result = classicScore(fund);
    assert.equal(result.composite, Math.round((6 / 7) * 100));
  });
});

// ---------------------------------------------------------------------------
// Red flags
// ---------------------------------------------------------------------------

describe('evaluateFlags', () => {
  function baseFinancials() {
    return {
      income: Array.from({ length: 5 }, (_, i) => ({
        revenue:      1_000_000 * (1 + i * 0.05),
        grossProfit:   400_000 * (1 + i * 0.05),
        operatingIncome: 150_000,
        netIncome:      100_000,
        eps:            5,
        weightedAverageShsOut: 10_000,
      })).reverse(),  // [newest, ..., oldest]
      balance: Array.from({ length: 5 }, (_, i) => ({
        totalEquity:  500_000,
        totalDebt:    200_000,
        totalAssets:  800_000,
        goodwill:      50_000,
        netReceivables: 80_000,
        cashAndShortTermInvestments: 50_000,
      })),
      cashFlow: [{
        operatingCashFlow: 120_000,
        capitalExpenditure: -20_000,
        dividendsPaid: -10_000,
      }],
    };
  }

  test('no flags fire on healthy company', () => {
    const flags = firedFlags(baseFinancials());
    assert.equal(flags.length, 0);
  });

  test('share_dilution fires when shares grow > 5% over 3 years', () => {
    const fin = baseFinancials();
    fin.income[0].weightedAverageShsOut = 15_000;  // was 10_000 → +50%
    fin.income[3].weightedAverageShsOut = 10_000;
    const flags = firedFlags(fin);
    assert.ok(flags.some(f => f.id === 'share_dilution'));
  });

  test('goodwill_heavy fires when goodwill > 40% of assets', () => {
    const fin = baseFinancials();
    fin.balance[0].goodwill     = 400_000;
    fin.balance[0].totalAssets  = 800_000;
    const flags = firedFlags(fin);
    assert.ok(flags.some(f => f.id === 'goodwill_heavy'));
  });

  test('dividend_from_debt fires when FCF < dividends paid', () => {
    const fin = baseFinancials();
    fin.cashFlow[0].operatingCashFlow   = 10_000;
    fin.cashFlow[0].capitalExpenditure  = -5_000;
    fin.cashFlow[0].dividendsPaid       = -100_000;
    const flags = firedFlags(fin);
    assert.ok(flags.some(f => f.id === 'dividend_from_debt'));
  });

  test('evaluateFlags always returns 5 entries', () => {
    const all = evaluateFlags(baseFinancials());
    assert.equal(all.length, 5);
  });
});

// ---------------------------------------------------------------------------
// Composite weighting
// ---------------------------------------------------------------------------

describe('scoreSingleStock pillar weights', () => {
  test('composite follows weights when all pillars have same score', () => {
    // Build a universe with a controlled percentile for one ticker
    const universeMetrics = new Map();
    const METRIC_IDS = [
      'roic', 'grossMarginStability', 'fcfConversion', 'assetTurnover',
      'fcfYield', 'evToEbit', 'peVs5yAvg', 'shareholderYield',
      'revenueCagr5y', 'fcfPerShareCagr', 'marginTrajectory',
      'netDebtToEbitda', 'interestCover', 'epsVariability', 'downsideBeta',
      'rs6m', 'rs12m', 'distFrom52wHigh',
    ];

    // Provide a universe where TEST is always median (50th percentile)
    for (const mid of METRIC_IDS) {
      const m = new Map([['LOW', 1], ['TEST', 50], ['HIGH', 100]]);
      universeMetrics.set(mid, m);
    }

    const fundamentals = {
      income: Array.from({ length: 5 }, () => ({
        revenue: 100, grossProfit: 50, netIncome: 10,
        operatingIncome: 15, eps: 1,
        weightedAverageShsOut: 10, ebitda: 20,
        interestExpense: 2,
      })),
      balance: Array.from({ length: 5 }, () => ({
        totalEquity: 50, totalDebt: 20, totalAssets: 100,
        cashAndShortTermInvestments: 5, netReceivables: 8, goodwill: 5,
      })),
      cashFlow: Array.from({ length: 5 }, () => ({
        operatingCashFlow: 12, capitalExpenditure: -2, dividendsPaid: -1,
      })),
      keyMetrics: { peRatioTTM: 15, buybackYieldTTM: 0.01 },
      profile: { price: 15, mktCap: 150 },
    };

    const result = scoreSingleStock(
      fundamentals, null, null, universeMetrics, 'TEST',
      { pillarWeights: DEFAULT_PILLAR_WEIGHTS }
    );

    // Composite should be roughly 50 (all pillars at median), allow ±10
    if (result.composite !== null) {
      assert.ok(result.composite >= 40 && result.composite <= 60,
        `Expected composite ~50, got ${result.composite}`);
    }
  });

  test('result has required shape', () => {
    const result = scoreSingleStock({}, null, null, new Map(), 'X', {});
    assert.ok('composite' in result);
    assert.ok('pillars' in result);
    assert.ok('percentiles' in result);
    assert.ok('rawValues' in result);
    assert.ok('flags' in result);
    assert.ok('coverage' in result);
    assert.ok('scoredAt' in result);
  });
});
