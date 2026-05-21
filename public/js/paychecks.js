let allPaychecks = [];
let showPast = false;
let trendChart = null;
let view = 'timeline'; // 'timeline' | 'list'

async function loadPaychecks() {
  allPaychecks = await API.get('/api/paychecks');
  renderStats();
  renderTimeline();
  renderList();
  renderTrend();
}

function renderStats() {
  const today = new Date().toISOString().split('T')[0];
  const future = allPaychecks.filter(p => p.date >= today);
  const next = future[0];
  if (next) {
    document.getElementById('pc-next-date').textContent = fmtShortDate(next.date);
    const days = daysUntil(next.date);
    document.getElementById('pc-days-away').textContent = days === 0 ? '🎉 Today!' : `In ${days} day${days !== 1 ? 's' : ''}`;
    document.getElementById('pc-amount').textContent = fmt(next.amount);
    document.getElementById('pc-yearly').textContent = fmt(next.amount * 26);
  }
  document.getElementById('pc-count').textContent = future.length;
}

function renderTimeline() {
  const today = new Date().toISOString().split('T')[0];
  const strip = document.getElementById('timeline-strip');
  if (!strip) return;
  const toShow = allPaychecks.filter(p => p.date >= today).slice(0, 8);

  if (toShow.length === 0) {
    strip.innerHTML = `<div style="color:var(--text-muted);padding:24px;text-align:center;width:100%">No upcoming paychecks. Generate a schedule below →</div>`;
    return;
  }

  strip.innerHTML = toShow.map((p, idx) => {
    const d = new Date(p.date + 'T12:00:00');
    const isNext = idx === 0;
    const isExtra = p.is_extra;
    const net = p.net_remaining;
    return `
      <div class="tl-card ${isNext ? 'tl-next' : ''} ${isExtra ? 'tl-extra' : ''}" onclick="toggleBreakdown(${p.id}, '${p.date}')">
        <div class="tl-date-row">
          <div class="tl-day">${d.getDate()}</div>
          <div class="tl-mon">${d.toLocaleDateString('en-US',{month:'short'})}</div>
        </div>
        <div class="tl-weekday">${d.toLocaleDateString('en-US',{weekday:'short'})}</div>
        <div class="tl-amount">${fmt(p.amount)}</div>
        ${isExtra ? '<div class="tl-tag tl-tag-bonus">🎁 BONUS</div>' : ''}
        ${isNext ? '<div class="tl-tag tl-tag-next">NEXT</div>' : ''}
        ${net != null ? `<div class="tl-net ${net >= 0 ? 'pos' : 'neg'}">${net >= 0 ? '+' : ''}${fmt(net)} left</div>` : '<div class="tl-net" style="color:var(--text-muted)">tap for breakdown</div>'}
      </div>
    `;
  }).join('');
}

