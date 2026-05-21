let allGoals = [];
let allPaychecks = [];
let editingGoalId = null;
let savingsChart = null;
let availablePerCheck = 0;
let nextPaycheck = null;

async function loadSavings() {
  const [savingsResp, pcs] = await Promise.all([
    API.get('/api/savings'),
    API.get('/api/paychecks')
  ]);

  // The savings endpoint now returns { goals, available_per_check, next_paycheck }
  allGoals = savingsResp.goals || savingsResp;  // backward compat
  availablePerCheck = savingsResp.available_per_check || 0;
  nextPaycheck = savingsResp.next_paycheck || null;
  allPaychecks = pcs;

  renderStats();
  renderGoals();
  populatePaycheckDropdown();
  renderSavingsChart();
}

function renderStats() {
  const active = allGoals.filter(g => g.active);

  // Only count ACTUAL savings (base amount + past contributions)
  const totalSaved = active.reduce((s, g) => s + g.current_amount, 0);
  const totalTarget = active.reduce((s, g) => s + g.target_amount, 0);
  const totalPlanned = active.reduce((s, g) => s + (g.planned || 0), 0);
  const perCheck = active.reduce((s, g) => s + (g.per_check_contribution || 0), 0);
  const overallPct = totalTarget > 0 ? Math.min(100, (totalSaved / totalTarget) * 100) : 0;

  document.getElementById('sv-goals').textContent = active.length;
  document.getElementById('sv-saved').textContent = fmt(totalSaved);

  const targetEl = document.getElementById('sv-target');
  if (targetEl) targetEl.textContent = fmt(totalTarget);
  const perCheckEl = document.getElementById('sv-per-check');
  if (perCheckEl) perCheckEl.textContent = fmt(perCheck);

  // Update overall progress bar
  const bar = document.getElementById('sv-overall-bar');
  if (bar) {
    bar.style.width = overallPct + '%';
    bar.style.background = `linear-gradient(90deg, var(--teal), var(--green))`;
  }
  const pctEl = document.getElementById('sv-overall-pct');
  if (pctEl) pctEl.textContent = overallPct.toFixed(1) + '% saved';

  // Update overall bar labels
  const savedLabel = document.getElementById('sv-saved-label');
  if (savedLabel) savedLabel.textContent = fmt(totalSaved) + ' actually saved';

  // Available per check (what you CAN save from the next paycheck)
  const availEl = document.getElementById('sv-available');
  if (availEl) availEl.textContent = fmt(availablePerCheck);

  // Planned total
  const plannedEl = document.getElementById('sv-planned');
  if (plannedEl) {
    plannedEl.textContent = fmt(totalPlanned);
    plannedEl.title = 'Auto-allocated for future paychecks — not yet saved';
  }

  // On-track count
  const onTrackEl = document.getElementById('sv-on-track');
  if (onTrackEl) {
    const withTarget = active.filter(g => g.target_date);
    const onTrack = withTarget.filter(g => g.on_track);
    if (withTarget.length > 0) {
      onTrackEl.textContent = `${onTrack.length}/${withTarget.length}`;
      onTrackEl.className = onTrack.length === withTarget.length
        ? 'stat-value green' : 'stat-value amber';
    } else {
      onTrackEl.textContent = '—';
    }
  }
}

