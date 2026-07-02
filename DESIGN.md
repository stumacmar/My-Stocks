# V4 — The Observatory

Concept brief for the V4 release of Stuart's Stock Compass. This documents the
ideas generated, the ones killed and why, and how the survivors compose.

## The core insight

V3 shipped a five-pillar percentile engine (quality / value / growth / safety /
momentum — 18 metrics, ranked against the full S&P 500) and then never showed
it to anyone. The screen view renders one number per stock. That's like
building a telescope and using it as a paperweight.

Five continuous dimensions per stock is not a scoring detail — it's a *space*.
Stocks have positions in it. Positions imply neighbourhoods, distances,
movement over time. V4's job is to make that space visible, tactile, and
personal.

A compass navigates by the stars. So does this app now.

## Ideas generated (and what died)

| # | Idea | Verdict |
|---|------|---------|
| 1 | **Star chart** — the S&P 500 as a navigable night sky, each stock a star positioned by two pillars | **BUILD** — the flagship |
| 2 | **Compass rose** — five-axis signature per stock, morphing as you swipe between stocks | **BUILD** — gives every stock a face |
| 3 | **The Log** — "since your last reading" briefing that tells you what changed as prose, holdings first | **BUILD** — gives the app memory |
| 4 | Pull-to-scan physics on refresh | KILLED — a full run takes ~30 min; dressing that gesture up is a lie |
| 5 | Score sparklines per row | KILLED as standalone — derivative; trajectory lives in the Log and star trails instead |
| 6 | Sector heat treemap | KILLED — Finviz shipped this in 2007 |
| 7 | Thesis-health ring on holding cards | KILLED — a worse duplicate of the review chip |
| 8 | Scrubbing the gauge for haptics | KILLED — interaction with no question behind it |
| 9 | Head-to-head stock compare overlay | DEFERRED — the morphing rose already does the comparison implicitly |
| 10 | Portfolio orbit view (holdings orbiting a centre) | FOLDED IN — owned/starred stocks get a gold ring in the sky instead |
| 11 | Time-machine slider over past runs | DEFERRED — history storage ships now; the slider needs several runs of data to be worth building |
| 12 | **Drift trails** — each star shows a fading trail from where it sat last run | **BUILD** — the market as a flow field; nobody does this |
| 13 | Narrative "daily reading" ticker tape | KILLED — horoscope energy |

Filter applied: anything visible in Robinhood, Trading 212, Yahoo Finance, or
a Dribbble screener shot dies. What survives must run off already-cached data
(zero extra API calls), hold 60fps on an iPhone, and answer a real question.

## What ships

### 1. The Sky (`src/ui/observatory.js`, new SKY tab)

A full-pane canvas star field. Every scored stock is a star:

- **Position** = two pillar percentiles (x and y). Because both axes are
  percentiles-up, **up-and-right is always better on both** — a `◎ ideal`
  marker sits in the corner as the fixed North of every lens.
- **Lenses** — curated axis pairs: *Bargains* (value × quality), *Fortress*
  (safety × quality), *Rockets* (momentum × growth). Tapping an axis label
  cycles that axis through all five pillars for free exploration.
- **Colour** = RAG band. Hot stars twinkle (respects `prefers-reduced-motion`).
- **Size** = market cap (sqrt scale).
- **Gold ring** = you own it or starred it. Your portfolio sits *in* the
  market, not in a separate tab's table.
- **Drift trails** = when a previous run exists, each star draws a fading
  vector from where it was to where it is. Watch value rotate into momentum.
- Pan with a finger, pinch to zoom, double-tap to reset, tap a star for a
  card, tap the card to open the full detail sheet.
- Sector cycle button dims everything outside the chosen sector.

Renders ~500 stars with pre-rendered glow sprites (no per-frame shadowBlur),
draws only while the tab is active, in device-pixel-ratio space.

### 2. The Compass Rose (`src/ui/rose.js`, in the detail sheet)

Every stock's five-pillar signature as a pentagon rose under the gauge —
quality at north, then value, growth, safety, momentum clockwise. The polygon
draws in from the centre, tinted by band colour.

**Swipe left/right on the detail sheet navigates to the next/previous stock
in your current filter and sort order — and the rose morphs**, vertices
gliding from one company's shape to the next. Flicking through the Hot list
and watching the shapes shift is the fastest way ever built to *feel* the
difference between two companies. Arrow keys do the same on desktop. Axis
locking keeps the existing swipe-down-to-close gesture intact.

### 3. The Log (`src/state/history.js`, briefing card on Screen)

Every completed run appends a compact snapshot (score7, composite, five
pillars per ticker; capped at 8 snapshots, ~150 KB). From the second run
onward, the screen greets you with a briefing card:

> **Since 12 Jun** — 4 stocks climbed a band, 7 slipped.
> ★ NVDA (you hold this) slipped Hot → Strong.

Movers are prioritised: your holdings first, then starred, then the rest.
Expandable to the full list of band-crossers; dismissable per run-pair. This
is the answer to the question the app could never answer before: *"what
happened while I wasn't looking?"*

### 4. Pillars, everywhere the data flows

- The run loop now computes universe percentiles **once per metric** after
  scoring (`src/engine/universe.js`) and persists `pillars` + `mktCap` on
  every result row.
- Old cached results without pillars are enriched **from the LRU cache** on
  first Sky visit — a full re-chart with zero API calls.

## Hard constraints honoured

- `index.html` untouched. All work in `v3.html` + `src/`.
- No build step, no CDN, no CSP change. Canvas + SVG + Web Animations only.
- Zero new API calls — everything renders from state and cache.
- Classic 7, portfolio CRUD, migration, RAG vocabulary, `escHtml()`
  discipline, and named-export hygiene all preserved.
- New pure logic (universe aggregation, snapshot diffing, rose geometry) is
  unit-tested; CI now runs every `*.test.js` under `src/`.
