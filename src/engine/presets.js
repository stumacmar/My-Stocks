/**
 * Scoring presets.
 *
 * Each preset defines:
 *   - id         unique key stored in settings
 *   - name       display name
 *   - description one-liner shown in settings
 *   - pillarWeights { quality, value, growth, safety, momentum } — must sum to 1.0
 *   - metricOverrides (optional) per-metric weight multipliers within a pillar
 *   - sectorRelative (optional) default sector-relative mode
 *
 * CLASSIC_7 is a special case: it runs the exact V2 binary pass/fail formula
 * rather than the percentile engine, to give continuity for users who know
 * the existing 0–7 score.
 */

export const PRESETS = Object.freeze({

  BALANCED: {
    id:          'BALANCED',
    name:        'Balanced',
    description: 'Equal weight across all five factors. Good default for most investors.',
    pillarWeights: {
      quality:  0.25,
      value:    0.25,
      growth:   0.20,
      safety:   0.15,
      momentum: 0.15,
    },
  },

  QUALITY_COMPOUNDER: {
    id:          'QUALITY_COMPOUNDER',
    name:        'Quality Compounder',
    description: 'Heavy quality and growth tilt. Favours durable-moat businesses.',
    pillarWeights: {
      quality:  0.35,
      value:    0.15,
      growth:   0.30,
      safety:   0.15,
      momentum: 0.05,
    },
  },

  DEEP_VALUE: {
    id:          'DEEP_VALUE',
    name:        'Deep Value',
    description: 'Maximises value weight. Safety check keeps it away from value traps.',
    pillarWeights: {
      quality:  0.15,
      value:    0.45,
      growth:   0.10,
      safety:   0.25,
      momentum: 0.05,
    },
  },

  CLASSIC_7: {
    id:          'CLASSIC_7',
    name:        'Classic 7',
    description: 'The original 7-criteria binary score from V1/V2. 0–7 mapped to 0–100.',
    pillarWeights: null,  // not used — custom scorer handles this
    useClassicScorer: true,
  },

});

// ---------------------------------------------------------------------------
// Classic 7 scorer — faithful V2 reproduction
// ---------------------------------------------------------------------------

/**
 * Reproduce the exact V2 binary pass/fail scoring formula.
 * Returns { score: 0–7, criteria: { id, pass, value, threshold }[], composite: 0–100 }
 *
 * Criteria (matching V2):
 *   1. EPS positive (TTM)
 *   2. Revenue growth positive YoY
 *   3. Gross margin > 30%
 *   4. P/E < 25  (or N/A if no earnings)
 *   5. Debt/Equity < 1.5
 *   6. FCF positive
 *   7. Return on Equity > 10%
 */
export function classicScore(fundamentals) {
  const { income = [], balance = [], cashFlow = [], keyMetrics = {} } = fundamentals;

  const latest     = income[0] || {};
  const prior      = income[1] || {};
  const latestBal  = balance[0] || {};
  const latestCF   = cashFlow[0] || {};

  const checks = [
    {
      id:        'eps_positive',
      label:     'Positive EPS',
      value:     latest.eps,
      pass:      latest.eps != null && latest.eps > 0,
      threshold: '> 0',
    },
    {
      id:        'revenue_growth',
      label:     'Revenue growth',
      value:     latest.revenue && prior.revenue
        ? ((latest.revenue - prior.revenue) / prior.revenue) * 100
        : null,
      pass:      latest.revenue != null && prior.revenue != null && latest.revenue > prior.revenue,
      threshold: '> 0%',
    },
    {
      id:        'gross_margin',
      label:     'Gross margin > 30%',
      value:     latest.revenue ? (latest.grossProfit / latest.revenue) * 100 : null,
      pass:      latest.revenue != null
        ? (latest.grossProfit / latest.revenue) > 0.30
        : false,
      threshold: '> 30%',
    },
    {
      id:        'pe_under_25',
      label:     'P/E < 25',
      value:     keyMetrics.peRatioTTM ?? null,
      pass:      keyMetrics.peRatioTTM != null
        ? keyMetrics.peRatioTTM > 0 && keyMetrics.peRatioTTM < 25
        : false,
      threshold: '< 25',
    },
    {
      id:        'debt_equity',
      label:     'Debt/Equity < 1.5',
      value:     latestBal.totalEquity
        ? (latestBal.totalDebt || 0) / latestBal.totalEquity
        : null,
      pass:      latestBal.totalEquity != null && latestBal.totalEquity > 0
        ? ((latestBal.totalDebt || 0) / latestBal.totalEquity) < 1.5
        : false,
      threshold: '< 1.5',
    },
    {
      id:        'fcf_positive',
      label:     'Positive FCF',
      value:     latestCF.operatingCashFlow != null
        ? latestCF.operatingCashFlow - Math.abs(latestCF.capitalExpenditure || 0)
        : null,
      pass:      latestCF.operatingCashFlow != null
        ? (latestCF.operatingCashFlow - Math.abs(latestCF.capitalExpenditure || 0)) > 0
        : false,
      threshold: '> 0',
    },
    {
      id:        'roe_over_10',
      label:     'ROE > 10%',
      value:     latestBal.totalEquity && latest.netIncome
        ? (latest.netIncome / latestBal.totalEquity) * 100
        : null,
      pass:      latestBal.totalEquity != null && latestBal.totalEquity > 0 && latest.netIncome != null
        ? (latest.netIncome / latestBal.totalEquity) > 0.10
        : false,
      threshold: '> 10%',
    },
  ];

  const score = checks.filter(c => c.pass).length;

  return {
    score,
    maxScore:  7,
    criteria:  checks,
    composite: Math.round((score / 7) * 100),
    rag: score === 7 ? 'hot'
       : score >= 6 ? 'strong'
       : score >= 4 ? 'watch'
       : 'avoid',
    scoredAt: new Date().toISOString(),
  };
}

/**
 * Return the preset object for a given preset id.
 * Defaults to BALANCED if id is unknown.
 */
export function getPreset(id) {
  return PRESETS[id] || PRESETS.BALANCED;
}
