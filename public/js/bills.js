let allBills = [];
let billsPieChart = null;
let budgetPieChart = null;
let editingId = null;
let activeFilter = 'all';

async function loadBills() {
  allBills = await API.get('/api/bills?include_savings=1');
  renderBills();
  renderStats();
  renderPieCharts();
}

function renderStats() {
  const active = allBills.filter(b => b.active);
  const total = active.reduce((s, b) => s + (b.computed_portion || 0), 0);
  const splitCount = active.filter(b => !b.is_savings && b.split_count > 1).length;
  const today = new Date();
  const dueSoon = active.filter(b => {
    if (!b.due_day || b.is_savings) return false;
    const due = new Date(today.getFullYear(), today.getMonth(), b.due_day);
    const diff = Math.ceil((due - today) / 86400000);
    return diff >= 0 && diff <= 7;
  }).length;

  document.getElementById('s-total').textContent = fmt(total);
  document.getElementById('s-count').textContent = active.length;
  document.getElementById('s-split').textContent = splitCount;
  document.getElementById('s-due-soon').textContent = dueSoon;
}

function renderBills() {
  const tbody = document.getElementById('bills-tbody');
  const filtered = activeFilter === 'all' ? allBills : allBills.filter(b => b.category === activeFilter);

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><div class="empty-icon">🧾</div><p>No bills yet. Add your first bill!</p></div></td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(b => {
    const portion = b.computed_portion || 0;
    const slotLabel = { auto: 'Auto', every_check: 'Every Check', check1: '1st Check', check2: '2nd Check', split: 'Both' }[b.paycheck_slot] || 'Auto';
    // Status indicator
    let statusBar = '';
    if (b.due_day) {
      const today = new Date();
      const thisMonth = new Date(today.getFullYear(), today.getMonth(), b.due_day);
      const days = Math.ceil((thisMonth - today) / 86400000);
      if (days < 0) statusBar = 'status-overdue';
      else if (days <= 3) statusBar = 'status-urgent';
      else if (days <= 7) statusBar = 'status-soon';
      else statusBar = 'status-ok';
    }

    // Savings pseudo-bill row
    if (b.is_savings) {
      const pct = b.target_amount > 0 ? Math.min(100, (b.current_progress / b.target_amount) * 100) : 0;
      return `
        <tr class="bill-row savings-row" style="background:linear-gradient(90deg, rgba(20,184,166,0.04), transparent)">
          <td>
            <div style="display:flex;align-items:center;gap:8px">
              <span style="width:10px;height:10px;border-radius:3px;background:${b.color};flex-shrink:0;display:inline-block"></span>
              <div>
                <div style="font-weight:600">🏦 ${b.name}
                  <span class="badge badge-teal" style="font-size:9px;margin-left:4px">SAVINGS</span>
                  ${b.auto_allocate ? '<span class="badge badge-green" style="font-size:9px">⚡ AUTO</span>' : ''}
                  ${b.priority > 0 ? `<span class="badge badge-amber" style="font-size:9px">P${b.priority}</span>` : ''}
                </div>
                <div style="font-size:11px;color:var(--text-muted)">Savings · ${fmt(b.current_progress)} of ${fmt(b.target_amount)} (${pct.toFixed(0)}%)</div>
              </div>
            </div>
          </td>
          <td style="color:var(--text-secondary)">${fmt(b.per_check_contribution)}/check</td>
          <td><span class="badge badge-teal">Goal</span></td>
          <td style="font-weight:700;color:var(--teal)">${fmt(portion)}</td>
          <td><span style="color:var(--text-muted)">monthly</span></td>
          <td><span class="badge badge-teal">${slotLabel}</span></td>
          <td>
            <div style="display:flex;gap:6px">
              <button class="btn btn-icon" title="Edit goal" onclick="editSavingsGoal(${b.savings_goal_id})">✏️</button>
              <a class="btn btn-icon" title="Open Savings page" href="/savings.html">↗</a>
            </div>
          </td>
        </tr>
      `;
    }

    return `
      <tr class="bill-row ${statusBar}">
        <td>
          <div style="display:flex;align-items:center;gap:8px">
            <span style="width:10px;height:10px;border-radius:3px;background:${b.color};flex-shrink:0;display:inline-block"></span>
            <div>
              <div style="font-weight:600">${b.name}
                ${b.variable ? '<span class="badge badge-amber" style="font-size:9px;margin-left:4px">VARIABLE</span>' : ''}
                ${b.remaining_payments != null ? `<span class="badge badge-purple" style="font-size:9px;margin-left:4px">${b.remaining_payments} left</span>` : ''}
              </div>
              <div style="font-size:11px;color:var(--text-muted)">${b.category}</div>
            </div>
          </div>
        </td>
        <td style="color:var(--text-secondary)">${fmt(b.total_amount)}</td>
        <td>
          ${b.split_count > 1
            ? `<span class="badge badge-blue">÷ ${b.split_count} people</span>`
            : `<span class="badge badge-gray">No split</span>`}
        </td>
        <td style="font-weight:700;color:var(--red)">${fmt(portion)}</td>
        <td>${b.due_day ? dueBadge(b.due_day) : '<span style="color:var(--text-muted)">—</span>'}</td>
        <td><span class="badge badge-gray">${slotLabel}</span></td>
        <td>
          <div style="display:flex;gap:6px">
            <button class="btn btn-icon" title="History" onclick="openHistory(${b.id}, '${b.name.replace(/'/g,"\\'")}')">📜</button>
            <button class="btn btn-icon" title="Edit" onclick="editBill(${b.id})">✏️</button>
            <button class="btn btn-icon btn-danger" title="Delete" onclick="deleteBill(${b.id})">🗑️</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function renderPieCharts() {
  // ── Bills by Category pie ─────────────────────────────────────────────────
  const catMap = {};
  allBills.filter(b => b.active).forEach(b => {
    const cat = b.category || 'Other';
    catMap[cat] = (catMap[cat] || 0) + (b.computed_portion || 0);
  });
  const catLabels = Object.keys(catMap);
  const catValues = Object.values(catMap);
  const catColors = catLabels.map(l => categoryColor(l));

  if (billsPieChart) billsPieChart.destroy();
  const ctx1 = document.getElementById('bills-pie').getContext('2d');
  billsPieChart = new Chart(ctx1, {
    type: 'pie',
    data: {
      labels: catLabels,
      datasets: [{
        data: catValues,
        backgroundColor: catColors.map(c => c + 'cc'),
        borderColor: catColors,
        borderWidth: 2,
        hoverOffset: 10
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => ` ${c.label}: ${fmt(c.raw)}` } }
      }
    }
  });

  // Custom legend
  document.getElementById('pie-legend').innerHTML = catLabels.map((l, i) => `
    <div style="display:flex;align-items:center;justify-content:space-between;font-size:12px">
      <div style="display:flex;align-items:center;gap:6px">
        <div style="width:10px;height:10px;border-radius:2px;background:${catColors[i]};flex-shrink:0"></div>
        <span style="color:var(--text-secondary)">${l}</span>
      </div>
      <span style="font-weight:600">${fmt(catValues[i])}</span>
    </div>
  `).join('');

  // ── Budget breakdown pie (income vs bills vs events vs savings) ───────────
  API.get('/api/dashboard').then(data => {
    const totalBills = allBills.filter(b => b.active && !b.is_savings).reduce((s, b) => s + (b.computed_portion || 0), 0);
    // Use the better of allBills savings (includes auto-allocate estimates) or dashboard savings
    const savingsFromBills = allBills.filter(b => b.active && b.is_savings).reduce((s, b) => s + (b.computed_portion || 0), 0);
    const totalSavings = Math.max(savingsFromBills, data.monthly.savings || 0);
    const incomeLeft = Math.max(0, (data.monthly.income || 0) - totalBills - (data.monthly.events || 0) - totalSavings);

    const bLabels = ['Bills', 'Events', 'Savings', 'Remaining'];
    const bValues = [totalBills, data.monthly.events || 0, totalSavings, incomeLeft];
    const bColors = ['#ef4444', '#a855f7', '#14b8a6', '#22c55e'];

    if (budgetPieChart) budgetPieChart.destroy();
    const ctx2 = document.getElementById('budget-pie').getContext('2d');
    budgetPieChart = new Chart(ctx2, {
      type: 'pie',
      data: {
        labels: bLabels,
        datasets: [{
          data: bValues,
          backgroundColor: bColors.map(c => c + 'cc'),
          borderColor: bColors,
          borderWidth: 2,
          hoverOffset: 10
        }]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: c => ` ${c.label}: ${fmt(c.raw)}` } }
        }
      }
    });

    document.getElementById('budget-legend').innerHTML = bLabels.map((l, i) => `
      <div style="display:flex;align-items:center;justify-content:space-between;font-size:12px">
        <div style="display:flex;align-items:center;gap:6px">
          <div style="width:10px;height:10px;border-radius:2px;background:${bColors[i]};flex-shrink:0"></div>
          <span style="color:var(--text-secondary)">${l}</span>
        </div>
        <span style="font-weight:600">${fmt(bValues[i])}</span>
      </div>
    `).join('');
  });
}

// ── Split calculator live preview ─────────────────────────────────────────────
function updateSplitPreview() {
  const total = parseFloat(document.getElementById('bill-total').value) || 0;
  const split = parseInt(document.getElementById('bill-split').value) || 1;
  const override = parseFloat(document.getElementById('bill-portion').value);
  const portion = !isNaN(override) && override > 0 ? override : total / split;
  document.getElementById('split-result').textContent = fmt(portion);
  document.getElementById('split-formula').textContent = split > 1
    ? `${fmt(total)} ÷ ${split} people`
    : 'Full amount (no split)';
}

// ── Edit ──────────────────────────────────────────────────────────────────────
function editBill(id) {
  const b = allBills.find(x => x.id === id);
  if (!b) return;
  if (b.is_savings) return editSavingsGoal(b.savings_goal_id);
  editingId = id;
  document.getElementById('bill-modal-title').textContent = 'Edit Bill';
  document.getElementById('bill-id').value = id;
  document.getElementById('bill-name').value = b.name;
  document.getElementById('bill-total').value = b.total_amount;
  document.getElementById('bill-split').value = b.split_count || 1;
  document.getElementById('bill-portion').value = b.my_portion || '';
  document.getElementById('bill-due').value = b.due_day || '';
  document.getElementById('bill-category').value = b.category || 'Other';
  document.getElementById('bill-slot').value = b.paycheck_slot || 'auto';
  document.getElementById('bill-color').value = b.color || '#ef4444';
  document.getElementById('bill-note').value = b.note || '';
  const rem = document.getElementById('bill-remaining');
  if (rem) rem.value = b.remaining_payments ?? '';
  const va = document.getElementById('bill-variable');
  if (va) va.checked = !!b.variable;
  updateSplitPreview();
  openModal('bill-modal');
}

async function openHistory(billId, name) {
  document.getElementById('history-title').textContent = `History · ${name}`;
  document.getElementById('history-body').innerHTML = '<div class="skeleton skeleton-text"></div>';
  openModal('history-modal');
  const occs = await API.get(`/api/bills/${billId}/occurrences`);
  if (occs.length === 0) {
    document.getElementById('history-body').innerHTML = `<div class="empty-state"><div class="empty-icon">📜</div><p>No occurrences yet. Tap a paycheck breakdown to assign &amp; track this bill.</p></div>`;
    return;
  }
  document.getElementById('history-body').innerHTML = occs.map(o => `
    <div class="breakdown-row" style="gap:12px">
      <div style="flex:1">
        <div style="font-weight:600">${o.paycheck_date ? fmtDate(o.paycheck_date) : 'Unassigned'}</div>
        <div style="font-size:11px;color:var(--text-muted)">${o.note || ''}</div>
      </div>
      <div style="text-align:right">
        <div style="font-size:11px;color:var(--text-muted)">Est: ${fmt(o.estimated_amount || 0)}</div>
        <input type="number" step="0.01" placeholder="actual" value="${o.actual_amount ?? ''}"
          style="width:90px;font-size:12px;padding:4px 8px;text-align:right"
          onchange="updateOccActual(${o.id}, this.value, ${o.paid})" />
      </div>
      <label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:12px">
        <input type="checkbox" ${o.paid ? 'checked' : ''} onchange="updateOccPaid(${o.id}, this.checked, ${o.actual_amount || 'null'})" />
        Paid
      </label>
    </div>
  `).join('');
}

async function updateOccActual(id, val, paid) {
  await API.put(`/api/bill-occurrences/${id}`, {
    actual_amount: val === '' ? null : parseFloat(val),
    paid: paid ? 1 : 0,
    note: null,
  });
  toast('Updated ✓');
}
async function editSavingsGoal(goalId) {
  const goals = await API.get('/api/savings');
  const g = goals.find(x => x.id === goalId);
  if (!g) return toast('Goal not found', 'error');
  document.getElementById('sve-id').value = g.id;
  document.getElementById('sve-name').value = g.name;
  document.getElementById('sve-target').value = g.target_amount;
  document.getElementById('sve-per').value = g.per_check_contribution || '';
  document.getElementById('sve-priority').value = g.priority || 0;
  document.getElementById('sve-date').value = g.target_date || '';
  document.getElementById('sve-auto').checked = !!g.auto_allocate;
  // Stash original goal so save can preserve fields we don't expose
  document.getElementById('savings-edit-form').dataset.original = JSON.stringify(g);
  openModal('savings-edit-modal');
}

async function updateOccPaid(id, checked, actual) {
  await API.put(`/api/bill-occurrences/${id}`, {
    actual_amount: actual,
    paid: checked ? 1 : 0,
    note: null,
  });
  toast(checked ? 'Marked paid ✓' : 'Unmarked');
}

async function deleteBill(id) {
  if (!confirm2('Delete this bill?')) return;
  await API.del(`/api/bills/${id}`);
  toast('Bill deleted');
  loadBills();
}

// ── Form submit ───────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadBills();

  // Category filter
  document.getElementById('cat-filter').addEventListener('click', e => {
    const btn = e.target.closest('.cat-btn');
    if (!btn) return;
    document.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeFilter = btn.dataset.cat;
    renderBills();
  });

  // Live split preview
  ['bill-total', 'bill-split', 'bill-portion'].forEach(id => {
    document.getElementById(id).addEventListener('input', updateSplitPreview);
  });

  // Form submit
  document.getElementById('bill-form').addEventListener('submit', async e => {
    e.preventDefault();
    const remVal = document.getElementById('bill-remaining').value;
    const payload = {
      name: document.getElementById('bill-name').value,
      total_amount: parseFloat(document.getElementById('bill-total').value),
      split_count: parseInt(document.getElementById('bill-split').value) || 1,
      my_portion: parseFloat(document.getElementById('bill-portion').value) || null,
      due_day: parseInt(document.getElementById('bill-due').value) || null,
      category: document.getElementById('bill-category').value,
      paycheck_slot: document.getElementById('bill-slot').value,
      color: document.getElementById('bill-color').value,
      note: document.getElementById('bill-note').value,
      remaining_payments: remVal === '' ? null : parseInt(remVal),
      variable: document.getElementById('bill-variable').checked ? 1 : 0,
      active: 1
    };

    if (editingId) {
      await API.put(`/api/bills/${editingId}`, payload);
      toast('Bill updated ✓');
    } else {
      await API.post('/api/bills', payload);
      toast('Bill added ✓');
    }
    editingId = null;
    document.getElementById('bill-form').reset();
    document.getElementById('bill-modal-title').textContent = 'Add Bill';
    closeModal('bill-modal');
    loadBills();
  });

  // Savings goal inline edit
  document.getElementById('savings-edit-form').addEventListener('submit', async e => {
    e.preventDefault();
    const id = document.getElementById('sve-id').value;
    const original = JSON.parse(e.currentTarget.dataset.original || '{}');
    const payload = {
      ...original,
      name: document.getElementById('sve-name').value,
      target_amount: parseFloat(document.getElementById('sve-target').value),
      per_check_contribution: parseFloat(document.getElementById('sve-per').value) || 0,
      priority: parseInt(document.getElementById('sve-priority').value) || 0,
      target_date: document.getElementById('sve-date').value || null,
      auto_allocate: document.getElementById('sve-auto').checked ? 1 : 0,
      active: 1,
    };
    // current_amount on goal record is the user-set base; the displayed "current_amount"
    // from /api/savings includes contributions, so subtract them to avoid double-count
    payload.current_amount = (original.current_amount || 0) - (original.contributed || 0);
    await API.put(`/api/savings/${id}`, payload);
    toast('Savings goal updated ✓');
    closeModal('savings-edit-modal');
    loadBills();
  });

  // Reset form on open for new bill
  document.getElementById('add-bill-btn').addEventListener('click', () => {
    editingId = null;
    document.getElementById('bill-form').reset();
    document.getElementById('bill-id').value = '';
    document.getElementById('bill-split').value = 1;
    document.getElementById('bill-color').value = '#ef4444';
    document.getElementById('bill-modal-title').textContent = 'Add Bill';
    updateSplitPreview();
  });
});
