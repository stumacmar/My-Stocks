/**
 * The Sky — an observatory for the whole market.
 *
 * Every scored stock is a star on a full-pane canvas, positioned by two
 * pillar percentiles. Because both axes are percentile-ranked, up-and-right
 * is ALWAYS better on both dimensions — the `◎ ideal` corner is the fixed
 * North of every lens.
 *
 *   - Colour = RAG band. Hot stars twinkle.
 *   - Size   = market cap (sqrt scale).
 *   - Gold ring = you own it or starred it.
 *   - Drift trails = where each star sat last run, fading toward today.
 *
 * Pan with a finger, pinch (or wheel) to zoom, double-tap to reset, tap a
 * star for its card, tap the card to open the full detail sheet.
 *
 * Zero network use: renders from persisted screen results; old results
 * without pillar data are enriched from the fundamentals LRU cache.
 */

import { getState, dispatch, ACTIONS, subscribe } from '../state/store.js';
import { RAG_COLORS, RAG_LABELS } from '../engine/rag.js';
import { computeUniversePillars, fundMapFromCache } from '../engine/universe.js';
import { previousSnapshot, snapshotPillars } from '../state/history.js';
import { ROSE_AXES } from './rose.js';

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Lenses
// ---------------------------------------------------------------------------

const PILLARS = ROSE_AXES.map(a => a.id);
const PILLAR_NAMES = {
  quality: 'Quality', value: 'Value', growth: 'Growth',
  safety: 'Safety', momentum: 'Momentum',
};

const LENSES = [
  { id: 'bargains', label: 'Bargains', x: 'value',    y: 'quality' },
  { id: 'fortress', label: 'Fortress', x: 'safety',   y: 'quality' },
  { id: 'rockets',  label: 'Rockets',  x: 'momentum', y: 'growth'  },
];

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let _canvas, _ctx, _stage, _dpr = 1;
let _W = 0, _H = 0;               // CSS px
let _stars = [];                  // { ticker, name, sector, rag, pillars, prevPillars, size, owned, hash }
let _axes = { x: 'value', y: 'quality' };
let _cam  = { k: 1, px: 0, py: 0 };
let _selected = null;             // ticker
let _sectorIdx = -1;              // -1 = all
let _sectors = [];
let _active = false;
let _raf = null;
let _sprites = {};                // rag → offscreen glow canvas
let _reducedMotion = false;
let _pointers = new Map();        // pointerId → {x, y}
let _pinch = null;                // { d0, k0, mx, my, px0, py0 }
let _drag  = null;                // { x0, y0, px0, py0, moved }
let _lastTap = 0;

const PAD = 34;                   // world padding inside the stage, CSS px

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

function ownedAndStarred() {
  const s   = getState();
  const set = new Set();
  for (const p of (s.portfolios || [])) {
    for (const h of (p.holdings || [])) set.add(h.ticker);
  }
  for (const w of (s.watchlist || [])) {
    set.add(typeof w === 'string' ? w : w.ticker);
  }
  return set;
}

function rebuildStars() {
  const rows = getState().screenResults?.results || [];
  const owned = ownedAndStarred();
  const prev  = previousSnapshot();

  const withPillars = rows.filter(r => r.pillars);
  const maxMkt = Math.max(1, ...withPillars.map(r => r.mktCap || 0));

  _stars = withPillars.map(r => {
    const prevRow = prev?.stocks?.[r.ticker];
    let hash = 0;
    for (let i = 0; i < r.ticker.length; i++) hash = (hash * 31 + r.ticker.charCodeAt(i)) & 0xffff;
    return {
      ticker:      r.ticker,
      name:        r.name || r.ticker,
      sector:      r.sector || null,
      rag:         r.rag || 'watch',
      pillars:     r.pillars,
      prevPillars: prevRow ? snapshotPillars(prevRow) : null,
      size:        r.mktCap ? 2.5 + 4.5 * Math.sqrt(r.mktCap / maxMkt) : 3,
      owned:       owned.has(r.ticker),
      hash,
    };
  });

  _sectors = [...new Set(_stars.map(s => s.sector).filter(Boolean))].sort();
  if (_sectorIdx >= _sectors.length) _sectorIdx = -1;
  updateChrome();
}

/**
 * Ensure results carry pillar data; enrich from the LRU cache if they don't.
 * Returns 'ready' | 'empty' | 'no-data'.
 */
