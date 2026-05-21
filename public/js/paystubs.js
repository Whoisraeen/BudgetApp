let allStubs = [];

async function loadStubs() {
  allStubs = await API.get('/api/paystubs');
  renderStats();
  renderList();
}

function renderStats() {
  document.getElementById('ps-count').textContent = allStubs.length;
  const g = allStubs.reduce((s, x) => s + (x.gross || 0), 0);
  const t = allStubs.reduce((s, x) => s + (x.tax_total || 0), 0);
  const n = allStubs.reduce((s, x) => s + (x.net || 0), 0);
  document.getElementById('ps-gross').textContent = fmt(g);
  document.getElementById('ps-tax').textContent = fmt(t);
  document.getElementById('ps-net').textContent = fmt(n);
}

function renderList() {
  const list = document.getElementById('stubs-list');
  if (allStubs.length === 0) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">📄</div><p>No paystubs uploaded yet. Drop a PDF above to start.</p></div>`;
    return;
  }
  list.innerHTML = allStubs.map(s => {
    const ded = s.deductions || {};
    const dedPills = Object.entries(ded).slice(0, 6).map(([k, v]) =>
      `<span class="ded-pill" title="YTD: ${fmt(v.ytd || 0)}">${k} ${fmt(v.current || 0)}</span>`
    ).join('');
    return `
      <div class="stub-card">
        <div class="stub-row">
          <div>
            <div class="stub-label">Check date</div>
            <div style="font-weight:700">${fmtShortDate(s.check_date)}</div>
            ${s.pay_period_start ? `<div style="font-size:11px;color:var(--text-muted)">${fmtShortDate(s.pay_period_start)} → ${fmtShortDate(s.pay_period_end)}</div>` : ''}
          </div>
          <div>
            <div class="stub-label">Gross</div>
            <div class="stub-amt" style="color:var(--blue)">${fmt(s.gross)}</div>
            <div style="font-size:11px;color:var(--text-muted)">${s.hours_worked ? s.hours_worked.toFixed(1) + ' hrs @ $' + s.rate : ''}</div>
          </div>
          <div>
            <div class="stub-label">Tax</div>
            <div class="stub-amt" style="color:var(--red)">${fmt(s.tax_total)}</div>
            <div style="font-size:11px;color:var(--text-muted)">${s.gross ? ((s.tax_total/s.gross)*100).toFixed(1)+'% eff' : ''}</div>
          </div>
          <div>
            <div class="stub-label">Deductions</div>
            <div class="stub-amt" style="color:var(--amber)">${fmt(s.deduction_total)}</div>
          </div>
          <div>
            <div class="stub-label">Net</div>
            <div class="stub-amt" style="color:var(--green);font-size:18px">${fmt(s.net)}</div>
          </div>
          <button class="btn btn-icon btn-danger" onclick="deleteStub(${s.id})" title="Delete">🗑️</button>
        </div>
        <div style="margin-top:10px;display:flex;flex-wrap:wrap;gap:8px;font-size:11px">
          <span class="ded-pill">Fed ${fmt(s.federal)}</span>
          <span class="ded-pill">State ${fmt(s.state_tax)}${s.state ? ' ('+s.state+')' : ''}</span>
          ${s.city_tax > 0 ? `<span class="ded-pill">City ${fmt(s.city_tax)}${s.city ? ' ('+s.city+')' : ''}</span>` : ''}
          <span class="ded-pill">SS ${fmt(s.oasdi)}</span>
          <span class="ded-pill">Medicare ${fmt(s.medicare)}</span>
          ${dedPills}
        </div>
        ${s.ytd_gross ? `<div style="margin-top:8px;font-size:11px;color:var(--text-muted)">YTD: gross ${fmt(s.ytd_gross)} · tax ${fmt(s.ytd_tax)} · ded ${fmt(s.ytd_deductions)}</div>` : ''}
      </div>
    `;
  }).join('');
}

async function uploadPDF(file) {
  const status = document.getElementById('upload-status');
  status.innerHTML = `<span style="color:var(--accent)">⏳ Parsing ${file.name}...</span>`;
  const fd = new FormData();
  fd.append('pdf', file);
  try {
    const r = await fetch('/api/paystubs/upload', { method: 'POST', body: fd });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Upload failed');
    status.innerHTML = `<span style="color:var(--green)">✓ Parsed ${data.parsed} stubs · imported ${data.inserted}${data.skipped_duplicates ? ' · skipped ' + data.skipped_duplicates + ' duplicates' : ''}</span>`;
    toast(`Imported ${data.inserted} paystubs ✓`);
    loadStubs();
  } catch (e) {
    status.innerHTML = `<span style="color:var(--red)">✕ ${e.message}</span>`;
    toast('Upload failed', 'error');
  }
}

async function reconcileStubs() {
  const r = await API.post('/api/paystubs/reconcile', {});
  toast(`✓ ${r.updated} paychecks updated, ${r.created} created`);
}

async function deleteStub(id) {
  if (!confirm2('Delete this paystub record?')) return;
  await API.del(`/api/paystubs/${id}`);
  toast('Deleted');
  loadStubs();
}

document.addEventListener('DOMContentLoaded', () => {
  loadStubs();
  const zone = document.getElementById('upload-zone');
  const input = document.getElementById('pdf-input');
  input.addEventListener('change', e => { if (e.target.files[0]) uploadPDF(e.target.files[0]); });
  ['dragenter','dragover'].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.add('dragover'); }));
  ['dragleave','drop'].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.remove('dragover'); }));
  zone.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f && f.type === 'application/pdf') uploadPDF(f); });
});
