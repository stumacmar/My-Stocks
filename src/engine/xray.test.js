import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeXray, xrayTiltText } from './xray.js';

const P = (q, v, g, s, m) =>
  ({ quality: q, value: v, growth: g, safety: s, momentum: m });

test('value-weights pillar percentiles', () => {
  const x = computeXray([
    { value: 3000, pillars: P(90, 30, 60, 70, 80) },
    { value: 1000, pillars: P(50, 70, 40, 50, 40) },
  ]);
  assert.ok(x);
  // quality: (90*3000 + 50*1000) / 4000 = 80
  assert.ok(Math.abs(x.pillars.quality - 80) < 1e-9);
  assert.ok(Math.abs(x.pillars.value - 40) < 1e-9);
  assert.equal(x.n, 2);
  assert.equal(x.totalN, 2);
  assert.equal(x.topPillar, 'quality');
  assert.equal(x.bottomPillar, 'value');
});

test('excludes holdings without pillars but reports coverage', () => {
  const x = computeXray([
    { value: 5000, pillars: null },                    // a fund
    { value: 1000, pillars: P(60, 60, 60, 60, 60) },
  ]);
  assert.equal(x.n, 1);
  assert.equal(x.totalN, 2);
  assert.ok(Math.abs(x.pillars.quality - 60) < 1e-9);
});

test('per-pillar null gaps use only holdings that have that pillar', () => {
  const x = computeXray([
    { value: 1000, pillars: { ...P(80, 80, 80, 80, 80), momentum: null } },
    { value: 1000, pillars: P(40, 40, 40, 40, 20) },
  ]);
  assert.ok(Math.abs(x.pillars.quality - 60) < 1e-9);
  assert.ok(Math.abs(x.pillars.momentum - 20) < 1e-9); // only the second holding
});

test('null when nothing is scoreable', () => {
  assert.equal(computeXray([]), null);
  assert.equal(computeXray([{ value: 100, pillars: null }]), null);
  assert.equal(computeXray([{ value: 0, pillars: P(50, 50, 50, 50, 50) }]), null);
});

test('tilt text names top and bottom pillars', () => {
  const x = computeXray([{ value: 100, pillars: P(90, 30, 60, 70, 80) }]);
  const t = xrayTiltText(x);
  assert.ok(t.includes('Quality (90th percentile)'));
  assert.ok(t.includes('Value (30th)'));
});

test('ordinals', async () => {
  const { ordinal } = await import('./xray.js');
  assert.equal(ordinal(71), '71st');
  assert.equal(ordinal(42), '42nd');
  assert.equal(ordinal(63), '63rd');
  assert.equal(ordinal(30), '30th');
  assert.equal(ordinal(11), '11th');
  assert.equal(ordinal(12), '12th');
});
