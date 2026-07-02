import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roseAngle, rosePoints, lerpPillars, ROSE_AXES } from './rose.js';

const FULL = { quality: 100, value: 100, growth: 100, safety: 100, momentum: 100 };

test('roseAngle puts quality at north and spaces axes evenly', () => {
  assert.equal(roseAngle(0), -Math.PI / 2);
  const step = (2 * Math.PI) / ROSE_AXES.length;
  for (let i = 1; i < ROSE_AXES.length; i++) {
    assert.ok(Math.abs(roseAngle(i) - roseAngle(i - 1) - step) < 1e-12);
  }
});

test('rosePoints', async (t) => {
  await t.test('quality=100 reaches the top of the circle', () => {
    const pts = rosePoints(FULL, 100, 100, 80);
    assert.equal(pts.length, 5);
    assert.ok(Math.abs(pts[0].x - 100) < 1e-9);
    assert.ok(Math.abs(pts[0].y - 20) < 1e-9);  // cy - r
  });

  await t.test('null pillars collapse to a visible nub, not zero', () => {
    const pts = rosePoints(null, 100, 100, 80);
    for (const p of pts) {
      const d = Math.hypot(p.x - 100, p.y - 100);
      assert.ok(d > 0 && d < 10, `nub radius ${d} should be small but nonzero`);
      assert.equal(p.pct, null);
    }
  });

  await t.test('score 50 lands at half radius', () => {
    const pts = rosePoints({ ...FULL, quality: 50 }, 0, 0, 80);
    assert.ok(Math.abs(pts[0].y + 40) < 1e-9);  // −r/2 (north)
  });
});

test('lerpPillars interpolates and treats null as 0', () => {
  const mid = lerpPillars({ quality: 0 }, { quality: 100 }, 0.5);
  assert.equal(mid.quality, 50);
  assert.equal(mid.value, 0);       // null → 0 on both sides
  const done = lerpPillars(null, FULL, 1);
  assert.equal(done.momentum, 100);
});
