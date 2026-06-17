/**
 * Portfolio view — Phase 5.
 *
 * Renders the portfolio pane inside #v3-portfolio-pane.
 * Manages:
 *   - Portfolio tab selector (create / switch)
 *   - Household summary card (total value + return)
 *   - Holdings list (cards with return, score-at-entry vs now, review flag)
 *   - Add holding sheet
 *   - Holding detail sheet (score, return, delete)
 */

import { getState, dispatch, ACTIONS, subscribe } from '../state/store.js';
import {
  getPortfolios, createPortfolio, deletePortfolio, renamePortfolio,
  addHolding, removeHolding, holdingReturn, getHouseholdSummary,
} from '../portfolio/index.js';
import { ragFromScore7, RAG_LABELS, RAG_COLORS } from '../engine/rag.js';
import { compassGaugeHTML, animateGauge } from './gauge.js';

// ---------------------------------------------------------------------------
// XSS helper
// ---------------------------------------------------------------------------

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let _activeId   = null;  // active portfolio ID
let _quoteMap   = new Map();  // ticker → { price, score7, rag }
let _detailMeta = null;       // { portfolioId, holdingId } for open detail sheet

// ---------------------------------------------------------------------------
// Build quote/score map from cached screen results
// ---------------------------------------------------------------------------

function buildQuoteMap() {
  const { screenResults } = getState();
  const m = new Map();
  for (const r of (screenResults?.results || [])) {
    m.set(r.ticker, { price: r.price, score7: r.score7, rag: r.rag, composite: r.composite });
  }
  _quoteMap = m;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const CURRENCY_SYMBOLS = { GBP: '£', USD: '$' };

function fmtValue(v, currency) {
  if (v == null) return '—';
  const sym = CURRENCY_SYMBOLS[currency] || currency;
  if (Math.abs(v) >= 1_000_000) return `${sym}${(v / 1_000_000).toFixed(2)}M`;
  if (Math.abs(v) >= 1_000)     return `${sym}${(v / 1_000).toFixed(1)}k`;
  return `${sym}${v.toFixed(2)}`;
}

function fmtPct(pct) {
  if (pct == null) return '—';
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

function fmtDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' });
  } catch { return iso; }
}

function returnColor(pct) {
  if (pct == null) return 'var(--text-2)';
  return pct >= 0 ? 'var(--green)' : 'var(--red)';
}

// ---------------------------------------------------------------------------
// Score-change chip HTML
// ---------------------------------------------------------------------------

function scoreChangeChipHTML(entryScore, nowScore7) {
  const entryRag = ragFromScore7(entryScore);
  const nowRag   = ragFromScore7(nowScore7);

  const entryLabel = entryRag ? `${RAG_LABELS[entryRag]}` : '—';
  const nowLabel   = nowRag   ? `${RAG_LABELS[nowRag]}`   : '—';
  const entryColor = entryRag ? RAG_COLORS[entryRag]       : 'var(--text-2)';
  const nowColor   = nowRag   ? RAG_COLORS[nowRag]         : 'var(--text-2)';

  const review = (
    entryScore != null && nowScore7 != null &&
    nowScore7 < entryScore
  );

  const reviewChip = review
    ? `<span class="v3-review-chip">⚠ Review?</span>`
    : '';

  return `
    <div class="v3-score-change-chip">
      <span style="color:${entryColor};font-weight:600">entered ${entryLabel}</span>
      ${nowRag ? `<span class="v3-score-arrow">→</span><span style="color:${nowColor};font-weight:600">now ${nowLabel}</span>` : ''}
      ${reviewChip}
    </div>`;
}

// ---------------------------------------------------------------------------
// Holding card HTML
// ---------------------------------------------------------------------------

