/**
 * localStorage cache with TTL and LRU eviction.
 *
 * Each entry: { v, fetchedAt: ISO, ttl: ms, accessedAt: epoch ms }
 * Entire cache lives under one localStorage key (KEYS.STOCK_CACHE).
 *
 * LRU note: accessedAt is updated on set(), not on get(), to avoid
 * triggering a full serialise/deserialise/write cycle on every read.
 */

import { KEYS } from '../state/schema.js';
import { dispatch, ACTIONS, getState } from '../state/store.js';

export const TTL = Object.freeze({
  PROFILE:       7  * 24 * 60 * 60 * 1000,
  FUNDAMENTALS:  24 * 60 * 60 * 1000,
  QUOTE_MARKET:  15 * 60 * 1000,
  QUOTE_CLOSED:  4  * 60 * 60 * 1000,
  FX:             1 * 60 * 60 * 1000,
  ETF_PROXY:     24 * 60 * 60 * 1000,
});

const MAX_SIZE_BYTES = 4.5 * 1024 * 1024;
const EVICT_TARGET   = 4.0 * 1024 * 1024;

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
  return JSON.stringify(cache).length * 2;
}

function _evictLRU(cache, targetBytes) {
  const entries = Object.entries(cache);
  entries.sort((a, b) => (a[1].accessedAt || 0) - (b[1].accessedAt || 0));

  // Track size incrementally to avoid O(n²) full-serialise per eviction
  let approxSize = _approxSize(cache);
  for (const [key, entry] of entries) {
    if (approxSize <= targetBytes) break;
    approxSize -= JSON.stringify(entry).length * 2;
    delete cache[key];
  }
}

export function get(key) {
  const cache = _loadCache();
  const entry = cache[key];
  if (!entry) return null;
  const { v, fetchedAt, ttl } = entry;
  if (!fetchedAt || !ttl) return null;
  const age = Date.now() - new Date(fetchedAt).getTime();
  if (age > ttl) return null;
  // No flush on read — accessedAt stays as set-time; avoids write-on-every-read
  return v;
}

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

export function invalidate(key) {
  const cache = _loadCache();
  delete cache[key];
  _flush(cache);
}

export function clearAll() {
  _flush({});
}

export function isStale(key) {
  return get(key) === null;
}

export function getFreshness(key) {
  const cache = _loadCache();
  const entry = cache[key];
  if (!entry || !entry.fetchedAt) {
    return { fetchedAt: null, age: null, ttl: null, fresh: false };
  }
  const age = Date.now() - new Date(entry.fetchedAt).getTime();
  return { fetchedAt: entry.fetchedAt, age, ttl: entry.ttl, fresh: age <= entry.ttl };
}

export function staleKeys(keys) {
  const cache = _loadCache();
  const now = Date.now();
  return keys.filter(k => {
    const e = cache[k];
    if (!e?.fetchedAt || !e.ttl) return true;
    return now - new Date(e.fetchedAt).getTime() > e.ttl;
  });
}

export function sizeBytes() {
  return _approxSize(_loadCache());
}
