let currentPlan = null;
let projChart = null;

// Safe number-to-string: handles null, undefined, NaN, Infinity
function nf(v, decimals = 1) {
  const n = Number(v);
  if (!isFinite(n) || isNaN(n)) return '0';
  return n.toFixed(decimals);
}

async function generatePlan() {
  const btn = document.getElementById('generate-btn');
  btn.disabled = true;
  btn.textContent = '⏳ Running the numbers...';
  try {
    currentPlan = await API.post('/api/plan/generate', {});
    try {
      renderPlan();
      toast('Plan generated ✓');
    } catch (renderErr) {
      console.error('Plan render error:', renderErr, 'Plan data:', currentPlan);
      toast('Render error (data ok, see console): ' + renderErr.message, 'error');
    }
  } catch (e) {
    console.error('Plan generation error:', e);
    toast('Generation failed: ' + e.message, 'error');
  }
  btn.disabled = false;
  btn.textContent = '⚡ Regenerate My Plan';
}

async function loadLatest() {
  try {
    const p = await API.get('/api/plan/latest');
    if (p) {
      currentPlan = p;
      try { renderPlan(); }
      catch (e) {
        console.warn('Could not render saved plan (likely stale schema):', e);
        document.getElementById('plan-meta').textContent = 'A saved plan exists but has a stale format — click "Regenerate My Plan" to refresh.';
      }
    }
  } catch {}
}

