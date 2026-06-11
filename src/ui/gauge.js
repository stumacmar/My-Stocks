/**
 * Compass Gauge — V3's visual identity element.
 *
 * Renders an SVG semicircle gauge showing a 0–100 composite score.
 * Four coloured track segments: Avoid (red) → Watch (amber) → Strong (green) → Hot (gold).
 * A needle points to the current score; a filled arc shows the score region.
 *
 * Usage:
 *   import { compassGaugeHTML } from './gauge.js';
 *   element.innerHTML = compassGaugeHTML(72, { size: 240 });
 */

// Band boundaries on the 0–100 scale
const BANDS = [
  { from: 0,  to: 45, color: '#f87171', label: 'Avoid'  },  // red
  { from: 45, to: 60, color: '#f59e0b', label: 'Watch'  },  // amber
  { from: 60, to: 85, color: '#2ecc71', label: 'Strong' },  // green
  { from: 85, to: 100,color: '#f5c518', label: 'Hot'    },  // gold
];

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

// Map a 0–100 score to an angle in SVG space.
// Gauge sweeps left-to-right through the top (π → 0).
// score=0 → π (left), score=100 → 0 (right), score=50 → π/2 (top).
function scoreToAngle(score) {
  return Math.PI - (score / 100) * Math.PI;
}

function polarToXY(cx, cy, r, angle) {
  return {
    x: cx + r * Math.cos(angle),
    y: cy - r * Math.sin(angle),  // SVG y is inverted
  };
}

function arcPath(cx, cy, r, fromScore, toScore) {
  const a0 = scoreToAngle(fromScore);
  const a1 = scoreToAngle(toScore);
  const p0 = polarToXY(cx, cy, r, a0);
  const p1 = polarToXY(cx, cy, r, a1);
  const largeArc = (toScore - fromScore) > 50 ? 1 : 0;
  // sweep=1 = clockwise in SVG screen coords → goes through the top ✓
  return `M ${p0.x.toFixed(2)} ${p0.y.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Label and color helpers
// ---------------------------------------------------------------------------

export function compositeToRag(score) {
  if (score == null) return 'none';
  if (score >= 85) return 'hot';
  if (score >= 60) return 'strong';
  if (score >= 45) return 'watch';
  return 'avoid';
}

export function compositeToLabel(score) {
  const rag = compositeToRag(score);
  return { hot: '★ Hot', strong: 'Strong', watch: 'Watch', avoid: 'Avoid', none: '—' }[rag];
}

export function compositeToColor(score) {
  const rag = compositeToRag(score);
  return { hot: '#f5c518', strong: '#2ecc71', watch: '#f59e0b', avoid: '#f87171', none: '#6b7a90' }[rag];
}

// ---------------------------------------------------------------------------
// Main render function
// ---------------------------------------------------------------------------

/**
 * @param {number|null} composite - 0–100 score, or null for empty state
 * @param {{ size?: number, trackWidth?: number, label?: string }} options
 * @returns {string} SVG HTML string
 */
export function compassGaugeHTML(composite, { size = 220, trackWidth = 18, label = null } = {}) {
  const cx = size / 2;
  const cy = size / 2;           // center vertically in square viewBox
  const r  = (size / 2) - trackWidth - 8;  // leave room for stroke

  // The gauge sits in the top half; total height needed = cy + small bottom clearance
  const viewH = Math.round(cy + trackWidth + 16);

  const score = composite ?? 0;
  const color = compositeToColor(composite);
  const rag   = compositeToRag(composite);
  const scoreLabel = label ?? compositeToLabel(composite);

  // --- Background track (full semicircle, dim) ---
  const trackPath = arcPath(cx, cy, r, 0, 100);

  // --- Band segments on the track ---
  const bandPaths = BANDS.map(b => {
    const path = arcPath(cx, cy, r, b.from, b.to);
    return `<path d="${path}" fill="none" stroke="${b.color}" stroke-width="${trackWidth}" stroke-linecap="butt" opacity="0.18"/>`;
  }).join('');

  // --- Score filled arc ---
  const filled = composite != null && score > 0
    ? `<path d="${arcPath(cx, cy, r, 0, Math.min(score, 100))}" fill="none" stroke="${color}" stroke-width="${trackWidth}" stroke-linecap="round" opacity="0.9"/>`
    : '';

  // --- Needle dot at score position ---
  const needleAngle = scoreToAngle(Math.min(Math.max(score, 0), 100));
  const needlePt    = polarToXY(cx, cy, r, needleAngle);
  const needle = composite != null
    ? `<circle cx="${needlePt.x.toFixed(2)}" cy="${needlePt.y.toFixed(2)}" r="${trackWidth / 2 + 2}" fill="${color}" filter="url(#gaugeGlow)"/>`
    : '';

  // --- Center text ---
  const centerY     = cy - 2;
  const scoreText   = composite != null ? score : '—';
  const centerLabel = composite != null
    ? `<text x="${cx}" y="${centerY - 18}" text-anchor="middle" font-family="Georgia,serif" font-size="${Math.round(size * 0.23)}" font-weight="700" fill="${color}">${scoreText}</text>
       <text x="${cx}" y="${centerY + 4}" text-anchor="middle" font-family="Inter,system-ui,sans-serif" font-size="${Math.round(size * 0.072)}" font-weight="600" letter-spacing="0.06em" fill="${color}" text-transform="uppercase">${scoreLabel}</text>`
    : `<text x="${cx}" y="${centerY}" text-anchor="middle" font-family="Georgia,serif" font-size="${Math.round(size * 0.18)}" fill="#6b7a90">—</text>`;

  // --- Band tick marks at boundaries ---
  const ticks = BANDS.slice(1).map(b => {
    const ang = scoreToAngle(b.from);
    const inner = polarToXY(cx, cy, r - trackWidth / 2 - 2, ang);
    const outer = polarToXY(cx, cy, r + trackWidth / 2 + 2, ang);
    return `<line x1="${inner.x.toFixed(1)}" y1="${inner.y.toFixed(1)}" x2="${outer.x.toFixed(1)}" y2="${outer.y.toFixed(1)}" stroke="rgba(0,0,0,0.5)" stroke-width="1.5"/>`;
  }).join('');

  return `<svg viewBox="0 0 ${size} ${viewH}" width="${size}" height="${viewH}" xmlns="http://www.w3.org/2000/svg" aria-label="Score gauge: ${scoreText}">
  <defs>
    <filter id="gaugeGlow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="4" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <!-- Background track -->
  <path d="${trackPath}" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="${trackWidth}" stroke-linecap="butt"/>
  <!-- Band colours -->
  ${bandPaths}
  <!-- Score arc -->
  ${filled}
  <!-- Tick dividers -->
  ${ticks}
  <!-- Needle dot -->
  ${needle}
  <!-- Center label -->
  ${centerLabel}
</svg>`;
}

/**
 * Animate a gauge from 0 to its target score.
 * @param {HTMLElement} container - element that contains the gauge SVG
 * @param {number} target - final composite score
 * @param {object} opts - passed to compassGaugeHTML
 */
export function animateGauge(container, target, opts = {}) {
  const duration = 800;
  const start    = performance.now();

  function easeOut(t) { return 1 - Math.pow(1 - t, 3); }

  function frame(now) {
    const t   = Math.min((now - start) / duration, 1);
    const val = Math.round(easeOut(t) * target);
    container.innerHTML = compassGaugeHTML(val, opts);
    if (t < 1) requestAnimationFrame(frame);
    else container.innerHTML = compassGaugeHTML(target, opts);
  }

  requestAnimationFrame(frame);
}
