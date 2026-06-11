/**
 * Red-flag checks — 5 binary signals independent of the composite score.
 *
 * A red flag does not penalise the composite; it is surfaced separately
 * as a warning the user must decide how to weight.
 *
 * Each flag definition:
 *   { id, label, description, check(fund) → bool }
 *
 * check() returns true if the flag is FIRED (bad).
 */

export const FLAG_DEFS = [
  {
    id:    'share_dilution',
    label: 'Share dilution',
    description: 'Share count has grown by more than 5% over 3 years, diluting existing holders.',
    /**
     * @param {{ income: object[], balance: object[] }} fund
     */
    check({ income } = {}) {
      if (!Array.isArray(income) || income.length < 4) return false;
      const newest = income[0]?.weightedAverageShsOut;
      const oldest = income[3]?.weightedAverageShsOut;
      if (!newest || !oldest || oldest <= 0) return false;
      return (newest - oldest) / oldest > 0.05;
    },
  },

  {
    id:    'declining_roic',
    label: 'Declining ROIC',
    description: 'Return on invested capital has fallen for 3 consecutive years.',
    check({ income, balance } = {}) {
      if (!Array.isArray(income) || income.length < 4) return false;
      if (!Array.isArray(balance) || balance.length < 4) return false;

      const roics = income.slice(0, 4).map((inc, i) => {
        const bal = balance[i];
        if (!inc || !bal) return null;
        const nopat = (inc.operatingIncome || 0) * (1 - 0.21);
        const invested = (bal.totalEquity || 0) + (bal.totalDebt || 0) - (bal.cashAndShortTermInvestments || 0);
        if (invested <= 0) return null;
        return nopat / invested;
      });

      // Need 4 consecutive values without null
      if (roics.some(r => r === null)) return false;

      // Check if each value is strictly less than the previous year
      // roics[0] = newest, roics[3] = oldest
      return roics[0] < roics[1] && roics[1] < roics[2] && roics[2] < roics[3];
    },
  },

  {
    id:    'receivables_outpacing_revenue',
    label: 'Receivables outpacing revenue',
    description: 'Accounts receivable growing significantly faster than revenue — may signal revenue-recognition issues.',
    check({ income, balance } = {}) {
      if (!Array.isArray(income) || income.length < 3) return false;
      if (!Array.isArray(balance) || balance.length < 3) return false;

      const revGrowth = (() => {
        const r0 = income[0]?.revenue;
        const r2 = income[2]?.revenue;
        if (!r0 || !r2 || r2 <= 0) return null;
        return (r0 - r2) / r2;
      })();

      const recGrowth = (() => {
        const a0 = balance[0]?.netReceivables;
        const a2 = balance[2]?.netReceivables;
        if (!a0 || !a2 || a2 <= 0) return null;
        return (a0 - a2) / a2;
      })();

      if (revGrowth === null || recGrowth === null) return false;

      // Flag if receivables growing >1.5× faster than revenue and >10% faster in absolute terms
      return recGrowth > revGrowth * 1.5 && recGrowth - revGrowth > 0.10;
    },
  },

  {
    id:    'goodwill_heavy',
    label: 'Goodwill heavy',
    description: 'Goodwill represents more than 40% of total assets — acquisition risk if impairments occur.',
    check({ balance } = {}) {
      if (!Array.isArray(balance) || balance.length < 1) return false;
      const b = balance[0];
      if (!b) return false;
      const gw    = b.goodwill || 0;
      const total = b.totalAssets;
      if (!total || total <= 0) return false;
      return gw / total > 0.40;
    },
  },

  {
    id:    'dividend_from_debt',
    label: 'Dividend funded by debt',
    description: 'Free cash flow is insufficient to cover dividends — company may be borrowing to pay shareholders.',
    check({ cashFlow } = {}) {
      if (!Array.isArray(cashFlow) || cashFlow.length < 1) return false;
      const cf = cashFlow[0];
      if (!cf) return false;
      const fcf  = (cf.operatingCashFlow || 0) - Math.abs(cf.capitalExpenditure || 0);
      const divs = Math.abs(cf.dividendsPaid || 0);
      if (divs === 0) return false;  // no dividend, not applicable
      return fcf < divs;
    },
  },
];

/**
 * Evaluate all red flags for a given set of fundamental data.
 *
 * @param {{ income: object[], cashFlow: object[], balance: object[] }} fundamentals
 * @returns {{ id, label, description, fired: bool }[]}
 */
export function evaluateFlags(fundamentals) {
  return FLAG_DEFS.map(flag => ({
    id:          flag.id,
    label:       flag.label,
    description: flag.description,
    fired:       Boolean(flag.check(fundamentals)),
  }));
}

/**
 * Returns only the flags that fired.
 */
export function firedFlags(fundamentals) {
  return evaluateFlags(fundamentals).filter(f => f.fired);
}
