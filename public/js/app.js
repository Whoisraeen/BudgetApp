// ── API Client ────────────────────────────────────────────────────────────────
const API = {
  async get(path) {
    const r = await fetch(path);
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  },
  async post(path, data) {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  },
  async put(path, data) {
    const r = await fetch(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  },
  async del(path) {
    const r = await fetch(path, { method: 'DELETE' });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }
};

// ── Formatting ────────────────────────────────────────────────────────────────
function fmt(amount) {
  if (amount == null || isNaN(amount)) return '$0.00';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}

function fmtDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtShortDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const d = new Date(dateStr + 'T00:00:00');
  return Math.round((d - now) / 86400000);
}

function ordinal(n) {
  const s = ['th','st','nd','rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function categoryColor(cat) {
  const map = {
    'Housing': '#ef4444',
    'Utilities': '#f59e0b',
    'Phone': '#3b82f6',
    'Transport': '#8b5cf6',
    'Subscriptions': '#ec4899',
    'Credit Card': '#f97316',
    'Food': '#22c55e',
    'Entertainment': '#a855f7',
    'Health': '#14b8a6',
    'Savings': '#06b6d4',
    'Other': '#6b7280'
  };
  return map[cat] || '#6b7280';
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function toast(msg, type = 'success') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${type === 'success' ? '✓' : '✕'}</span> ${msg}`;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ── Modal ─────────────────────────────────────────────────────────────────────
function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('open');
}
function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('open');
}
function setupModalClose() {
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => {
      if (e.target === overlay) overlay.classList.remove('open');
    });
  });
  document.querySelectorAll('.modal-close').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.closest('.modal-overlay').classList.remove('open');
    });
  });
}

// ── Active Nav ────────────────────────────────────────────────────────────────
function setActiveNav() {
  const current = window.location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.nav-item[data-page]').forEach(el => {
    el.classList.toggle('active', el.dataset.page === current);
  });
}

// ── Sidebar injection (single source of truth for nav) ────────────────────────
function buildSidebarHTML() {
  return `
    <div class="sidebar-logo">
      <div class="logo-icon">💎</div>
      <div><div class="logo-text">BudgetOS</div><div class="logo-sub">Personal Finance</div></div>
    </div>
    <span class="nav-section-label">Overview</span>
    <a href="/index.html" class="nav-item" data-page="index.html"><span class="nav-icon">📊</span><span>Dashboard</span></a>
    <a href="/plan.html" class="nav-item" data-page="plan.html"><span class="nav-icon">🚀</span><span>Plan to Millionaire</span></a>
    <a href="/calendar.html" class="nav-item" data-page="calendar.html"><span class="nav-icon">📅</span><span>Calendar</span></a>
    <span class="nav-section-label">Money</span>
    <a href="/paychecks.html" class="nav-item" data-page="paychecks.html"><span class="nav-icon">💰</span><span>Paychecks</span></a>
    <a href="/paystubs.html" class="nav-item" data-page="paystubs.html"><span class="nav-icon">📄</span><span>Paystubs</span></a>
    <a href="/bills.html" class="nav-item" data-page="bills.html"><span class="nav-icon">🧾</span><span>Bills</span></a>
    <a href="/taxes.html" class="nav-item" data-page="taxes.html"><span class="nav-icon">🏛️</span><span>Taxes</span></a>
    <span class="nav-section-label">Wealth</span>
    <a href="/networth.html" class="nav-item" data-page="networth.html"><span class="nav-icon">💎</span><span>Net Worth</span></a>
    <a href="/debts.html" class="nav-item" data-page="debts.html"><span class="nav-icon">💳</span><span>Debts</span></a>
    <a href="/savings.html" class="nav-item" data-page="savings.html"><span class="nav-icon">🏦</span><span>Savings</span></a>
    <span class="nav-section-label">Planning</span>
    <a href="/planner.html" class="nav-item" data-page="planner.html"><span class="nav-icon">📋</span><span>Planner</span></a>
    <a href="/events.html" class="nav-item" data-page="events.html"><span class="nav-icon">🎉</span><span>Events</span></a>
    <div class="sidebar-footer">BudgetOS v2.0</div>
  `;
}

function injectSidebar() {
  const sb = document.querySelector('.sidebar');
  if (sb) sb.innerHTML = buildSidebarHTML();
}

// ── Due Date Badge ────────────────────────────────────────────────────────────
function dueBadge(dueDay) {
  if (!dueDay) return '';
  const today = new Date();
  const thisMonth = new Date(today.getFullYear(), today.getMonth(), dueDay);
  const nextMonth = new Date(today.getFullYear(), today.getMonth() + 1, dueDay);
  const due = thisMonth >= today ? thisMonth : nextMonth;
  const days = Math.ceil((due - today) / 86400000);
  if (days <= 3) return `<span class="due-badge due-urgent">🔴 Due in ${days}d</span>`;
  if (days <= 7) return `<span class="due-badge due-soon">🟡 Due in ${days}d</span>`;
  return `<span class="due-badge due-ok">Due ${ordinal(dueDay)}</span>`;
}

// ── Confirm ────────────────────────────────────────────────────────────────────
function confirm2(msg) {
  return window.confirm(msg);
}

// ── Global keyboard shortcuts ─────────────────────────────────────────────────
function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Don't capture when typing
    if (['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    const k = e.key.toLowerCase();
    const map = {
      'g': '/index.html',
      'p': '/paychecks.html',
      'b': '/bills.html',
      'l': '/planner.html',
      's': '/savings.html',
      'c': '/calendar.html',
      'e': '/events.html',
    };
    if (map[k]) {
      e.preventDefault();
      window.location.href = map[k];
      return;
    }
    if (k === '?') {
      e.preventDefault();
      alert('Shortcuts:\n  G — Dashboard\n  P — Paychecks\n  L — Planner\n  B — Bills\n  S — Savings\n  C — Calendar\n  E — Events\n  Esc — Close modal');
    }
    if (k === 'escape') {
      document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open'));
    }
  });
}

// Also update the mobile nav with new pages
function injectMobileNav() {
  if (document.querySelector('.mobile-nav')) return;
  const current = window.location.pathname.split('/').pop() || 'index.html';
  const items = [
    { href: '/index.html',   icon: '📊', label: 'Home' },
    { href: '/plan.html',    icon: '🚀', label: 'Plan' },
    { href: '/paychecks.html', icon: '💰', label: 'Pay' },
    { href: '/networth.html', icon: '💎', label: 'Worth' },
    { href: '/bills.html',   icon: '🧾', label: 'Bills' },
  ];
  const nav = document.createElement('nav');
  nav.className = 'mobile-nav';
  nav.innerHTML = items.map(i => {
    const active = i.href.endsWith(current) ? 'active' : '';
    return `<a href="${i.href}" class="${active}"><span class="mn-icon">${i.icon}</span><span>${i.label}</span></a>`;
  }).join('');
  document.body.appendChild(nav);
}

document.addEventListener('DOMContentLoaded', () => {
  injectSidebar();
  setActiveNav();
  setupModalClose();
  injectMobileNav();
  setupKeyboardShortcuts();
});
