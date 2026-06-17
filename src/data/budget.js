/**
 * Daily FMP API call budget tracker.
 * Uses an in-memory counter (initialised from localStorage on first use,
 * reset on day boundary) so that concurrent pre-call checks within a
 * single event loop tick see the correct running total.
 */

import { KEYS } from '../state/schema.js';

const MAX_HISTORY_DAYS = 30;
export const DEFAULT_DAILY_LIMIT = 750;

// In-memory state — avoids localStorage race between concurrent checks
let _day   = null;   // 'YYYY-MM-DD' for the loaded day
let _count = 0;      // calls made today (in-memory)

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function readLog() {
  try {
    const raw = localStorage.getItem(KEYS.DAILY_CALL_LOG);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeLog(log) {
  try {
    localStorage.setItem(KEYS.DAILY_CALL_LOG, JSON.stringify(log.slice(-MAX_HISTORY_DAYS)));
  } catch { /* storage full — not fatal */ }
}

function _ensureLoaded() {
  const today = todayStr();
  if (_day !== today) {
    const log   = readLog();
    const entry = log.find(e => e.date === today);
    _count = entry ? entry.count : 0;
    _day   = today;
  }
}

function _persist() {
  const log   = readLog();
  const today = todayStr();
  const entry = log.find(e => e.date === today);
  if (entry) entry.count = _count;
  else log.push({ date: today, count: _count });
  writeLog(log);
}

export function recordCalls(n = 1) {
  if (n <= 0) return;
  _ensureLoaded();
  _count += n;
  _persist();
}

export function getCallsToday() {
  _ensureLoaded();
  return _count;
}

export function getRemainingBudget(limit = DEFAULT_DAILY_LIMIT) {
  return Math.max(0, limit - getCallsToday());
}

export function wouldExceedBudget(n = 1, limit = DEFAULT_DAILY_LIMIT) {
  return getCallsToday() + n > limit;
}

export function getCallLog() {
  return readLog();
}

export function getSummary(days = 7, limit = DEFAULT_DAILY_LIMIT) {
  const log   = readLog();
  const today = todayStr();
  const results = [];
  for (let i = days - 1; i >= 0; i--) {
    const d     = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    const entry = log.find(e => e.date === d);
    results.push({ date: d, count: entry ? entry.count : 0, overLimit: entry ? entry.count > limit : false, isToday: d === today });
  }
  return results;
}

export function resetToday() {
  _ensureLoaded();
  _count = 0;
  _persist();
}