function renderPlan() {
  if (!currentPlan) return;
  const p = currentPlan;
  const s = p.snapshot;
  document.getElementById('plan-meta').textContent = `Last generated ${p._generated_at ? new Date(p._generated_at).toLocaleString() : 'just now'} · ${p.principles_applied.length} principles applied`;

  const moderate = p.millionaire_timeline.scenarios.find(x => x.name === 'Moderate');

  document.getElementById('plan-content').innerHTML = `
    <!-- Warnings first -->
    ${p.warnings.length > 0 ? `
      <div class="card" style="margin-bottom:24px;border-left:3px solid var(--red)">
        <div class="card-title">⚠️ Things to address first</div>
        ${p.warnings.map(w => `<div class="warning-card ${w.severity}">${w.message}</div>`).join('')}
      </div>
    ` : ''}

    <!-- Snapshot -->
    <div class="grid-4" style="margin-bottom:24px">
      <div class="stat-card"><div class="stat-icon green">💼</div><div class="stat-body"><div class="stat-label">Annual Gross</div><div class="stat-value green">${fmt(s.annual_gross)}</div><div class="stat-meta">Per check: ${fmt(s.avg_gross_per_check)}</div></div></div>
      <div class="stat-card"><div class="stat-icon teal">✨</div><div class="stat-body"><div class="stat-label">Monthly Net</div><div class="stat-value teal">${fmt(s.monthly_net)}</div><div class="stat-meta">Free cash: ${fmt(s.monthly_free_cash)}</div></div></div>
      <div class="stat-card"><div class="stat-icon ${(s.net_worth || 0) >= 0 ? 'blue' : 'red'}">💎</div><div class="stat-body"><div class="stat-label">Net Worth</div><div class="stat-value ${(s.net_worth || 0) >= 0 ? 'blue' : 'red'}">${fmt(s.net_worth)}</div><div class="stat-meta">${nf(s.emergency_coverage_months, 1)} months covered</div></div></div>
      <div class="stat-card"><div class="stat-icon amber">📊</div><div class="stat-body"><div class="stat-label">Savings Rate</div><div class="stat-value amber">${nf((s.savings_rate || 0) * 100, 1)}%</div><div class="stat-meta">Target: 15-20%</div></div></div>
    </div>

    <!-- Millionaire timeline -->
    <div class="card" style="margin-bottom:24px;background:linear-gradient(135deg, rgba(34,197,94,0.08), transparent 60%);border-color:rgba(34,197,94,0.2)">
      <div class="card-title">🚀 Path to $1,000,000</div>
      <div style="display:flex;align-items:baseline;gap:12px;margin-bottom:18px">
        <div style="font-size:52px;font-weight:800;letter-spacing:-2px;color:var(--green);line-height:1">
          ${moderate && typeof moderate.years_to_1m === 'number' && isFinite(moderate.years_to_1m) ? nf(moderate.years_to_1m, 1) : '∞'}
        </div>
        <div style="font-size:18px;color:var(--text-secondary)">years (moderate scenario)</div>
      </div>
      <div style="color:var(--text-secondary);font-size:13px;margin-bottom:18px">
        At ${fmt(p.millionaire_timeline.monthly_investable)}/mo invested · ${nf((p.millionaire_timeline.assumed_real_return || 0) * 100, 0)}% real return · starting from ${fmt(p.millionaire_timeline.current_investments)}.
      </div>
      <div class="grid-3" style="margin-bottom:20px">
        ${(p.millionaire_timeline.scenarios || []).map(sc => `
          <div class="scenario-card">
            <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.8px">${sc.name}</div>
            <div class="scenario-yrs" style="color:${sc.name === 'Conservative' ? 'var(--amber)' : sc.name === 'Moderate' ? 'var(--green)' : 'var(--accent)'}">
              ${typeof sc.years_to_1m === 'number' && isFinite(sc.years_to_1m) ? nf(sc.years_to_1m, 1) + 'y' : '∞'}
            </div>
            <div style="font-size:12px;color:var(--text-secondary);margin-top:6px">${fmt(sc.monthly)}/mo @ ${nf((sc.return || 0) * 100, 0)}%</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:4px">In 30 yrs: ${fmt(sc.fv_in_30y)}</div>
          </div>
        `).join('')}
      </div>
      <div style="height:240px;position:relative"><canvas id="proj-chart"></canvas></div>
    </div>

    <!-- Recommendations waterfall -->
    <div class="card" style="margin-bottom:24px">
      <div class="card-title">📋 Your investing waterfall (in order)</div>
      <div style="color:var(--text-secondary);font-size:13px;margin-bottom:14px">Each dollar of free cash flows down this priority list. The math: do step N completely before starting N+1.</div>
      ${p.recommendations.map(r => `
        <div class="rec-card">
          <div class="rec-step">${r.step}</div>
          <div style="flex:1">
            <h4>${r.title}</h4>
            <div style="color:var(--text-secondary);font-size:13px;margin-top:4px">${r.why}</div>
            ${r.suggestion ? `<div style="font-size:12px;color:var(--text-muted);margin-top:6px">💡 ${r.suggestion}</div>` : ''}
            ${r.target_debts ? `<div style="margin-top:8px;font-size:12px">${r.target_debts.map(d => `<span class="principle">${d.name} · ${d.apr}% APR · ${fmt(d.balance)}</span>`).join('')}</div>` : ''}
          </div>
          <div class="rec-amt">${fmt(r.monthly)}/mo</div>
        </div>
      `).join('')}
    </div>

    <!-- Debt strategy -->
    ${p.debt_strategy.avalanche.length > 0 ? `
      <div class="card" style="margin-bottom:24px">
        <div class="card-title">🔥 Debt strategy</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-bottom:14px">
          <div><div style="font-size:11px;color:var(--text-muted)">MIN PAYMENTS ONLY</div><div style="font-size:24px;font-weight:800">${Math.floor((p.debt_strategy.debt_free_min_only_months || 0)/12)}y ${(p.debt_strategy.debt_free_min_only_months || 0)%12}mo</div></div>
          <div><div style="font-size:11px;color:var(--text-muted)">WITH +$200/MO</div><div style="font-size:24px;font-weight:800;color:var(--amber)">${Math.floor((p.debt_strategy.debt_free_with_200_extra_months || 0)/12)}y ${(p.debt_strategy.debt_free_with_200_extra_months || 0)%12}mo</div></div>
          <div><div style="font-size:11px;color:var(--text-muted)">WITH MAX FREE CASH</div><div style="font-size:24px;font-weight:800;color:var(--green)">${Math.floor((p.debt_strategy.debt_free_with_max_free_months || 0)/12)}y ${(p.debt_strategy.debt_free_with_max_free_months || 0)%12}mo</div></div>
        </div>
        <div style="padding:14px;background:var(--bg-input);border-radius:var(--radius-sm);font-size:13px">
          <strong>Recommended: ${p.debt_strategy.preferred.toUpperCase()}</strong> ·
          ${p.debt_strategy.preferred === 'avalanche'
            ? 'Pay extra on highest-APR debt first while making minimums on the rest.'
            : 'Pay off smallest balance first for psychological wins.'}
          <div style="margin-top:8px;color:var(--text-muted)">Order: ${p.debt_strategy[p.debt_strategy.preferred].map(d => d.name + ' (' + d.apr + '%)').join(' → ')}</div>
        </div>
      </div>
    ` : ''}

    <!-- Business runway -->
    <div class="card" style="margin-bottom:24px;background:linear-gradient(135deg, rgba(168,85,247,0.08), transparent 60%);border-color:rgba(168,85,247,0.2)">
      <div class="card-title">🏗️ Business launch runway</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px">
        <div><div style="font-size:11px;color:var(--text-muted)">RUNWAY TARGET</div><div style="font-size:24px;font-weight:800;color:var(--purple)">${fmt(p.business_launch.target)}</div><div style="font-size:11px;color:var(--text-muted)">12 months expenses</div></div>
        <div><div style="font-size:11px;color:var(--text-muted)">SET ASIDE/MO</div><div style="font-size:24px;font-weight:800">${fmt(p.business_launch.monthly_to_set_aside)}</div></div>
        <div><div style="font-size:11px;color:var(--text-muted)">READY IN</div><div style="font-size:24px;font-weight:800;color:var(--accent)">${Math.round(p.business_launch.months_to_runway)} months</div></div>
      </div>
      <div style="margin-top:14px;font-size:13px;color:var(--text-secondary)">${p.business_launch.note}</div>
    </div>

    <!-- Apply suggested goals -->
    <div class="card" style="margin-bottom:24px">
      <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:14px;flex-wrap:wrap;gap:8px">
        <div>
          <div class="card-title" style="margin-bottom:2px">🎯 Auto-create these savings goals</div>
          <div style="font-size:12px;color:var(--text-secondary)">One click creates them all (skips existing) with auto-allocate ON.</div>
        </div>
        <button class="btn btn-primary" onclick="applyGoals()">✨ Create All Goals</button>
      </div>
      <div class="grid-2">
        ${p.suggested_goals.map(g => `
          <div style="padding:14px;border:1px solid var(--border);border-radius:var(--radius-sm);border-left:4px solid ${g.color}">
            <div style="font-weight:700">${g.name}</div>
            <div style="font-size:13px;color:var(--text-secondary);margin-top:4px">Target ${fmt(g.target_amount)} · ${fmt(g.per_check_contribution)}/check · priority ${g.priority}</div>
          </div>
        `).join('')}
      </div>
    </div>

    <!-- Principles -->
    <div class="card">
      <div class="card-title">📚 Principles applied (researched personal finance)</div>
      <div style="margin-top:8px">${p.principles_applied.map(pr => `<span class="principle">${pr}</span>`).join('')}</div>
    </div>
  `;

  renderProjection();
}