function ensurePillars() {
  const state = getState();
  const sr    = state.screenResults;
  const rows  = sr?.results || [];
  if (!rows.length) return 'empty';
  if (rows.some(r => r.pillars)) return 'ready';

  const fundMap = fundMapFromCache(state.stockCache, rows.map(r => r.ticker));
  if (fundMap.size < 10) return 'no-data';

  const pillarMap = computeUniversePillars(fundMap);
  let hits = 0;
  const enriched = rows.map(r => {
    const p = pillarMap.get(r.ticker) || null;
    if (p && Object.values(p).some(v => v != null)) hits++;
    return {
      ...r,
      pillars: p,
      mktCap:  r.mktCap ?? fundMap.get(r.ticker)?.fundamentals?.profile?.mktCap ?? null,
    };
  });
  if (hits < 10) return 'no-data';

  dispatch(ACTIONS.SET_SCREEN_RESULTS, { ...sr, results: enriched });
  return 'ready';
}

// ---------------------------------------------------------------------------
// Geometry — world [0,1]² → screen
// ---------------------------------------------------------------------------

function worldPos(pillars) {
  const xv = pillars?.[_axes.x];
  const yv = pillars?.[_axes.y];
  if (xv == null || yv == null) return null;
  return { wx: xv / 100, wy: 1 - yv / 100 };  // up = better
}

function baseX(wx) { return PAD + wx * (_W - PAD * 2); }
function baseY(wy) { return PAD + wy * (_H - PAD * 2); }

function toScreen(wx, wy) {
  return {
    x: _W / 2 + (baseX(wx) - _W / 2) * _cam.k + _cam.px,
    y: _H / 2 + (baseY(wy) - _H / 2) * _cam.k + _cam.py,
  };
}

function clampCam() {
  _cam.k = Math.min(6, Math.max(0.75, _cam.k));
  const maxPan = Math.max(_W, _H) * _cam.k;
  _cam.px = Math.min(maxPan, Math.max(-maxPan, _cam.px));
  _cam.py = Math.min(maxPan, Math.max(-maxPan, _cam.py));
}

// ---------------------------------------------------------------------------
// Glow sprites — pre-rendered so drawing 500 stars costs 500 drawImages
// ---------------------------------------------------------------------------

function makeSprite(color) {
  const c = document.createElement('canvas');
  const s = 64;
  c.width = c.height = s;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(s/2, s/2, 0, s/2, s/2, s/2);
  grad.addColorStop(0,    color);
  grad.addColorStop(0.25, color + 'cc');
  grad.addColorStop(0.5,  color + '33');
  grad.addColorStop(1,    color + '00');
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  return c;
}

