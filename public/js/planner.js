let plannerData = []; // [{paycheck, breakdown}]
let dragSource = null; // { billId, fromPaycheckId, portion }

async function loadPlanner() {
  const today = new Date().toISOString().split('T')[0];
  const allPaychecks = await API.get('/api/paychecks');
  const upcoming = allPaychecks.filter(p => p.date >= today).slice(0, 6);
  const board = document.getElementById('planner-board');

  if (upcoming.length === 0) {
    board.innerHTML = `<div class="empty-state" style="width:100%"><div class="empty-icon">📅</div><p>No upcoming paychecks found. Generate them in the Paychecks tab first.</p></div>`;
    return;
  }

  board.innerHTML = `<div style="padding:20px;color:var(--text-muted)">Loading your plan...</div>`;

  plannerData = await Promise.all(
    upcoming.map(async p => {
      const bd = await API.get(`/api/paychecks/${p.id}/breakdown`);
      return { paycheck: p, breakdown: bd };
    })
  );

  renderBoard();
}

function renderBoard() {
  const board = document.getElementById('planner-board');
  board.innerHTML = plannerData.map((col, idx) => {
    const { paycheck: p, breakdown: bd } = col;
    const { assignedBills, events, contributions, totals, slotInfo } = bd;
    const d = new Date(p.date + 'T12:00:00');
    const isNext = idx === 0;
    const isExtra = slotInfo?.isExtra;
    const net = totals.netRemaining;

    return `
      <div class="planner-col ${isExtra ? 'extra-check' : ''}"
           data-paycheck-id="${p.id}"
           ondragover="onDragOver(event)"
           ondragleave="onDragLeave(event)"
           ondrop="onDrop(event, ${p.id})"
           style="${isNext ? 'border-color:rgba(34,197,94,0.4); box-shadow:0 0 20px rgba(34,197,94,0.05)' : ''}">
        <div class="planner-col-header">
          <div class="col-date">
            ${d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
            ${isNext ? '<span class="badge badge-green" style="margin-left:6px;font-size:10px">NEXT</span>' : ''}
            ${isExtra ? '<span class="badge badge-purple" style="margin-left:6px;font-size:10px">🎁 BONUS</span>' : ''}
          </div>
          <div class="col-amount">${fmt(p.amount)}</div>
          ${isExtra ? `<div style="font-size:11px;color:var(--purple);margin-top:4px">3rd check — surplus available for goals</div>` : ''}
        </div>

        <div class="planner-col-body">
          ${assignedBills.length > 0 ? `
            <div>
              <div class="planner-group-title">Bills · drag to move</div>
              ${assignedBills.map(b => `
                <div class="planner-item draggable ${b.paid ? 'paid' : ''}"
                     draggable="true"
                     data-bill-id="${b.id}"
                     data-from="${p.id}"
                     data-portion="${b.assigned_portion}"
                     ondragstart="onDragStart(event, ${b.id}, ${p.id}, ${b.assigned_portion})"
                     ondragend="onDragEnd(event)">
                  <div class="planner-item-name">
                    <span class="drag-handle">⋮⋮</span>
                    <span style="width:10px;height:10px;border-radius:2px;background:${b.color}"></span>
                    ${b.name} ${b.split_count > 1 ? `<span style="font-size:11px;color:var(--text-muted);font-weight:500">÷${b.split_count}</span>` : ''}
                    ${b.is_override ? '<span class="badge badge-blue" style="font-size:9px;padding:1px 6px">moved</span>' : ''}
                    ${b.paid ? '<span class="badge badge-green" style="font-size:9px;padding:1px 6px">paid</span>' : ''}
                  </div>
                  <div class="planner-item-amount negative">${fmt(b.assigned_portion)}</div>
                </div>
              `).join('')}
            </div>
          ` : ''}

          ${events.length > 0 ? `
            <div>
              <div class="planner-group-title">Events</div>
              ${events.map(e => `
                <div class="planner-item">
                  <div class="planner-item-name">🎉 ${e.name}</div>
                  <div class="planner-item-amount negative">${fmt(e.estimated_cost)}</div>
                </div>
              `).join('')}
            </div>
          ` : ''}

          ${contributions.length > 0 ? `
            <div>
              <div class="planner-group-title">Savings Contributions</div>
              ${contributions.map(c => `
                <div class="planner-item">
                  <div class="planner-item-name">🏦 ${c.goal_name} ${c.auto ? '<span class="badge badge-teal" style="font-size:9px;padding:1px 6px">auto</span>' : ''}</div>
                  <div class="planner-item-amount negative">${fmt(c.amount)}</div>
                </div>
              `).join('')}
            </div>
          ` : ''}

          ${(assignedBills.length === 0 && events.length === 0 && contributions.length === 0) ? `
            <div style="color:var(--text-muted);text-align:center;padding:20px;font-size:13px">
              ${isExtra ? '🎁 Bonus paycheck — no obligations. Drag bills here, or auto-allocate to savings.' : 'No obligations for this check.'}
            </div>
          ` : ''}
        </div>

        <div class="planner-col-footer">
          <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;font-size:11px;color:var(--text-muted)">
            <span>Bills: ${fmt(totals.bills)}</span>
            <span>Sav: ${fmt(totals.savings)}</span>
          </div>
          <div class="net-label">Net Remaining</div>
          <div class="net-amount ${net >= 0 ? 'net-positive' : 'net-negative'}">${fmt(net)}</div>
          ${net < 0 ? `<div style="color:var(--red);font-size:11px;margin-top:4px">⚠️ Over-budget</div>` : ''}
          <button class="btn btn-secondary btn-sm" style="width:100%;margin-top:10px"
                  onclick="autoAllocateOne(${p.id})">⚡ Auto-allocate savings</button>
        </div>
      </div>
    `;
  }).join('');
}

function onDragStart(e, billId, fromPaycheckId, portion) {
  dragSource = { billId, fromPaycheckId, portion };
  e.dataTransfer.effectAllowed = 'move';
  e.currentTarget.classList.add('dragging');
}

function onDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  document.querySelectorAll('.planner-col').forEach(c => c.classList.remove('drag-over'));
}

function onDragOver(e) {
  e.preventDefault();
  e.currentTarget.classList.add('drag-over');
}

function onDragLeave(e) {
  if (e.currentTarget.contains(e.relatedTarget)) return;
  e.currentTarget.classList.remove('drag-over');
}

async function onDrop(e, targetPaycheckId) {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  if (!dragSource) return;
  if (dragSource.fromPaycheckId === targetPaycheckId) { dragSource = null; return; }

  await API.post(`/api/paychecks/${targetPaycheckId}/assign-bill`, {
    bill_id: dragSource.billId,
    estimated_amount: dragSource.portion,
    remove_from_paycheck_id: dragSource.fromPaycheckId,
  });
  toast('Bill moved ✓');
  dragSource = null;
  loadPlanner();
}

async function autoAllocateOne(paycheckId) {
  const r = await API.post(`/api/paychecks/${paycheckId}/auto-allocate`, {});
  toast(`✓ ${r.created.length} contribution${r.created.length !== 1 ? 's' : ''} allocated`);
  loadPlanner();
}

async function autoAllocateAll() {
  const r = await API.post('/api/savings/auto-allocate-upcoming', { count: 6 });
  toast(`✓ ${r.contributions_created} contributions across ${r.paychecks_processed} paychecks`);
  loadPlanner();
}

document.addEventListener('DOMContentLoaded', () => {
  loadPlanner();
  const btn = document.getElementById('auto-allocate-all-btn');
  if (btn) btn.addEventListener('click', autoAllocateAll);
});
