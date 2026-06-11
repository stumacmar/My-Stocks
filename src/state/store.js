/**
 * Central application store.
 *
 * Lightweight pub/sub pattern — no framework dependency.
 * All async side-effects (API calls, cache writes) happen in action handlers,
 * not inside dispatch itself.
 */

import { KEYS } from './schema.js';

// ---------------------------------------------------------------------------
// Action type constants
// ---------------------------------------------------------------------------

export const ACTIONS = Object.freeze({
  SET_API_KEY:        'SET_API_KEY',
  SET_CURRENCY:       'SET_CURRENCY',
  SET_FX:             'SET_FX',
  SET_PORTFOLIOS:     'SET_PORTFOLIOS',
  SET_WATCHLIST:      'SET_WATCHLIST',
  SET_SAVED_FILTERS:  'SET_SAVED_FILTERS',
  SET_STOCK_CACHE:    'SET_STOCK_CACHE',
  SET_SCREEN_RESULTS: 'SET_SCREEN_RESULTS',
  SET_ETF_PROXIES:    'SET_ETF_PROXIES',
  SET_SETTINGS:       'SET_SETTINGS',
  SET_LAST_STATE:     'SET_LAST_STATE',
  PATCH_SETTINGS:     'PATCH_SETTINGS',
});

// ---------------------------------------------------------------------------
// Initial state (loaded from localStorage on first import)
// ---------------------------------------------------------------------------

function readJSON(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function makeInitialState() {
  return {
    apiKey:         localStorage.getItem(KEYS.API_KEY) || '',
    currency:       localStorage.getItem(KEYS.DISPLAY_CURRENCY) || 'GBP',
    fx:             readJSON(KEYS.FX, null),
    portfolios:     readJSON(KEYS.PORTFOLIOS, []),
    watchlist:      readJSON(KEYS.WATCHLIST, []),
    savedFilters:   readJSON(KEYS.SAVED_FILTERS, []),
    stockCache:     readJSON(KEYS.STOCK_CACHE, {}),
    screenResults:  readJSON(KEYS.SCREEN_RESULTS, null),
    etfProxies:     readJSON(KEYS.ETF_PROXIES, {}),
    settings:       readJSON(KEYS.SETTINGS, {
      scoringPreset:  'BALANCED',
      sectorRelative: false,
      benchmarkTicker: 'SPY',
      dcfWacc:        null,  // user must set
      dcfGrowthRate:  null,  // user must set
      dcfTerminalRate: null, // user must set
      allocationTargets: null, // user must set
    }),
    lastState:      readJSON(KEYS.LAST_STATE, { view: 'screen', filter: 'all' }),
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

let _state = makeInitialState();
const _listeners = new Set();

/**
 * Return a shallow copy of the current state.
 * Do not mutate the returned object.
 */
export function getState() {
  return { ..._state };
}

/**
 * Subscribe to state changes. Returns an unsubscribe function.
 */
export function subscribe(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

function _notify(prevState) {
  for (const fn of _listeners) {
    try { fn(_state, prevState); } catch (e) { console.error('[store] listener error', e); }
  }
}

function _persist(key, value) {
  try {
    if (value === null || value === undefined) {
      localStorage.removeItem(key);
    } else if (typeof value === 'string') {
      localStorage.setItem(key, value);
    } else {
      localStorage.setItem(key, JSON.stringify(value));
    }
  } catch (e) {
    console.warn('[store] persist failed:', key, e);
  }
}

/**
 * Dispatch an action to update state.
 * Actions are processed synchronously.
 */
export function dispatch(action, payload) {
  const prev = _state;

  switch (action) {
    case ACTIONS.SET_API_KEY:
      _state = { ..._state, apiKey: payload };
      _persist(KEYS.API_KEY, payload);
      break;

    case ACTIONS.SET_CURRENCY:
      _state = { ..._state, currency: payload };
      _persist(KEYS.DISPLAY_CURRENCY, payload);
      break;

    case ACTIONS.SET_FX:
      _state = { ..._state, fx: payload };
      _persist(KEYS.FX, payload);
      break;

    case ACTIONS.SET_PORTFOLIOS:
      _state = { ..._state, portfolios: payload };
      _persist(KEYS.PORTFOLIOS, payload);
      break;

    case ACTIONS.SET_WATCHLIST:
      _state = { ..._state, watchlist: payload };
      _persist(KEYS.WATCHLIST, payload);
      break;

    case ACTIONS.SET_SAVED_FILTERS:
      _state = { ..._state, savedFilters: payload };
      _persist(KEYS.SAVED_FILTERS, payload);
      break;

    case ACTIONS.SET_STOCK_CACHE:
      _state = { ..._state, stockCache: payload };
      _persist(KEYS.STOCK_CACHE, payload);
      break;

    case ACTIONS.SET_SCREEN_RESULTS:
      _state = { ..._state, screenResults: payload };
      _persist(KEYS.SCREEN_RESULTS, payload);
      break;

    case ACTIONS.SET_ETF_PROXIES:
      _state = { ..._state, etfProxies: payload };
      _persist(KEYS.ETF_PROXIES, payload);
      break;

    case ACTIONS.SET_SETTINGS:
      _state = { ..._state, settings: payload };
      _persist(KEYS.SETTINGS, payload);
      break;

    case ACTIONS.PATCH_SETTINGS:
      _state = { ..._state, settings: { ..._state.settings, ...payload } };
      _persist(KEYS.SETTINGS, _state.settings);
      break;

    case ACTIONS.SET_LAST_STATE:
      _state = { ..._state, lastState: payload };
      _persist(KEYS.LAST_STATE, payload);
      break;

    default:
      console.warn('[store] unknown action:', action);
      return;
  }

  _notify(prev);
}
