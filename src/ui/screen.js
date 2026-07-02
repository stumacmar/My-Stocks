/**
 * Screen view — full S&P 500 scorer.
 *
 * Manages:
 *   - Run flow (fetch → score → display, with progress and cancel)
 *   - Results table with filter/sort/virtual-scroll
 *   - Distribution bar
 *   - Filter chips with live counts
 *   - Detail bottom sheet (per-stock)
 *   - Starred (watchlist) toggle
 *
 * All DOM manipulation targets elements inside #v3-screen-pane.
 */

import { fetchStockData, fetchBulkQuotes } from '../data/fmp.js';
import { getState, dispatch, ACTIONS, subscribe } from '../state/store.js';
import { classicScore } from '../engine/presets.js';
import { evaluateFlags } from '../engine/flags.js';
import { compassGaugeHTML, animateGauge, compositeToRag, compositeToLabel, compositeToColor } from './gauge.js';
import { SP500 } from '../data/sp500.js';
import { RAG_LABELS, RAG_COLORS, ragFromScore7 } from '../engine/rag.js';
import { getRemainingBudget } from '../data/budget.js';
import { computeUniversePillars } from '../engine/universe.js';
import { recordRun, latestDiff, isBriefingSeen, markBriefingSeen } from '../state/history.js';
import { roseHTML, animateRose } from './rose.js';

// ---------------------------------------------------------------------------
// XSS helper
// ---------------------------------------------------------------------------

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let _results      = [];        // ScoredStock[]
let _filter       = 'all';     // 'all'|'hot'|'strong'|'watch'|'avoid'|'starred'
let _sort         = { col: 'composite', dir: 'desc' };
let _running      = false;
let _stopRequested = false;
let _activeDetail = null;      // ticker of open detail sheet

// ---------------------------------------------------------------------------
// Distribution bar
// ---------------------------------------------------------------------------

function renderDistBar(results) {
  const el = document.getElementById('v3-dist-bar');
  if (!el) return;

  const counts = { hot: 0, strong: 0, watch: 0, avoid: 0 };
  for (const r of results) counts[r.rag] = (counts[r.rag] || 0) + 1;
  const total = results.length || 1;

  el.innerHTML = Object.entries(counts).map(([rag, n]) => {
    const pct   = ((n / total) * 100).toFixed(1);
    const color = RAG_COLORS[rag];
    const label = RAG_LABELS[rag];
    return `
      <div class="v3-dist-seg" data-rag="${rag}" style="flex:${n || 0.001};background:${color}20;border-top:2px solid ${color};cursor:pointer" onclick="v3Screen.setFilter('${rag}')">
        <div class="v3-dist-count" style="color:${color}">${n}</div>
        <div class="v3-dist-label">${label}</div>
        <div class="v3-dist-pct">${pct}%</div>
      </div>`;
  }).join('');
}

// ---------------------------------------------------------------------------
// Filter chips
// ---------------------------------------------------------------------------

function updateFilterChips(results) {
  const counts = { hot: 0, strong: 0, watch: 0, avoid: 0 };
  for (const r of results) counts[r.rag] = (counts[r.rag] || 0) + 1;
  const starred = results.filter(r => isStarred(r.ticker)).length;

  const defs = [
    { id: 'chip-all',     filter: 'all',     label: `All (${results.length})` },
    { id: 'chip-hot',     filter: 'hot',     label: `★ Hot${counts.hot     ? ` (${counts.hot})`     : ''}` },
    { id: 'chip-strong',  filter: 'strong',  label: `Strong${counts.strong  ? ` (${counts.strong})`  : ''}` },
    { id: 'chip-watch',   filter: 'watch',   label: `Watch${counts.watch    ? ` (${counts.watch})`   : ''}` },
    { id: 'chip-avoid',   filter: 'avoid',   label: `Avoid${counts.avoid    ? ` (${counts.avoid})`   : ''}` },
    { id: 'chip-starred', filter: 'starred', label: `★ Starred${starred     ? ` (${starred})`        : ''}` },
  ];

  for (const d of defs) {
    const el = document.getElementById(d.id);
    if (el) {
      el.textContent = d.label;
      el.classList.toggle('active', _filter === d.filter);
    }
  }
}

// ---------------------------------------------------------------------------
// Starred (watchlist)
// ---------------------------------------------------------------------------

