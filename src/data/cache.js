/**
 * localStorage cache with TTL and LRU eviction.
 *
 * Each entry is stored as:
 *   { v: <data>, fetchedAt: ISO string, ttl: ms, accessedAt: epoch ms }
 *
 * The entire cache lives under a single localStorage key (KEYS.STOCK_CACHE)
 * loaded once into memory, flushed on every write.
 *
 * MAX_SIZE (4.5 MB) is an approximate guard — eviction is triggered before
 * any write that would exceed it.
 */

import { KEYS } from '../state/schema.js';
import { dispatch, ACTIONS, getState } from '../state/store.js';

// ---------------------------------------------------------------------------
// TTL presets (milliseconds)
// ---------------------------------------------------------------------------

export const TTL = Object.freeze({
  PROFILE:       7  * 24 * 60 * 60 * 1000,  //  7 days
  FUNDAMENTALS:  24 * 60 * 60 * 1000,        // 24 hours
  QUOTE_MARKET:  15 * 60 * 1000,             // 15 minutes (market hours)
  QUOTE_CLOSED:  4  * 60 * 60 * 1000,        //  4 hours (market closed)
  FX:             1 * 60 * 60 * 1000,        //  1 hour
  ETF_PROXY:     24 * 60 * 60 * 1000,        // 24 hours
});

const MAX_SIZE_BYTES = 4.5 * 1024 * 1024;  // 4.5 MB
const EVICT_TARGET   = 4.0 * 1024 * 1024;  // evict until under 4.0 MB

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _loadCache() {
  try {
    const raw = localStorage.getItem(KEYS.STOCK_CACHE);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function _flush(cache) {
  dispatch(ACTIONS.SET_STOCK_CACHE, cache);
}

function _approxSize(cache) {
  return JSON.stringify(cache).length * 2;  // UTF-16 bytes approx
}

function _evictLRU(cache, targetBytes) {
  const entries = Object.entries(cache);
  // Sort by accessedAt ascending (oldest first)
  entries.sort((a, b) => (a[1].accessedAt || 0) - (b[1].accessedAt || 0));

  let removed = 0;
  for (const [key] of entries) {
    if (_approxSize(cache) <= targetBytes) break;
    delete cache[key];
    removed++;
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read a cached entry. Returns null if absent, expired, or corrupt.
 * Updates accessedAt to implement LRU tracking.
 */
export function get(key) {
  const cache = _loadCache();
  const entry = cache[key];
  if (!entry) return null;

  const { v, fetchedAt, ttl } = entry;
  if (!fetchedAt || !ttl) return null;

  const age = Date.now() - new Date(fetchedAt).getTime();
  if (age > ttl) return null;

  // Touch accessedAt for LRU
  cache[key] = { ...entry, accessedAt: Date.now() };
  _flush(cache);
  return v;
}

/**
 * Write an entry. ttlMs defaults to TTL.FUNDAMENTALS (24h).
 * Evicts LRU entries if the cache exceeds MAX_SIZE_BYTES.
 */
export function set(key, value, ttlMs = TTL.FUNDAMENTALS) {
  const cache = _loadCache();
  cache[key] = {
    v:          value,
    fetchedAt:  new Date().toISOString(),
    ttl:        ttlMs,
    accessedAt: Date.now(),
  };

  if (_approxSize(cache) > MAX_SIZE_BYTES) {
    _evictLRU(cache, EVICT_TARGET);
  }

  _flush(cache);
}

/**
 * Remove a single key.
 */
export function invalidate(key) {
  const cache = _loadCache();
  delete cache[key];
  _flush(cache);
}

/**
 * Clear all cached entries.
 */
export function clearAll() {
  _flush({});
}

/**
 * Returns true if the key is absent or expired.
 */
export function isStale(key) {
  return get(key) === null;
}

/**
 * Returns { fetchedAt: ISO|null, age: ms|null, ttl: ms|null, fresh: bool }.
 */
export function getFreshness(key) {
  const cache = _loadCache();
  const entry = cache[key];
  if (!entry || !entry.fetchedAt) {
    return { fetchedAt: null, age: null, ttl: null, fresh: false };
  }
  const age = Date.now() - new Date(entry.fetchedAt).getTime();
  return {
    fetchedAt: entry.fetchedAt,
    age,
    ttl:   entry.ttl,
    fresh: age <= entry.ttl,
  };
}

/**
 * Return all keys that are currently stale (expired or missing).
 */
export function staleKeys(keys) {
  return keys.filter(k => isStale(k));
}

/**
 * Approximate current cache size in bytes.
 */
export function sizeBytes() {
  return _approxSize(_loadCache());
}
