let nwData = null;
let nwPie = null, nwTrend = null;
let editingAcct = null;

const TYPE_LABELS = {
  checking: 'Checking', savings: 'Savings', hysa: 'HYSA',
  brokerage: 'Brokerage', roth_ira: 'Roth IRA', '401k': '401(k)',
  investment: 'Investment', crypto: 'Crypto', property: 'Property',
  vehicle: 'Vehicle', cash: 'Cash', other: 'Other'
};
const TYPE_COLORS = {
  checking: '#22c55e', savings: '#14b8a6', hysa: '#06b6d4',
  brokerage: '#3b82f6', roth_ira: '#8b5cf6', '401k': '#a855f7',
  investment: '#6366f1', crypto: '#f59e0b', property: '#ec4899',
  vehicle: '#f97316', cash: '#84cc16', other: '#6b7280'
};

async function loadNetWorth() {
  nwData = await API.get('/api/networth');
  render();
}

function render() {
  const { net_worth, total_assets, total_debts, assets_by_type, accounts, history } = nwData;
  document.getElementById('nw-total').textContent = fmt(net_worth);
  document.getElementById('nw-total').style.color = net_worth >= 0 ? 'var(--green)' : 'var(--red)';
  document.getElementById('nw-assets').textContent = fmt(total_assets);
  document.getElementById('nw-debts').textContent = fmt(total_debts);
  const cash = accounts.filter(a => ['checking','savings','hysa','cash'].includes(a.type)).reduce((s,a) => s+a.balance, 0);
  const invest = accounts.filter(a => ['brokerage','roth_ira','401k','investment','crypto'].includes(a.type)).reduce((s,a) => s+a.balance, 0);
  document.getElementById('nw-cash').textContent = fmt(cash);
  document.getElementById('nw-invest').textContent = fmt(invest);

  // Accounts grid
  const grid = document.getElementById('accts-grid');
  if (accounts.length === 0) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="empty-icon">💎</div><p>No accounts yet. Add your first one!</p></div>`;
  } else {
    grid.innerHTML = accounts.map(a => `
      <div class="acct-card" style="cursor:pointer" onclick="editAcct(${a.id})">
        <div style="position:absolute;left:0;top:0;bottom:0;width:4px;background:${a.color || TYPE_COLORS[a.type]}"></div>
        <div class="acct-name">${a.name}</div>
        <div class="acct-inst">${a.institution || ''}</div>
        <div class="acct-bal" style="color:${a.color || TYPE_COLORS[a.type]}">${fmt(a.balance)}</div>
        <div style="margin-top:8px;display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <span class="acct-type">${TYPE_LABELS[a.type] || a.type}</span>
          ${a.apy > 0 ? `<span class="acct-type" style="color:var(--green)">${a.apy}% APY</span>` : ''}
        </div>
      </div>
    `).join('');
  }

  // Pie
  const labels = Object.keys(assets_by_type);
  const values = Object.values(assets_by_type);
  const colors = labels.map(l => TYPE_COLORS[l] || '#6b7280');
  if (nwPie) nwPie.destroy();
  if (labels.length > 0) {
    nwPie = new Chart(document.getElementById('nw-pie').getContext('2d'), {
      type: 'doughnut',
      data: { labels: labels.map(l => TYPE_LABELS[l] || l), datasets: [{ data: values, backgroundColor: colors.map(c => c+'cc'), borderColor: colors, borderWidth: 2 }] },
      options: { responsive: true, cutout: '60%', plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ` ${c.label}: ${fmt(c.raw)}` } } } }
    });
    document.getElementById('nw-pie-legend').innerHTML = labels.map((l, i) => `
      <div style="display:flex;justify-content:space-between;font-size:12px">
        <div style="display:flex;gap:6px;align-items:center"><span style="width:10px;height:10px;border-radius:2px;background:${colors[i]}"></span>${TYPE_LABELS[l] || l}</div>
        <span style="font-weight:600">${fmt(values[i])}</span></div>
    `).join('');
  }

  // Trend
  if (nwTrend) nwTrend.destroy();
  if (history && history.length > 1) {
    nwTrend = new Chart(document.getElementById('nw-trend').getContext('2d'), {
      type: 'line',
      data: { labels: history.map(h => fmtShortDate(h.date)), datasets: [{
        data: history.map(h => h.total), borderColor: '#22c55e',
        backgroundColor: 'rgba(34,197,94,0.15)', fill: true, tension: 0.35, pointRadius: 2
      }]},
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
        scales: { y: { ticks: { color: '#8b96b0', callback: v => '$' + v }, grid: { color: 'rgba(255,255,255,0.04)' } },
                  x: { ticks: { color: '#8b96b0', font: { size: 10 } }, grid: { display: false } } } }
    });
  } else {
    document.getElementById('nw-trend').parentElement.innerHTML = `<div style="text-align:center;color:var(--text-muted);padding:60px 0">Update an account balance to start tracking the trend.</div>`;
  }
}

function openAddAcct() {
  editingAcct = null;
  document.getElementById('acct-form').reset();
  document.getElementById('acct-id').value = '';
  document.getElementById('acct-title').textContent = 'Add Account';
  document.getElementById('acct-delete').style.display = 'none';
  openModal('acct-modal');
}

function editAcct(id) {
  const a = nwData.accounts.find(x => x.id === id);
  if (!a) return;
  editingAcct = id;
  document.getElementById('acct-id').value = id;
  document.getElementById('acct-name').value = a.name;
  document.getElementById('acct-type').value = a.type;
  document.getElementById('acct-balance').value = a.balance;
  document.getElementById('acct-apy').value = a.apy || 0;
  document.getElementById('acct-inst').value = a.institution || '';
  document.getElementById('acct-color').value = a.color || TYPE_COLORS[a.type];
  document.getElementById('acct-note').value = a.note || '';
  document.getElementById('acct-title').textContent = 'Edit Account';
  document.getElementById('acct-delete').style.display = 'inline-flex';
  openModal('acct-modal');
}

async function deleteAcct() {
  if (!editingAcct || !confirm2('Delete this account?')) return;
  await API.del(`/api/accounts/${editingAcct}`);
  toast('Account deleted');
  closeModal('acct-modal');
  loadNetWorth();
}

document.addEventListener('DOMContentLoaded', () => {
  loadNetWorth();
  document.getElementById('acct-form').addEventListener('submit', async e => {
    e.preventDefault();
    const payload = {
      name: document.getElementById('acct-name').value,
      type: document.getElementById('acct-type').value,
      balance: parseFloat(document.getElementById('acct-balance').value),
      apy: parseFloat(document.getElementById('acct-apy').value) || 0,
      institution: document.getElementById('acct-inst').value,
      color: document.getElementById('acct-color').value,
      note: document.getElementById('acct-note').value,
      active: 1
    };
    if (editingAcct) await API.put(`/api/accounts/${editingAcct}`, payload);
    else await API.post('/api/accounts', payload);
    toast('Saved ✓');
    closeModal('acct-modal');
    loadNetWorth();
  });
});
