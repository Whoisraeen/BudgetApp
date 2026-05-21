let categoryChart = null;
let netTrendChart = null;

async function loadDashboard() {
  const data = await API.get('/api/dashboard');

  // Greeting + date
  const now = new Date();
  const hour = now.getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  document.getElementById('greeting').textContent = `${greeting} 👋`;
  document.getElementById('today-date').textContent = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  // Next paycheck
  if (data.nextPaycheck) {
    const days = daysUntil(data.nextPaycheck.date);
    document.getElementById('next-paycheck-amount').textContent = fmt(data.nextPaycheck.amount);
    document.getElementById('next-paycheck-date').textContent =
      days === 0 ? '🎉 Today!' : days === 1 ? 'Tomorrow' : `In ${days} days — ${fmtShortDate(data.nextPaycheck.date)}`;
  }

  // Stat cards
  document.getElementById('monthly-bills').textContent = fmt(data.monthly.bills);
  document.getElementById('monthly-events').textContent = fmt(data.monthly.events);
  document.getElementById('monthly-savings').textContent = fmt(data.monthly.savings);

  // Breakdown
  document.getElementById('bd-income').textContent = fmt(data.monthly.income);
  document.getElementById('bd-bills').textContent = `−${fmt(data.monthly.bills)}`;
  document.getElementById('bd-events').textContent = `−${fmt(data.monthly.events)}`;
  document.getElementById('bd-savings').textContent = `−${fmt(data.monthly.savings)}`;
  const netEl = document.getElementById('bd-net');
  netEl.textContent = fmt(data.monthly.net);
  netEl.className = `amount ${data.monthly.net >= 0 ? 'positive' : 'negative'}`;

  // Upcoming bills
  const billsList = document.getElementById('upcoming-bills-list');
  if (data.upcomingBills.length === 0) {
    billsList.innerHTML = `<div class="empty-state"><div class="empty-icon">✅</div><p>No bills due in the next 14 days</p></div>`;
  } else {
    billsList.innerHTML = data.upcomingBills.map(b => `
      <div class="item-row">
        <span class="color-swatch" style="background:${b.color || '#ef4444'};border-radius:3px;width:12px;height:12px;display:inline-block;flex-shrink:0"></span>
        <div style="flex:1">
          <div class="item-name">${b.name}${b.split_count > 1 ? ` <span style="color:var(--text-muted);font-size:11px">÷${b.split_count}</span>` : ''}</div>
          <div class="item-meta">${b.category} · Due ${ordinal(b.due_day)}</div>
        </div>
        <div style="text-align:right">
          <div class="item-amount" style="color:var(--red)">${fmt(b.computed_portion)}</div>
          ${b.days_until <= 3 ? `<span class="due-badge due-urgent">In ${b.days_until}d</span>` :
            b.days_until <= 7 ? `<span class="due-badge due-soon">In ${b.days_until}d</span>` :
            `<span class="due-badge due-ok">In ${b.days_until}d</span>`}
        </div>
      </div>
    `).join('');
  }

  // Upcoming events
  const eventsList = document.getElementById('upcoming-events-list');
  if (data.upcomingEvents.length === 0) {
    eventsList.innerHTML = `<div class="empty-state"><div class="empty-icon">🎉</div><p>No upcoming events</p></div>`;
  } else {
    eventsList.innerHTML = data.upcomingEvents.map(e => `
      <div class="item-row">
        <span style="font-size:20px">🎉</span>
        <div style="flex:1">
          <div class="item-name">${e.name}</div>
          <div class="item-meta">${fmtDate(e.date)}${e.paycheck_date ? ` · Paycheck: ${fmtShortDate(e.paycheck_date)}` : ''}</div>
        </div>
        <div class="item-amount" style="color:var(--purple)">${fmt(e.estimated_cost)}</div>
      </div>
    `).join('');
  }

  // Savings goals
  const savingsList = document.getElementById('savings-list');
  if (data.savingsGoals.length === 0) {
    savingsList.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="empty-icon">🏦</div><p>No savings goals yet. <a href="/savings.html" style="color:var(--accent)">Add one →</a></p></div>`;
  } else {
    savingsList.innerHTML = data.savingsGoals.map(g => `
      <div class="savings-card">
        <div class="savings-header">
          <div>
            <div class="savings-name">${g.name}</div>
            <div class="savings-target">${g.target_date ? `Target: ${fmtShortDate(g.target_date)}` : 'No target date'}</div>
          </div>
          <span class="badge" style="background:${g.color}22;color:${g.color}">${Math.round(g.progress_pct)}%</span>
        </div>
        <div class="savings-amounts">
          <div class="savings-current" style="color:${g.color}">${fmt(g.current_amount)}</div>
          <div class="savings-target-amt">of ${fmt(g.target_amount)}</div>
        </div>
        <div class="progress-bar"><div class="progress-fill" style="width:${g.progress_pct}%;background:${g.color}"></div></div>
        <div class="savings-per-check">${fmt(g.per_check_contribution)} per paycheck</div>
      </div>
    `).join('');
  }

  // Net-remaining sparkline
  const trendCanvas = document.getElementById('net-trend-chart');
  if (trendCanvas && data.trend) {
    const trend = data.trend.filter(t => t.net_remaining != null);
    const trendEmpty = document.getElementById('net-trend-empty');
    if (trend.length === 0) {
      trendCanvas.style.display = 'none';
      if (trendEmpty) trendEmpty.style.display = 'block';
    } else {
      trendCanvas.style.display = 'block';
      if (trendEmpty) trendEmpty.style.display = 'none';
      const labels = trend.map(t => fmtShortDate(t.date));
      const values = trend.map(t => t.net_remaining);
      if (netTrendChart) netTrendChart.destroy();
      netTrendChart = new Chart(trendCanvas.getContext('2d'), {
        type: 'line',
        data: { labels, datasets: [{
          data: values, borderColor: '#22c55e',
          backgroundColor: 'rgba(34,197,94,0.12)', fill: true,
          tension: 0.4, pointRadius: 2,
          pointBackgroundColor: values.map(v => v >= 0 ? '#22c55e' : '#ef4444'),
        }]},
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ` Net: ${fmt(c.raw)}` } } },
          scales: {
            x: { display: false },
            y: { ticks: { color: '#8b96b0', callback: v => '$' + v, font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.04)' } }
          }
        }
      });
    }
  }

  // Category chart
  const cats = data.categoryTotals;
  const labels = Object.keys(cats);
  const values = Object.values(cats);
  const colors = labels.map(l => categoryColor(l));

  if (categoryChart) categoryChart.destroy();
  const ctx = document.getElementById('category-chart').getContext('2d');
  categoryChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: colors.map(c => c + '99'),
        borderColor: colors,
        borderWidth: 2,
        hoverOffset: 8
      }]
    },
    options: {
      responsive: true,
      cutout: '65%',
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: '#8b96b0', font: { size: 11 }, padding: 12, boxWidth: 12 }
        },
        tooltip: {
          callbacks: {
            label: ctx => ` ${ctx.label}: ${fmt(ctx.raw)}`
          }
        }
      }
    }
  });
}

document.addEventListener('DOMContentLoaded', loadDashboard);
