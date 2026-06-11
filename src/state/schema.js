/**
 * Central registry of all localStorage keys and schema version.
 * Import KEYS everywhere — never hard-code key strings.
 */

export const CURRENT_SCHEMA = 1;

export const KEYS = Object.freeze({
  SCHEMA_VERSION:   'scV3.schemaVersion',
  API_KEY:          'scV3.apiKey',
  DISPLAY_CURRENCY: 'scV3.displayCurrency',
  FX:               'scV3.fx',
  PORTFOLIOS:       'scV3.portfolios',
  WATCHLIST:        'scV3.watchlist',
  SAVED_FILTERS:    'scV3.savedFilters',
  STOCK_CACHE:      'scV3.stockCache',
  SCREEN_RESULTS:   'scV3.screenResults',
  DAILY_CALL_LOG:   'scV3.dailyCallLog',
  ETF_PROXIES:      'scV3.etfProxies',
  SETTINGS:         'scV3.settings',
  LAST_STATE:       'scV3.lastState',
});

// V2 key prefixes — read-only during migration, never written
export const V2_PREFIXES = [
  'fmp_',
  'stock_cache_',
  'run_cache',
  'prev_run',
  'per_stock_cache',
  'portfolios',
  'watchlist',
  'compass_welcomed_v1',
  'candle_explained_v1',
];
