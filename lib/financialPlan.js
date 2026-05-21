// Financial plan engine — synthesizes a personalized plan from the user's
// paystubs, bills, savings goals, accounts, debts, and pay schedule.
//
// Encodes well-established personal finance heuristics:
//   * 50/30/20 budgeting (needs/wants/savings)
//   * 3-6 month emergency fund (Ramsey / Bogleheads / Vanguard consensus)
//   * Investing waterfall: 401k-match → high-APR debt → Roth IRA → 401k → taxable
//   * Debt avalanche (highest APR first) vs snowball (smallest balance first)
//   * Compound interest projections at conservative real return (~7%)
//   * Path-to-millionaire FV = PMT * [((1+r)^n - 1) / r]
//
// Inputs are read-only — caller persists the returned plan to financial_plans.

const REAL_RETURN_ANNUAL = 0.07;      // inflation-adjusted historical S&P 500
const STOCK_NOMINAL = 0.10;            // nominal historical
const SAFE_HYSA_APY = 0.045;           // current ~4.5% HYSA rate
const ROTH_IRA_LIMIT_2025 = 7000;      // IRS 2025 limit (under 50)
const ROTH_IRA_LIMIT_50 = 8000;
const FOUR01K_LIMIT_2025 = 23000;      // 401(k) elective deferral limit

function avg(arr) { return arr.length ? arr.reduce((s,v)=>s+v,0) / arr.length : 0; }
function sum(arr) { return arr.reduce((s,v)=>s+v,0); }

// Future value of a series of payments (annuity)
function fvAnnuity(pmt, ratePerPeriod, periods) {
  if (ratePerPeriod === 0) return pmt * periods;
  return pmt * ((Math.pow(1 + ratePerPeriod, periods) - 1) / ratePerPeriod);
}

// Years to reach goal given monthly contribution
function yearsToReach(target, currentBalance, monthlyContribution, annualReturn = REAL_RETURN_ANNUAL) {
  if (monthlyContribution <= 0 && annualReturn <= 0) return Infinity;
  const r = annualReturn / 12;
  let balance = currentBalance, months = 0;
  while (balance < target && months < 12 * 100) {
    balance = balance * (1 + r) + monthlyContribution;
    months++;
  }
  return months >= 12 * 100 ? Infinity : months / 12;
}