function renderList() {
  const today = new Date().toISOString().split('T')[0];
  const list = document.getElementById('paychecks-list');
  const toShow = showPast ? allPaychecks : allPaychecks.filter(p => p.date >= today);

  if (toShow.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📅</div>
        <p>No paychecks scheduled yet.<br>Use the setup wizard to generate your schedule.</p>
      </div>`;
    return;
  }

  list.innerHTML = toShow.map(p => {
    const d = new Date(p.date + 'T12:00:00');
    const past = p.date < today;
    const isNext = !past && allPaychecks.filter(x => x.date >= today)[0]?.id === p.id;
    const isExtra = p.is_extra;
    return `
      <div class="pc-card ${past ? 'pc-past' : ''} ${isExtra ? 'pc-extra' : ''}" id="pc-${p.id}">
        <div class="pc-header" onclick="toggleBreakdown(${p.id}, '${p.date}')">
          <div class="pc-date-badge" ${isNext ? 'style="background:rgba(34,197,94,0.25);border-color:rgba(34,197,94,0.5)"' : ''}>
            <div class="day">${d.getDate()}</div>
            <div class="mon">${d.toLocaleDateString('en-US',{month:'short'})}</div>
          </div>
          <div class="pc-info">
            <div class="pc-label">${p.label || 'Paycheck'}
              ${isNext ? '<span class="badge badge-green" style="margin-left:6px">Next</span>' : ''}
              ${isExtra ? '<span class="badge badge-purple" style="margin-left:6px">🎁 Bonus check</span>' : ''}
            </div>
            <div class="pc-sub">${d.toLocaleDateString('en-US',{weekday:'long', year:'numeric', month:'long', day:'numeric'})}</div>
          </div>
          <div style="text-align:right">
            <div class="pc-amount">${fmt(p.amount)}</div>
            <div class="pc-net" id="net-${p.id}" style="color:${p.net_remaining != null ? (p.net_remaining >= 0 ? 'var(--green)' : 'var(--red)') : 'var(--text-muted)'}">
              ${p.net_remaining != null ? 'Net: ' + fmt(p.net_remaining) : 'tap for breakdown'}
            </div>
          </div>
          <span style="color:var(--text-muted);margin-left:8px;font-size:14px" id="chevron-${p.id}">▼</span>
        </div>
        <div class="pc-detail" id="detail-${p.id}"></div>
      </div>
    `;
  }).join('');
}

async function toggleBreakdown(id, date) {
  // If called from timeline card, scroll the list into view
  const card = document.getElementById(`pc-${id}`);
  if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });

  const detail = document.getElementById(`detail-${id}`);
  const chevron = document.getElementById(`chevron-${id}`);
  if (!detail) return;
  if (detail.classList.contains('open')) {
    detail.classList.remove('open');
    if (chevron) chevron.textContent = '▼';
    return;
  }
  detail.innerHTML = `<div class="skeleton skeleton-text"></div><div class="skeleton skeleton-text" style="width:60%"></div>`;
  detail.classList.add('open');
  if (chevron) chevron.textContent = '▲';

  try {
    const data = await API.get(`/api/paychecks/${id}/breakdown`);
    const { assignedBills, events, contributions, totals } = data;
    const net = totals.netRemaining;

    const netEl = document.getElementById(`net-${id}`);
    if (netEl) {
      netEl.textContent = `Net: ${fmt(net)}`;
      netEl.style.color = net >= 0 ? 'var(--green)' : 'var(--red)';
    }

    detail.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-bottom:16px">
        <div style="text-align:center">
          <div style="font-size:11px;color:var(--text-muted);margin-bottom:2px">Bills</div>
          <div style="font-weight:700;color:var(--red)">${fmt(totals.bills)}</div>
        </div>
        <div style="text-align:center">
          <div style="font-size:11px;color:var(--text-muted);margin-bottom:2px">Events</div>
          <div style="font-weight:700;color:var(--purple)">${fmt(totals.events)}</div>
        </div>
        <div style="text-align:center">
          <div style="font-size:11px;color:var(--text-muted);margin-bottom:2px">Savings</div>
          <div style="font-weight:700;color:var(--teal)">${fmt(totals.savings)}</div>
        </div>
      </div>

      ${assignedBills.length > 0 ? `
        <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.8px;margin-bottom:8px">Bills</div>
        ${assignedBills.map(b => `
          <div class="breakdown-row">
            <div style="display:flex;align-items:center;gap:6px">
              <span style="width:8px;height:8px;border-radius:2px;background:${b.color};display:inline-block"></span>
              <span class="label">${b.name}${b.split_count>1?` (÷${b.split_count})`:''}</span>
              ${b.paid ? '<span class="badge badge-green" style="font-size:9px">paid</span>' : ''}
            </div>
            <span class="amount negative">${fmt(b.assigned_portion)}</span>
          </div>
        `).join('')}
      ` : ''}

      ${events.length > 0 ? `
        <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.8px;margin:12px 0 8px">Events</div>
        ${events.map(e => `
          <div class="breakdown-row">
            <span class="label">🎉 ${e.name}</span>
            <span class="amount negative">${fmt(e.estimated_cost)}</span>
          </div>
        `).join('')}
      ` : ''}

      ${contributions.length > 0 ? `
        <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.8px;margin:12px 0 8px">Savings</div>
        ${contributions.map(c => `
          <div class="breakdown-row">
            <span class="label">🏦 ${c.goal_name} ${c.auto ? '<span class="badge badge-teal" style="font-size:9px">auto</span>' : ''}</span>
            <span class="amount negative">${fmt(c.amount)}</span>
          </div>
        `).join('')}
      ` : ''}

      <div class="breakdown-row total" style="margin-top:8px">
        <span class="label">Net Remaining</span>
        <span class="amount ${net >= 0 ? 'positive' : 'negative'}">${fmt(net)}</span>
      </div>

      <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
        <button class="btn btn-secondary btn-sm" onclick="openEditPc(${id}, event)">✏️ Edit</button>
        <button class="btn btn-secondary btn-sm" onclick="autoAllocate(${id})">⚡ Auto-allocate savings</button>
      </div>
    `;
  } catch (err) {
    detail.innerHTML = `<div style="color:var(--red);font-size:13px">Error loading breakdown</div>`;
  }
}

