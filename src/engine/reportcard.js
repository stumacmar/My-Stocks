/**
 * Score Report Card — a walk-forward test of whether the score predicts.
 *
 * For each historical run snapshot that recorded prices, compare the price
 * then to the price now for every scored stock, and grade the bands
 * (Hot / Strong / Watch / Avoid) with proper statistics:
 *
 *   - avg:     average return since scored
 *   - excess:  average return MINUS the universe average (benchmark-relative
 *              — "+4%" means nothing if the whole market rose 5%)
 *   - hitRate: fraction of the band's stocks that beat the universe median
 *              (breadth — an average can be dragged by one lucky stock)
 *   - stdev:   dispersion of returns within the band
 *
 * Because each snapshot was written BEFORE the returns it is judged on,
 * this is free of look-ahead and survivorship bias — the app grading its
 * own past calls. reportVerdict() then says, honestly, whether there is
 * enough evidence to conclude anything at all.
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

/** Below this horizon/run count the verdict refuses to judge. */
export const MIN_JUDGE_DAYS = 14;
export const MIN_JUDGE_RUNS = 2;

function _mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function _median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function _stdev(xs) {
  if (xs.length < 2) return null;
  const m = _mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

/**
 * Grade one snapshot against current prices.
 *
 * @param {object} snap - { at, stocks: { TICKER: [score7, ..., price] } }
 * @param {Map<string, number>} priceNow - ticker -> current price
 * @param {Date} now
 * @returns {null | {
 *   at, days, n,
 *   universe: { avg, median },
 *   bands: { hot|strong|watch|avoid: { avg, excess, hitRate, stdev, n } },
 *   spread,
 * }}
 */
export function gradeSnapshot(snap, priceNow, now = new Date()) {
  if (!snap?.stocks || !priceNow?.size) return null;

  const days = (now - new Date(snap.at)) / 86400_000;
  if (!(days >= MIN_AGE_DAYS)) return null;

  const byBand = {};
  for (const b of BAND_ORDER) byBand[b] = [];
  const allRets = [];

  for (const [ticker, row] of Object.entries(snap.stocks)) {
    const band = ragFromScore7(Array.isArray(row) ? row[0] : null);
    const then = snapshotPrice(row);
    const cur  = priceNow.get(ticker);
    if (!band || then == null || then <= 0 || cur == null || cur <= 0) continue;
    const ret = ((cur - then) / then) * 100;
    byBand[band].push(ret);
    allRets.push(ret);
  }
  if (allRets.length < MIN_COVERAGE) return null;

  const universe = { avg: _mean(allRets), median: _median(allRets) };

  const bands = {};
  for (const b of BAND_ORDER) {
    const rets = byBand[b];
    const avg  = _mean(rets);
    bands[b] = {
      avg,
      excess:  avg != null ? avg - universe.avg : null,
      hitRate: rets.length
        ? rets.filter(r => r > universe.median).length / rets.length
        : null,
      stdev:   _stdev(rets),
      n:       rets.length,
    };
  }

  const spread = bands.hot.avg != null && bands.avoid.avg != null
    ? bands.hot.avg - bands.avoid.avg
    : null;

  return { at: snap.at, days: Math.round(days), n: allRets.length, universe, bands, spread };
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

/**
 * The honest summary: does the evidence support a conclusion yet?
 *
 * Judges on consistency of the Hot-minus-Avoid spread across graded runs,
 * and refuses to judge below MIN_JUDGE_DAYS / MIN_JUDGE_RUNS — with a few
 * runs over a few weeks, noise dominates and the card should say so.
 *
 * @param {Array} card - output of buildReportCard()
 * @returns {null | { tone: 'early'|'good'|'bad'|'mixed', text: string }}
 */
export function reportVerdict(card) {
  if (!card?.length) return null;

  const spreads = card.map(g => g.spread).filter(v => v != null);
  const runs    = spreads.length;
  const oldest  = card[0];

  if (!runs) {
    return { tone: 'early', text: 'Bands are missing Hot or Avoid stocks — no spread to grade yet.' };
  }
  if (oldest.days < MIN_JUDGE_DAYS || runs < MIN_JUDGE_RUNS) {
    return {
      tone: 'early',
      text: `Too early to judge — ${runs} graded run${runs === 1 ? '' : 's'} over ` +
            `${oldest.days} day${oldest.days === 1 ? '' : 's'}. At this horizon the numbers are mostly noise.`,
    };
  }

  const pos = spreads.filter(s => s > 0).length;
  if (pos === runs) {
    return {
      tone: 'good',
      text: `Higher bands have beaten lower ones in all ${runs} graded runs ` +
            `(longest ${oldest.days} days) — an early sign the score predicts. ` +
            `Keep running: more runs make this verdict stronger.`,
    };
  }
  if (pos === 0) {
    return {
      tone: 'bad',
      text: `Lower bands have beaten higher ones in all ${runs} graded runs — ` +
            `so far the score has not predicted. Worth watching before trusting the bands.`,
    };
  }
  return {
    tone: 'mixed',
    text: `Mixed evidence: higher bands won in ${pos} of ${runs} graded runs — ` +
          `no reliable signal either way yet.`,
  };
}
