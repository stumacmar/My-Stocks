/**
 * Score history — compact per-run snapshots that give the app memory.
 *
 * Each completed screen run appends one snapshot:
 *   { id, at: ISO, stocks: { TICKER: [score7, composite, q, v, g, s, m] } }
 *
 * Snapshot arrays use nulls for missing values. History is capped at
 * MAX_SNAPSHOTS (~150 KB total for a full S&P 500 universe), oldest dropped
 * first.
 *
 * The pure functions (makeSnapshot / appendSnapshot / diffSnapshots) have no
 * storage dependency and are unit-tested; the load/save/record wrappers touch
 * localStorage.
 */

import { KEYS } from './schema.js';

export const MAX_SNAPSHOTS = 8;

const PILLAR_ORDER = ['quality', 'value', 'growth', 'safety', 'momentum'];

// ---------------------------------------------------------------------------
// Pure core
// ---------------------------------------------------------------------------

/**
 * Build a snapshot from screen result rows.
 * @param {Array<{ticker, score7, composite, pillars?}>} rows
 * @param {string} at - ISO timestamp of the run
 */
export function makeSnapshot(rows, at) {
  const stocks = {};
  for (const r of rows || []) {
    if (!r?.ticker) continue;
    const p = r.pillars || {};
    stocks[r.ticker] = [
      r.score7    ?? null,
      r.composite ?? null,
      ...PILLAR_ORDER.map(id => p[id] ?? null),
    ];
  }
  return { id: `snap-${at}`, at, stocks };
}

/**
 * Append a snapshot, dropping the oldest beyond MAX_SNAPSHOTS.
 * Pure — returns a new array.
 */
export function appendSnapshot(history, snap) {
  const h = [...(history || []), snap];
  return h.length > MAX_SNAPSHOTS ? h.slice(h.length - MAX_SNAPSHOTS) : h;
}

/** Read one stock's pillar values back out of a snapshot row. */
export function snapshotPillars(row) {
  if (!Array.isArray(row)) return null;
  const out = {};
  PILLAR_ORDER.forEach((id, i) => { out[id] = row[2 + i] ?? null; });
  return out;
}

// Band rank for movement detection: higher = better band
function bandRank(score7) {
  if (score7 == null) return -1;
  if (score7 === 7)  return 3;  // hot
  if (score7 >= 6)   return 2;  // strong
  if (score7 >= 4)   return 1;  // watch
  return 0;                     // avoid
}

/**
 * Diff two snapshots. A stock "moves" when it crosses a RAG band boundary —
 * a 5→4 wobble inside Watch is noise; a 6→7 crossing into Hot is news.
 *
 * @returns {{ id, from, to, risers: Mover[], fallers: Mover[] }|null}
 *   Mover = { ticker, score7From, score7To, rankFrom, rankTo }
 */
export function diffSnapshots(prev, curr) {
  if (!prev?.stocks || !curr?.stocks) return null;

  const risers  = [];
  const fallers = [];

  for (const [ticker, currRow] of Object.entries(curr.stocks)) {
    const prevRow = prev.stocks[ticker];
    if (!prevRow) continue;
    const rankFrom = bandRank(prevRow[0]);
    const rankTo   = bandRank(currRow[0]);
    if (rankFrom < 0 || rankTo < 0 || rankFrom === rankTo) continue;

    const mover = {
      ticker,
      score7From: prevRow[0],
      score7To:   currRow[0],
      rankFrom,
      rankTo,
    };
    (rankTo > rankFrom ? risers : fallers).push(mover);
  }

  // Biggest moves first
  risers.sort((a, b)  => (b.rankTo - b.rankFrom) - (a.rankTo - a.rankFrom));
  fallers.sort((a, b) => (b.rankFrom - b.rankTo) - (a.rankFrom - a.rankTo));

  return {
    id:   `${prev.id}→${curr.id}`,
    from: prev.at,
    to:   curr.at,
    risers,
    fallers,
  };
}

// ---------------------------------------------------------------------------
// Storage wrappers
// ---------------------------------------------------------------------------

export function loadHistory() {
  try {
    const raw = localStorage.getItem(KEYS.SCORE_HISTORY);
    const h   = raw ? JSON.parse(raw) : [];
    return Array.isArray(h) ? h : [];
  } catch {
    return [];
  }
}

export function saveHistory(history) {
  try {
    localStorage.setItem(KEYS.SCORE_HISTORY, JSON.stringify(history));
  } catch {
    // Storage full — drop the oldest half and retry once
    try {
      const trimmed = history.slice(Math.ceil(history.length / 2));
      localStorage.setItem(KEYS.SCORE_HISTORY, JSON.stringify(trimmed));
    } catch { /* give up quietly — history is a luxury, not a requirement */ }
  }
}

/** Record a completed run. Returns the new snapshot. */
export function recordRun(rows, at = new Date().toISOString()) {
  const snap = makeSnapshot(rows, at);
  saveHistory(appendSnapshot(loadHistory(), snap));
  return snap;
}

/** Diff of the two most recent snapshots, or null if fewer than two runs. */
export function latestDiff() {
  const h = loadHistory();
  if (h.length < 2) return null;
  return diffSnapshots(h[h.length - 2], h[h.length - 1]);
}

/** Previous (second-most-recent) snapshot — used for sky drift trails. */
export function previousSnapshot() {
  const h = loadHistory();
  return h.length >= 2 ? h[h.length - 2] : null;
}

// ---------------------------------------------------------------------------
// Briefing dismissal
// ---------------------------------------------------------------------------

export function isBriefingSeen(diffId) {
  try { return localStorage.getItem(KEYS.BRIEFING_SEEN) === diffId; }
  catch { return false; }
}

export function markBriefingSeen(diffId) {
  try { localStorage.setItem(KEYS.BRIEFING_SEEN, diffId); } catch { /* no-op */ }
}