async function autoAllocate(id) {
  const r = await API.post(`/api/paychecks/${id}/auto-allocate`, {});
  toast(`✓ ${r.created.length} contribution${r.created.length !== 1 ? 's' : ''} allocated`);
  loadPaychecks();
}

function renderTrend() {
  const canvas = document.getElementById('trend-chart');
  if (!canvas) return;
  const data = allPaychecks
    .filter(p => p.net_remaining != null)
    .slice(-16);

  if (data.length === 0) {
    canvas.style.display = 'none';
    document.getElementById('trend-empty').style.display = 'block';
    return;
  }
  canvas.style.display = 'block';
  const empty = document.getElementById('trend-empty');
  if (empty) empty.style.display = 'none';

  const labels = data.map(p => fmtShortDate(p.date));
  const values = data.map(p => p.net_remaining);
  const avg = values.reduce((s, v) => s + v, 0) / values.length;
  document.getElementById('trend-avg').textContent = fmt(avg);

  if (trendChart) trendChart.destroy();
  trendChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Net remaining',
          data: values,
          borderColor: '#22c55e',
          backgroundColor: 'rgba(34,197,94,0.15)',
          fill: true,
          tension: 0.35,
          pointRadius: 3,
          pointBackgroundColor: values.map(v => v >= 0 ? '#22c55e' : '#ef4444'),
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => ` Net: ${fmt(c.raw)}` } }
      },
      scales: {
        x: { ticks: { color: '#8b96b0', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.03)' } },
        y: { ticks: { color: '#8b96b0', callback: v => '$' + v }, grid: { color: 'rgba(255,255,255,0.04)' } }
      }
    }
  });
}

function openEditPc(id, e) {
  e && e.stopPropagation();
  const pc = allPaychecks.find(p => p.id === id);
  if (!pc) return;
  document.getElementById('edit-pc-id').value = id;
  document.getElementById('edit-pc-amount').value = pc.amount;
  document.getElementById('edit-pc-label').value = pc.label || 'Paycheck';
  document.getElementById('edit-pc-note').value = pc.note || '';
  document.getElementById('edit-pc-title').textContent = `Edit Paycheck — ${fmtShortDate(pc.date)}`;
  openModal('edit-pc-modal');
}

function togglePast() {
  showPast = !showPast;
  document.getElementById('show-past-btn').textContent = showPast ? 'Hide Past' : 'Show Past';
  renderList();
}

async function generateSchedule() {
  const startDate = document.getElementById('gen-start-date').value;
  const amount = parseFloat(document.getElementById('gen-amount').value) || 0;
  const count = parseInt(document.getElementById('gen-count').value);
  const frequency = document.getElementById('gen-frequency').value;
  if (!startDate) return toast('Please select a start date', 'error');
  await API.post('/api/paychecks/generate', { startDate, amount, count, frequency });
  toast(`✓ Generated ${count} ${frequency} paychecks`);
  loadPaychecks();
}

document.addEventListener('DOMContentLoaded', async () => {
  // Load current pay frequency setting
  try {
    const s = await API.get('/api/settings');
    if (s.pay_frequency) document.getElementById('gen-frequency').value = s.pay_frequency;
  } catch {}

  loadPaychecks();

  document.getElementById('edit-pc-form').addEventListener('submit', async e => {
    e.preventDefault();
    const id = document.getElementById('edit-pc-id').value;
    await API.put(`/api/paychecks/${id}`, {
      amount: parseFloat(document.getElementById('edit-pc-amount').value),
      label: document.getElementById('edit-pc-label').value || 'Paycheck',
      note: document.getElementById('edit-pc-note').value
    });
    toast('Paycheck updated ✓');
    closeModal('edit-pc-modal');
    loadPaychecks();
  });
});
