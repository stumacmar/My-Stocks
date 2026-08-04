/**
 * Portfolio Factor X-Ray — the portfolio's aggregate factor exposure.
 *
 * Value-weights each holding's five pillar percentiles into one set of
 * portfolio-level pillars: "what factor bets is this portfolio actually
 * making?" Holdings without pillar data (funds, unscored tickers) are
 * excluded and reported as coverage.
 *
 * Pure — the UI supplies [{ value, pillars }] items already priced in a
 * common currency.
 */

const PILLAR_IDS = ['quality', 'value', 'growth', 'safety', 'momentum'];

/**
 * @param {Array<{value: number, pillars: object|null}>} items
 *   value: holding market value in a common currency (weight)
 *   pillars: { quality, value, growth, safety, momentum } 0-100, or null
 * @returns {null | { pillars, n, totalN, topPillar, bottomPillar }}
 */
export function computeXray(items) {
  const all  = (items || []).filter(it => it && it.value > 0);
  const used = all.filter(it =>
    it.pillars && PILLAR_IDS.some(id => it.pillars[id] != null));
  if (!used.length) return null;

  const totalWeight = used.reduce((s, it) => s + it.value, 0);
  if (totalWeight <= 0) return null;

  const pillars = {};
  for (const id of PILLAR_IDS) {
    // Weight within the subset that actually has this pillar, so one fund
    // with a null pillar doesn't drag the average toward nothing.
    let sum = 0, w = 0;
    for (const it of used) {
      const v = it.pillars[id];
      if (v == null) continue;
      sum += v * it.value;
      w   += it.value;
    }
    pillars[id] = w > 0 ? sum / w : null;
  }

  const ranked = PILLAR_IDS
    .filter(id => pillars[id] != null)
    .sort((a, b) => pillars[b] - pillars[a]);

  return {
    pillars,
    n: used.length,
    totalN: all.length,
    topPillar:    ranked[0] ?? null,
    bottomPillar: ranked[ranked.length - 1] ?? null,
  };
}

/** 71 -> "71st", 42 -> "42nd", 30 -> "30th", 11-13 -> "th" */
export function ordinal(n) {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th';
  return `${n}${suffix}`;
}

/** One-sentence tilt description for the X-Ray card. */
export function xrayTiltText(xray) {
  if (!xray?.topPillar || !xray?.bottomPillar) return '';
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  const top = Math.round(xray.pillars[xray.topPillar]);
  const bot = Math.round(xray.pillars[xray.bottomPillar]);
  if (xray.topPillar === xray.bottomPillar) return '';
  return `Tilted toward ${cap(xray.topPillar)} (${ordinal(top)} percentile), ` +
         `lightest on ${cap(xray.bottomPillar)} (${ordinal(bot)}).`;
}
