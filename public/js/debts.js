let allDebts = [];
let editingDebt = null;

async function loadDebts() {
  allDebts = await API.get('/api/debts');
  renderStats();
  renderGrid();
  loadStrategy();
}

function renderStats() {
  const total = allDebts.reduce((s, d) => s + d.balance, 0);
  const min = allDebts.reduce((s, d) => s + (d.minimum_payment || 0), 0);
  const wApr = total > 0 ? allDebts.reduce((s, d) => s + d.apr * d.balance, 0) / total : 0;
  document.getElementById('d-total').textContent = fmt(total);
  document.getElementById('d-apr').textContent = wApr.toFixed(1) + '%';
  document.getElementById('d-min').textContent = fmt(min);
}

function renderGrid() {
  const grid = document.getElementById('debts-grid');
  if (allDebts.length === 0) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="empty-icon">🎉</div><p>Debt-free — or just haven't added any yet. Add a debt to track payoff.</p></div>`;
    return;
  }
  grid.innerHTML = allDebts.map(d => {
    const pct = d.original_balance > 0 ? Math.min(100, ((d.original_balance - d.balance) / d.original_balance) * 100) : 0;
    return `
      <div class="debt-card ${d.apr >= 15 ? 'high-apr' : ''}" onclick="editDebt(${d.id})">
        <div style="position:absolute;left:0;top:0;bottom:0;width:4px;background:${d.color || '#ef4444'}"></div>
        <div style="font-weight:700;font-size:15px">${d.name}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px">${d.type.replace('_',' ')}</div>
        <div style="font-size:28px;font-weight:800;color:${d.color || '#ef4444'};letter-spacing:-1px">${fmt(d.balance)}</div>
        <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
          <span class="badge ${d.apr >= 15 ? 'badge-red' : d.apr >= 7 ? 'badge-amber' : 'badge-gray'}">${d.apr}% APR</span>
          ${d.minimum_payment > 0 ? `<span class="badge badge-gray">${fmt(d.minimum_payment)}/mo min</span>` : ''}
        </div>
        ${d.original_balance > 0 ? `
          <div style="margin-top:12px">
            <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-muted);margin-bottom:4px"><span>Paid down</span><span>${pct.toFixed(0)}%</span></div>
            <div class="progress-bar"><div class="progress-fill" style="width:${pct}%;background:${d.color || '#ef4444'}"></div></div>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
}

async function loadStrategy() {
  if (allDebts.length === 0) {
    document.getElementById('strat-title').textContent = 'No debts — invest the surplus instead 🚀';
    return;
  }
  const extra = parseFloat(document.getElementById('extra-input').value) || 0;
  const s = await API.get(`/api/debts/strategy?extra=${extra}`);

  document.getElementById('strat-title').textContent = `Recommend: ${s.recommended.toUpperCase()} · pay ${fmt(extra)} extra/mo`;
  document.getElementById('ava-time').textContent = s.avalanche.years + 'y ' + (s.avalanche.months % 12) + 'mo';
  document.getElementById('ava-int').textContent = `Total interest paid: ${fmt(s.avalanche.interest)}`;
  document.getElementById('ava-order').textContent = '→ ' + s.avalanche.order.join(' → ');
  document.getElementById('sno-time').textContent = s.snowball.years + 'y ' + (s.snowball.months % 12) + 'mo';
  document.getElementById('sno-int').textContent = `Total interest paid: ${fmt(s.snowball.interest)}`;
  document.getElementById('sno-order').textContent = '→ ' + s.snowball.order.join(' → ');

  const savings = s.savings;
  const rec = s.recommended === 'avalanche'
    ? `<strong>💡 Avalanche saves ${fmt(Math.abs(savings))} in interest</strong> vs snowball. It's mathematically optimal: pay extra toward the highest-APR debt first while making minimums on the rest.`
    : `<strong>💡 Snowball costs you ${fmt(Math.abs(savings))} extra</strong> but the quick early wins build momentum. Pick this if motivation matters more than pure math.`;
  document.getElementById('strat-recommend').innerHTML = rec;
}

function openAddDebt() {
  editingDebt = null;
  document.getElementById('debt-form').reset();
  document.getElementById('debt-id').value = '';
  document.getElementById('debt-color').value = '#ef4444';
  document.getElementById('debt-title').textContent = 'Add Debt';
  document.getElementById('debt-delete').style.display = 'none';
  openModal('debt-modal');
}

function editDebt(id) {
  const d = allDebts.find(x => x.id === id);
  if (!d) return;
  editingDebt = id;
  document.getElementById('debt-id').value = id;
  document.getElementById('debt-name').value = d.name;
  document.getElementById('debt-type').value = d.type;
  document.getElementById('debt-balance').value = d.balance;
  document.getElementById('debt-apr').value = d.apr;
  document.getElementById('debt-min').value = d.minimum_payment || '';
  document.getElementById('debt-orig').value = d.original_balance || '';
  document.getElementById('debt-due').value = d.due_day || '';
  document.getElementById('debt-color').value = d.color || '#ef4444';
  document.getElementById('debt-note').value = d.note || '';
  document.getElementById('debt-title').textContent = 'Edit Debt';
  document.getElementById('debt-delete').style.display = 'inline-flex';
  openModal('debt-modal');
}

async function deleteDebt() {
  if (!editingDebt || !confirm2('Delete this debt?')) return;
  await API.del(`/api/debts/${editingDebt}`);
  toast('Deleted');
  closeModal('debt-modal');
  loadDebts();
}

document.addEventListener('DOMContentLoaded', () => {
  loadDebts();
  document.getElementById('debt-form').addEventListener('submit', async e => {
    e.preventDefault();
    const payload = {
      name: document.getElementById('debt-name').value,
      type: document.getElementById('debt-type').value,
      balance: parseFloat(document.getElementById('debt-balance').value),
      apr: parseFloat(document.getElementById('debt-apr').value),
      minimum_payment: parseFloat(document.getElementById('debt-min').value) || 0,
      original_balance: parseFloat(document.getElementById('debt-orig').value) || null,
      due_day: parseInt(document.getElementById('debt-due').value) || null,
      color: document.getElementById('debt-color').value,
      note: document.getElementById('debt-note').value,
      active: 1
    };
    if (editingDebt) await API.put(`/api/debts/${editingDebt}`, payload);
    else await API.post('/api/debts', payload);
    toast('Saved ✓');
    closeModal('debt-modal');
    loadDebts();
  });
});
