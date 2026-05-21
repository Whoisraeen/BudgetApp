async function loadTaxes() {
  const year = document.getElementById('tax-year').value || new Date().getFullYear();
  const data = await API.get(`/api/taxes/summary?year=${year}`);
  const { totals, projected_annual_gross, projected_annual_tax, effective_tax_rate, stubs } = data;

  document.getElementById('tx-gross').textContent = fmt(totals.gross);
  document.getElementById('tx-gross-meta').textContent = `${data.stubs_count} paystubs`;
  document.getElementById('tx-total').textContent = fmt(totals.total_tax);
  document.getElementById('tx-rate').textContent = `${(effective_tax_rate*100).toFixed(1)}% effective`;
  document.getElementById('tx-proj').textContent = fmt(projected_annual_tax);
  document.getElementById('tx-net').textContent = fmt(totals.net);
  document.getElementById('tx-takehome-pct').textContent = totals.gross ? `${((totals.net/totals.gross)*100).toFixed(1)}% take-home` : '—';

  // Stacked bar of tax components
  const segs = [
    { label: 'Federal',  value: totals.federal,  color: '#ef4444' },
    { label: 'OASDI/SS', value: totals.oasdi,    color: '#f59e0b' },
    { label: 'Medicare', value: totals.medicare, color: '#a855f7' },
    { label: 'State',    value: totals.state,    color: '#3b82f6' },
    { label: 'City',     value: totals.city,     color: '#14b8a6' },
  ].filter(s => s.value > 0);
  const totalSeg = segs.reduce((s, x) => s + x.value, 0);
  document.getElementById('tax-bar').innerHTML = segs.map(s =>
    `<div class="tax-bar-seg" style="width:${(s.value/totalSeg*100).toFixed(2)}%;background:${s.color}" title="${s.label}: ${fmt(s.value)}">${(s.value/totalSeg*100).toFixed(0)}%</div>`
  ).join('');
  document.getElementById('tax-legend').innerHTML = segs.map(s =>
    `<div style="display:flex;align-items:center;gap:8px"><span style="width:12px;height:12px;background:${s.color};border-radius:3px"></span><div><div style="font-size:12px;color:var(--text-secondary)">${s.label}</div><div style="font-weight:700">${fmt(s.value)}</div></div></div>`
  ).join('');

  // Detail
  document.getElementById('tax-detail').innerHTML = `
    <div class="breakdown-row"><span class="label">Federal Withholding</span><span class="amount negative">${fmt(totals.federal)}</span></div>
    <div class="breakdown-row"><span class="label">Social Security (OASDI 6.2%)</span><span class="amount negative">${fmt(totals.oasdi)}</span></div>
    <div class="breakdown-row"><span class="label">Medicare (1.45%)</span><span class="amount negative">${fmt(totals.medicare)}</span></div>
    <div class="breakdown-row"><span class="label">State Tax</span><span class="amount negative">${fmt(totals.state)}</span></div>
    <div class="breakdown-row"><span class="label">City/Local Tax</span><span class="amount negative">${fmt(totals.city)}</span></div>
    <div class="breakdown-row total"><span class="label">Total YTD Tax</span><span class="amount negative">${fmt(totals.total_tax)}</span></div>
    <div class="breakdown-row"><span class="label">Pre-tax Deductions (medical, etc.)</span><span class="amount">${fmt(totals.deductions)}</span></div>
  `;

  // Insights — researched personal finance tax tips
  const insights = [];
  const annualGrossProj = projected_annual_gross;
  // 2024/2025 federal brackets (single filer, approximate)
  let bracket = 'Unknown';
  if      (annualGrossProj < 11600) bracket = '10% bracket';
  else if (annualGrossProj < 47150) bracket = '12% bracket';
  else if (annualGrossProj < 100525) bracket = '22% bracket';
  else if (annualGrossProj < 191950) bracket = '24% bracket';
  else if (annualGrossProj < 243725) bracket = '32% bracket';
  else if (annualGrossProj < 609350) bracket = '35% bracket';
  else bracket = '37% bracket';
  insights.push(`<div style="padding:10px;border-radius:8px;background:var(--accent-dim);margin-bottom:8px;font-size:13px"><strong>📊 Projected federal bracket:</strong> ${bracket} on projected ${fmt(annualGrossProj)} gross.</div>`);

  if (effective_tax_rate > 0.25) {
    insights.push(`<div style="padding:10px;border-radius:8px;background:var(--amber-dim);margin-bottom:8px;font-size:13px"><strong>💡 High effective rate:</strong> Pre-tax 401(k) contributions reduce taxable income dollar-for-dollar. Every $1k contributed saves ~$220-$320 in tax at your bracket.</div>`);
  }
  if (totals.state === 0 && data.stubs_count > 0) {
    insights.push(`<div style="padding:10px;border-radius:8px;background:var(--green-dim);margin-bottom:8px;font-size:13px"><strong>🎯 No state tax detected.</strong> Lucky — that's typically worth 4-6% of gross income.</div>`);
  }
  if (annualGrossProj > 0 && annualGrossProj < 47150) {
    insights.push(`<div style="padding:10px;border-radius:8px;background:var(--teal-dim);margin-bottom:8px;font-size:13px"><strong>🌱 Saver's Credit eligible!</strong> Up to $1,000 tax credit for retirement contributions. File Form 8880.</div>`);
  }
  if (totals.federal > 0 && totals.federal / Math.max(1, totals.gross) > 0.15) {
    insights.push(`<div style="padding:10px;border-radius:8px;background:var(--blue-dim);margin-bottom:8px;font-size:13px"><strong>📝 You may be over-withholding.</strong> If you typically get a big refund, update your W-4 to use the money throughout the year instead.</div>`);
  }
  insights.push(`<div style="padding:10px;border-radius:8px;background:var(--bg-input);font-size:13px;color:var(--text-secondary)"><strong>FICA cap:</strong> Social Security tax (6.2%) stops above $168,600 (2024) / $176,100 (2025). You've paid ${fmt(totals.oasdi)} so far.</div>`);

  document.getElementById('tax-insights').innerHTML = insights.join('');

  // Stub table
  const tbody = document.getElementById('stub-tbody');
  if (stubs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9"><div class="empty-state"><p>No paystubs for ${year}. Upload some on the Paystubs page.</p></div></td></tr>`;
  } else {
    tbody.innerHTML = stubs.map(s => {
      const rate = s.gross ? (s.tax_total/s.gross*100).toFixed(1) + '%' : '—';
      return `<tr>
        <td>${fmtShortDate(s.check_date)}</td>
        <td>${fmt(s.gross)}</td>
        <td>${fmt(s.federal)}</td>
        <td>${fmt(s.state_tax)}</td>
        <td>${fmt(s.city_tax)}</td>
        <td>${fmt(s.oasdi)}</td>
        <td>${fmt(s.medicare)}</td>
        <td style="color:var(--green);font-weight:700">${fmt(s.net)}</td>
        <td><span class="badge badge-gray">${rate}</span></td>
      </tr>`;
    }).join('');
  }
}

async function initYears() {
  const stubs = await API.get('/api/paystubs');
  const years = new Set(stubs.map(s => s.check_date?.slice(0, 4)).filter(Boolean));
  const current = String(new Date().getFullYear());
  years.add(current);
  const sel = document.getElementById('tax-year');
  sel.innerHTML = [...years].sort().reverse().map(y => `<option value="${y}" ${y===current?'selected':''}>${y}</option>`).join('');
  sel.addEventListener('change', loadTaxes);
}

document.addEventListener('DOMContentLoaded', async () => {
  await initYears();
  loadTaxes();
});
