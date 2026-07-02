import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeUniversePillars, fundMapFromCache, PILLAR_IDS } from './universe.js';

// ---------------------------------------------------------------------------
// Synthetic fundamentals
// ---------------------------------------------------------------------------

function makeFund({ operatingIncome, revenue, grossProfit, netIncome, totalEquity, totalDebt, cash, totalAssets, ocf, capex, shares, price, mktCap, ebitda, interestExpense }) {
  return {
    fundamentals: {
      income: [{
        operatingIncome, revenue, grossProfit, netIncome,
        eps: netIncome / shares, weightedAverageShsOut: shares,
        ebitda, interestExpense,
      }],
      balance: [{
        totalEquity, totalDebt, cashAndShortTermInvestments: cash, totalAssets,
      }],
      cashFlow: [{ operatingCashFlow: ocf, capitalExpenditure: capex }],
      keyMetrics: { peRatioTTM: price / (netIncome / shares) },
      profile: { price, mktCap },
    },
    priceHistory: null,
  };
}

const STRONG = makeFund({
  operatingIncome: 500, revenue: 1000, grossProfit: 600, netIncome: 400,
  totalEquity: 1000, totalDebt: 100, cash: 300, totalAssets: 1500,
  ocf: 450, capex: 50, shares: 100, price: 40, mktCap: 4000,
  ebitda: 550, interestExpense: 5,
});

const WEAK = makeFund({
  operatingIncome: 50, revenue: 1000, grossProfit: 200, netIncome: 20,
  totalEquity: 500, totalDebt: 2000, cash: 50, totalAssets: 3000,
  ocf: 60, capex: 55, shares: 100, price: 40, mktCap: 4000,
  ebitda: 80, interestExpense: 100,
});

const MID = makeFund({
  operatingIncome: 200, revenue: 1000, grossProfit: 400, netIncome: 150,
  totalEquity: 800, totalDebt: 600, cash: 100, totalAssets: 2000,
  ocf: 200, capex: 60, shares: 100, price: 40, mktCap: 4000,
  ebitda: 250, interestExpense: 30,
});

test('computeUniversePillars', async (t) => {
  await t.test('returns a pillar object per ticker with all five pillars', () => {
    const out = computeUniversePillars(new Map([
      ['AAA', STRONG], ['BBB', WEAK], ['CCC', MID],
    ]));
    assert.equal(out.size, 3);
    for (const pid of PILLAR_IDS) {
      assert.ok(pid in out.get('AAA'));
    }
  });

  await t.test('better fundamentals score higher on quality', () => {
    const out = computeUniversePillars(new Map([
      ['AAA', STRONG], ['BBB', WEAK], ['CCC', MID],
    ]));
    assert.ok(out.get('AAA').quality > out.get('BBB').quality,
      `expected AAA quality (${out.get('AAA').quality}) > BBB (${out.get('BBB').quality})`);
  });

  await t.test('lowerIsBetter inversion: heavy debt scores LOW on safety', () => {
    const out = computeUniversePillars(new Map([
      ['AAA', STRONG], ['BBB', WEAK], ['CCC', MID],
    ]));
    // WEAK has net debt 1950 vs EBITDA 80 → terrible; STRONG has net cash
    assert.ok(out.get('AAA').safety > out.get('BBB').safety,
      `expected AAA safety (${out.get('AAA').safety}) > BBB (${out.get('BBB').safety})`);
  });

  await t.test('momentum is null without price history', () => {
    const out = computeUniversePillars(new Map([['AAA', STRONG], ['BBB', WEAK]]));
    assert.equal(out.get('AAA').momentum, null);
  });

  await t.test('empty universe returns empty map', () => {
    assert.equal(computeUniversePillars(new Map()).size, 0);
    assert.equal(computeUniversePillars(null).size, 0);
  });

  await t.test('broken fundamentals do not crash the pass', () => {
    const out = computeUniversePillars(new Map([
      ['AAA', STRONG],
      ['BAD', { fundamentals: null, priceHistory: null }],
    ]));
    assert.equal(out.size, 2);
  });
});

test('fundMapFromCache', async (t) => {
  const cacheEntry = (v) => ({ v, fetchedAt: '2026-01-01T00:00:00Z', ttl: 1, accessedAt: 0 });

  await t.test('reconstructs fundamentals from sanitised cache keys', () => {
    const cache = {
      'fmp_income_AAPL':  cacheEntry([{ revenue: 100 }]),
      'fmp_balance_AAPL': cacheEntry([{ totalAssets: 500 }]),
      'fmp_profile_AAPL': cacheEntry({ mktCap: 999 }),
      'fmp_price_AAPL':   cacheEntry([{ date: '2026-01-01', close: 10 }]),
    };
    const out = fundMapFromCache(cache, ['AAPL']);
    assert.equal(out.size, 1);
    const e = out.get('AAPL');
    assert.equal(e.fundamentals.income[0].revenue, 100);
    assert.equal(e.fundamentals.profile.mktCap, 999);
    assert.equal(e.priceHistory[0].close, 10);
  });

  await t.test('maps sanitised dotted tickers back to real symbols', () => {
    const cache = {
      'fmp_income_BRK_B':  cacheEntry([{ revenue: 42 }]),
      'fmp_balance_BRK_B': cacheEntry([{ totalAssets: 1 }]),
    };
    const out = fundMapFromCache(cache, ['BRK.B']);
    assert.ok(out.has('BRK.B'));
    assert.equal(out.get('BRK.B').fundamentals.income[0].revenue, 42);
  });

  await t.test('ignores tickers outside the universe and unknown endpoints', () => {
    const cache = {
      'fmp_income_MSFT':   cacheEntry([{ revenue: 1 }]),
      'fmp_quote_AAPL':    cacheEntry({ price: 1 }),   // quote is not a fundamentals endpoint
      'someOtherKey':      cacheEntry({ x: 1 }),
    };
    const out = fundMapFromCache(cache, ['AAPL']);
    assert.equal(out.size, 0);
  });

  await t.test('skips tickers with no statement data at all', () => {
    const cache = { 'fmp_profile_AAPL': cacheEntry({ mktCap: 1 }) };
    assert.equal(fundMapFromCache(cache, ['AAPL']).size, 0);
  });
});
