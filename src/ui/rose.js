/**
 * Compass Rose — a stock's five-pillar signature as a pentagon rose.
 *
 * Quality sits at north; value, growth, safety, momentum follow clockwise.
 * The filled polygon is the company's "shape": a fortress reads wide on the
 * left, a rocket bulges bottom-right. animateRose() morphs one company's
 * shape into another's — the signature interaction of the V4 detail sheet.
 *
 * Geometry helpers are pure and unit-tested.
 */

export const ROSE_AXES = [
  { id: 'quality',  label: 'Qual' },
  { id: 'value',    label: 'Val'  },
  { id: 'growth',   label: 'Grow' },
  { id: 'safety',   label: 'Safe' },
  { id: 'momentum', label: 'Mom'  },
];

const MIN_FRAC = 0.06;  // null / zero pillars still show a visible nub

// ---------------------------------------------------------------------------
// Pure geometry
// ---------------------------------------------------------------------------

/** Angle of axis i (radians, −π/2 = north, clockwise). */
export function roseAngle(i) {
  return -Math.PI / 2 + (i * 2 * Math.PI) / ROSE_AXES.length;
}

/**
 * Vertex positions for a set of pillar scores.
 * @param {{quality,value,growth,safety,momentum}|null} pillars - 0–100 or null each
 * @param {number} cx @param {number} cy @param {number} r
 * @returns {{x, y, pct}[]} 5 vertices, quality first
 */
export function rosePoints(pillars, cx, cy, r) {
  return ROSE_AXES.map((axis, i) => {
    const pct  = pillars?.[axis.id] ?? null;
    const frac = pct == null ? MIN_FRAC : Math.max(MIN_FRAC, pct / 100);
    const a    = roseAngle(i);
    return {
      x: cx + r * frac * Math.cos(a),
      y: cy + r * frac * Math.sin(a),
      pct,
    };
  });
}

/** Linear interpolation between two pillar sets (null treated as 0). */
export function lerpPillars(from, to, t) {
  const out = {};
  for (const { id } of ROSE_AXES) {
    const a = from?.[id] ?? 0;
    const b = to?.[id] ?? 0;
    out[id] = a + (b - a) * t;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function polygonPath(points) {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ') + ' Z';
}

/**
 * @param {object|null} pillars
 * @param {{ size?: number, color?: string, showLabels?: boolean }} opts
 * @returns {string} SVG HTML
 */
export function roseHTML(pillars, { size = 200, color = '#14b8a6', showLabels = true } = {}) {
  const cx = size / 2;
  const cy = size / 2;
  const r  = size / 2 - (showLabels ? 26 : 8);

  // Spider-web rings at 25/50/75/100%
  const rings = [0.25, 0.5, 0.75, 1].map(f => {
    const pts = ROSE_AXES.map((_, i) => {
      const a = roseAngle(i);
      return `${(cx + r * f * Math.cos(a)).toFixed(1)},${(cy + r * f * Math.sin(a)).toFixed(1)}`;
    }).join(' ');
    return `<polygon points="${pts}" fill="none" stroke="rgba(255,255,255,${f === 1 ? 0.10 : 0.05})" stroke-width="1"/>`;
  }).join('');

  // Axis spokes
  const spokes = ROSE_AXES.map((_, i) => {
    const a = roseAngle(i);
    return `<line x1="${cx}" y1="${cy}" x2="${(cx + r * Math.cos(a)).toFixed(1)}" y2="${(cy + r * Math.sin(a)).toFixed(1)}" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>`;
  }).join('');

  // Axis labels + values
  const labels = showLabels ? ROSE_AXES.map((axis, i) => {
    const a   = roseAngle(i);
    const lx  = cx + (r + 15) * Math.cos(a);
    const ly  = cy + (r + 15) * Math.sin(a);
    const pct = pillars?.[axis.id];
    return `
      <text x="${lx.toFixed(1)}" y="${(ly - 3).toFixed(1)}" text-anchor="middle" font-family="Inter,system-ui,sans-serif" font-size="9" font-weight="600" letter-spacing="0.06em" fill="#6b7a90">${axis.label.toUpperCase()}</text>
      <text x="${lx.toFixed(1)}" y="${(ly + 8).toFixed(1)}" text-anchor="middle" font-family="Fraunces,Georgia,serif" font-size="11" font-weight="700" fill="${pct != null ? color : '#3d4553'}">${pct != null ? Math.round(pct) : '—'}</text>`;
  }).join('') : '';

  // The shape itself
  const pts     = rosePoints(pillars, cx, cy, r);
  const path    = polygonPath(pts);
  const vertices = pts.map(p =>
    p.pct != null
      ? `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.5" fill="${color}"/>`
      : ''
  ).join('');

  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg" aria-label="Five pillar rose">
  ${rings}${spokes}
  <path d="${path}" fill="${color}22" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>
  ${vertices}
  ${labels}
</svg>`;
}

/**
 * Animate a rose: draw-in from centre (fromPillars = null) or morph between
 * two companies' shapes.
 */
export function animateRose(container, fromPillars, toPillars, opts = {}) {
  const duration = fromPillars ? 350 : 500;
  const start    = performance.now();

  const reduced = typeof matchMedia !== 'undefined'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) {
    container.innerHTML = roseHTML(toPillars, opts);
    return;
  }

  const from = fromPillars || { quality: 0, value: 0, growth: 0, safety: 0, momentum: 0 };

  function easeOut(t) { return 1 - Math.pow(1 - t, 3); }

  function frame(now) {
    const t = Math.min((now - start) / duration, 1);
    container.innerHTML = roseHTML(lerpPillars(from, toPillars, easeOut(t)), opts);
    if (t < 1) requestAnimationFrame(frame);
    else container.innerHTML = roseHTML(toPillars, opts);
  }

  requestAnimationFrame(frame);
}
