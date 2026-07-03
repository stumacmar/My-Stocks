import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeSnapshot, appendSnapshot, diffSnapshots, snapshotPillars, MAX_SNAPSHOTS,
} from './history.js';

const AT = '2026-07-01T10:00:00Z';

test('makeSnapshot', async (t) => {
  await t.test('packs score7, composite and pillars into compact arrays', () => {
    const snap = makeSnapshot([
      { ticker: 'AAPL', score7: 7, composite: 100,
        pillars: { quality: 90, value: 40, growth: 70, safety: 80, momentum: 60 } },
    ], AT);
    assert.equal(snap.at, AT);
    assert.deepEqual(snap.stocks.AAPL, [7, 100, 90, 40, 70, 80, 60]);
  });

  await t.test('missing values become nulls', () => {
    const snap = makeSnapshot([{ ticker: 'X' }], AT);
    assert.deepEqual(snap.stocks.X, [null, null, null, null, null, null, null]);
  });

  await t.test('rows without a ticker are skipped', () => {
    const snap = makeSnapshot([{ score7: 5 }, null], AT);
    assert.deepEqual(Object.keys(snap.stocks), []);
  });
});

test('snapshotPillars round-trips makeSnapshot', () => {
  const pillars = { quality: 90, value: 40, growth: 70, safety: 80, momentum: 60 };
  const snap = makeSnapshot([{ ticker: 'A', score7: 6, composite: 86, pillars }], AT);
  assert.deepEqual(snapshotPillars(snap.stocks.A), pillars);
  assert.equal(snapshotPillars(null), null);
});

test('appendSnapshot caps history at MAX_SNAPSHOTS, dropping oldest', () => {
  let h = [];
  for (let i = 0; i < MAX_SNAPSHOTS + 3; i++) {
    h = appendSnapshot(h, { id: `snap-${i}`, at: AT, stocks: {} });
  }
  assert.equal(h.length, MAX_SNAPSHOTS);
  assert.equal(h[0].id, 'snap-3');
  assert.equal(h[h.length - 1].id, `snap-${MAX_SNAPSHOTS + 2}`);
});

test('diffSnapshots', async (t) => {
  const snap = (stocks) => ({ id: 'x', at: AT, stocks });

  await t.test('detects band crossings, not intra-band wobble', () => {
    const prev = snap({
      RISER:  [6, 86, null, null, null, null, null],   // strong
      FALLER: [7, 100, null, null, null, null, null],  // hot
      WOBBLE: [5, 71, null, null, null, null, null],   // watch
      SAME:   [4, 57, null, null, null, null, null],   // watch
    });
    const curr = snap({
      RISER:  [7, 100, null, null, null, null, null],  // → hot
      FALLER: [6, 86, null, null, null, null, null],   // → strong
      WOBBLE: [4, 57, null, null, null, null, null],   // watch → watch (5→4 is noise)
      SAME:   [4, 57, null, null, null, null, null],
    });
    const d = diffSnapshots(prev, curr);
    assert.deepEqual(d.risers.map(m => m.ticker), ['RISER']);
    assert.deepEqual(d.fallers.map(m => m.ticker), ['FALLER']);
  });

  await t.test('biggest falls sort first', () => {
    const prev = snap({
      SMALL: [7, 100, null, null, null, null, null],  // hot → strong (1 band)
      BIG:   [7, 100, null, null, null, null, null],  // hot → avoid (3 bands)
    });
    const curr = snap({
      SMALL: [6, 86, null, null, null, null, null],
      BIG:   [1, 14, null, null, null, null, null],
    });
    const d = diffSnapshots(prev, curr);
    assert.deepEqual(d.fallers.map(m => m.ticker), ['BIG', 'SMALL']);
  });

  await t.test('null scores and new tickers are excluded', () => {
    const prev = snap({ A: [null, null, null, null, null, null, null] });
    const curr = snap({
      A: [7, 100, null, null, null, null, null],
      NEW: [7, 100, null, null, null, null, null],
    });
    const d = diffSnapshots(prev, curr);
    assert.equal(d.risers.length, 0);
    assert.equal(d.fallers.length, 0);
  });

  await t.test('returns null for missing snapshots', () => {
    assert.equal(diffSnapshots(null, snap({})), null);
  });
});