function isStarred(ticker) {
  const { watchlist } = getState();
  return Array.isArray(watchlist) && watchlist.some(w =>
    typeof w === 'string' ? w === ticker : w.ticker === ticker
  );
}

function toggleStar(ticker) {
  const { watchlist = [] } = getState();
  const tickers = watchlist.map(w => typeof w === 'string' ? w : w.ticker);
  const next = tickers.includes(ticker)
    ? watchlist.filter(w => (typeof w === 'string' ? w : w.ticker) !== ticker)
    : [...watchlist, ticker];
  dispatch(ACTIONS.SET_WATCHLIST, next);
  renderTable(_results);
  updateFilterChips(_results);
}

// ---------------------------------------------------------------------------
// Table rendering
// ---------------------------------------------------------------------------

function filteredSorted(results) {
  let rows = results;
  if (_filter === 'starred') {
    rows = rows.filter(r => isStarred(r.ticker));
  } else if (_filter !== 'all') {
    rows = rows.filter(r => r.rag === _filter);
  }

  const { col, dir } = _sort;
  rows = [...rows].sort((a, b) => {
    const av = a[col] ?? -Infinity;
    const bv = b[col] ?? -Infinity;
    return dir === 'asc' ? av - bv : bv - av;
  });

  return rows;
}

function renderTable(results) {
  const wrap = document.getElementById('v3-table-body');
  if (!wrap) return;

  const rows  = filteredSorted(results);
  const state = getState();

  if (!rows.length) {
    wrap.innerHTML = `
      <div class="v3-empty">
        <div class="v3-empty-icon">◎</div>
        <div class="v3-empty-title">${_filter === 'all' ? 'Ready to screen' : 'No matches'}</div>
        <div class="v3-empty-sub">
          ${_filter === 'all'
            ? 'Tap <strong>Run Screen</strong> to score all S&P 500 stocks.'
            : 'Try a different filter.'}
        </div>
      </div>`;
    return;
  }

  wrap.innerHTML = rows.map(r => {
    const color   = RAG_COLORS[r.rag] || '#6b7a90';
    const starred = isStarred(r.ticker);
    const flagged = r.flagCount > 0;
    return `
    <div class="v3-row" role="button" tabindex="0" onclick="v3Screen.openDetail('${escHtml(r.ticker)}')" onkeydown="if(event.key==='Enter'||event.key===' ')v3Screen.openDetail('${escHtml(r.ticker)}')">
      <div class="v3-row-star" onclick="event.stopPropagation();v3Screen.toggleStar('${escHtml(r.ticker)}')" title="${starred ? 'Unstar' : 'Star'}">${starred ? '★' : '☆'}</div>
      <div class="v3-row-ticker">${escHtml(r.ticker)}</div>
      <div class="v3-row-name">${escHtml(r.name || '')}</div>
      <div class="v3-row-score">
        <span class="v3-score-badge" style="color:${color};border-color:${color}20;background:${color}10">
          ${r.composite != null ? r.composite : '—'}
        </span>
      </div>
      <div class="v3-row-classic">
        <span style="color:${RAG_COLORS[ragFromScore7(r.score7)] || '#6b7a90'};font-size:12px;font-weight:600">
          ${r.score7 != null ? `${r.score7}/7` : '—'}
        </span>
      </div>
      <div class="v3-row-rag">
        <span class="v3-rag-pill" style="color:${color};background:${color}15;border-color:${color}30">${RAG_LABELS[r.rag] || r.rag}</span>
      </div>
      ${flagged ? `<div class="v3-row-flag" title="${r.flagCount} red flag${r.flagCount > 1 ? 's' : ''}">🚩</div>` : '<div class="v3-row-flag"></div>'}
    </div>`;
  }).join('');
}

// ---------------------------------------------------------------------------
// Last-run timestamp
// ---------------------------------------------------------------------------