function buildSprites() {
  for (const [rag, color] of Object.entries(RAG_COLORS)) {
    _sprites[rag] = makeSprite(color);
  }
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

function draw(now) {
  if (!_ctx) return;
  _ctx.setTransform(_dpr, 0, 0, _dpr, 0, 0);
  _ctx.clearRect(0, 0, _W, _H);

  const sectorName = _sectorIdx >= 0 ? _sectors[_sectorIdx] : null;
  const t = now / 1000;

  // Ideal corner — the fixed North of every lens
  _ctx.save();
  _ctx.font = '600 10px Inter, system-ui, sans-serif';
  _ctx.fillStyle = 'rgba(240,243,247,0.35)';
  _ctx.textAlign = 'right';
  _ctx.fillText('◎ ideal', _W - 12, 20);
  _ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  _ctx.lineWidth = 1;
  // Quadrant cross at the world midpoint
  const mid = toScreen(0.5, 0.5);
  _ctx.beginPath();
  _ctx.moveTo(mid.x, 0); _ctx.lineTo(mid.x, _H);
  _ctx.moveTo(0, mid.y); _ctx.lineTo(_W, mid.y);
  _ctx.stroke();
  _ctx.restore();

  // Drift trails first, under the stars
  _ctx.lineWidth = 1;
  for (const s of _stars) {
    if (!s.prevPillars) continue;
    const cur = worldPos(s.pillars);
    const prv = worldPos(s.prevPillars);
    if (!cur || !prv) continue;
    const a = toScreen(prv.wx, prv.wy);
    const b = toScreen(cur.wx, cur.wy);
    const dx = b.x - a.x, dy = b.y - a.y;
    if (dx * dx + dy * dy < 4) continue;
    const dim = sectorName && s.sector !== sectorName;
    const grad = _ctx.createLinearGradient(a.x, a.y, b.x, b.y);
    const col  = RAG_COLORS[s.rag] || '#6b7a90';
    grad.addColorStop(0, col + '00');
    grad.addColorStop(1, col + (dim ? '14' : '55'));
    _ctx.strokeStyle = grad;
    _ctx.beginPath();
    _ctx.moveTo(a.x, a.y);
    _ctx.lineTo(b.x, b.y);
    _ctx.stroke();
  }

  // Stars
  const showLabels = _cam.k >= 2.2;
  _ctx.font = '600 9px Inter, system-ui, sans-serif';
  _ctx.textAlign = 'left';

  for (const s of _stars) {
    const w = worldPos(s.pillars);
    if (!w) continue;
    const p = toScreen(w.wx, w.wy);
    if (p.x < -20 || p.x > _W + 20 || p.y < -20 || p.y > _H + 20) continue;

    const dim = sectorName && s.sector !== sectorName;
    let r = s.size;
    if (s.rag === 'hot' && !_reducedMotion) {
      r *= 1 + 0.15 * Math.sin(t * 2.2 + s.hash);
    }
    const spriteR = r * 2.6;

    _ctx.globalAlpha = dim ? 0.10 : 1;
    const sprite = _sprites[s.rag] || _sprites.watch;
    _ctx.drawImage(sprite, p.x - spriteR, p.y - spriteR, spriteR * 2, spriteR * 2);

    if (s.owned && !dim) {
      _ctx.strokeStyle = '#f5c518';
      _ctx.lineWidth = 1.25;
      _ctx.beginPath();
      _ctx.arc(p.x, p.y, r + 3.5, 0, Math.PI * 2);
      _ctx.stroke();
    }

    if (showLabels && !dim) {
      _ctx.fillStyle = 'rgba(240,243,247,0.72)';
      _ctx.fillText(s.ticker, p.x + spriteR * 0.55 + 2, p.y + 3);
    }
    _ctx.globalAlpha = 1;
  }

  // Selected halo
  if (_selected) {
    const s = _stars.find(st => st.ticker === _selected);
    const w = s && worldPos(s.pillars);
    if (w) {
      const p = toScreen(w.wx, w.wy);
      _ctx.strokeStyle = 'rgba(240,243,247,0.85)';
      _ctx.lineWidth = 1.5;
      _ctx.beginPath();
      _ctx.arc(p.x, p.y, s.size + 8, 0, Math.PI * 2);
      _ctx.stroke();
    }
  }
}

function loop(now) {
  if (!_active) { _raf = null; return; }
  draw(now);
  _raf = requestAnimationFrame(loop);
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

function hitTest(x, y) {
  let best = null, bestD = 22 * 22;
  for (const s of _stars) {
    const w = worldPos(s.pillars);
    if (!w) continue;
    const p = toScreen(w.wx, w.wy);
    const d = (p.x - x) ** 2 + (p.y - y) ** 2;
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}

function stagePoint(e) {
  const rect = _stage.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function onPointerDown(e) {
  // Axis buttons and the star card live inside the stage — leave their
  // clicks alone, or pointer capture would swallow them.
  if (e.target !== _canvas) return;
  _stage.setPointerCapture?.(e.pointerId);
  const pt = stagePoint(e);
  _pointers.set(e.pointerId, pt);

  if (_pointers.size === 2) {
    const [a, b] = [..._pointers.values()];
    _pinch = {
      d0: Math.hypot(a.x - b.x, a.y - b.y),
      k0: _cam.k,
      mx: (a.x + b.x) / 2,
      my: (a.y + b.y) / 2,
      px0: _cam.px,
      py0: _cam.py,
    };
    _drag = null;
  } else if (_pointers.size === 1) {
    _drag = { x0: pt.x, y0: pt.y, px0: _cam.px, py0: _cam.py, moved: false };
  }
}

function onPointerMove(e) {
  if (!_pointers.has(e.pointerId)) return;
  const pt = stagePoint(e);
  _pointers.set(e.pointerId, pt);

  if (_pinch && _pointers.size >= 2) {
    const [a, b] = [..._pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (_pinch.d0 > 0) {
      const kNew = Math.min(6, Math.max(0.75, _pinch.k0 * (d / _pinch.d0)));
      // Keep the world point under the pinch midpoint fixed
      const ratio = kNew / _pinch.k0;
      _cam.px = _pinch.mx - _W / 2 - (_pinch.mx - _W / 2 - _pinch.px0) * ratio;
      _cam.py = _pinch.my - _H / 2 - (_pinch.my - _H / 2 - _pinch.py0) * ratio;
      _cam.k  = kNew;
      clampCam();
    }
  } else if (_drag) {
    const dx = pt.x - _drag.x0;
    const dy = pt.y - _drag.y0;
    if (Math.abs(dx) + Math.abs(dy) > 6) _drag.moved = true;
    _cam.px = _drag.px0 + dx;
    _cam.py = _drag.py0 + dy;
    clampCam();
  }
}

function onPointerUp(e) {
  const wasDrag = _drag;
  _pointers.delete(e.pointerId);
  if (_pointers.size < 2) _pinch = null;

  if (wasDrag && !wasDrag.moved && _pointers.size === 0) {
    const pt  = stagePoint(e);
    const now = performance.now();
    if (now - _lastTap < 320) {
      // Double tap — reset camera
      _cam = { k: 1, px: 0, py: 0 };
      _lastTap = 0;
      selectStar(null);
      return;
    }
    _lastTap = now;
    selectStar(hitTest(pt.x, pt.y));
  }
  if (_pointers.size === 0) _drag = null;
}

function onWheel(e) {
  e.preventDefault();
  const pt = stagePoint(e);
  const kNew = Math.min(6, Math.max(0.75, _cam.k * (e.deltaY < 0 ? 1.15 : 0.87)));
  const ratio = kNew / _cam.k;
  _cam.px = pt.x - _W / 2 - (pt.x - _W / 2 - _cam.px) * ratio;
  _cam.py = pt.y - _H / 2 - (pt.y - _H / 2 - _cam.py) * ratio;
  _cam.k  = kNew;
  clampCam();
}

// ---------------------------------------------------------------------------
// Star card
// ---------------------------------------------------------------------------

function selectStar(star) {
  _selected = star?.ticker || null;
  const card = document.getElementById('v3-sky-card');
  if (!card) return;

  if (!star) {
    card.style.display = 'none';
    return;
  }

  const color = RAG_COLORS[star.rag] || '#6b7a90';
  const bars  = PILLARS.map(id => {
    const v = star.pillars?.[id];
    return `
      <div class="v3-sky-bar-row">
        <span class="v3-sky-bar-label">${PILLAR_NAMES[id].slice(0, 4)}</span>
        <div class="v3-sky-bar-track"><div class="v3-sky-bar-fill" style="width:${v ?? 0}%;background:${color}"></div></div>
        <span class="v3-sky-bar-val">${v != null ? v : '—'}</span>
      </div>`;
  }).join('');

  card.innerHTML = `
    <div class="v3-sky-card-head">
      <div>
        <span class="v3-sky-card-ticker">${escHtml(star.ticker)}</span>
        ${star.owned ? '<span class="v3-sky-owned-chip">◉ yours</span>' : ''}
        <div class="v3-sky-card-name">${escHtml(star.name)}</div>
      </div>
      <span class="v3-rag-pill" style="color:${color};background:${color}15;border-color:${color}30">${RAG_LABELS[star.rag] || star.rag}</span>
    </div>
    <div class="v3-sky-bars">${bars}</div>
    <button class="v3-sky-open-btn" onclick="v3Sky.openSelected()">Open detail →</button>`;
  card.style.display = 'block';
}

function openSelected() {
  if (!_selected) return;
  window.v3Screen?.openDetail(_selected);
}

// ---------------------------------------------------------------------------
// Chrome — lenses, axis buttons, sector cycle, legend
// ---------------------------------------------------------------------------

function setLens(lensId) {
  const lens = LENSES.find(l => l.id === lensId);
  if (!lens) return;
  _axes = { x: lens.x, y: lens.y };
  _cam  = { k: 1, px: 0, py: 0 };
  updateChrome();
}

function cycleAxis(which) {
  const cur  = _axes[which];
  const next = PILLARS[(PILLARS.indexOf(cur) + 1) % PILLARS.length];
  // Never chart a pillar against itself
  _axes[which] = next === _axes[which === 'x' ? 'y' : 'x']
    ? PILLARS[(PILLARS.indexOf(next) + 1) % PILLARS.length]
    : next;
  updateChrome();
}

function cycleSector() {
  _sectorIdx = _sectorIdx + 1 >= _sectors.length ? -1 : _sectorIdx + 1;
  updateChrome();
}

function updateChrome() {
  const xBtn = document.getElementById('v3-sky-xaxis');
  const yBtn = document.getElementById('v3-sky-yaxis');
  if (xBtn) xBtn.textContent = `${PILLAR_NAMES[_axes.x]} →`;
  if (yBtn) yBtn.textContent = `${PILLAR_NAMES[_axes.y]} ↑`;

  const secBtn = document.getElementById('v3-sky-sector');
  if (secBtn) {
    secBtn.textContent = _sectorIdx >= 0 ? _sectors[_sectorIdx] : 'All sectors';
    secBtn.classList.toggle('active', _sectorIdx >= 0);
  }

  const activeLens = LENSES.find(l => l.x === _axes.x && l.y === _axes.y);
  for (const lens of LENSES) {
    document.getElementById(`v3-lens-${lens.id}`)
      ?.classList.toggle('active', activeLens?.id === lens.id);
  }

  const count = document.getElementById('v3-sky-count');
  if (count) {
    const total = getState().screenResults?.results?.length || 0;
    const charted = _stars.filter(s => worldPos(s.pillars)).length;
    count.textContent = charted ? `${charted} of ${total} charted` : '';
  }
}

// ---------------------------------------------------------------------------
// Sizing
// ---------------------------------------------------------------------------

function resize() {
  if (!_stage || !_canvas) return;
  _W = _stage.clientWidth;
  _H = _stage.clientHeight;
  _dpr = Math.min(window.devicePixelRatio || 1, 2);
  _canvas.width  = Math.round(_W * _dpr);
  _canvas.height = Math.round(_H * _dpr);
  _canvas.style.width  = _W + 'px';
  _canvas.style.height = _H + 'px';
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export function activateSky() {
  if (_active) return;
  _active = true;
  resize();

  const empty = document.getElementById('v3-sky-empty');
  const status = ensurePillars();

  if (status === 'ready') {
    if (empty) empty.style.display = 'none';
    rebuildStars();
  } else if (empty) {
    empty.style.display = 'flex';
    empty.innerHTML = status === 'empty'
      ? `<div class="v3-empty-icon">✶</div>
         <div class="v3-empty-title">The sky is dark</div>
         <div class="v3-empty-sub">Run a screen and every stock becomes a star,<br>positioned by its nature.</div>
         <button class="v3-portf-create-btn" onclick="document.querySelector('[data-v3-tab=&quot;screen&quot;]').click()">Go to Screen</button>`
      : `<div class="v3-empty-icon">✶</div>
         <div class="v3-empty-title">Not enough light</div>
         <div class="v3-empty-sub">Your saved results are from an older version of the app.<br>Run one fresh screen and every stock becomes a star.</div>
         <button class="v3-portf-create-btn" onclick="document.querySelector('[data-v3-tab=&quot;screen&quot;]').click()">Go to Screen</button>`;
  }

  if (!_raf) _raf = requestAnimationFrame(loop);
}

export function deactivateSky() {
  _active = false;
  if (_raf) { cancelAnimationFrame(_raf); _raf = null; }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export function initObservatory() {
  _stage  = document.getElementById('v3-sky-stage');
  _canvas = document.getElementById('v3-sky-canvas');
  if (!_stage || !_canvas) return;
  _ctx = _canvas.getContext('2d');

  _reducedMotion = typeof matchMedia !== 'undefined'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;

  buildSprites();
  resize();
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(resize).observe(_stage);
  }

  _stage.addEventListener('pointerdown',   onPointerDown);
  _stage.addEventListener('pointermove',   onPointerMove);
  _stage.addEventListener('pointerup',     onPointerUp);
  _stage.addEventListener('pointercancel', onPointerUp);
  _stage.addEventListener('wheel', onWheel, { passive: false });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (_raf) { cancelAnimationFrame(_raf); _raf = null; }
    } else if (_active && !_raf) {
      _raf = requestAnimationFrame(loop);
    }
  });

  // Rebuild when results / holdings / watchlist change
  subscribe((state, prev) => {
    if (
      state.screenResults !== prev.screenResults ||
      state.portfolios    !== prev.portfolios    ||
      state.watchlist     !== prev.watchlist
    ) {
      rebuildStars();
    }
  });

  rebuildStars();
}

// Expose for HTML onclick handlers
window.v3Sky = { setLens, cycleAxis, cycleSector, openSelected };
