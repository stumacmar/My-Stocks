/**
 * Stock Compass V3 — application entry point.
 * Imported by v3.html via <script type="module">.
 *
 * Boot sequence:
 *   1. Run V2 → V3 data migration (idempotent, no-op if already done)
 *   2. Load state from localStorage into the central store
 *   3. Initialise UI views
 *   4. Restore last view state (screen / portfolio)
 */

import { runMigrationIfNeeded } from './state/migration.js';
import { getState, subscribe, dispatch, ACTIONS } from './state/store.js';

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  // Step 1 — migration
  const migrated = runMigrationIfNeeded({ offerBackupDownload: true });
  if (migrated) {
    console.info('[V3] migrated from V2 data');
  }

  // Step 2 — restore last view state
  const { lastState, apiKey } = getState();

  // Step 3 — if no API key, show the API key setup prompt
  if (!apiKey) {
    showApiKeyPrompt();
    return;
  }

  // Step 4 — route to last view
  const view = lastState?.view || 'screen';
  switchView(view);
}

// ---------------------------------------------------------------------------
// View routing (stubs — replaced by full UI in Phase 4+)
// ---------------------------------------------------------------------------

function switchView(view) {
  const state = getState();
  dispatch(ACTIONS.SET_LAST_STATE, { ...state.lastState, view });

  const screenPane    = document.getElementById('v3-screen-pane');
  const portfolioPane = document.getElementById('v3-portfolio-pane');

  if (screenPane)    screenPane.style.display    = view === 'screen'    ? '' : 'none';
  if (portfolioPane) portfolioPane.style.display = view === 'portfolio' ? '' : 'none';

  document.querySelectorAll('[data-v3-tab]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.v3Tab === view);
  });
}

function showApiKeyPrompt() {
  const el = document.getElementById('v3-api-key-prompt');
  if (el) el.style.display = '';
}

// ---------------------------------------------------------------------------
// Global UI event wiring
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  // Tab navigation
  document.querySelectorAll('[data-v3-tab]').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.v3Tab));
  });

  // API key form
  const apiKeyForm = document.getElementById('v3-api-key-form');
  if (apiKeyForm) {
    apiKeyForm.addEventListener('submit', e => {
      e.preventDefault();
      const input = document.getElementById('v3-api-key-input');
      const key = input?.value.trim();
      if (key) {
        dispatch(ACTIONS.SET_API_KEY, key);
        document.getElementById('v3-api-key-prompt').style.display = 'none';
        switchView('screen');
      }
    });
  }

  boot();
});

// Export helpers for console/debug use
window._v3 = { getState, dispatch, ACTIONS };