function updateRunMeta(ts) {
  const el = document.getElementById('v3-run-meta');
  if (!el) return;
  if (!ts) { el.textContent = ''; return; }
  const d = new Date(ts);
  el.textContent = `Last run: ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

// ---------------------------------------------------------------------------
// Progress bar
// ---------------------------------------------------------------------------

function setProgress(done, total, currentTicker = '') {
  const bar  = document.getElementById('v3-progress-bar');
  const text = document.getElementById('v3-progress-text');
  const wrap = document.getElementById('v3-progress-wrap');

  if (!wrap) return;

  if (total === 0) {
    wrap.style.display = 'none';
    return;
  }

  wrap.style.display = '';
  const pct = Math.round((done / total) * 100);
  if (bar)  bar.style.width = pct + '%';
  if (text) text.textContent = `${done} / ${total}${currentTicker ? ` — ${currentTicker}` : ''}`;
}

// ---------------------------------------------------------------------------
// Run flow
// ---------------------------------------------------------------------------

export async function runScreen() {
  if (_running) return;

  const { apiKey } = getState();
  if (!apiKey) {
    document.getElementById('v3-api-prompt')?.classList.add('visible');
    return;
  }

  // Warn if budget is likely insufficient for a full run
  const remaining = getRemainingBudget();
  // Cost estimate: 6 calls per uncached stock + bulk quotes
  // (simplified: warn if < 100 calls remaining)
  if (remaining < 100) {
    const ok = confirm(
      `Low API budget: only ${remaining} calls remaining today.\n\n` +
      `A full screen run uses ~6 calls per uncached stock.\n` +
      `You may only score a partial list. Continue?`
    );
    if (!ok) return;
  }

  _running      = true;
  _stopRequested = false;
  _results       = [];

  const runBtn  = document.getElementById('v3-run-btn');
  const stopBtn = document.getElementById('v3-stop-btn');
  if (runBtn)  runBtn.disabled = true;
  if (stopBtn) stopBtn.style.display = 'flex';

  const universe = SP500;
  const scored   = [];

  // Fetch bulk quotes first (~10 calls for full S&P 500)
  setProgress(0, universe.length, 'Fetching quotes…');
  const quoteResult = await fetchBulkQuotes(universe, apiKey);

  if (quoteResult.error && !quoteResult.data?.size) {
    showRunError(quoteResult.error);
    finishRun();
    return;
  }

  const quoteMap = quoteResult.data || new Map();

  // Score each stock
  for (let i = 0; i < universe.length; i++) {
    if (_stopRequested) break;

    const ticker = universe[i];
    setProgress(i, universe.length, ticker);

    try {
      const stockResult = await fetchStockData(ticker, apiKey);
      if (stockResult.error?.toLowerCase().includes('budget')) {
        // Budget exhausted — stop run rather than scoring with null data
        _stopRequested = true;
        showRunError(`Daily API budget reached at ${scored.length} stocks. Run again tomorrow for remaining stocks.`);
        break;
      }
      const fund        = stockResult.data || {};

      // Classic 7 is the primary scorer for now (V3 percentile engine needs full universe data)
      const c7   = classicScore(fund);
      const flags = evaluateFlags(fund);

      const quote = quoteMap.get(ticker);

      scored.push({
        ticker,
        name:      fund.profile?.companyName || quote?.name || ticker,
        composite: c7.composite,   // 0–100 mapped from Classic 7 for now
        score7:    c7.score,
        rag:       ragFromScore7(c7.score),
        criteria:  c7.criteria,
        flags,
        flagCount: flags.filter(f => f.fired).length,
        price:     quote?.price || fund.profile?.price || null,
        sector:    fund.profile?.sector || quote?.sector || null,
        mktCap:    quote?.marketCap ?? fund.profile?.mktCap ?? null,
        fund,
      });

      // Partial update every 10 stocks
      if (scored.length % 10 === 0) {
        _results = [...scored];
        renderTable(_results);
        renderDistBar(_results);
        updateFilterChips(_results);
      }
    } catch {
      // skip failed tickers silently
    }

    // Small delay to avoid hammering the API
    await new Promise(r => setTimeout(r, 200));
  }

  _results = scored;
  const runAt = new Date().toISOString();

  // Whole-universe pillar pass — one percentile sort per metric, then attach
  // five 0–100 pillar scores to every stock. Powers the Sky and the Rose.
  if (scored.length) {
    setProgress(universe.length, universe.length, 'Charting the sky…');
    try {
      const fundMap = new Map(scored.map(r =>
        [r.ticker, { fundamentals: r.fund, priceHistory: r.fund?.priceHistory || null }]
      ));
      const pillarMap = computeUniversePillars(fundMap);
      for (const r of scored) r.pillars = pillarMap.get(r.ticker) || null;
    } catch (e) {
      console.warn('[screen] pillar pass failed', e);
    }
  }

  const persistedRows = scored.map(r => ({
    ticker: r.ticker, name: r.name, composite: r.composite,
    score7: r.score7, rag: r.rag, flagCount: r.flagCount,
    price: r.price, sector: r.sector, mktCap: r.mktCap ?? null,
    pillars: r.pillars ?? null, scoredAt: runAt,
  }));

  // Persist to store
  dispatch(ACTIONS.SET_SCREEN_RESULTS, {
    results: persistedRows,
    scoredAt: runAt,
    universe: 'sp500',
  });

  // Append this run to score history — feeds the briefing and sky trails
  if (persistedRows.length) {
    try { recordRun(persistedRows, runAt); } catch { /* history is a luxury */ }
  }

  renderTable(_results);
  renderDistBar(_results);
  updateFilterChips(_results);
  updateRunMeta(runAt);
  renderBriefing();
  setProgress(0, 0);
  finishRun();
}

function finishRun() {
  _running = false;
  const runBtn  = document.getElementById('v3-run-btn');
  const stopBtn = document.getElementById('v3-stop-btn');
  if (runBtn)  runBtn.disabled = false;
  if (stopBtn) stopBtn.style.display = 'none';
  setProgress(0, 0);
}

function showRunError(msg) {
  const el = document.getElementById('v3-run-error');
  if (el) { el.textContent = msg; el.style.display = ''; }
}

export function stopScreen() {
  _stopRequested = true;
}

// ---------------------------------------------------------------------------
// The Log — "since your last reading" briefing
// ---------------------------------------------------------------------------

function _ownedTickers() {
  const set = new Set();
  for (const p of (getState().portfolios || [])) {
    for (const h of (p.holdings || [])) set.add(h.ticker);
  }
  return set;
}

function _briefingDate(iso) {
  try {
    return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  } catch { return ''; }
}

function _moverLine(m, dir, owned, starred) {
  const fromRag = ragFromScore7(m.score7From);
  const toRag   = ragFromScore7(m.score7To);
  const verb    = dir === 'up' ? 'climbed' : 'slipped';
  const tag     = owned.has(m.ticker) ? ' <span class="v3-log-tag">you hold this</span>'
                : starred.has(m.ticker) ? ' <span class="v3-log-tag">starred</span>' : '';
  return `
    <div class="v3-log-mover" onclick="v3Screen.openDetail('${escHtml(m.ticker)}')" role="button" tabindex="0">
      <span class="v3-log-ticker">${escHtml(m.ticker)}</span>
      <span class="v3-log-verb">${verb}</span>
      <span style="color:${RAG_COLORS[fromRag]};font-weight:600">${RAG_LABELS[fromRag]}</span>
      <span class="v3-log-arrow">→</span>
      <span style="color:${RAG_COLORS[toRag]};font-weight:600">${RAG_LABELS[toRag]}</span>${tag}
    </div>`;
}

let _briefingExpanded = false;

function renderBriefing() {
  const el = document.getElementById('v3-briefing');
  if (!el) return;

  let diff = null;
  try { diff = latestDiff(); } catch { /* no history */ }

  if (!diff || (!diff.risers.length && !diff.fallers.length) || isBriefingSeen(diff.id)) {
    el.innerHTML = '';
    el.style.display = 'none';
    return;
  }

  const owned   = _ownedTickers();
  const { watchlist = [] } = getState();
  const starred = new Set(watchlist.map(w => typeof w === 'string' ? w : w.ticker));

  // Priority: your holdings first, then starred, then biggest band jumps
  const weight = (m) => (owned.has(m.ticker) ? 200 : 0)
                      + (starred.has(m.ticker) ? 100 : 0)
                      + Math.abs(m.rankTo - m.rankFrom);
  const byPriority = (a, b) => weight(b) - weight(a);
  const risers  = [...diff.risers].sort(byPriority);
  const fallers = [...diff.fallers].sort(byPriority);

  const headline = [
    risers.length  ? `${risers.length} climbed a band`  : null,
    fallers.length ? `${fallers.length} slipped` : null,
  ].filter(Boolean).join(' · ');

  const top = [
    ...fallers.slice(0, 2).map(m => _moverLine(m, 'down', owned, starred)),
    ...risers.slice(0, 1).map(m => _moverLine(m, 'up', owned, starred)),
  ];
  const rest = [
    ...fallers.slice(2).map(m => _moverLine(m, 'down', owned, starred)),
    ...risers.slice(1).map(m => _moverLine(m, 'up', owned, starred)),
  ];

  el.innerHTML = `
    <div class="v3-log-card">
      <div class="v3-log-head">
        <div>
          <div class="v3-log-title">Since ${_briefingDate(diff.from)}</div>
          <div class="v3-log-sub">${headline}</div>
        </div>
        <button class="v3-log-dismiss" onclick="v3Screen.dismissBriefing()" aria-label="Dismiss briefing">✕</button>
      </div>
      <div class="v3-log-movers">${top.join('')}</div>
      ${rest.length ? `
        <div class="v3-log-movers" id="v3-log-more" style="display:${_briefingExpanded ? 'block' : 'none'}">${rest.join('')}</div>
        <button class="v3-log-expand" onclick="v3Screen.toggleBriefing()">${_briefingExpanded ? 'Show less' : `Show all ${rest.length + top.length} movers`}</button>
      ` : ''}
    </div>`;
  el.style.display = 'block';
}

export function dismissBriefing() {
  try {
    const diff = latestDiff();
    if (diff) markBriefingSeen(diff.id);
  } catch { /* no-op */ }
  renderBriefing();
}

export function toggleBriefing() {
  _briefingExpanded = !_briefingExpanded;
  renderBriefing();
}

// ---------------------------------------------------------------------------
// Detail sheet
// ---------------------------------------------------------------------------

let _lastRosePillars = null;   // previous stock's pillars — enables the morph

export function openDetail(ticker) {
  const result = _results.find(r => r.ticker === ticker);
  if (!result) return;
  const wasOpen     = _activeDetail != null;
  const morphFrom   = wasOpen ? _lastRosePillars : null;
  _activeDetail = ticker;

  const sheet    = document.getElementById('v3-detail-sheet');
  const overlay  = document.getElementById('v3-detail-overlay');
  if (!sheet) return;

  const color  = RAG_COLORS[result.rag] || '#6b7a90';
  const flags  = result.flags || [];
  const fired  = flags.filter(f => f.fired);

  const gaugeSize = Math.min(window.innerWidth - 64, 240);
  const hasPillars = result.pillars && Object.values(result.pillars).some(v => v != null);
  const navRows    = filteredSorted(_results);
  const canNav     = navRows.length > 1;

  sheet.innerHTML = `
    <div class="v3-sheet-handle"></div>
    <div class="v3-sheet-inner">

      <!-- Header -->
      <div class="v3-detail-header">
        <div>
          <div class="v3-detail-ticker">${escHtml(result.ticker)}</div>
          <div class="v3-detail-name">${escHtml(result.name || '')}</div>
          ${result.sector ? `<div class="v3-detail-sector">${escHtml(result.sector)}</div>` : ''}
        </div>
        <div class="v3-detail-star" onclick="v3Screen.toggleStar('${escHtml(ticker)}')">${isStarred(ticker) ? '★' : '☆'}</div>
      </div>

      <!-- Compass gauge -->
      <div class="v3-gauge-wrap" id="v3-gauge-container"></div>

      ${hasPillars ? `
      <!-- Compass rose — the five-pillar signature -->
      <div class="v3-section-title">Five Pillars <span class="v3-section-hint">vs S&amp;P 500 percentile</span></div>
      <div class="v3-rose-wrap" id="v3-rose-container"></div>
      ` : ''}

      ${result.criteria?.length ? `
      <!-- Classic 7 criteria (in-memory during a run session only) -->
      <div class="v3-section-title">Classic 7 Criteria</div>
      <div class="v3-criteria-list">
        ${result.criteria.map(c => `
          <div class="v3-crit-row">
            <span class="v3-crit-icon ${c.pass ? 'pass' : 'fail'}">${c.pass ? '✓' : '✗'}</span>
            <span class="v3-crit-label">${c.label}</span>
            <span class="v3-crit-val" style="color:${c.pass ? '#2ecc71' : '#f87171'}">${c.value != null ? (typeof c.value === 'number' ? c.value.toFixed(2) : c.value) : '—'}</span>
          </div>
        `).join('')}
      </div>` : ''}

      <!-- Red flags -->
      ${fired.length > 0 ? `
        <div class="v3-section-title" style="color:#f59e0b">⚠ Red Flags (${fired.length})</div>
        <div class="v3-flags-list">
          ${fired.map(f => `
            <div class="v3-flag-row">
              <span class="v3-flag-icon">🚩</span>
              <div>
                <div class="v3-flag-label">${f.label}</div>
                <div class="v3-flag-desc">${f.description}</div>
              </div>
            </div>
          `).join('')}
        </div>
      ` : `<div class="v3-no-flags">✓ No red flags detected</div>`}

      <!-- Price -->
      ${result.price ? `<div class="v3-detail-price">Current price: <strong>$${result.price.toFixed(2)}</strong></div>` : ''}

      ${canNav ? '<div class="v3-detail-nav-hint">‹ swipe for next stock ›</div>' : ''}
      <div style="height:32px"></div>
    </div>`;

  // Animate gauge + rose after DOM is ready
  requestAnimationFrame(() => {
    const gaugeContainer = document.getElementById('v3-gauge-container');
    if (gaugeContainer) {
      gaugeContainer.innerHTML = compassGaugeHTML(0, { size: gaugeSize });
      animateGauge(gaugeContainer, result.composite ?? 0, { size: gaugeSize });
    }
    const roseContainer = document.getElementById('v3-rose-container');
    if (roseContainer && hasPillars) {
      const roseSize = Math.min(window.innerWidth - 96, 220);
      roseContainer.innerHTML = roseHTML(morphFrom || result.pillars, { size: roseSize, color });
      animateRose(roseContainer, morphFrom, result.pillars, { size: roseSize, color });
    }
  });

  _lastRosePillars = hasPillars ? result.pillars : null;

  sheet.classList.add('open');
  if (overlay) overlay.style.display = 'block';
  document.body.style.overflow = 'hidden';
}

/**
 * Navigate to the previous/next stock in the current filter + sort order.
 * The rose morphs between companies; this is the flick-through interaction.
 * @param {1|-1} dir
 */
export function navigateDetail(dir) {
  if (_activeDetail == null) return;
  const rows = filteredSorted(_results);
  const idx  = rows.findIndex(r => r.ticker === _activeDetail);
  if (idx < 0) return;
  const next = rows[idx + dir];
  if (!next) return;

  // Quick slide of the content in the swipe direction
  const inner = document.querySelector('#v3-detail-sheet .v3-sheet-inner');
  if (inner && typeof inner.animate === 'function') {
    inner.animate(
      [{ opacity: 0.35, transform: `translateX(${dir * -14}px)` }, { opacity: 1, transform: 'translateX(0)' }],
      { duration: 180, easing: 'ease-out' }
    );
  }
  openDetail(next.ticker);
}

/** True when a screen detail is open and there is somewhere to navigate. */
export function canNavigateDetail() {
  return _activeDetail != null && filteredSorted(_results).length > 1;
}

export function closeDetail() {
  const sheet   = document.getElementById('v3-detail-sheet');
  const overlay = document.getElementById('v3-detail-overlay');
  if (sheet)   sheet.classList.remove('open');
  if (overlay) overlay.style.display = 'none';
  document.body.style.overflow = '';
  _activeDetail = null;
}

// ---------------------------------------------------------------------------
// Filter / sort controls
// ---------------------------------------------------------------------------

export function setFilter(f) {
  _filter = f;
  renderTable(_results);
  updateFilterChips(_results);
}

export function setSort(col) {
  if (_sort.col === col) {
    _sort.dir = _sort.dir === 'desc' ? 'asc' : 'desc';
  } else {
    _sort = { col, dir: 'desc' };
  }
  renderTable(_results);
}

// ---------------------------------------------------------------------------
// Init — load cached results and render
// ---------------------------------------------------------------------------

export function initScreen() {
  const { screenResults } = getState();

  if (screenResults?.results?.length) {
    _results = screenResults.results;
    renderTable(_results);
    renderDistBar(_results);
    updateFilterChips(_results);
    updateRunMeta(screenResults.scoredAt);
  }

  renderBriefing();

  // Re-render when watchlist changes
  subscribe((state, prev) => {
    if (state.watchlist !== prev.watchlist) {
      renderTable(_results);
      updateFilterChips(_results);
    }
  });
}

// Expose on window for HTML onclick handlers
window.v3Screen = {
  openDetail, closeDetail, toggleStar, setFilter, setSort, runScreen, stopScreen,
  navigateDetail, canNavigateDetail, dismissBriefing, toggleBriefing,
};
