/**
 * Daily FMP API call budget tracker.
 *
 * Stored in localStorage as scV3.dailyCallLog:
 *   [ { date: 'YYYY-MM-DD', count: number }, ... ]
 *
 * Keeps only the last 30 days of entries to bound storage growth.
 */

import { KEYS } from '../state/schema.js';

const MAX_HISTORY_DAYS = 30;

// Default daily budget. FMP Starter tier = 750 calls/day.
export const DEFAULT_DAILY_LIMIT = 750;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function todayStr() {
  return new Date().toISOString().slice(0, 10);  // 'YYYY-MM-DD'
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
  // Trim to last MAX_HISTORY_DAYS entries
  const trimmed = log.slice(-MAX_HISTORY_DAYS);
  try {
    localStorage.setItem(KEYS.DAILY_CALL_LOG, JSON.stringify(trimmed));
  } catch {
    // storage full — not fatal
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record n API calls made now.
 */
export function recordCalls(n = 1) {
  if (n <= 0) return;
  const log  = readLog();
  const today = todayStr();
  const entry = log.find(e => e.date === today);
  if (entry) {
    entry.count += n;
  } else {
    log.push({ date: today, count: n });
  }
  writeLog(log);
}

/**
 * Return the number of calls made today.
 */
export function getCallsToday() {
  const log = readLog();
  const entry = log.find(e => e.date === todayStr());
  return entry ? entry.count : 0;
}

/**
 * Return remaining budget for today.
 */
export function getRemainingBudget(limit = DEFAULT_DAILY_LIMIT) {
  return Math.max(0, limit - getCallsToday());
}

/**
 * Return true if adding n calls would exceed the daily limit.
 */
export function wouldExceedBudget(n = 1, limit = DEFAULT_DAILY_LIMIT) {
  return getCallsToday() + n > limit;
}

/**
 * Return the full call log (array of { date, count }).
 */
export function getCallLog() {
  return readLog();
}

/**
 * Summarise the last N days: [ { date, count, overLimit } ]
 */
export function getSummary(days = 7, limit = DEFAULT_DAILY_LIMIT) {
  const log   = readLog();
  const today = todayStr();
  const results = [];

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
    const entry = log.find(e => e.date === d);
    results.push({
      date:     d,
      count:    entry ? entry.count : 0,
      overLimit: entry ? entry.count > limit : false,
      isToday:  d === today,
    });
  }
  return results;
}

/**
 * Reset today's counter. Useful in tests or manual override.
 */
export function resetToday() {
  const log = readLog().filter(e => e.date !== todayStr());
  writeLog(log);
}