function generatePlan({ paystubs, bills, savingsGoals, accounts, debts, paychecks, settings }) {
  // ── 1. INCOME SNAPSHOT ────────────────────────────────────────────────────
  const recentStubs = paystubs.slice(-12); // last 12 checks
  const avgGross = avg(recentStubs.map(s => s.gross));
  const avgNet   = avg(recentStubs.map(s => s.net));
  const avgTax   = avg(recentStubs.map(s => s.tax_total));
  const avgDed   = avg(recentStubs.map(s => s.deduction_total));

  // Determine pay frequency from check spacing
  let payFrequency = settings.pay_frequency || 'biweekly';
  const periodsPerYear = ({ weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12 })[payFrequency] || 26;
  const monthsPerPeriod = 12 / periodsPerYear;
  const checksPerMonth = periodsPerYear / 12;

  const annualGross = avgGross * periodsPerYear;
  const annualNet   = avgNet * periodsPerYear;
  const annualTax   = avgTax * periodsPerYear;
  const effectiveTaxRate = avgGross > 0 ? avgTax / avgGross : 0;

  // YTD from most recent stub (most accurate)
  const latestStub = paystubs[paystubs.length - 1];
  const ytdGross = latestStub?.ytd_gross || 0;
  const ytdNet   = ytdGross - (latestStub?.ytd_tax || 0) - (latestStub?.ytd_deductions || 0);

  // ── 2. EXPENSES & CASH FLOW ───────────────────────────────────────────────
  const monthlyBills = bills.filter(b => b.active).reduce((s, b) => {
    const portion = b.my_portion != null ? b.my_portion : (b.total_amount / (b.split_count || 1));
    const multiplier = b.paycheck_slot === 'every_check' ? checksPerMonth : 1;
    return s + portion * multiplier;
  }, 0);

  const monthlyNet = avgNet * checksPerMonth;
  const monthlyDebtMin = debts.filter(d => d.active).reduce((s, d) => s + (d.minimum_payment || 0), 0);
  const fixedMonthlyOutflow = monthlyBills + monthlyDebtMin;
  const monthlyFreeCash = monthlyNet - fixedMonthlyOutflow;

  // ── 3. NET WORTH ──────────────────────────────────────────────────────────
  const totalAssets = accounts.filter(a => a.active).reduce((s, a) => s + (a.balance || 0), 0);
  const totalDebts  = debts.filter(d => d.active).reduce((s, d) => s + (d.balance || 0), 0);
  const netWorth = totalAssets - totalDebts;

  const cashAccounts = accounts.filter(a => a.active && ['checking','savings','hysa'].includes(a.type));
  const totalCash = cashAccounts.reduce((s, a) => s + (a.balance || 0), 0);
  const emergencyFundTarget3mo = monthlyBills * 3;
  const emergencyFundTarget6mo = monthlyBills * 6;
  const emergencyFundCoverage = monthlyBills > 0 ? totalCash / monthlyBills : 0; // months

  // ── 4. DEBT STRATEGY ─────────────────────────────────────────────────────
  const activeDebts = debts.filter(d => d.active && d.balance > 0);
  const highInterestDebts = activeDebts.filter(d => d.apr >= 7);
  const totalHighInterestBalance = highInterestDebts.reduce((s, d) => s + d.balance, 0);
  const weightedApr = activeDebts.length > 0
    ? activeDebts.reduce((s, d) => s + d.apr * d.balance, 0) / Math.max(1, totalDebts)
    : 0;

  // Avalanche order: highest APR first
  const avalanche = [...activeDebts].sort((a, b) => (b.apr || 0) - (a.apr || 0));
  // Snowball order: smallest balance first
  const snowball  = [...activeDebts].sort((a, b) => (a.balance || 0) - (b.balance || 0));

  // Estimated months to debt-free at current minimums + $X extra
  function debtFreeMonths(orderedDebts, extraMonthly) {
    let balances = orderedDebts.map(d => ({...d}));
    let months = 0;
    let extra = extraMonthly;
    while (balances.some(d => d.balance > 0) && months < 600) {
      months++;
      // Apply interest
      for (const d of balances) {
        if (d.balance > 0) d.balance += d.balance * (d.apr / 100 / 12);
      }
      // Pay min on every debt + extra to first non-zero
      let extraLeft = extra;
      for (const d of balances) {
        if (d.balance <= 0) continue;
        const pay = Math.min(d.balance, (d.minimum_payment || 0));
        d.balance -= pay;
      }
      for (const d of balances) {
        if (d.balance <= 0) continue;
        const pay = Math.min(d.balance, extraLeft);
        d.balance -= pay;
        extraLeft -= pay;
        if (extraLeft <= 0) break;
      }
    }
    return months;
  }

  const debtFreeMinOnly = activeDebts.length ? debtFreeMonths(avalanche, 0) : 0;
  const debtFreeWith200 = activeDebts.length ? debtFreeMonths(avalanche, 200) : 0;
  const debtFreeWithMaxFree = activeDebts.length && monthlyFreeCash > 0
    ? debtFreeMonths(avalanche, monthlyFreeCash) : 0;

  // ── 5. INVESTMENT WATERFALL ──────────────────────────────────────────────
  // Determine what % of paycheck should go where, in priority order.
  const recommendations = [];
  let remainingMonthly = Math.max(0, monthlyFreeCash);

  // Step 1: Emergency fund (priority 1 if <1 month, then continue building to 3mo)
  if (emergencyFundCoverage < 1 && monthlyBills > 0) {
    const target = Math.min(remainingMonthly, monthlyBills * 0.5);
    recommendations.push({
      step: 1,
      type: 'emergency_starter',
      title: '🚨 Build $1,000 starter emergency fund FIRST',
      monthly: Math.min(target, 500),
      why: `You have ${emergencyFundCoverage.toFixed(1)} months of bills in cash. A $1,000 buffer prevents minor surprises from becoming credit-card debt.`,
      account_type: 'hysa',
      target_amount: 1000,
    });
    remainingMonthly -= Math.min(target, 500);
  }

  // Step 2: 401(k) employer match (assume 4% match — typical AT&T-style)
  const matchPct = parseFloat(settings.employer_match_pct) || 4;
  const match401kMonthly = (annualGross * (matchPct / 100)) / 12;
  if (match401kMonthly > 0) {
    recommendations.push({
      step: 2,
      type: '401k_match',
      title: `💼 Capture full 401(k) employer match (${matchPct}%)`,
      monthly: match401kMonthly,
      why: 'This is a 100% instant return. Free money — never leave it on the table.',
      account_type: '401k',
      annual: match401kMonthly * 12,
    });
    // 401k contributions come from gross, not from monthlyFreeCash — so don't decrement
  }

  // Step 3: Crush high-APR debt
  if (totalHighInterestBalance > 0 && remainingMonthly > 0) {
    const allocateToDebt = Math.min(remainingMonthly, Math.max(200, monthlyFreeCash * 0.5));
    recommendations.push({
      step: 3,
      type: 'debt_payoff',
      title: '🔥 Avalanche high-APR debt',
      monthly: allocateToDebt,
      why: `You have ${formatCurrency(totalHighInterestBalance)} at ${weightedApr.toFixed(1)}% avg APR. No safe investment beats that guaranteed return.`,
      target_debts: avalanche.filter(d => d.apr >= 7).map(d => ({ name: d.name, balance: d.balance, apr: d.apr })),
      debt_free_in_months: debtFreeMonths(avalanche, allocateToDebt),
    });
    remainingMonthly -= allocateToDebt;
  }

  // Step 4: Finish 3-6 month emergency fund
  const efGap = Math.max(0, emergencyFundTarget3mo - totalCash);
  if (efGap > 0 && remainingMonthly > 0) {
    const allocate = Math.min(remainingMonthly, efGap / 6); // fill over ~6 months
    recommendations.push({
      step: 4,
      type: 'emergency_full',
      title: `🛟 Finish full emergency fund (3-month minimum)`,
      monthly: allocate,
      why: `${formatCurrency(efGap)} more needed to hit 3 months of expenses. Park it in a HYSA at ~${(SAFE_HYSA_APY*100).toFixed(1)}% APY.`,
      account_type: 'hysa',
      target_amount: emergencyFundTarget3mo,
      months_to_full: efGap / Math.max(1, allocate),
    });
    remainingMonthly -= allocate;
  }

  // Step 5: Roth IRA up to limit
  if (remainingMonthly > 0) {
    const rothMonthlyMax = ROTH_IRA_LIMIT_2025 / 12;
    const rothAllocate = Math.min(remainingMonthly, rothMonthlyMax);
    recommendations.push({
      step: 5,
      type: 'roth_ira',
      title: '🌱 Max Roth IRA ($7,000/yr — tax-free growth)',
      monthly: rothAllocate,
      annual: rothAllocate * 12,
      why: 'Roth contributions grow tax-free forever. Even small monthly amounts compound massively over decades.',
      target_account_type: 'brokerage',
      suggestion: 'Open at Fidelity / Schwab / Vanguard. Buy a target-date fund or VTI/VTSAX.',
    });
    remainingMonthly -= rothAllocate;
  }

  // Step 6: Bump 401(k) past match
  if (remainingMonthly > 0) {
    recommendations.push({
      step: 6,
      type: '401k_increase',
      title: '📈 Increase 401(k) beyond the match',
      monthly: remainingMonthly * 0.5,
      why: 'Reduces taxable income now (traditional) or grows tax-free (Roth 401k). Limit is $23,000/yr in 2025.',
    });
    remainingMonthly -= remainingMonthly * 0.5;
  }

  // Step 7: Taxable brokerage / business runway
  if (remainingMonthly > 0) {
    recommendations.push({
      step: 7,
      type: 'taxable_brokerage',
      title: '🏗️ Taxable brokerage OR business runway fund',
      monthly: remainingMonthly,
      why: 'Flexibility tier — no contribution limits. Use it for index funds, individual stocks, or as seed capital for your business launch.',
      suggestion: 'Index funds (VTI 70% / VXUS 30%) for diversified growth, or set aside as business seed capital.',
    });
  }

  // ── 6. MILLIONAIRE TIMELINE ──────────────────────────────────────────────
  // Estimate aggressive (max recommended), moderate, and conservative monthly investing
  // Then project years to $1M at 7% real return.
  const totalInvestableMonthly = recommendations
    .filter(r => ['401k_match', 'roth_ira', '401k_increase', 'taxable_brokerage'].includes(r.type))
    .reduce((s, r) => s + r.monthly, 0);
  const currentInvestments = accounts
    .filter(a => a.active && ['401k', 'roth_ira', 'brokerage', 'investment'].includes(a.type))
    .reduce((s, a) => s + (a.balance || 0), 0);

  const scenarios = [
    { name: 'Conservative', monthly: totalInvestableMonthly * 0.5, return: 0.05 },
    { name: 'Moderate',     monthly: totalInvestableMonthly,        return: 0.07 },
    { name: 'Aggressive',   monthly: totalInvestableMonthly * 1.5,  return: 0.09 },
  ].map(s => ({
    ...s,
    years_to_1m: yearsToReach(1_000_000, currentInvestments, s.monthly, s.return),
    fv_in_30y: currentInvestments * Math.pow(1 + s.return, 30) + fvAnnuity(s.monthly, s.return / 12, 360),
  }));

  // Year-by-year projection for the chart (moderate scenario)
  const projection = [];
  let bal = currentInvestments;
  const monthlyPMT = totalInvestableMonthly;
  for (let y = 0; y <= 40; y++) {
    projection.push({ year: y, balance: Math.round(bal) });
    for (let m = 0; m < 12; m++) {
      bal = bal * (1 + REAL_RETURN_ANNUAL / 12) + monthlyPMT;
    }
  }

  // ── 7. BUSINESS LAUNCH RUNWAY ────────────────────────────────────────────
  // Recommend setting aside 6-12mo of personal expenses + estimated startup capital
  const businessReserveTarget = monthlyBills * 12; // 12-month runway
  const businessLine = {
    target: businessReserveTarget,
    monthly_to_set_aside: Math.min(remainingMonthly + 100, businessReserveTarget / 36), // 3-year build
    months_to_runway: businessReserveTarget / Math.max(100, remainingMonthly + 100),
    note: 'Aim for 12 months personal expenses set aside in HYSA before launch, plus 6 months business operating capital.',
  };

  // ── 8. AUTO-GENERATED SAVINGS GOALS ──────────────────────────────────────
  // Concrete goals the user can one-click create
  const suggestedGoals = [];
  if (totalCash < 1000) {
    suggestedGoals.push({
      name: '🚨 Starter Emergency Fund',
      target_amount: 1000,
      per_check_contribution: Math.round(Math.min(250, monthlyFreeCash / checksPerMonth)),
      priority: 10,
      auto_allocate: 1,
      color: '#ef4444',
    });
  }
  if (totalCash < emergencyFundTarget3mo) {
    suggestedGoals.push({
      name: '🛟 3-Month Emergency Fund',
      target_amount: Math.round(emergencyFundTarget3mo),
      current_amount: totalCash,
      per_check_contribution: Math.round((emergencyFundTarget3mo - totalCash) / 26),
      priority: 8,
      auto_allocate: 1,
      color: '#3b82f6',
    });
  }
  suggestedGoals.push({
    name: '🌱 Roth IRA Annual Max',
    target_amount: ROTH_IRA_LIMIT_2025,
    per_check_contribution: Math.round(ROTH_IRA_LIMIT_2025 / 26),
    priority: 6,
    auto_allocate: 1,
    color: '#14b8a6',
  });
  suggestedGoals.push({
    name: '🏗️ Business Launch Runway',
    target_amount: Math.round(businessReserveTarget),
    per_check_contribution: Math.round(businessReserveTarget / 78), // 3yr
    priority: 4,
    auto_allocate: 1,
    color: '#a855f7',
  });

  // ── 9. RISK / WARNINGS ───────────────────────────────────────────────────
  const warnings = [];
  if (monthlyFreeCash < 0) {
    warnings.push({
      severity: 'critical',
      message: `🚨 You're spending ${formatCurrency(-monthlyFreeCash)}/month more than you earn. Reduce bills before investing.`,
    });
  }
  if (totalCash < 500) {
    warnings.push({
      severity: 'high',
      message: '⚠️ Less than $500 cash on hand. A single car repair could force credit card debt.',
    });
  }
  if (weightedApr > 15 && totalDebts > 0) {
    warnings.push({
      severity: 'high',
      message: `⚠️ Average debt APR is ${weightedApr.toFixed(1)}% — devastating long-term. Make this priority 1 after the $1k starter fund.`,
    });
  }
  if (effectiveTaxRate > 0.25) {
    warnings.push({
      severity: 'medium',
      message: `Tax rate is ${(effectiveTaxRate*100).toFixed(1)}% of gross. Consider maxing pre-tax 401(k) to lower taxable income.`,
    });
  }
  const savingsRate = annualGross > 0 ? (totalInvestableMonthly * 12) / annualGross : 0;
  if (savingsRate < 0.15) {
    warnings.push({
      severity: 'medium',
      message: `Savings rate is ${(savingsRate*100).toFixed(1)}%. 15-20% is the standard for retiring at 65, 30%+ for FIRE.`,
    });
  }

  return {
    generated_at: new Date().toISOString(),
    snapshot: {
      avg_gross_per_check: avgGross,
      avg_net_per_check: avgNet,
      annual_gross: annualGross,
      annual_net: annualNet,
      annual_tax: annualTax,
      effective_tax_rate: effectiveTaxRate,
      ytd_gross: ytdGross,
      ytd_net: ytdNet,
      monthly_bills: monthlyBills,
      monthly_net: monthlyNet,
      monthly_free_cash: monthlyFreeCash,
      net_worth: netWorth,
      total_assets: totalAssets,
      total_cash: totalCash,
      total_debts: totalDebts,
      weighted_apr: weightedApr,
      emergency_coverage_months: emergencyFundCoverage,
      savings_rate: savingsRate,
      pay_frequency: payFrequency,
    },
    recommendations,
    debt_strategy: {
      avalanche: avalanche.map(d => ({ name: d.name, balance: d.balance, apr: d.apr, minimum: d.minimum_payment })),
      snowball:  snowball.map(d => ({ name: d.name, balance: d.balance, apr: d.apr, minimum: d.minimum_payment })),
      debt_free_min_only_months: debtFreeMinOnly,
      debt_free_with_200_extra_months: debtFreeWith200,
      debt_free_with_max_free_months: debtFreeWithMaxFree,
      preferred: weightedApr > 8 ? 'avalanche' : (activeDebts.length <= 2 ? 'snowball' : 'avalanche'),
    },
    millionaire_timeline: {
      current_investments: currentInvestments,
      monthly_investable: totalInvestableMonthly,
      scenarios,
      projection,
      assumed_real_return: REAL_RETURN_ANNUAL,
    },
    business_launch: businessLine,
    suggested_goals: suggestedGoals,
    warnings,
    principles_applied: [
      'Dave Ramsey starter $1k emergency before all else',
      '401(k) match capture before any other investing (100% return)',
      'Debt avalanche (highest APR first) — mathematically optimal',
      '3-6 month emergency fund in HYSA (Bogleheads/Vanguard standard)',
      'Roth IRA max for tax-free growth ($7k/yr 2025 limit)',
      '50/30/20 budget rule informs free-cash thresholds',
      'Conservative real return 7% (S&P 500 historical inflation-adjusted)',
      'FV annuity formula for projection: PMT × ((1+r)^n - 1) / r',
    ],
  };
}

function formatCurrency(n) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}

module.exports = { generatePlan, yearsToReach, fvAnnuity, REAL_RETURN_ANNUAL };
