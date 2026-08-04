import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  gradeSnapshot, buildReportCard, reportVerdict, MIN_COVERAGE,
} from './reportcard.js';

// Snapshot rows: [score7, composite, q, v, g, s, m, price]
function snap(at, entries) {
  const stocks = {};
  for (const [ticker, score7, price] of entries) {
    stocks[ticker] = [score7, 50, 50, 50, 50, 50, 50, price];
  }
  return { id: `snap-${at}`, at, stocks };
}

// Enough filler tickers to clear MIN_COVERAGE, all Watch band, flat price.
function withFiller(entries) {
  const filler = [];
  for (let i = 0; i < MIN_COVERAGE; i++) filler.push([`FILL${i}`, 4, 100]);
  return [...entries, ...filler];
}

function fillerPrices(extra = {}) {
  const m = new Map(Object.entries(extra));
  for (let i = 0; i < MIN_COVERAGE; i++) m.set(`FILL${i}`, 100);
  return m;
}

const NOW = new Date('2026-08-01T00:00:00Z');

test('grades bands with averages, spread and universe stats', () => {
  const s = snap('2026-07-01T00:00:00Z', withFiller([
    ['HOT1', 7, 100], ['HOT2', 7, 200],   // +10%, +5% -> avg +7.5
    ['AVD1', 1, 100],                     // -10%
  ]));
  const prices = fillerPrices({ HOT1: 110, HOT2: 210, AVD1: 90 });
  const g = gradeSnapshot(s, prices, NOW);
  assert.ok(g);
  assert.equal(g.days, 31);
  assert.equal(g.n, MIN_COVERAGE + 3);
  assert.ok(Math.abs(g.bands.hot.avg - 7.5) < 1e-9);
  assert.equal(g.bands.hot.n, 2);
  assert.ok(Math.abs(g.bands.avoid.avg - -10) < 1e-9);
  assert.ok(Math.abs(g.spread - 17.5) < 1e-9);
  // Universe: 20 zeros + 10 + 5 - 10 = 5 over 23 stocks
  assert.ok(Math.abs(g.universe.avg - 5 / 23) < 1e-9);
  assert.equal(g.universe.median, 0);
});

test('excess is benchmark-relative, hit rate measures breadth', () => {
  const s = snap('2026-07-01T00:00:00Z', withFiller([
    ['HOT1', 7, 100],   // +20 -> beats median
    ['HOT2', 7, 100],   // -2  -> does not
  ]));
  const g = gradeSnapshot(s, fillerPrices({ HOT1: 120, HOT2: 98 }), NOW);
  const uniAvg = (20 - 2) / (MIN_COVERAGE + 2);
  assert.ok(Math.abs(g.bands.hot.excess - (9 - uniAvg)) < 1e-9);
  assert.ok(Math.abs(g.bands.hot.hitRate - 0.5) < 1e-9);
  // Filler watch band: all exactly at the median (0) -> nothing strictly beats it
  assert.equal(g.bands.watch.hitRate, 0);
  // Dispersion: sample stdev of [20, -2]
  assert.ok(Math.abs(g.bands.hot.stdev - Math.sqrt(242)) < 1e-9);
  // Single-member/empty bands have no stdev
  assert.equal(g.bands.avoid.stdev, null);
});

test('rejects snapshots below coverage, too young, or without prices', () => {
  assert.equal(gradeSnapshot(
    snap('2026-07-01T00:00:00Z', [['A', 7, 100]]),
    fillerPrices({ A: 110 }), NOW), null);

  assert.equal(gradeSnapshot(
    snap('2026-08-01T00:00:00Z', withFiller([])),
    fillerPrices(), new Date('2026-08-01T06:00:00Z')), null);

  const old = snap('2026-07-01T00:00:00Z', withFiller([]));
  for (const t of Object.keys(old.stocks)) old.stocks[t] = old.stocks[t].slice(0, 7);
  assert.equal(gradeSnapshot(old, fillerPrices(), NOW), null);
});

test('skips tickers missing then/now price without failing the rest', () => {
  const s = snap('2026-07-01T00:00:00Z', withFiller([
    ['GONE', 7, 100],
    ['NEW', 7, null],
    ['OK', 7, 100],
  ]));
  const g = gradeSnapshot(s, fillerPrices({ OK: 120 }), NOW);
  assert.equal(g.bands.hot.n, 1);
  assert.ok(Math.abs(g.bands.hot.avg - 20) < 1e-9);
});

test('buildReportCard grades all snapshots oldest first', () => {
  const history = [
    snap('2026-07-15T00:00:00Z', withFiller([])),
    snap('2026-07-01T00:00:00Z', withFiller([])),
    snap('2026-07-31T23:00:00Z', withFiller([])),  // < 1 day old at NOW
  ];
  const card = buildReportCard(history, fillerPrices(), NOW);
  assert.equal(card.length, 2);
  assert.equal(card[0].at, '2026-07-01T00:00:00Z');
  assert.equal(card[1].at, '2026-07-15T00:00:00Z');
});

// ---------------------------------------------------------------------------
// reportVerdict
// ---------------------------------------------------------------------------

function gradedRun(daysAgoISO, days, spread) {
  return { at: daysAgoISO, days, spread, n: 100, universe: { avg: 0, median: 0 }, bands: {} };
}

test('verdict refuses to judge on short horizons or single runs', () => {
  const early = reportVerdict([gradedRun('2026-07-25T00:00:00Z', 7, 5)]);
  assert.equal(early.tone, 'early');
  assert.ok(early.text.includes('Too early'));

  const oneRun = reportVerdict([gradedRun('2026-07-01T00:00:00Z', 31, 5)]);
  assert.equal(oneRun.tone, 'early');
});

test('verdict judges consistency once mature', () => {
  const good = reportVerdict([
    gradedRun('2026-07-01T00:00:00Z', 31, 5),
    gradedRun('2026-07-15T00:00:00Z', 17, 2),
  ]);
  assert.equal(good.tone, 'good');
  assert.ok(good.text.includes('all 2'));

  const bad = reportVerdict([
    gradedRun('2026-07-01T00:00:00Z', 31, -5),
    gradedRun('2026-07-15T00:00:00Z', 17, -1),
  ]);
  assert.equal(bad.tone, 'bad');

  const mixed = reportVerdict([
    gradedRun('2026-07-01T00:00:00Z', 31, 5),
    gradedRun('2026-07-15T00:00:00Z', 17, -1),
  ]);
  assert.equal(mixed.tone, 'mixed');
  assert.ok(mixed.text.includes('1 of 2'));
});

test('verdict handles missing spreads and empty card', () => {
  assert.equal(reportVerdict([]), null);
  const noSpread = reportVerdict([gradedRun('2026-07-01T00:00:00Z', 31, null)]);
  assert.equal(noSpread.tone, 'early');
});
