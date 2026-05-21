let allEvents = [];
let allPaychecks = [];
let currentFilter = 'all';
let editingEventId = null;

async function loadEvents() {
  [allEvents, allPaychecks] = await Promise.all([
    API.get('/api/events'),
    API.get('/api/paychecks')
  ]);
  renderStats();
  renderEvents();
  populatePaycheckDropdown();
}

function renderStats() {
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('ev-count').textContent = allEvents.length;
  document.getElementById('ev-total').textContent = fmt(allEvents.reduce((s, e) => s + (e.estimated_cost || 0), 0));
  document.getElementById('ev-paid').textContent = allEvents.filter(e => e.paid).length;
  document.getElementById('ev-upcoming').textContent = fmt(
    allEvents.filter(e => !e.paid && e.date >= today).reduce((s, e) => s + (e.estimated_cost || 0), 0)
  );
}

function renderEvents() {
  const today = new Date().toISOString().split('T')[0];
  let filtered = [...allEvents];
  if (currentFilter === 'upcoming') filtered = filtered.filter(e => !e.paid && e.date >= today);
  if (currentFilter === 'paid') filtered = filtered.filter(e => e.paid);
  filtered.sort((a, b) => a.date.localeCompare(b.date));

  const grid = document.getElementById('events-grid');
  if (filtered.length === 0) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="empty-icon">🎉</div><p>No events here yet.</p></div>`;
    return;
  }

  grid.innerHTML = filtered.map(e => {
    const days = daysUntil(e.date);
    const daysLabel = days === null ? '' : days < 0 ? `${Math.abs(days)} days ago` : days === 0 ? 'Today!' : `In ${days} days`;
    const color = e.color || '#a855f7';
    return `
      <div class="event-card" style="border-left:3px solid ${color}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
          <span class="badge" style="background:${color}22;color:${color}">${e.category || 'Event'}</span>
          ${e.paid
            ? `<span class="badge badge-green">✓ Paid</span>`
            : days !== null && days <= 7 && days >= 0
            ? `<span class="badge badge-amber">⚡ Soon</span>`
            : `<span class="badge badge-gray">Planned</span>`}
        </div>
        <div class="event-card-name">${e.name}</div>
        <div class="event-card-date">${fmtDate(e.date)} ${daysLabel ? `· <span style="color:${color}">${daysLabel}</span>` : ''}</div>
        <div class="event-card-cost" style="color:${color}">${fmt(e.estimated_cost)}</div>
        <div class="event-card-paycheck">
          ${e.paycheck_date ? `💰 Paycheck: ${fmtShortDate(e.paycheck_date)}` : '⚠️ No paycheck assigned'}
        </div>
        ${e.note ? `<div style="font-size:12px;color:var(--text-muted);margin-top:8px;border-top:1px solid var(--border);padding-top:8px">${e.note}</div>` : ''}
        <div class="event-card-actions">
          ${!e.paid ? `<button class="btn btn-secondary btn-sm" onclick="markPaid(${e.id})">✓ Mark Paid</button>` : ''}
          <button class="btn btn-icon btn-sm" onclick="editEvent(${e.id})" title="Edit">✏️</button>
          <button class="btn btn-icon btn-sm btn-danger" onclick="deleteEvent(${e.id})" title="Delete">🗑️</button>
        </div>
      </div>
    `;
  }).join('');
}

function populatePaycheckDropdown() {
  const today = new Date().toISOString().split('T')[0];
  const sel = document.getElementById('event-paycheck');
  const currentVal = sel.value;
  sel.innerHTML = `<option value="">— Unassigned —</option>` +
    allPaychecks
      .filter(p => p.date >= today)
      .slice(0, 30)
      .map(p => `<option value="${p.id}">${fmtShortDate(p.date)} — ${fmt(p.amount)}</option>`)
      .join('');
  if (currentVal) sel.value = currentVal;
}

function setFilter(f, btn) {
  currentFilter = f;
  document.querySelectorAll('.status-filter .tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  renderEvents();
}

function openAddEvent() {
  editingEventId = null;
  document.getElementById('event-form').reset();
  document.getElementById('event-id').value = '';
  document.getElementById('event-color').value = '#a855f7';
  document.getElementById('event-modal-title').textContent = 'Add Event';
  openModal('event-modal');
}

function editEvent(id) {
  const e = allEvents.find(x => x.id === id);
  if (!e) return;
  editingEventId = id;
  document.getElementById('event-id').value = id;
  document.getElementById('event-name').value = e.name;
  document.getElementById('event-date').value = e.date;
  document.getElementById('event-cost').value = e.estimated_cost;
  document.getElementById('event-category').value = e.category || 'Entertainment';
  document.getElementById('event-color').value = e.color || '#a855f7';
  document.getElementById('event-paycheck').value = e.paycheck_id || '';
  document.getElementById('event-note').value = e.note || '';
  document.getElementById('event-modal-title').textContent = 'Edit Event';
  openModal('event-modal');
}

async function markPaid(id) {
  const e = allEvents.find(x => x.id === id);
  if (!e) return;
  await API.put(`/api/events/${id}`, { ...e, paid: 1 });
  toast('Event marked as paid ✓');
  loadEvents();
}

async function deleteEvent(id) {
  if (!confirm2('Delete this event?')) return;
  await API.del(`/api/events/${id}`);
  toast('Event deleted');
  loadEvents();
}

document.addEventListener('DOMContentLoaded', () => {
  loadEvents();

  document.getElementById('event-form').addEventListener('submit', async e => {
    e.preventDefault();
    const payload = {
      name: document.getElementById('event-name').value,
      date: document.getElementById('event-date').value,
      estimated_cost: parseFloat(document.getElementById('event-cost').value) || 0,
      category: document.getElementById('event-category').value,
      color: document.getElementById('event-color').value,
      paycheck_id: document.getElementById('event-paycheck').value || null,
      note: document.getElementById('event-note').value,
      paid: 0
    };

    if (editingEventId) {
      await API.put(`/api/events/${editingEventId}`, payload);
      toast('Event updated ✓');
    } else {
      await API.post('/api/events', payload);
      toast('Event added ✓');
    }
    closeModal('event-modal');
    loadEvents();
  });
});
