let calendarInstance = null;
let allEvents = [];

async function initCalendar() {
  allEvents = await API.get('/api/calendar');

  const calEl = document.getElementById('calendar');
  calendarInstance = new FullCalendar.Calendar(calEl, {
    initialView: 'dayGridMonth',
    height: 'auto',
    headerToolbar: {
      left: 'prev,next today',
      center: 'title',
      right: 'dayGridMonth,timeGridWeek,listMonth'
    },
    events: allEvents,
    eventClick: handleEventClick,
    dateClick: handleDateClick,
    datesSet: updateMonthStats,
    eventDidMount(info) {
      info.el.title = info.event.title;
    }
  });
  calendarInstance.render();
  updateMonthStats();
}

function handleEventClick(info) {
  const props = info.event.extendedProps;
  const panel = document.getElementById('detail-content');

  if (props.type === 'paycheck') {
    const p = props.data;
    panel.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
        <div style="width:36px;height:36px;background:var(--green-dim);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:18px">💰</div>
        <div><div style="font-weight:700">${p.label || 'Paycheck'}</div><div style="color:var(--text-secondary);font-size:12px">${fmtDate(p.date)}</div></div>
      </div>
      <div style="font-size:28px;font-weight:800;color:var(--green);margin-bottom:8px">${fmt(p.amount)}</div>
      ${p.note ? `<div style="font-size:12px;color:var(--text-muted)">${p.note}</div>` : ''}
      <a href="/paychecks.html" class="btn btn-secondary btn-sm" style="margin-top:12px">View breakdown →</a>
    `;
  } else if (props.type === 'bill') {
    const b = props.data;
    panel.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
        <div style="width:36px;height:36px;background:var(--red-dim);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:18px">🧾</div>
        <div><div style="font-weight:700">${b.name}</div><div style="color:var(--text-secondary);font-size:12px">${b.category}</div></div>
      </div>
      ${b.split_count > 1 ? `
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">Total: ${fmt(b.total_amount)} ÷ ${b.split_count} people</div>
      ` : ''}
      <div style="font-size:28px;font-weight:800;color:var(--red);margin-bottom:4px">${fmt(b.computed_portion)}</div>
      <div style="font-size:12px;color:var(--text-muted)">Your portion · Due ${ordinal(b.due_day)}</div>
      ${b.note ? `<div style="font-size:12px;color:var(--text-muted);margin-top:8px">${b.note}</div>` : ''}
    `;
  } else if (props.type === 'event') {
    const e = props.data;
    panel.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
        <div style="width:36px;height:36px;background:var(--purple-dim);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:18px">🎉</div>
        <div><div style="font-weight:700">${e.name}</div><div style="color:var(--text-secondary);font-size:12px">${fmtDate(e.date)}</div></div>
      </div>
      <div style="font-size:28px;font-weight:800;color:var(--purple);margin-bottom:4px">${fmt(e.estimated_cost)}</div>
      <div style="font-size:12px;color:var(--text-muted)">${e.category}${e.paycheck_date ? ` · Funded by paycheck on ${fmtShortDate(e.paycheck_date)}` : ''}</div>
      ${e.note ? `<div style="font-size:12px;color:var(--text-muted);margin-top:8px">${e.note}</div>` : ''}
      <span class="badge ${e.paid ? 'badge-green' : 'badge-amber'}" style="margin-top:12px;display:inline-flex">${e.paid ? '✓ Paid' : '⏳ Planned'}</span>
    `;
  }
}

function handleDateClick(info) {
  const date = info.dateStr;
  const dayEvents = allEvents.filter(e => e.start === date);
  const panel = document.getElementById('detail-content');

  if (dayEvents.length === 0) {
    panel.innerHTML = `<div class="detail-empty">Nothing on ${fmtShortDate(date)}</div>`;
    return;
  }

  panel.innerHTML = `
    <div style="font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:10px">${fmtDate(date)}</div>
    ${dayEvents.map(e => `
      <div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border)">
        <div style="width:8px;height:8px;border-radius:50%;background:${e.backgroundColor};flex-shrink:0"></div>
        <div style="font-size:13px;flex:1">${e.title.replace(/^[^\s]+\s/, '')}</div>
      </div>
    `).join('')}
  `;
}

function updateMonthStats() {
  if (!calendarInstance) return;
  const view = calendarInstance.view;
  const start = view.activeStart;
  const end = view.activeEnd;

  const visible = allEvents.filter(e => {
    const d = new Date(e.start + 'T12:00:00');
    return d >= start && d < end;
  });

  let income = 0, bills = 0, events = 0;
  visible.forEach(e => {
    const type = e.extendedProps?.type;
    const amount = parseFloat((e.title.match(/\$(\d[\d,.]+)/) || [])[1]?.replace(/,/g,'') || 0);
    if (type === 'paycheck') income += e.extendedProps.data.amount || 0;
    else if (type === 'bill') bills += e.extendedProps.data.computed_portion || 0;
    else if (type === 'event') events += e.extendedProps.data.estimated_cost || 0;
  });

  document.getElementById('ms-income').textContent = fmt(income);
  document.getElementById('ms-bills').textContent = fmt(bills);
  document.getElementById('ms-events').textContent = fmt(events);
}

document.addEventListener('DOMContentLoaded', initCalendar);
