/**
 * Score Report Card — a walk-forward test of whether the score predicts.
 *
 * For each historical run snapshot that recorded prices, compare the price
 * then to the price now for every scored stock, and average the returns by
 * band (Hot / Strong / Watch / Avoid). Because each snapshot was written
 * BEFORE the returns it is judged on, this is free of look-ahead and
 * survivorship bias — it is the app grading its own past calls.
 *
 * All functions are pure; the UI supplies history and current prices.
 */

import { ragFromScore7 } from './rag.js';
import { snapshotPrice } from '../state/history.js';

export const BAND_ORDER = ['hot', 'strong', 'watch', 'avoid'];

/** Minimum stocks with then+now prices for a snapshot to be gradeable. */
export const MIN_COVERAGE = 20;

/** Minimum age in days before a snapshot is worth grading. */
export const MIN_AGE_DAYS = 1;

/**
 * Grade one snapshot against current prices.
 *
 * @param {object} snap - { at, stocks: { TICKER: [score7, ..., price] } }
 * @param {Map<string, number>} priceNow - ticker -> current price
 * @param {Date} now
 * @returns {null | { at, days, bands: {hot|strong|watch|avoid: {avg, n}}, spread, n }}
 */
export function gradeSnapshot(snap, priceNow, now = new Date()) {
  if (!snap?.stocks || !priceNow?.size) return null;

  const days = (now - new Date(snap.at)) / 86400_000;
  if (!(days >= MIN_AGE_DAYS)) return null;

  const sums = {};
  for (const b of BAND_ORDER) sums[b] = { total: 0, n: 0 };

  let n = 0;
  for (const [ticker, row] of Object.entries(snap.stocks)) {
    const band = ragFromScore7(Array.isArray(row) ? row[0] : null);
    const then = snapshotPrice(row);
    const cur  = priceNow.get(ticker);
    if (!band || then == null || then <= 0 || cur == null || cur <= 0) continue;
    sums[band].total += (cur - then) / then;
    sums[band].n++;
    n++;
  }
  if (n < MIN_COVERAGE) return null;

  const bands = {};
  for (const b of BAND_ORDER) {
    bands[b] = { avg: sums[b].n ? (sums[b].total / sums[b].n) * 100 : null, n: sums[b].n };
  }

  const spread = bands.hot.avg != null && bands.avoid.avg != null
    ? bands.hot.avg - bands.avoid.avg
    : null;

  return { at: snap.at, days: Math.round(days), bands, spread, n };
}

/**
 * Grade every gradeable snapshot, oldest first (longest horizon leads).
 *
 * @param {Array<object>} history - snapshot array from loadHistory()
 * @param {Map<string, number>} priceNow
 * @param {Date} now
 * @returns {Array} graded snapshots (may be empty)
 */
export function buildReportCard(history, priceNow, now = new Date()) {
  return (history || [])
    .map(snap => gradeSnapshot(snap, priceNow, now))
    .filter(Boolean)
    .sort((a, b) => new Date(a.at) - new Date(b.at));
}