function holdingCardHTML(h, portfolioId, currency) {
  const { screenResults } = getState();
  const scoreNow   = _quoteMap.get(h.ticker);
  const nowScore7  = scoreNow?.score7 ?? null;
  const nowRag     = ragFromScore7(nowScore7);
  const nowColor   = nowRag ? RAG_COLORS[nowRag] : 'var(--text-2)';
  const fxObj      = getState().fx;
  const ret        = scoreNow?.price != null
    ? holdingReturn(h, scoreNow.price, fxObj, currency)
    : null;

  const pctColor   = returnColor(ret?.returnPct);
  const hasReview  = h.entryScore != null && nowScore7 != null && nowScore7 < h.entryScore;

  return `
    <div class="v3-holding-card${hasReview ? ' v3-holding-review' : ''}"
         style="border-left-color:${nowRag ? nowColor : 'var(--bg-4)'}"
         onclick="v3Portfolio.openHoldingDetail('${escHtml(portfolioId)}','${escHtml(h.id)}')"
         role="button" tabindex="0"
         onkeydown="if(event.key==='Enter')v3Portfolio.openHoldingDetail('${escHtml(portfolioId)}','${escHtml(h.id)}')">

      <div class="v3-holding-top">
        <div class="v3-holding-ticker-wrap">
          <span class="v3-holding-ticker">${escHtml(h.ticker)}</span>
          <span class="v3-holding-account-badge">${escHtml(h.accountType)}</span>
        </div>
        <div class="v3-holding-value-wrap">
          <span class="v3-holding-value">${fmtValue(ret?.value, currency)}</span>
          <span class="v3-holding-pct" style="color:${pctColor}">${fmtPct(ret?.returnPct)}</span>
        </div>
      </div>

      <div class="v3-holding-bottom">
        <div class="v3-holding-meta">
          ${h.name && h.name !== h.ticker ? `<span class="v3-holding-name">${escHtml(h.name)}</span> · ` : ''}
          <span>${h.shares} ${h.type === 'fund' || h.type === 'etf' ? 'units' : 'shares'}</span>
          · <span>entered ${fmtDate(h.entryDate)}</span>
        </div>
        ${h.entryScore != null || nowScore7 != null
          ? scoreChangeChipHTML(h.entryScore, nowScore7)
          : (ret == null ? '<div class="v3-no-data-hint">Run Screen for live data →</div>' : '')}
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Portfolio tabs HTML
// ---------------------------------------------------------------------------

function portfolioTabsHTML(portfolios, activeId) {
  const tabs = portfolios.map(p => `
    <button class="v3-portf-tab${p.id === activeId ? ' active' : ''}"
            onclick="v3Portfolio.switchPortfolio('${p.id}')">
      ${p.name}
    </button>`).join('');

  return `
    <div id="v3-portf-tabs">
      ${tabs}
      <button class="v3-portf-tab-add" onclick="v3Portfolio.promptCreatePortfolio()" title="Add portfolio">+</button>
    </div>`;
}

// ---------------------------------------------------------------------------
// Household summary card
// ---------------------------------------------------------------------------

function householdSummaryHTML(summary, currency) {
  const sym        = CURRENCY_SYMBOLS[currency] || currency;
  const pctColor   = returnColor(summary.returnPct);
  const hasData    = summary.pricedCount > 0;

  return `
    <div class="v3-household-card">
      <div class="v3-household-top">
        <div>
          <div class="v3-household-label">Total value</div>
          <div class="v3-household-value">${hasData ? fmtValue(summary.totalValue, currency) : '—'}</div>
        </div>
        <div style="text-align:right">
          <div class="v3-household-label">Return</div>
          <div class="v3-household-return" style="color:${hasData ? pctColor : 'var(--text-2)'}">
            ${hasData ? fmtPct(summary.returnPct) : '—'}
            ${hasData && summary.returnAbs != null ? `<span class="v3-household-abs">${fmtValue(summary.returnAbs, currency)}</span>` : ''}
          </div>
        </div>
      </div>
      <div class="v3-household-meta">
        ${summary.portfolioCount} portfolio${summary.portfolioCount !== 1 ? 's' : ''} ·
        ${summary.holdingCount} holding${summary.holdingCount !== 1 ? 's' : ''}
        ${!hasData && summary.holdingCount > 0 ? ' · <span style="color:var(--amber)">Run Screen for live data</span>' : ''}
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Main render
// ---------------------------------------------------------------------------

export function renderPortfolioView() {
  buildQuoteMap();
  const portfolios = getPortfolios();
  const pane       = document.getElementById('v3-portfolio-pane');
  if (!pane) return;

  // No portfolios — show empty state
  if (portfolios.length === 0) {
    pane.innerHTML = `
      <div class="v3-portf-empty">
        <div class="v3-portf-empty-icon">📊</div>
        <div class="v3-portf-empty-title">Track your holdings</div>
        <div class="v3-portf-empty-body">
          Add the stocks and funds you actually own — across as many accounts as you like.
          The app tracks them alongside the same signals as the screener.
        </div>
        <button class="v3-portf-create-btn" onclick="v3Portfolio.promptCreatePortfolio()">
          + Create portfolio
        </button>
      </div>`;
    updatePortfolioFAB(false);
    return;
  }

  // Ensure active portfolio is valid
  if (!_activeId || !portfolios.find(p => p.id === _activeId)) {
    _activeId = portfolios[0].id;
  }

  const active    = portfolios.find(p => p.id === _activeId);
  const currency  = getState().currency || 'GBP';
  const fxObj     = getState().fx;
  const summary   = getHouseholdSummary(_quoteMap, fxObj, currency);
  const holdings  = active?.holdings || [];

  // Sort holdings: priced ones by value desc, unpriced at end
  const sorted = [...holdings].sort((a, b) => {
    const ra = _quoteMap.get(a.ticker);
    const rb = _quoteMap.get(b.ticker);
    if (!ra?.price && !rb?.price) return 0;
    if (!ra?.price) return 1;
    if (!rb?.price) return -1;
    const retA = holdingReturn(a, ra.price, fxObj, currency);
    const retB = holdingReturn(b, rb.price, fxObj, currency);
    return (retB?.value ?? 0) - (retA?.value ?? 0);
  });

  const holdingsHTML = sorted.length > 0
    ? sorted.map(h => holdingCardHTML(h, _activeId, currency)).join('')
    : `<div class="v3-portf-holdings-empty">
        <div style="font-size:28px;margin-bottom:8px">📋</div>
        <div style="font-weight:600;color:var(--text-0);margin-bottom:6px">No holdings yet</div>
        <div style="color:var(--text-2);font-size:13px">Tap + Add Holding to get started.</div>
       </div>`;

  pane.innerHTML = `
    ${portfolioTabsHTML(portfolios, _activeId)}
    ${portfolios.length > 1 ? householdSummaryHTML(summary, currency) : ''}
    <div id="v3-portf-holdings">
      ${holdingsHTML}
    </div>
    <div style="height:96px"></div>`;

  updatePortfolioFAB(true);
}

// ---------------------------------------------------------------------------
// FAB visibility
// ---------------------------------------------------------------------------

function updatePortfolioFAB(show) {
  const fab = document.getElementById('v3-add-holding-fab');
  if (fab) fab.style.display = show ? 'flex' : 'none';
}

// ---------------------------------------------------------------------------
// Portfolio creation
// ---------------------------------------------------------------------------

export function promptCreatePortfolio() {
  const sheet   = document.getElementById('v3-create-portf-sheet');
  const overlay = document.getElementById('v3-create-portf-overlay');
  const input   = document.getElementById('v3-portf-name-input');
  if (sheet) { sheet.classList.add('open'); if (input) { input.value = ''; input.focus(); } }
  if (overlay) overlay.style.display = 'block';
  document.body.style.overflow = 'hidden';
}

export function closeCreatePortfolio() {
  document.getElementById('v3-create-portf-sheet')?.classList.remove('open');
  const overlay = document.getElementById('v3-create-portf-overlay');
  if (overlay) overlay.style.display = 'none';
  document.body.style.overflow = '';
}

export function submitCreatePortfolio() {
  const name = document.getElementById('v3-portf-name-input')?.value.trim();
  if (!name) return;
  const p = createPortfolio(name);
  _activeId = p.id;
  closeCreatePortfolio();
  renderPortfolioView();
}

// ---------------------------------------------------------------------------
// Portfolio switch / delete
// ---------------------------------------------------------------------------

export function switchPortfolio(id) {
  _activeId = id;
  renderPortfolioView();
}

export function deleteActivePortfolio() {
  if (!_activeId) return;
  const name = getPortfolios().find(p => p.id === _activeId)?.name || 'this portfolio';
  if (!confirm(`Delete "${name}" and all its holdings? This cannot be undone.`)) return;
  deletePortfolio(_activeId);
  _activeId = null;
  renderPortfolioView();
}

// ---------------------------------------------------------------------------
// Add holding sheet
// ---------------------------------------------------------------------------

export function openAddHolding() {
  const sheet   = document.getElementById('v3-add-holding-sheet');
  const overlay = document.getElementById('v3-add-holding-overlay');
  if (!sheet) return;

  // Reset form
  ['v3-ah-ticker','v3-ah-shares','v3-ah-price','v3-ah-date','v3-ah-notes'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  document.getElementById('v3-ah-date').value = new Date().toISOString().slice(0, 10);
  document.getElementById('v3-ah-score-preview').textContent = '';
  document.getElementById('v3-ah-error').textContent = '';

  sheet.classList.add('open');
  if (overlay) overlay.style.display = 'block';
  document.body.style.overflow = 'hidden';
  document.getElementById('v3-ah-ticker')?.focus();
}

export function closeAddHolding() {
  document.getElementById('v3-add-holding-sheet')?.classList.remove('open');
  const overlay = document.getElementById('v3-add-holding-overlay');
  if (overlay) overlay.style.display = 'none';
  document.body.style.overflow = '';
}

// Live score preview when ticker is typed
export function tickerInputChanged(val) {
  const ticker  = val.toUpperCase().trim();
  const preview = document.getElementById('v3-ah-score-preview');
  if (!preview) return;
  const score   = _quoteMap.get(ticker);
  if (score?.score7 != null) {
    const rag   = ragFromScore7(score.score7);
    const color = RAG_COLORS[rag];
    const label = RAG_LABELS[rag];
    preview.innerHTML = `Current score: <strong style="color:${color}">${label} (${score.score7}/7)</strong> — will be stored as entry score`;
  } else {
    preview.textContent = ticker ? 'Not in screen results — run Screen first to capture score' : '';
  }
}

export function submitAddHolding() {
  const ticker  = document.getElementById('v3-ah-ticker')?.value.toUpperCase().trim();
  const shares  = parseFloat(document.getElementById('v3-ah-shares')?.value);
  const price   = parseFloat(document.getElementById('v3-ah-price')?.value);
  const date    = document.getElementById('v3-ah-date')?.value;
  const cur     = document.getElementById('v3-ah-currency')?.value || 'USD';
  const account = document.getElementById('v3-ah-account')?.value || 'GIA';
  const notes   = document.getElementById('v3-ah-notes')?.value.trim();
  const errEl   = document.getElementById('v3-ah-error');

  if (!ticker) { if (errEl) errEl.textContent = 'Ticker is required.'; return; }
  if (!shares || shares <= 0) { if (errEl) errEl.textContent = 'Enter a valid number of shares.'; return; }
  if (!price  || price  <= 0) { if (errEl) errEl.textContent = 'Enter a valid entry price.'; return; }
  if (errEl) errEl.textContent = '';

  // Capture current score from screen results as entry score
  const scoreNow  = _quoteMap.get(ticker);
  const entryScore = scoreNow?.score7 ?? null;
  const name       = scoreNow ? (getState().screenResults?.results?.find(r => r.ticker === ticker)?.name || ticker) : ticker;

  // Detect type: if ticker ends in common ETF/fund patterns, mark as etf
  const type = /\.(L|AS|PA|DE|IR)$/.test(ticker) ? 'fund'
             : /(ETF|ETC|IT|TRUST)$/i.test(ticker) ? 'etf'
             : 'stock';

  if (!_activeId) {
    const portfolios = getPortfolios();
    if (portfolios.length === 0) { if (errEl) errEl.textContent = 'Create a portfolio first.'; return; }
    _activeId = portfolios[0].id;
  }

  addHolding(_activeId, { ticker, name, type, shares, entryPrice: price, entryCurrency: cur, entryDate: date, entryScore, accountType: account, notes });
  closeAddHolding();
  renderPortfolioView();
}

// ---------------------------------------------------------------------------
// Holding detail sheet
// ---------------------------------------------------------------------------

export function openHoldingDetail(portfolioId, holdingId) {
  const portfolios = getPortfolios();
  const portfolio  = portfolios.find(p => p.id === portfolioId);
  const h          = portfolio?.holdings?.find(h => h.id === holdingId);
  if (!h) return;

  _detailMeta = { portfolioId, holdingId };

  const currency   = getState().currency || 'GBP';
  const fxObj      = getState().fx;
  const scoreNow   = _quoteMap.get(h.ticker);
  const ret        = scoreNow?.price != null ? holdingReturn(h, scoreNow.price, fxObj, currency) : null;
  const nowScore7  = scoreNow?.score7 ?? null;
  const pctColor   = returnColor(ret?.returnPct);
  const gaugeScore = scoreNow?.composite ?? (nowScore7 != null ? Math.round((nowScore7 / 7) * 100) : null);

  const sheet   = document.getElementById('v3-detail-sheet');
  const overlay = document.getElementById('v3-detail-overlay');
  if (!sheet) return;

  sheet.innerHTML = `
    <div class="v3-sheet-handle"></div>
    <div class="v3-sheet-inner">

      <div class="v3-detail-header">
        <div>
          <div class="v3-detail-ticker">${escHtml(h.ticker)}</div>
          <div class="v3-detail-name">${h.name !== h.ticker ? escHtml(h.name) : ''}</div>
          <div class="v3-detail-sector">${escHtml(h.accountType)} · ${escHtml(portfolio.name)}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:22px;font-weight:700;color:${pctColor}">${fmtValue(ret?.value, currency)}</div>
          <div style="font-size:14px;font-weight:600;color:${pctColor}">${fmtPct(ret?.returnPct)}</div>
        </div>
      </div>

      <!-- Compass gauge -->
      <div class="v3-gauge-wrap" id="v3-gauge-container"></div>

      <!-- Score change -->
      <div class="v3-section-title">Score tracker</div>
      <div style="padding:12px;background:var(--bg-2);border-radius:10px;margin-bottom:2px">
        ${h.entryScore != null || nowScore7 != null
          ? scoreChangeChipHTML(h.entryScore, nowScore7)
          : '<div style="color:var(--text-2);font-size:13px">Run Screen to see current score</div>'}
        <div style="font-size:12px;color:var(--text-2);margin-top:6px">
          ${h.shares} shares · entered ${fmtDate(h.entryDate)} at ${CURRENCY_SYMBOLS[h.entryCurrency] || h.entryCurrency}${h.entryPrice.toFixed(2)}
        </div>
        ${ret ? `<div style="font-size:12px;color:var(--text-2);margin-top:2px">
          Cost basis: ${fmtValue(ret.costBasis, currency)} · P&amp;L: <span style="color:${pctColor}">${fmtValue(ret.returnAbs, currency)}</span>
        </div>` : ''}
      </div>

      ${h.notes ? `<div class="v3-section-title">Notes</div>
        <div style="font-size:13px;color:var(--text-1);padding:10px;background:var(--bg-2);border-radius:8px">${escHtml(h.notes)}</div>` : ''}

      <!-- Delete button -->
      <div style="margin-top:28px">
        <button class="v3-delete-btn" onclick="v3Portfolio.removeHoldingConfirm('${portfolioId}','${holdingId}')">
          Remove holding
        </button>
      </div>
      <div style="height:24px"></div>
    </div>`;

  // Animate gauge
  const gaugeSize = Math.min(window.innerWidth - 64, 240);
  requestAnimationFrame(() => {
    const gc = document.getElementById('v3-gauge-container');
    if (gc && gaugeScore != null) {
      gc.innerHTML = compassGaugeHTML(0, { size: gaugeSize });
      animateGauge(gc, gaugeScore, { size: gaugeSize });
    } else if (gc) {
      gc.innerHTML = compassGaugeHTML(null, { size: gaugeSize });
    }
  });

  sheet.classList.add('open');
  // Move focus into the sheet for keyboard and screen-reader users
  requestAnimationFrame(() => {
    const firstFocusable = sheet.querySelector('button, [href], input, [tabindex]:not([tabindex="-1"])');
    firstFocusable?.focus();
  });
  if (overlay) overlay.style.display = 'block';
  document.body.style.overflow = 'hidden';
}

export function removeHoldingConfirm(portfolioId, holdingId) {
  const portfolio = getPortfolios().find(p => p.id === portfolioId);
  const h         = portfolio?.holdings?.find(h => h.id === holdingId);
  if (!h) return;
  if (!confirm(`Remove ${h.ticker} from ${portfolio.name}?`)) return;

  // Close detail sheet
  document.getElementById('v3-detail-sheet')?.classList.remove('open');
  document.getElementById('v3-detail-overlay').style.display = 'none';
  document.body.style.overflow = '';

  removeHolding(portfolioId, holdingId);
  renderPortfolioView();
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export function initPortfolio() {
  buildQuoteMap();
  renderPortfolioView();

  // Re-render when store changes (new screen results, watchlist, currency, portfolios)
  subscribe((state, prev) => {
    if (
      state.portfolios    !== prev.portfolios    ||
      state.screenResults !== prev.screenResults ||
      state.currency      !== prev.currency      ||
      state.fx            !== prev.fx
    ) {
      buildQuoteMap();
      const pane = document.getElementById('v3-portfolio-pane');
      if (pane && pane.style.display !== 'none') {
        renderPortfolioView();
      }
    }
  });
}

// Expose on window for HTML onclick handlers
window.v3Portfolio = {
  switchPortfolio,
  promptCreatePortfolio,
  closeCreatePortfolio,
  submitCreatePortfolio,
  deleteActivePortfolio,
  openAddHolding,
  closeAddHolding,
  tickerInputChanged,
  submitAddHolding,
  openHoldingDetail,
  removeHoldingConfirm,
};
