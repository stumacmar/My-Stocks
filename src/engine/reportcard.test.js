import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gradeSnapshot, buildReportCard, MIN_COVERAGE } from './reportcard.js';

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

test('grades bands with average returns and spread', () => {
  const s = snap('2026-07-01T00:00:00Z', withFiller([
    ['HOT1', 7, 100], ['HOT2', 7, 200],   // +10%, +5% -> avg +7.5
    ['AVD1', 1, 100],                     // -10%
  ]));
  const prices = fillerPrices({ HOT1: 110, HOT2: 210, AVD1: 90 });
  const g = gradeSnapshot(s, prices, NOW);
  assert.ok(g);
  assert.equal(g.days, 31);
  assert.ok(Math.abs(g.bands.hot.avg - 7.5) < 1e-9);
  assert.equal(g.bands.hot.n, 2);
  assert.ok(Math.abs(g.bands.avoid.avg - -10) < 1e-9);
  assert.ok(Math.abs(g.spread - 17.5) < 1e-9);
  assert.equal(g.bands.watch.n, MIN_COVERAGE);
  assert.ok(Math.abs(g.bands.watch.avg - 0) < 1e-9);
});

test('null spread when a band is empty', () => {
  const g = gradeSnapshot(
    snap('2026-07-01T00:00:00Z', withFiller([['HOT1', 7, 100]])),
    fillerPrices({ HOT1: 110 }), NOW);
  assert.equal(g.bands.avoid.n, 0);
  assert.equal(g.bands.avoid.avg, null);
  assert.equal(g.spread, null);
});

test('rejects snapshots below coverage, too young, or without prices', () => {
  // Below coverage
  assert.equal(gradeSnapshot(
    snap('2026-07-01T00:00:00Z', [['A', 7, 100]]),
    fillerPrices({ A: 110 }), NOW), null);

  // Too young (< 1 day)
  assert.equal(gradeSnapshot(
    snap('2026-08-01T00:00:00Z', withFiller([])),
    fillerPrices(), new Date('2026-08-01T06:00:00Z')), null);

  // Old 7-element rows (no price recorded) never grade
  const old = snap('2026-07-01T00:00:00Z', withFiller([]));
  for (const t of Object.keys(old.stocks)) old.stocks[t] = old.stocks[t].slice(0, 7);
  assert.equal(gradeSnapshot(old, fillerPrices(), NOW), null);
});

test('skips tickers missing then/now price without failing the rest', () => {
  const s = snap('2026-07-01T00:00:00Z', withFiller([
    ['GONE', 7, 100],        // no current price (delisted) — skipped
    ['NEW', 7, null],        // no recorded price — skipped
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