function renderGoals() {
  const grid = document.getElementById('savings-grid');
  const active = allGoals.filter(g => g.active);

  if (active.length === 0) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="empty-icon">🏦</div><p>No savings goals yet. Create your first one!</p></div>`;
    return;
  }

  grid.innerHTML = active.map(g => {
    const pct = Math.min(100, g.progress_pct || 0);
    const remaining = Math.max(0, g.target_amount - g.current_amount);
    const r = 38, circ = 2 * Math.PI * r;
    const dash = (pct / 100) * circ;
    const checksNeeded = g.per_check_contribution > 0 ? Math.ceil(remaining / g.per_check_contribution) : null;
    const projDate = checksNeeded
      ? new Date(Date.now() + checksNeeded * 14 * 24 * 60 * 60 * 1000).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
      : null;
    const ringColor = g.color || '#14b8a6';
    const offTrack = g.target_date && !g.on_track;
    const planned = g.planned || 0;

    // Milestone badges
    let milestones = '';
    if (pct >= 100) milestones = '<span class="badge badge-green" style="font-size:9px;margin-left:4px">🏆 DONE</span>';
    else if (pct >= 75) milestones = '<span class="badge badge-green" style="font-size:9px;margin-left:4px">🔥 75%+</span>';
    else if (pct >= 50) milestones = '<span class="badge badge-blue" style="font-size:9px;margin-left:4px">⭐ Halfway</span>';
    else if (pct >= 25) milestones = '<span class="badge badge-purple" style="font-size:9px;margin-left:4px">📈 25%+</span>';

    // Contribution velocity
    const velocity = g.savings_velocity || 0;
    let velocityBadge = '';
    if (velocity > 0) velocityBadge = '<span style="color:var(--green);font-size:11px;font-weight:600">↑ Growing</span>';
    else if (velocity < 0) velocityBadge = '<span style="color:var(--amber);font-size:11px;font-weight:600">↓ Slowing</span>';

    // Recent contributions mini-list
    const recentHtml = (g.recent_contributions || []).slice(0, 3).map(c => `
      <div style="display:flex;justify-content:space-between;font-size:11px;padding:4px 0;border-bottom:1px solid var(--border)">
        <span style="color:var(--text-muted)">${c.auto ? '⚡' : '📝'} ${fmtShortDate(c.date)}</span>
        <span style="color:var(--green);font-weight:600">+${fmt(c.amount)}</span>
      </div>
    `).join('');

    return `
      <div class="savings-card ${offTrack ? 'off-track' : ''}" style="position:relative">
        ${pct >= 100 ? '<div style="position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,var(--green),var(--teal));border-radius:var(--radius-lg) var(--radius-lg) 0 0"></div>' : ''}
        <div style="display:flex;align-items:center;gap:16px;margin-bottom:16px">
          <div class="ring-wrap" style="width:90px;height:90px">
            <svg width="90" height="90" viewBox="0 0 90 90">
              <circle cx="45" cy="45" r="${r}" fill="none" stroke="var(--border)" stroke-width="7"/>
              <circle cx="45" cy="45" r="${r}" fill="none" stroke="${ringColor}" stroke-width="7"
                stroke-dasharray="${dash} ${circ}" stroke-linecap="round" style="transition:stroke-dasharray 0.8s ease;filter:drop-shadow(0 0 6px ${ringColor}55)"/>
            </svg>
            <div class="ring-pct" style="color:${ringColor};font-size:15px">${Math.round(pct)}%</div>
          </div>
          <div style="flex:1;min-width:0">
            <div class="savings-name">${g.name}
              ${g.auto_allocate ? '<span class="badge badge-teal" style="font-size:10px;margin-left:6px">⚡ AUTO</span>' : ''}
              ${g.priority > 0 ? `<span class="badge badge-amber" style="font-size:10px;margin-left:4px">P${g.priority}</span>` : ''}
              ${milestones}
            </div>
            <div style="font-size:12px;color:var(--text-secondary);margin-top:2px">
              ${g.target_date ? `Target: ${fmtDate(g.target_date)}` : 'No target date'}
            </div>
            ${projDate ? `<div style="font-size:11px;color:var(--text-muted);margin-top:2px">Projected: ${projDate}</div>` : ''}
            ${g.target_date ? `<div style="font-size:11px;margin-top:4px;font-weight:600;color:${g.on_track ? 'var(--green)' : 'var(--amber)'}">
              ${g.on_track ? '✓ On track' : `⚠️ Needs ${fmt(g.suggested_per_check)}/check to catch up`}
            </div>` : ''}
            ${velocityBadge ? `<div style="margin-top:4px">${velocityBadge}</div>` : ''}
          </div>
        </div>

        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
          <div style="font-size:24px;font-weight:800;color:${ringColor}">${fmt(g.current_amount)}</div>
          <div style="font-size:13px;color:var(--text-secondary)">of ${fmt(g.target_amount)}</div>
        </div>
        <div class="progress-bar"><div class="progress-fill" style="width:${pct}%;background:${ringColor}"></div></div>

        <div style="display:flex;justify-content:space-between;margin-top:10px;font-size:12px;color:var(--text-muted)">
          <span>${fmt(remaining)} to go</span>
          <span>${fmt(g.per_check_contribution || 0)}/check · ${checksNeeded ? checksNeeded + ' checks left' : 'No auto-contribution'}</span>
        </div>

        ${planned > 0 ? `
          <div style="margin-top:8px;padding:6px 10px;background:var(--blue-dim);border:1px solid rgba(59,130,246,0.2);border-radius:var(--radius-sm);font-size:11px;color:var(--blue)">
            📋 ${fmt(planned)} planned from upcoming paychecks
          </div>
        ` : ''}

        ${recentHtml ? `
          <div style="margin-top:12px;border-top:1px solid var(--border);padding-top:10px">
            <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;color:var(--text-muted);margin-bottom:6px">Recent Activity</div>
            ${recentHtml}
          </div>
        ` : ''}

        ${g.note ? `<div style="font-size:12px;color:var(--text-muted);margin-top:10px;border-top:1px solid var(--border);padding-top:10px">${g.note}</div>` : ''}

        <div class="savings-actions">
          <button class="btn btn-secondary btn-sm" onclick="openContrib(${g.id}, '${g.name.replace(/'/g,"\\'")}')">+ Contribute</button>
          <button class="btn btn-icon btn-sm" onclick="viewHistory(${g.id}, '${g.name.replace(/'/g,"\\'")}')" title="History">📜</button>
          <button class="btn btn-icon btn-sm" onclick="editGoal(${g.id})" title="Edit">✏️</button>
          <button class="btn btn-icon btn-sm btn-danger" onclick="deleteGoal(${g.id})" title="Delete">🗑️</button>
        </div>
      </div>
    `;
  }).join('');
}

async function renderSavingsChart() {
  const canvas = document.getElementById('savings-trend-chart');
  if (!canvas) return;

  try {
    const contributions = await API.get('/api/savings/analytics');
    if (!contributions || !contributions.monthly_totals) return;

    const months = contributions.monthly_totals;
    const labels = months.map(m => m.month);
    const data = months.map(m => m.total);
    const cumulative = [];
    let runningTotal = contributions.base_total || 0;
    months.forEach(m => {
      runningTotal += m.total;
      cumulative.push(runningTotal);
    });

    if (savingsChart) savingsChart.destroy();
    savingsChart = new Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'Monthly Contributions',
            data,
            backgroundColor: 'rgba(20, 184, 166, 0.3)',
            borderColor: '#14b8a6',
            borderWidth: 1.5,
            borderRadius: 6,
            order: 2
          },
          {
            label: 'Cumulative Saved',
            data: cumulative,
            type: 'line',
            borderColor: '#22c55e',
            backgroundColor: 'rgba(34, 197, 94, 0.1)',
            fill: true,
            tension: 0.4,
            borderWidth: 2,
            pointRadius: 3,
            pointBackgroundColor: '#22c55e',
            order: 1
          }
        ]
      },
      options: {
        responsive: true,
        interaction: { intersect: false, mode: 'index' },
        plugins: {
          legend: {
            labels: { color: '#8b96b0', font: { family: 'Inter', size: 11 } }
          },
          tooltip: {
            callbacks: {
              label: c => ` ${c.dataset.label}: ${fmt(c.raw)}`
            }
          }
        },
        scales: {
          x: {
            grid: { color: 'rgba(255,255,255,0.04)' },
            ticks: { color: '#4a5568', font: { size: 10 } }
          },
          y: {
            grid: { color: 'rgba(255,255,255,0.04)' },
            ticks: {
              color: '#4a5568',
              font: { size: 10 },
              callback: v => '$' + (v >= 1000 ? (v/1000).toFixed(0) + 'k' : v)
            }
          }
        }
      }
    });
  } catch (e) {
    console.warn('Savings analytics not available:', e);
  }
}

async function viewHistory(goalId, name) {
  try {
    const contributions = await API.get(`/api/savings/${goalId}/contributions`);
    const body = document.getElementById('history-body');
    const title = document.getElementById('history-title');
    if (title) title.textContent = `Contribution History · ${name}`;

    if (!contributions || contributions.length === 0) {
      body.innerHTML = `<div class="empty-state"><div class="empty-icon">📜</div><p>No contributions yet.</p></div>`;
    } else {
      const totalContrib = contributions.reduce((s, c) => s + c.amount, 0);
      body.innerHTML = `
        <div style="display:flex;justify-content:space-between;padding:12px 0;border-bottom:1px solid var(--border);margin-bottom:12px">
          <span style="color:var(--text-muted);font-size:13px">${contributions.length} contributions</span>
          <span style="color:var(--green);font-weight:700;font-size:15px">${fmt(totalContrib)}</span>
        </div>
        ${contributions.map(c => `
          <div class="breakdown-row" style="gap:12px">
            <div style="flex:1">
              <div style="font-weight:600;font-size:13px">
                ${c.auto ? '⚡ Auto' : '📝 Manual'} — ${fmtShortDate(c.date || c.paycheck_date)}
              </div>
              <div style="font-size:11px;color:var(--text-muted)">${c.note || ''}${c.paycheck_date ? ` · Paycheck ${fmtShortDate(c.paycheck_date)}` : ''}</div>
            </div>
            <div style="font-weight:700;color:var(--green)">+${fmt(c.amount)}</div>
          </div>
        `).join('')}
      `;
    }
    openModal('history-modal');
  } catch (e) {
    toast('Error loading history: ' + e.message, 'error');
  }
}

function populatePaycheckDropdown() {
  const today = new Date().toISOString().split('T')[0];
  const html = `<option value="">— None —</option>` +
    allPaychecks.filter(p => p.date >= today).slice(0, 20)
      .map(p => `<option value="${p.id}">${fmtShortDate(p.date)} — ${fmt(p.amount)}${p.is_extra ? ' 🎁' : ''}</option>`).join('');
  document.getElementById('contrib-paycheck').innerHTML = html;
}

function updateProjection() {
  const target = parseFloat(document.getElementById('goal-target').value) || 0;
  const current = parseFloat(document.getElementById('goal-current').value) || 0;
  const perCheck = parseFloat(document.getElementById('goal-per-check').value) || 0;
  const proj = document.getElementById('goal-projection');
  if (perCheck > 0 && target > current) {
    const checksNeeded = Math.ceil((target - current) / perCheck);
    const projDate = new Date(Date.now() + checksNeeded * 14 * 24 * 60 * 60 * 1000);
    document.getElementById('goal-proj-date').textContent = projDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    document.getElementById('goal-proj-checks').textContent = `${checksNeeded} paychecks · ${fmt(perCheck)} × ${checksNeeded} = ${fmt(perCheck * checksNeeded)}`;
    proj.style.display = 'block';
  } else {
    proj.style.display = 'none';
  }
}

function openAddGoal() {
  editingGoalId = null;
  document.getElementById('goal-form').reset();
  document.getElementById('goal-id').value = '';
  document.getElementById('goal-color').value = '#14b8a6';
  document.getElementById('goal-current').value = '0';
  document.getElementById('goal-auto').checked = true;
  document.getElementById('goal-priority').value = '0';
  document.getElementById('goal-modal-title').textContent = 'Add Savings Goal';
  document.getElementById('goal-projection').style.display = 'none';
  openModal('goal-modal');
}

function editGoal(id) {
  const g = allGoals.find(x => x.id === id);
  if (!g) return;
  editingGoalId = id;
  document.getElementById('goal-id').value = id;
  document.getElementById('goal-name').value = g.name;
  document.getElementById('goal-target').value = g.target_amount;
  document.getElementById('goal-current').value = g.current_amount - (g.contributed || 0);
  document.getElementById('goal-per-check').value = g.per_check_contribution || '';
  document.getElementById('goal-date').value = g.target_date || '';
  document.getElementById('goal-color').value = g.color || '#14b8a6';
  document.getElementById('goal-note').value = g.note || '';
  document.getElementById('goal-auto').checked = !!g.auto_allocate;
  document.getElementById('goal-priority').value = g.priority || 0;
  document.getElementById('goal-modal-title').textContent = 'Edit Goal';
  updateProjection();
  openModal('goal-modal');
}

async function deleteGoal(id) {
  if (!confirm2('Delete this savings goal and all contributions?')) return;
  await API.del(`/api/savings/${id}`);
  toast('Goal deleted');
  loadSavings();
}

function openContrib(id, name) {
  document.getElementById('contrib-goal-id').value = id;
  document.getElementById('contrib-modal-title').textContent = `Contribute to ${name}`;
  document.getElementById('contrib-form').reset();
  document.getElementById('contrib-goal-id').value = id;
  document.getElementById('contrib-date').value = new Date().toISOString().split('T')[0];
  openModal('contrib-modal');
}

async function autoAllocateAll() {
  const btn = document.getElementById('auto-allocate-btn');
  const origText = btn ? btn.textContent : '';
  try {
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Allocating…'; }

    const minBalance = parseFloat(document.getElementById('min-balance-input')?.value) || 0;
    const count = parseInt(document.getElementById('allocate-count')?.value) || 6;

    const r = await API.post('/api/savings/auto-allocate-upcoming', {
      count,
      min_balance: minBalance
    });

    if (r.contributions_created === 0) {
      toast('No contributions created — check that goals have per-check amounts or auto-allocate enabled, and that upcoming paychecks exist.', 'error');
    } else {
      toast(`✓ Allocated ${r.contributions_created} contributions across ${r.paychecks_processed} paychecks (${fmt(r.total_amount)})`);
    }
    loadSavings();
  } catch (err) {
    console.error('Auto-allocate failed:', err);
    toast('Auto-allocate failed: ' + (err.message || 'Unknown error'), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = origText || '⚡ Auto-Allocate Upcoming'; }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadSavings();

  ['goal-target','goal-current','goal-per-check'].forEach(id =>
    document.getElementById(id).addEventListener('input', updateProjection)
  );

  document.getElementById('goal-form').addEventListener('submit', async e => {
    e.preventDefault();
    const payload = {
      name: document.getElementById('goal-name').value,
      target_amount: parseFloat(document.getElementById('goal-target').value),
      current_amount: parseFloat(document.getElementById('goal-current').value) || 0,
      per_check_contribution: parseFloat(document.getElementById('goal-per-check').value) || 0,
      target_date: document.getElementById('goal-date').value || null,
      color: document.getElementById('goal-color').value,
      note: document.getElementById('goal-note').value,
      auto_allocate: document.getElementById('goal-auto').checked ? 1 : 0,
      priority: parseInt(document.getElementById('goal-priority').value) || 0,
      active: 1
    };
    if (editingGoalId) {
      await API.put(`/api/savings/${editingGoalId}`, payload);
      toast('Goal updated ✓');
    } else {
      await API.post('/api/savings', payload);
      toast('Goal created ✓');
    }
    closeModal('goal-modal');
    loadSavings();
  });

  document.getElementById('contrib-form').addEventListener('submit', async e => {
    e.preventDefault();
    const goalId = document.getElementById('contrib-goal-id').value;
    await API.post(`/api/savings/${goalId}/contribute`, {
      amount: parseFloat(document.getElementById('contrib-amount').value),
      paycheck_id: document.getElementById('contrib-paycheck').value || null,
      date: document.getElementById('contrib-date').value,
      note: document.getElementById('contrib-note').value
    });
    toast('Contribution added ✓');
    closeModal('contrib-modal');
    loadSavings();
  });

  const btn = document.getElementById('auto-allocate-btn');
  if (btn) btn.addEventListener('click', autoAllocateAll);
});