function renderProjection() {
  const proj = currentPlan.millionaire_timeline.projection;
  if (projChart) projChart.destroy();
  projChart = new Chart(document.getElementById('proj-chart').getContext('2d'), {
    type: 'line',
    data: {
      labels: proj.map(p => 'Year ' + p.year),
      datasets: [{
        label: 'Portfolio value',
        data: proj.map(p => p.balance),
        borderColor: '#22c55e',
        backgroundColor: 'rgba(34,197,94,0.15)',
        fill: true, tension: 0.4, pointRadius: 0,
      }, {
        label: '$1M milestone',
        data: proj.map(() => 1000000),
        borderColor: 'rgba(168,85,247,0.6)',
        borderDash: [4,4], pointRadius: 0, fill: false,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#8b96b0' } },
        tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${fmt(c.raw)}` } } },
      scales: {
        x: { ticks: { color: '#8b96b0', maxTicksLimit: 8 }, grid: { color: 'rgba(255,255,255,0.03)' } },
        y: { ticks: { color: '#8b96b0', callback: v => '$' + (v/1000).toFixed(0) + 'k' }, grid: { color: 'rgba(255,255,255,0.04)' } }
      }
    }
  });
}

async function applyGoals() {
  if (!currentPlan?.suggested_goals) return;
  const r = await API.post('/api/plan/apply-goals', { goals: currentPlan.suggested_goals });
  toast(`✓ Created ${r.created} savings goals`);
}

document.addEventListener('DOMContentLoaded', () => {
  loadLatest();
  document.getElementById('generate-btn').addEventListener('click', generatePlan);
});
