const express = require('express');
const path = require('path');
const multer = require('multer');
const { getDb, query, get, run } = require('./db/database');
const { parsePaystubPDF } = require('./lib/paystubParser');
const { generatePlan } = require('./lib/financialPlan');

const app = express();
const PORT = 3000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

getDb();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function computePortion(bill) {
  if (bill.my_portion != null) return bill.my_portion;
  return bill.total_amount / (bill.split_count || 1);
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

function addMonths(dateStr, months) {
  const d = new Date(dateStr + 'T12:00:00');
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);
  // Clamp if month rolled (e.g., Jan 31 + 1mo)
  if (d.getDate() !== day) d.setDate(0);
  return d.toISOString().split('T')[0];
}

function frequencyDays(freq) {
  return ({ weekly: 7, biweekly: 14, semimonthly: 15, monthly: 30 })[freq] || 14;
}

function generatePaydates(startDateStr, count, freq) {
  const dates = [];
  let current = startDateStr;
  for (let i = 0; i < count; i++) {
    dates.push(current);
    if (freq === 'monthly') current = addMonths(current, 1);
    else if (freq === 'semimonthly') {
      // 1st and 15th-style: alternate +15/+15-ish using month boundaries
      const d = new Date(current + 'T12:00:00');
      const day = d.getDate();
      if (day < 15) current = addDays(current, 15);
      else current = addMonths(current.slice(0, 8) + '01', 1);
    } else {
      current = addDays(current, frequencyDays(freq));
    }
  }
  return dates;
}

async function getSetting(key, fallback) {
  const row = await get('SELECT value FROM settings WHERE key=?', [key]);
  return row ? row.value : fallback;
}

// Detect which "slot" a paycheck holds within its calendar month: 1, 2, or 3+ (extra).
async function getPaycheckSlotInfo(paycheck) {
  const pcDate = new Date(paycheck.date + 'T12:00:00');
  const monthStart = new Date(pcDate.getFullYear(), pcDate.getMonth(), 1)
    .toISOString().split('T')[0];
  const monthEnd = new Date(pcDate.getFullYear(), pcDate.getMonth() + 1, 0)
    .toISOString().split('T')[0];
  const siblings = await query(
    "SELECT id, date FROM paychecks WHERE date >= ? AND date <= ? ORDER BY date ASC",
    [monthStart, monthEnd]
  );
  const index = siblings.findIndex(p => p.id === paycheck.id);
  return {
    indexInMonth: index, // 0-based
    totalInMonth: siblings.length,
    isFirst: index === 0,
    isSecond: index === 1,
    isExtra: index >= 2,
  };
}

function periodKeyForPaycheck(paycheck) {
  // YYYY-MM-slotIndex — used to de-duplicate bill_occurrences per paycheck
  return paycheck.date.slice(0, 7) + '-' + paycheck.id;
}

// Compute which bills are assigned to a given paycheck, factoring in per-occurrence
// overrides, finite remaining_payments, and slot rules.
async function computeAssignedBills(paycheck) {
  const slotInfo = await getPaycheckSlotInfo(paycheck);
  const pcDate = new Date(paycheck.date + 'T12:00:00');
  const freq = await getSetting('pay_frequency', 'biweekly');
  const periodDays = frequencyDays(freq);
  const nextPcDate = new Date(pcDate.getTime() + periodDays * 24 * 60 * 60 * 1000);

  const bills = await query('SELECT * FROM bills WHERE active=1');

  // Pull every override that targets this paycheck
  const overrides = await query(
    'SELECT * FROM bill_occurrences WHERE paycheck_id=?',
    [paycheck.id]
  );
  const overrideByBill = {};
  overrides.forEach(o => { overrideByBill[o.bill_id] = o; });

  // Pull "removal" overrides from other paychecks for the same period so we don't double-assign
  // (handled by checking if the bill has an override pointing to this paycheck explicitly)

  // Extra (3rd+) paychecks get NO standard bills assigned — they're surplus checks.
  // But explicit overrides assigned to this paycheck still apply.
  const assigned = [];
  for (const b of bills) {
    const override = overrideByBill[b.id];

    if (override) {
      // Explicit assignment to this paycheck
      let portion = override.estimated_amount != null
        ? override.estimated_amount
        : computePortion(b);
      assigned.push({
        ...b,
        assigned_portion: portion,
        actual_amount: override.actual_amount,
        paid: override.paid,
        occurrence_id: override.id,
        is_override: true,
      });
      continue;
    }

    if (slotInfo.isExtra) continue; // no auto bills on extra paychecks

    // Skip if an override pinned this bill to a different paycheck in the same period
    const sameMonthOverride = await get(
      `SELECT bo.* FROM bill_occurrences bo
       JOIN paychecks p ON bo.paycheck_id = p.id
       WHERE bo.bill_id=? AND substr(p.date,1,7)=substr(?,1,7) AND bo.paycheck_id != ?`,
      [b.id, paycheck.date, paycheck.id]
    );
    if (sameMonthOverride) continue;

    let include = false;
    if (b.paycheck_slot === 'every_check') include = true;
    else if (b.paycheck_slot === 'check1' && slotInfo.isFirst) include = true;
    else if (b.paycheck_slot === 'check2' && slotInfo.isSecond) include = true;
    else if (b.paycheck_slot === 'split') include = true;
    else if (b.due_day) {
      const dueDate = new Date(pcDate.getFullYear(), pcDate.getMonth(), b.due_day);
      include = dueDate >= pcDate && dueDate < nextPcDate;
    } else {
      include = slotInfo.isFirst;
    }

    if (!include) continue;
    let portion = computePortion(b);
    if (b.paycheck_slot === 'split') portion = portion / 2;
    assigned.push({
      ...b,
      assigned_portion: portion,
      occurrence_id: null,
      is_override: false,
    });
  }

  return { assigned, slotInfo };
}

// Auto-allocate savings for a paycheck. Strategy:
//   1. For each active goal with auto_allocate=1, allocate min(per_check, remaining_gap).
//   2. If a target_date is set, scale per_check up to catch up (catch-up logic).
//   3. Sort by priority desc, then by urgency (target_date - now / remaining_gap).
//   4. Cap total allocation at available net (paycheck.amount - bills - events).
async function autoAllocateSavingsForPaycheck(paycheckId) {
  const enabled = await getSetting('auto_savings_enabled', 'true');
  if (enabled !== 'true') return [];

  const paycheck = await get('SELECT * FROM paychecks WHERE id=?', [paycheckId]);
  if (!paycheck) return [];

  // Skip extras unless user said otherwise (extras still auto-allocate — they're prime targets)
  const { assigned } = await computeAssignedBills(paycheck);
  const events = await query('SELECT * FROM events WHERE paycheck_id=?', [paycheckId]);
  const totalBills = assigned.reduce((s, b) => s + (b.actual_amount ?? b.assigned_portion), 0);
  const totalEvents = events.reduce((s, e) => s + (e.actual_cost ?? e.estimated_cost ?? 0), 0);
  let available = (paycheck.amount || 0) - totalBills - totalEvents;

  // Remove any existing auto contributions for this paycheck so we don't double up
  // IMPORTANT: do this BEFORE querying goals so contributed totals don't include stale values
  await run('DELETE FROM savings_contributions WHERE paycheck_id=? AND auto=1', [paycheckId]);

  const goals = await query(
    `SELECT g.*,
     (SELECT COALESCE(SUM(amount),0) FROM savings_contributions WHERE savings_goal_id=g.id) as contributed
     FROM savings_goals g
     WHERE g.active=1 AND g.auto_allocate=1`
  );

  // Build allocation candidates with urgency score
  const today = new Date(paycheck.date + 'T12:00:00');
  const freq = await getSetting('pay_frequency', 'biweekly');
  const periodDays = frequencyDays(freq);

  let candidates = goals.map(g => {
    const current = (g.current_amount || 0) + (g.contributed || 0);
    const remaining = Math.max(0, (g.target_amount || 0) - current);
    let perCheck = g.per_check_contribution || 0;
    let urgencyScore = 0;

    if (g.target_date) {
      const target = new Date(g.target_date + 'T12:00:00');
      const daysLeft = Math.max(1, Math.ceil((target - today) / 86400000));
      const checksLeft = Math.max(1, Math.ceil(daysLeft / periodDays));
      const needed = remaining / checksLeft;
      // Catch-up: ensure perCheck is enough to hit target on time
      if (needed > perCheck) perCheck = needed;
      urgencyScore = remaining > 0 ? remaining / daysLeft : 0;
    }

    return { goal: g, remaining, perCheck, urgencyScore, needsFairShare: perCheck <= 0 };
  }).filter(c => c.remaining > 0);

  // Fair-share fallback: any auto-allocate goal with no per-check + no target_date
  // gets a slice of remaining cash weighted by priority. Without this, the user
  // can hit "Auto Allocate" and have nothing happen because every goal is $0/check.
  const fairShareGoals = candidates.filter(c => c.needsFairShare);
  if (fairShareGoals.length > 0 && available > 0) {
    const totalWeight = fairShareGoals.reduce((s, c) => s + Math.max(1, c.goal.priority || 1), 0);
    // Reserve at most 80% of available net for fair-share so user keeps some cushion
    const fairSharePool = available * 0.8;
    for (const c of fairShareGoals) {
      const weight = Math.max(1, c.goal.priority || 1);
      const share = (fairSharePool * weight) / totalWeight;
      c.perCheck = Math.min(share, c.remaining);
    }
  }

  candidates = candidates
    .filter(c => c.perCheck > 0)
    .sort((a, b) => (b.goal.priority - a.goal.priority) || (b.urgencyScore - a.urgencyScore));


  const created = [];
  for (const c of candidates) {
    if (available <= 0) break;
    const amount = Math.min(c.perCheck, c.remaining, available);
    if (amount <= 0.005) continue;
    await run(
      `INSERT INTO savings_contributions (savings_goal_id, paycheck_id, amount, date, note, auto)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [c.goal.id, paycheckId, +amount.toFixed(2), paycheck.date, 'Auto-allocated']
    );
    available -= amount;
    created.push({ goal_id: c.goal.id, amount });
  }

  // Persist net_remaining
  const finalContribs = await get(
    'SELECT COALESCE(SUM(amount),0) as t FROM savings_contributions WHERE paycheck_id=?',
    [paycheckId]
  );
  const netRemaining = (paycheck.amount || 0) - totalBills - totalEvents - (finalContribs?.t || 0);
  await run('UPDATE paychecks SET net_remaining=? WHERE id=?', [+netRemaining.toFixed(2), paycheckId]);

  return created;
}

// Recompute & persist net_remaining for a paycheck without changing contributions.
async function refreshNetRemaining(paycheckId) {
  const paycheck = await get('SELECT * FROM paychecks WHERE id=?', [paycheckId]);
  if (!paycheck) return;
  const { assigned } = await computeAssignedBills(paycheck);
  const events = await query('SELECT * FROM events WHERE paycheck_id=?', [paycheckId]);
  const contribs = await get(
    'SELECT COALESCE(SUM(amount),0) as t FROM savings_contributions WHERE paycheck_id=?',
    [paycheckId]
  );
  const totalBills = assigned.reduce((s, b) => s + (b.actual_amount ?? b.assigned_portion), 0);
  const totalEvents = events.reduce((s, e) => s + (e.actual_cost ?? e.estimated_cost ?? 0), 0);
  const net = (paycheck.amount || 0) - totalBills - totalEvents - (contribs?.t || 0);
  await run('UPDATE paychecks SET net_remaining=? WHERE id=?', [+net.toFixed(2), paycheckId]);
  return net;
}

// ─── Settings ─────────────────────────────────────────────────────────────────

app.get('/api/settings', async (req, res) => {
  try {
    const rows = await query('SELECT key, value FROM settings');
    const settings = {};
    rows.forEach(r => settings[r.key] = r.value);
    res.json(settings);
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.put('/api/settings', async (req, res) => {
  try {
    const { key, value } = req.body;
    await run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, String(value)]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({error: e.message}); }
});

// ─── Paychecks ────────────────────────────────────────────────────────────────

app.get('/api/paychecks', async (req, res) => {
  try {
    const rows = await query('SELECT * FROM paychecks ORDER BY date ASC');
    // Tag is_extra dynamically based on slot in month (cheap)
    const tagged = [];
    for (const r of rows) {
      const slot = await getPaycheckSlotInfo(r);
      tagged.push({ ...r, is_extra: slot.isExtra ? 1 : 0, index_in_month: slot.indexInMonth });
    }
    res.json(tagged);
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/api/paychecks/generate', async (req, res) => {
  try {
    const { startDate, amount, count, frequency } = req.body;
    const freq = frequency || 'biweekly';
    const total = count || 54;
    const dates = generatePaydates(startDate, total, freq);

    await run("DELETE FROM paychecks WHERE date >= ?", [startDate]);
    for (const d of dates) {
      await run('INSERT INTO paychecks (date, amount, label) VALUES (?, ?, ?)', [d, amount || 0, 'Paycheck']);
    }
    await run("INSERT OR REPLACE INTO settings (key, value) VALUES ('pay_frequency', ?)", [freq]);

    const rows = await query('SELECT * FROM paychecks ORDER BY date ASC');
    res.json(rows);
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.put('/api/paychecks/:id', async (req, res) => {
  try {
    const { amount, label, note } = req.body;
    await run('UPDATE paychecks SET amount=?, label=?, note=? WHERE id=?', [amount, label, note, req.params.id]);
    await refreshNetRemaining(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.delete('/api/paychecks/:id', async (req, res) => {
  try {
    await run('DELETE FROM paychecks WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({error: e.message}); }
});

// Per-paycheck breakdown
app.get('/api/paychecks/:id/breakdown', async (req, res) => {
  try {
    const paycheck = await get('SELECT * FROM paychecks WHERE id=?', [req.params.id]);
    if (!paycheck) return res.status(404).json({ error: 'Not found' });

    const events = await query('SELECT * FROM events WHERE paycheck_id=?', [req.params.id]);
    const contributions = await query(`
      SELECT sc.*, sg.name as goal_name, sg.color
      FROM savings_contributions sc
      JOIN savings_goals sg ON sc.savings_goal_id = sg.id
      WHERE sc.paycheck_id=?
    `, [req.params.id]);

    const { assigned: assignedBills, slotInfo } = await computeAssignedBills(paycheck);

    const totalBills = assignedBills.reduce(
      (s, b) => s + (b.actual_amount ?? b.assigned_portion), 0
    );
    const totalEvents = events.reduce(
      (s, e) => s + (e.actual_cost ?? e.estimated_cost ?? 0), 0
    );
    const totalSavings = contributions.reduce((s, c) => s + c.amount, 0);
    const netRemaining = (paycheck.amount || 0) - totalBills - totalEvents - totalSavings;

    // Persist for trend chart
    await run('UPDATE paychecks SET net_remaining=? WHERE id=?',
      [+netRemaining.toFixed(2), paycheck.id]);

    res.json({
      paycheck: { ...paycheck, ...slotInfo, is_extra: slotInfo.isExtra ? 1 : 0 },
      assignedBills,
      events,
      contributions,
      slotInfo,
      totals: { bills: totalBills, events: totalEvents, savings: totalSavings, netRemaining }
    });
  } catch(e) { res.status(500).json({error: e.message}); }
});

// Reassign a bill to a different paycheck (planner what-if / drag-drop)
app.post('/api/paychecks/:id/assign-bill', async (req, res) => {
  try {
    const { bill_id, estimated_amount, remove_from_paycheck_id } = req.body;
    const targetId = req.params.id;

    // Remove any override for this bill in the same period (so we don't stack)
    if (remove_from_paycheck_id) {
      await run('DELETE FROM bill_occurrences WHERE bill_id=? AND paycheck_id=?',
        [bill_id, remove_from_paycheck_id]);
    }

    // Upsert override pointing at the new paycheck
    const existing = await get(
      'SELECT id FROM bill_occurrences WHERE bill_id=? AND paycheck_id=?',
      [bill_id, targetId]
    );
    if (existing) {
      await run(
        'UPDATE bill_occurrences SET estimated_amount=? WHERE id=?',
        [estimated_amount ?? null, existing.id]
      );
    } else {
      const paycheck = await get('SELECT date FROM paychecks WHERE id=?', [targetId]);
      await run(
        `INSERT INTO bill_occurrences (bill_id, paycheck_id, period_key, estimated_amount)
         VALUES (?, ?, ?, ?)`,
        [bill_id, targetId, paycheck?.date?.slice(0, 7) || null, estimated_amount ?? null]
      );
    }

    await refreshNetRemaining(targetId);
    if (remove_from_paycheck_id) await refreshNetRemaining(remove_from_paycheck_id);

    res.json({ ok: true });
  } catch(e) { res.status(500).json({error: e.message}); }
});

// Bill occurrences — used to mark a bill as paid/track actual on a specific paycheck
app.get('/api/bills/:id/occurrences', async (req, res) => {
  try {
    const rows = await query(
      `SELECT bo.*, p.date as paycheck_date
       FROM bill_occurrences bo
       LEFT JOIN paychecks p ON bo.paycheck_id = p.id
       WHERE bo.bill_id=?
       ORDER BY p.date DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.put('/api/bill-occurrences/:id', async (req, res) => {
  try {
    const { actual_amount, paid, note } = req.body;
    await run(
      'UPDATE bill_occurrences SET actual_amount=?, paid=?, note=? WHERE id=?',
      [actual_amount ?? null, paid ?? 0, note ?? null, req.params.id]
    );
    const occ = await get('SELECT paycheck_id FROM bill_occurrences WHERE id=?', [req.params.id]);
    if (occ?.paycheck_id) await refreshNetRemaining(occ.paycheck_id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({error: e.message}); }
});

// Create an occurrence (used to mark a bill paid on a paycheck where no override exists yet)
app.post('/api/bill-occurrences', async (req, res) => {
  try {
    const { bill_id, paycheck_id, estimated_amount, actual_amount, paid, note } = req.body;
    const paycheck = paycheck_id ? await get('SELECT date FROM paychecks WHERE id=?', [paycheck_id]) : null;
    const r = await run(
      `INSERT INTO bill_occurrences (bill_id, paycheck_id, period_key, estimated_amount, actual_amount, paid, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [bill_id, paycheck_id || null, paycheck?.date?.slice(0, 7) || null,
       estimated_amount ?? null, actual_amount ?? null, paid ?? 0, note || null]
    );
    if (paycheck_id) await refreshNetRemaining(paycheck_id);
    res.json({ id: r.lastID, ok: true });
  } catch(e) { res.status(500).json({error: e.message}); }
});

// Auto-allocate savings endpoint (idempotent)
app.post('/api/paychecks/:id/auto-allocate', async (req, res) => {
  try {
    const created = await autoAllocateSavingsForPaycheck(req.params.id);
    res.json({ ok: true, created });
  } catch(e) { res.status(500).json({error: e.message}); }
});

// Run auto-allocate for the next N upcoming paychecks
app.post('/api/savings/auto-allocate-upcoming', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const limit = parseInt(req.body?.count) || 6;
    const pcs = await query(
      'SELECT id FROM paychecks WHERE date >= ? ORDER BY date ASC LIMIT ?',
      [today, limit]
    );
    let total = 0;
    for (const p of pcs) {
      const c = await autoAllocateSavingsForPaycheck(p.id);
      total += c.length;
    }
    res.json({ ok: true, paychecks_processed: pcs.length, contributions_created: total });
  } catch(e) { res.status(500).json({error: e.message}); }
});

// Net-remaining trend (for sparkline)
app.get('/api/paychecks/trend', async (req, res) => {
  try {
    const months = parseInt(req.query.months) || 12;
    const today = new Date();
    const cutoff = new Date(today.getFullYear(), today.getMonth() - months, 1)
      .toISOString().split('T')[0];
    const horizon = new Date(today.getFullYear(), today.getMonth() + 3, 1)
      .toISOString().split('T')[0];
    const rows = await query(
      'SELECT id, date, amount, net_remaining FROM paychecks WHERE date >= ? AND date <= ? ORDER BY date ASC',
      [cutoff, horizon]
    );
    // Fill missing nets on the fly (cheap for ~30 rows)
    for (const r of rows) {
      if (r.net_remaining == null) {
        r.net_remaining = await refreshNetRemaining(r.id);
      }
    }
    res.json(rows);
  } catch(e) { res.status(500).json({error: e.message}); }
});

// ─── Bills ────────────────────────────────────────────────────────────────────

app.get('/api/bills', async (req, res) => {
  try {
    const rows = await query('SELECT * FROM bills ORDER BY due_day ASC, name ASC');
    const bills = rows.map(b => ({ ...b, computed_portion: computePortion(b) }));

    if (req.query.include_savings === '1') {
      const freq = await getSetting('pay_frequency', 'biweekly');
      const checksPerMonth = freq === 'weekly' ? 4 : freq === 'monthly' ? 1 : 2;

      const goals = await query(`
        SELECT g.*,
        (SELECT COALESCE(SUM(amount),0) FROM savings_contributions WHERE savings_goal_id=g.id) as contributed
        FROM savings_goals g WHERE g.active=1
      `);

      // Also fetch recent auto-contribution averages per goal for better estimates
      const recentContribs = await query(`
        SELECT savings_goal_id, AVG(amount) as avg_amount
        FROM savings_contributions
        WHERE auto=1 AND date >= date('now', '-60 days')
        GROUP BY savings_goal_id
      `);
      const recentAvgMap = {};
      recentContribs.forEach(rc => { recentAvgMap[rc.savings_goal_id] = rc.avg_amount; });

      for (const g of goals) {
        let perCheck = g.per_check_contribution || 0;
        // If per_check is 0 but auto_allocate is on, estimate from recent allocations
        // or from target date / remaining amount
        if (perCheck <= 0 && g.auto_allocate) {
          if (recentAvgMap[g.id]) {
            perCheck = recentAvgMap[g.id];
          } else if (g.target_date && g.target_amount) {
            const current = (g.current_amount || 0) + (g.contributed || 0);
            const remaining = Math.max(0, g.target_amount - current);
            const today = new Date();
            const target = new Date(g.target_date + 'T12:00:00');
            const daysLeft = Math.max(1, Math.ceil((target - today) / 86400000));
            const periodsLeft = Math.max(1, Math.ceil(daysLeft / (freq === 'weekly' ? 7 : freq === 'monthly' ? 30 : 14)));
            perCheck = remaining / periodsLeft;
          }
        }
        const monthly = perCheck * checksPerMonth;
        bills.push({
          id: 'sv-' + g.id,
          savings_goal_id: g.id,
          is_savings: true,
          name: g.name,
          total_amount: monthly,
          computed_portion: monthly,
          my_portion: monthly,
          split_count: 1,
          due_day: null,
          category: 'Savings',
          color: g.color || '#14b8a6',
          recurrence: 'monthly',
          paycheck_slot: 'every_check',
          active: g.active,
          note: g.note,
          auto_allocate: g.auto_allocate,
          priority: g.priority,
          target_amount: g.target_amount,
          current_progress: (g.current_amount || 0) + (g.contributed || 0),
          per_check_contribution: perCheck,
        });
      }
    }

    res.json(bills);
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/api/bills', async (req, res) => {
  try {
    const { name, total_amount, split_count, my_portion, due_day, category, color,
      recurrence, paycheck_slot, note, remaining_payments, variable } = req.body;
    const result = await run(`
      INSERT INTO bills (name, total_amount, split_count, my_portion, due_day, category, color,
        recurrence, paycheck_slot, note, remaining_payments, variable)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [name, total_amount, split_count || 1, my_portion || null, due_day, category || 'Other',
      color || '#ff6b6b', recurrence || 'monthly', paycheck_slot || 'auto', note || '',
      remaining_payments ?? null, variable ? 1 : 0]);
    res.json({ id: result.lastID, ok: true });
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.put('/api/bills/:id', async (req, res) => {
  try {
    const { name, total_amount, split_count, my_portion, due_day, category, color,
      recurrence, paycheck_slot, active, note, remaining_payments, variable } = req.body;
    await run(`
      UPDATE bills SET name=?, total_amount=?, split_count=?, my_portion=?, due_day=?,
      category=?, color=?, recurrence=?, paycheck_slot=?, active=?, note=?,
      remaining_payments=?, variable=? WHERE id=?
    `, [name, total_amount, split_count || 1, my_portion ?? null, due_day, category,
      color, recurrence, paycheck_slot, active ?? 1, note,
      remaining_payments ?? null, variable ? 1 : 0, req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.delete('/api/bills/:id', async (req, res) => {
  try {
    await run('DELETE FROM bills WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({error: e.message}); }
});

// ─── Events ───────────────────────────────────────────────────────────────────

app.get('/api/events', async (req, res) => {
  try {
    const rows = await query(`
      SELECT e.*, p.date as paycheck_date, p.amount as paycheck_amount
      FROM events e
      LEFT JOIN paychecks p ON e.paycheck_id = p.id
      ORDER BY e.date ASC
    `);
    res.json(rows);
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/api/events', async (req, res) => {
  try {
    const { name, date, estimated_cost, category, paycheck_id, color, note } = req.body;
    const result = await run(`
      INSERT INTO events (name, date, estimated_cost, category, paycheck_id, color, note)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [name, date, estimated_cost || 0, category || 'Other',
      paycheck_id || null, color || '#a855f7', note || '']);
    if (paycheck_id) await refreshNetRemaining(paycheck_id);
    res.json({ id: result.lastID, ok: true });
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.put('/api/events/:id', async (req, res) => {
  try {
    const { name, date, estimated_cost, actual_cost, category, paycheck_id, color, note, paid } = req.body;
    const before = await get('SELECT paycheck_id FROM events WHERE id=?', [req.params.id]);
    await run(`
      UPDATE events SET name=?, date=?, estimated_cost=?, actual_cost=?,
      category=?, paycheck_id=?, color=?, note=?, paid=? WHERE id=?
    `, [name, date, estimated_cost, actual_cost ?? null, category,
      paycheck_id ?? null, color, note, paid ?? 0, req.params.id]);
    if (before?.paycheck_id) await refreshNetRemaining(before.paycheck_id);
    if (paycheck_id) await refreshNetRemaining(paycheck_id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.delete('/api/events/:id', async (req, res) => {
  try {
    const before = await get('SELECT paycheck_id FROM events WHERE id=?', [req.params.id]);
    await run('DELETE FROM events WHERE id=?', [req.params.id]);
    if (before?.paycheck_id) await refreshNetRemaining(before.paycheck_id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({error: e.message}); }
});

// ─── Savings ──────────────────────────────────────────────────────────────────

app.get('/api/savings', async (req, res) => {
  try {
    const goals = await query('SELECT * FROM savings_goals ORDER BY priority DESC, name ASC');
    const enriched = await Promise.all(goals.map(async g => {
      const contribRow = await get(
        'SELECT COALESCE(SUM(amount), 0) as total FROM savings_contributions WHERE savings_goal_id=?',
        [g.id]
      );
      const totalContributed = contribRow ? contribRow.total : 0;
      const current = g.current_amount + totalContributed;
      const pct = g.target_amount > 0 ? Math.min(100, (current / g.target_amount) * 100) : 0;

      // Catch-up calc: required per-check given target_date
      let suggested_per_check = g.per_check_contribution || 0;
      let on_track = true;
      if (g.target_date) {
        const today = new Date();
        const target = new Date(g.target_date + 'T12:00:00');
        const daysLeft = Math.max(1, Math.ceil((target - today) / 86400000));
        const checksLeft = Math.max(1, Math.ceil(daysLeft / 14));
        const remaining = Math.max(0, g.target_amount - current);
        suggested_per_check = +(remaining / checksLeft).toFixed(2);
        on_track = (g.per_check_contribution || 0) >= suggested_per_check - 0.5;
      }
      return {
        ...g,
        current_amount: current,
        contributed: totalContributed,
        progress_pct: pct,
        suggested_per_check,
        on_track,
      };
    }));
    res.json(enriched);
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/api/savings', async (req, res) => {
  try {
    const { name, target_amount, current_amount, target_date, per_check_contribution,
      color, note, auto_allocate, priority } = req.body;
    const result = await run(`
      INSERT INTO savings_goals (name, target_amount, current_amount, target_date, per_check_contribution, color, note, auto_allocate, priority)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [name, target_amount, current_amount || 0, target_date || null,
      per_check_contribution || 0, color || '#14b8a6', note || '',
      auto_allocate ? 1 : 0, priority || 0]);
    res.json({ id: result.lastID, ok: true });
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.put('/api/savings/:id', async (req, res) => {
  try {
    const { name, target_amount, current_amount, target_date, per_check_contribution,
      color, note, active, auto_allocate, priority } = req.body;
    await run(`
      UPDATE savings_goals SET name=?, target_amount=?, current_amount=?, target_date=?,
      per_check_contribution=?, color=?, note=?, active=?, auto_allocate=?, priority=? WHERE id=?
    `, [name, target_amount, current_amount ?? 0, target_date ?? null,
      per_check_contribution ?? 0, color, note, active ?? 1,
      auto_allocate ? 1 : 0, priority || 0, req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.delete('/api/savings/:id', async (req, res) => {
  try {
    await run('DELETE FROM savings_goals WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/api/savings/:id/contribute', async (req, res) => {
  try {
    const { amount, paycheck_id, date, note } = req.body;
    await run(`
      INSERT INTO savings_contributions (savings_goal_id, paycheck_id, amount, date, note)
      VALUES (?, ?, ?, ?, ?)
    `, [req.params.id, paycheck_id || null, amount, date || new Date().toISOString().split('T')[0], note || '']);
    if (paycheck_id) await refreshNetRemaining(paycheck_id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.get('/api/savings/:id/contributions', async (req, res) => {
  try {
    const rows = await query(`
      SELECT sc.*, p.date as paycheck_date FROM savings_contributions sc
      LEFT JOIN paychecks p ON sc.paycheck_id = p.id
      WHERE sc.savings_goal_id=? ORDER BY sc.date DESC
    `, [req.params.id]);
    res.json(rows);
  } catch(e) { res.status(500).json({error: e.message}); }
});

// ─── Transactions (manual spending tracking) ──────────────────────────────────

app.get('/api/transactions', async (req, res) => {
  try {
    const { paycheck_id, from, to } = req.query;
    let sql = `SELECT t.*, b.name as bill_name, e.name as event_name
               FROM transactions t
               LEFT JOIN bills b ON t.bill_id = b.id
               LEFT JOIN events e ON t.event_id = e.id WHERE 1=1`;
    const params = [];
    if (paycheck_id) { sql += ' AND t.paycheck_id=?'; params.push(paycheck_id); }
    if (from) { sql += ' AND t.date >= ?'; params.push(from); }
    if (to) { sql += ' AND t.date <= ?'; params.push(to); }
    sql += ' ORDER BY t.date DESC LIMIT 500';
    const rows = await query(sql, params);
    res.json(rows);
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/api/transactions', async (req, res) => {
  try {
    const { date, amount, description, category, paycheck_id, bill_id, event_id, note } = req.body;
    const r = await run(`
      INSERT INTO transactions (date, amount, description, category, paycheck_id, bill_id, event_id, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [date, amount, description || '', category || 'Other',
      paycheck_id || null, bill_id || null, event_id || null, note || '']);
    res.json({ id: r.lastID, ok: true });
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.put('/api/transactions/:id', async (req, res) => {
  try {
    const { date, amount, description, category, paycheck_id, bill_id, event_id, note } = req.body;
    await run(`
      UPDATE transactions SET date=?, amount=?, description=?, category=?, paycheck_id=?,
      bill_id=?, event_id=?, note=? WHERE id=?
    `, [date, amount, description || '', category || 'Other',
      paycheck_id || null, bill_id || null, event_id || null, note || '', req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.delete('/api/transactions/:id', async (req, res) => {
  try {
    await run('DELETE FROM transactions WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({error: e.message}); }
});

// ─── Calendar ─────────────────────────────────────────────────────────────────

app.get('/api/calendar', async (req, res) => {
  try {
    const events = [];

    const paychecks = await query('SELECT * FROM paychecks ORDER BY date ASC');
    paychecks.forEach(p => {
      events.push({
        id: `pc-${p.id}`,
        title: `💰 ${p.label || 'Paycheck'} ${p.amount > 0 ? '$' + p.amount.toLocaleString() : ''}`,
        start: p.date,
        backgroundColor: '#22c55e',
        borderColor: '#16a34a',
        textColor: '#fff',
        extendedProps: { type: 'paycheck', data: p }
      });
    });

    const bills = await query('SELECT * FROM bills WHERE active=1');
    const today = new Date();
    const twoYearsOut = new Date(today.getFullYear() + 2, today.getMonth(), today.getDate());
    bills.forEach(b => {
      if (['every_check', 'split', 'check1', 'check2'].includes(b.paycheck_slot)) {
         let currentMonth = -1;
         let pcCountThisMonth = 0;
         paychecks.forEach(p => {
             const pcD = new Date(p.date + 'T12:00:00');
             if (pcD.getMonth() !== currentMonth) {
                 currentMonth = pcD.getMonth();
                 pcCountThisMonth = 1;
             } else {
                 pcCountThisMonth++;
             }

             let include = false;
             if (b.paycheck_slot === 'every_check' || b.paycheck_slot === 'split') include = true;
             else if (b.paycheck_slot === 'check1' && pcCountThisMonth === 1) include = true;
             else if (b.paycheck_slot === 'check2' && pcCountThisMonth === 2) include = true;

             if (include) {
                 const portion = b.paycheck_slot === 'split' ? computePortion(b) / 2 : computePortion(b);
                 events.push({
                     id: `bill-${b.id}-${p.date}`,
                     title: `📋 ${b.name} $${portion.toFixed(0)}${b.split_count > 1 ? ` (÷${b.split_count})` : ''}`,
                     start: p.date,
                     backgroundColor: b.color || '#ef4444',
                     borderColor: b.color || '#dc2626',
                     textColor: '#fff',
                     extendedProps: { type: 'bill', data: { ...b, computed_portion: portion } }
                 });
             }
         });
         return;
      }

      if (!b.due_day) return;
      let d = new Date(today.getFullYear(), today.getMonth(), b.due_day);
      while (d <= twoYearsOut) {
        const dateStr = d.toISOString().split('T')[0];
        const portion = computePortion(b);
        events.push({
          id: `bill-${b.id}-${dateStr}`,
          title: `📋 ${b.name} $${portion.toFixed(0)}${b.split_count > 1 ? ` (÷${b.split_count})` : ''}`,
          start: dateStr,
          backgroundColor: b.color || '#ef4444',
          borderColor: b.color || '#dc2626',
          textColor: '#fff',
          extendedProps: { type: 'bill', data: { ...b, computed_portion: portion } }
        });
        d = new Date(d.getFullYear(), d.getMonth() + 1, b.due_day);
      }
    });

    const userEvents = await query('SELECT * FROM events ORDER BY date ASC');
    userEvents.forEach(e => {
      events.push({
        id: `evt-${e.id}`,
        title: `🎉 ${e.name} $${e.estimated_cost}`,
        start: e.date,
        backgroundColor: e.color || '#a855f7',
        borderColor: '#9333ea',
        textColor: '#fff',
        extendedProps: { type: 'event', data: e }
      });
    });

    res.json(events);
  } catch(e) { res.status(500).json({error: e.message}); }
});

// ─── Dashboard ────────────────────────────────────────────────────────────────

app.get('/api/dashboard', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const todayDate = new Date();

    const nextPaycheck = await get("SELECT * FROM paychecks WHERE date >= ? ORDER BY date ASC LIMIT 1", [today]);

    const twoWeeksOut = new Date(todayDate.getTime() + 14 * 24 * 60 * 60 * 1000);
    const bills = await query('SELECT * FROM bills WHERE active=1');
    const upcomingBills = [];
    bills.forEach(b => {
      if (!b.due_day) return;
      const dueThisMonth = new Date(todayDate.getFullYear(), todayDate.getMonth(), b.due_day);
      const dueNextMonth = new Date(todayDate.getFullYear(), todayDate.getMonth() + 1, b.due_day);
      [dueThisMonth, dueNextMonth].forEach(due => {
        if (due >= todayDate && due <= twoWeeksOut) {
          const daysUntil = Math.ceil((due - todayDate) / (1000 * 60 * 60 * 24));
          upcomingBills.push({ ...b, computed_portion: computePortion(b), due_date: due.toISOString().split('T')[0], days_until: daysUntil });
        }
      });
    });
    upcomingBills.sort((a, b) => a.days_until - b.days_until);

    const monthStart = new Date(todayDate.getFullYear(), todayDate.getMonth(), 1).toISOString().split('T')[0];
    const monthEnd = new Date(todayDate.getFullYear(), todayDate.getMonth() + 1, 0).toISOString().split('T')[0];

    const freq = await getSetting('pay_frequency', 'biweekly');
    const checksPerMonth = freq === 'weekly' ? 4 : freq === 'monthly' ? 1 : 2;

    const upcomingPaychecks = await query("SELECT * FROM paychecks WHERE date >= ? ORDER BY date ASC LIMIT 4", [today]);
    let monthlyIncome = 0;
    if (upcomingPaychecks.length > 0) {
      monthlyIncome = (upcomingPaychecks[0].amount || 0) * checksPerMonth;
    }

    const monthlyBills = bills.reduce((sum, b) => {
      let monthlyCost = computePortion(b);
      if (b.paycheck_slot === 'every_check') monthlyCost = monthlyCost * checksPerMonth;
      return sum + monthlyCost;
    }, 0);

    const monthlyEventsRow = await get(
      "SELECT COALESCE(SUM(estimated_cost), 0) as total FROM events WHERE date >= ? AND date <= ?",
      [monthStart, monthEnd]
    );
    const monthlyEvents = monthlyEventsRow ? monthlyEventsRow.total : 0;

    const savingsGoals = await query('SELECT * FROM savings_goals WHERE active=1');
    const monthlySavings = savingsGoals.reduce((s, g) => s + ((g.per_check_contribution || 0) * checksPerMonth), 0);

    const categoryTotals = {};
    bills.forEach(b => {
      const cat = b.category || 'Other';
      categoryTotals[cat] = (categoryTotals[cat] || 0) + computePortion(b);
    });

    const upcomingEvents = await query(
      "SELECT e.*, p.date as paycheck_date FROM events e LEFT JOIN paychecks p ON e.paycheck_id=p.id WHERE e.date >= ? ORDER BY e.date ASC LIMIT 5",
      [today]
    );

    const savingsEnriched = await Promise.all(savingsGoals.map(async g => {
      const contribRow = await get('SELECT COALESCE(SUM(amount),0) as t FROM savings_contributions WHERE savings_goal_id=?', [g.id]);
      const contributed = contribRow ? contribRow.t : 0;
      const current = g.current_amount + contributed;
      return { ...g, current_amount: current, progress_pct: g.target_amount > 0 ? Math.min(100, (current / g.target_amount) * 100) : 0 };
    }));

    // Net-remaining trend (last 8 + next 4 paychecks)
    const trendCutoff = new Date(todayDate.getTime() - 120 * 86400000).toISOString().split('T')[0];
    const trendHorizon = new Date(todayDate.getTime() + 80 * 86400000).toISOString().split('T')[0];
    const trendRows = await query(
      'SELECT id, date, amount, net_remaining FROM paychecks WHERE date >= ? AND date <= ? ORDER BY date ASC',
      [trendCutoff, trendHorizon]
    );

    res.json({
      nextPaycheck,
      upcomingBills,
      upcomingEvents,
      savingsGoals: savingsEnriched,
      monthly: {
        income: monthlyIncome,
        bills: monthlyBills,
        events: monthlyEvents,
        savings: monthlySavings,
        net: monthlyIncome - monthlyBills - monthlyEvents - monthlySavings
      },
      categoryTotals,
      trend: trendRows,
      pay_frequency: freq,
    });
  } catch(e) { res.status(500).json({error: e.message}); }
});

// ─── Paystubs (PDF upload + parse) ────────────────────────────────────────────

app.post('/api/paystubs/upload', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const stubs = await parsePaystubPDF(req.file.buffer);
    const inserted = [];
    const skipped = [];
    for (const s of stubs) {
      // Try to match to existing paycheck by date
      const matchingPc = await get(
        'SELECT id FROM paychecks WHERE date=?',
        [s.check_date]
      );
      try {
        const r = await run(`
          INSERT INTO paystubs (check_date, pay_period_start, pay_period_end,
            gross, net, tax_total, deduction_total,
            oasdi, medicare, federal, state_tax, city_tax,
            ytd_gross, ytd_net, ytd_tax, ytd_deductions,
            deductions_json, hours_worked, rate, employer, state, city,
            paycheck_id, raw_text, source_file)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [s.check_date, s.pay_period_start, s.pay_period_end,
          s.gross, s.net, s.tax_total, s.deduction_total,
          s.oasdi, s.medicare, s.federal, s.state_tax, s.city_tax,
          s.ytd_gross, s.ytd_net, s.ytd_tax, s.ytd_deductions,
          s.deductions_json, s.hours_worked, s.rate, s.employer, s.state, s.city,
          matchingPc?.id || null, s.raw_text, req.file.originalname]);
        inserted.push({ id: r.lastID, ...s, paycheck_id: matchingPc?.id });

        // If we matched a paycheck, update its amount to the actual net pay
        if (matchingPc?.id) {
          await run('UPDATE paychecks SET amount=? WHERE id=?', [s.net, matchingPc.id]);
        } else {
          // No matching paycheck — auto-create one so it shows on calendar
          const pcr = await run(
            "INSERT INTO paychecks (date, amount, label, note) VALUES (?, ?, ?, ?)",
            [s.check_date, s.net, 'Paycheck', 'Auto-imported from paystub']
          );
          await run('UPDATE paystubs SET paycheck_id=? WHERE id=?', [pcr.lastID, r.lastID]);
        }
      } catch (e) {
        if (String(e.message).includes('UNIQUE')) {
          skipped.push(s.check_date);
        } else {
          throw e;
        }
      }
    }
    res.json({
      ok: true,
      parsed: stubs.length,
      inserted: inserted.length,
      skipped_duplicates: skipped.length,
      stubs: inserted,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/paystubs', async (req, res) => {
  try {
    const rows = await query('SELECT * FROM paystubs ORDER BY check_date DESC');
    res.json(rows.map(r => ({
      ...r,
      deductions: r.deductions_json ? JSON.parse(r.deductions_json) : {},
    })));
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.delete('/api/paystubs/:id', async (req, res) => {
  try {
    await run('DELETE FROM paystubs WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({error: e.message}); }
});

// Reconcile: take all paystubs and update matching paychecks + create missing ones
app.post('/api/paystubs/reconcile', async (req, res) => {
  try {
    const stubs = await query('SELECT * FROM paystubs ORDER BY check_date ASC');
    let updated = 0, created = 0;
    for (const s of stubs) {
      const pc = await get('SELECT id FROM paychecks WHERE date=?', [s.check_date]);
      if (pc) {
        await run('UPDATE paychecks SET amount=?, label=?, note=? WHERE id=?',
          [s.net, 'Paycheck', `Paystub imported · gross ${s.gross}`, pc.id]);
        await run('UPDATE paystubs SET paycheck_id=? WHERE id=?', [pc.id, s.id]);
        updated++;
      } else {
        const r = await run(
          'INSERT INTO paychecks (date, amount, label, note) VALUES (?, ?, ?, ?)',
          [s.check_date, s.net, 'Paycheck', 'Imported from paystub']
        );
        await run('UPDATE paystubs SET paycheck_id=? WHERE id=?', [r.lastID, s.id]);
        created++;
      }
    }
    res.json({ ok: true, updated, created, total: stubs.length });
  } catch(e) { res.status(500).json({error: e.message}); }
});

// ─── Taxes (aggregation) ──────────────────────────────────────────────────────

app.get('/api/taxes/summary', async (req, res) => {
  try {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const stubs = await query(
      "SELECT * FROM paystubs WHERE substr(check_date,1,4)=? ORDER BY check_date ASC",
      [String(year)]
    );
    const totals = stubs.reduce((a, s) => ({
      gross: a.gross + s.gross,
      net: a.net + s.net,
      federal: a.federal + s.federal,
      state: a.state + s.state_tax,
      city: a.city + s.city_tax,
      oasdi: a.oasdi + s.oasdi,
      medicare: a.medicare + s.medicare,
      total_tax: a.total_tax + s.tax_total,
      deductions: a.deductions + s.deduction_total,
    }), { gross:0, net:0, federal:0, state:0, city:0, oasdi:0, medicare:0, total_tax:0, deductions:0 });

    const latest = stubs[stubs.length - 1];
    const effectiveRate = totals.gross > 0 ? totals.total_tax / totals.gross : 0;

    // Projected full-year from current run-rate
    const monthsElapsed = stubs.length > 0
      ? (new Date(latest.check_date).getMonth() + 1) : 12;
    const projectedAnnual = monthsElapsed > 0
      ? (totals.gross / monthsElapsed) * 12 : 0;
    const projectedAnnualTax = monthsElapsed > 0
      ? (totals.total_tax / monthsElapsed) * 12 : 0;

    res.json({
      year, stubs_count: stubs.length, totals,
      ytd_from_stub: latest ? {
        gross: latest.ytd_gross, net: latest.ytd_net,
        tax: latest.ytd_tax, deductions: latest.ytd_deductions
      } : null,
      effective_tax_rate: effectiveRate,
      projected_annual_gross: projectedAnnual,
      projected_annual_tax: projectedAnnualTax,
      stubs,
    });
  } catch(e) { res.status(500).json({error: e.message}); }
});

// ─── Accounts (net worth assets) ──────────────────────────────────────────────

app.get('/api/accounts', async (req, res) => {
  try {
    const rows = await query('SELECT * FROM accounts WHERE active=1 ORDER BY type, name');
    res.json(rows);
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/api/accounts', async (req, res) => {
  try {
    const { name, type, balance, apy, institution, color, note } = req.body;
    const r = await run(
      `INSERT INTO accounts (name, type, balance, apy, institution, color, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [name, type || 'checking', balance || 0, apy || 0, institution || '', color || '#22c55e', note || '']
    );
    await run('INSERT INTO account_history (account_id, date, balance) VALUES (?, ?, ?)',
      [r.lastID, new Date().toISOString().slice(0,10), balance || 0]);
    res.json({ id: r.lastID, ok: true });
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.put('/api/accounts/:id', async (req, res) => {
  try {
    const { name, type, balance, apy, institution, color, note, active } = req.body;
    const prev = await get('SELECT balance FROM accounts WHERE id=?', [req.params.id]);
    await run(
      `UPDATE accounts SET name=?, type=?, balance=?, apy=?, institution=?, color=?, note=?, active=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      [name, type, balance, apy || 0, institution, color, note, active ?? 1, req.params.id]
    );
    if (prev && prev.balance !== balance) {
      await run('INSERT INTO account_history (account_id, date, balance) VALUES (?, ?, ?)',
        [req.params.id, new Date().toISOString().slice(0,10), balance]);
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.delete('/api/accounts/:id', async (req, res) => {
  try {
    await run('DELETE FROM accounts WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.get('/api/networth', async (req, res) => {
  try {
    const accounts = await query('SELECT * FROM accounts WHERE active=1');
    const debts = await query('SELECT * FROM debts WHERE active=1');
    const totalAssets = accounts.reduce((s, a) => s + (a.balance || 0), 0);
    const totalDebts  = debts.reduce((s, d) => s + (d.balance || 0), 0);
    const byType = {};
    accounts.forEach(a => { byType[a.type] = (byType[a.type] || 0) + a.balance; });
    const history = await query(
      `SELECT date, SUM(balance) as total FROM account_history
       WHERE date >= date('now', '-2 years') GROUP BY date ORDER BY date`
    );
    res.json({
      net_worth: totalAssets - totalDebts,
      total_assets: totalAssets,
      total_debts: totalDebts,
      assets_by_type: byType,
      accounts, debts, history,
    });
  } catch(e) { res.status(500).json({error: e.message}); }
});

// ─── Debts ────────────────────────────────────────────────────────────────────

app.get('/api/debts', async (req, res) => {
  try {
    const rows = await query('SELECT * FROM debts WHERE active=1 ORDER BY apr DESC');
    res.json(rows);
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/api/debts', async (req, res) => {
  try {
    const { name, type, balance, original_balance, apr, minimum_payment, due_day, color, note } = req.body;
    const r = await run(
      `INSERT INTO debts (name, type, balance, original_balance, apr, minimum_payment, due_day, color, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [name, type || 'credit_card', balance, original_balance || balance,
       apr || 0, minimum_payment || 0, due_day || null, color || '#ef4444', note || '']
    );
    res.json({ id: r.lastID, ok: true });
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.put('/api/debts/:id', async (req, res) => {
  try {
    const { name, type, balance, original_balance, apr, minimum_payment, due_day, color, note, active } = req.body;
    await run(
      `UPDATE debts SET name=?, type=?, balance=?, original_balance=?, apr=?, minimum_payment=?, due_day=?, color=?, note=?, active=? WHERE id=?`,
      [name, type, balance, original_balance, apr || 0, minimum_payment || 0,
       due_day || null, color, note, active ?? 1, req.params.id]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.delete('/api/debts/:id', async (req, res) => {
  try {
    await run('DELETE FROM debts WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({error: e.message}); }
});

// Compute snowball vs avalanche payoff scenarios
app.get('/api/debts/strategy', async (req, res) => {
  try {
    const debts = await query('SELECT * FROM debts WHERE active=1 AND balance > 0');
    const extra = parseFloat(req.query.extra) || 0;

    function simulate(orderedDebts, extraMonthly) {
      let balances = orderedDebts.map(d => ({...d, paid: 0}));
      let months = 0, totalInterest = 0;
      while (balances.some(d => d.balance > 0) && months < 600) {
        months++;
        for (const d of balances) {
          if (d.balance > 0) {
            const interest = d.balance * (d.apr / 100 / 12);
            d.balance += interest;
            totalInterest += interest;
          }
        }
        let extraLeft = extraMonthly;
        for (const d of balances) {
          if (d.balance <= 0) continue;
          const pay = Math.min(d.balance, d.minimum_payment || 0);
          d.balance -= pay;
          d.paid += pay;
        }
        for (const d of balances) {
          if (d.balance <= 0) continue;
          const pay = Math.min(d.balance, extraLeft);
          d.balance -= pay;
          d.paid += pay;
          extraLeft -= pay;
          if (extraLeft <= 0) break;
        }
      }
      return { months, totalInterest, finalBalances: balances };
    }

    const avalancheOrder = [...debts].sort((a,b) => b.apr - a.apr);
    const snowballOrder  = [...debts].sort((a,b) => a.balance - b.balance);
    const avalanche = simulate(avalancheOrder, extra);
    const snowball  = simulate(snowballOrder, extra);

    res.json({
      total_debt: debts.reduce((s,d) => s + d.balance, 0),
      total_minimum: debts.reduce((s,d) => s + d.minimum_payment, 0),
      extra,
      avalanche: { order: avalancheOrder.map(d => d.name), months: avalanche.months,
                   years: +(avalanche.months/12).toFixed(1), interest: +avalanche.totalInterest.toFixed(2) },
      snowball:  { order: snowballOrder.map(d => d.name), months: snowball.months,
                   years: +(snowball.months/12).toFixed(1), interest: +snowball.totalInterest.toFixed(2) },
      savings: +(snowball.totalInterest - avalanche.totalInterest).toFixed(2),
      recommended: avalanche.totalInterest < snowball.totalInterest ? 'avalanche' : 'snowball',
    });
  } catch(e) { res.status(500).json({error: e.message}); }
});

// ─── Financial Plan (the marquee one-click endpoint) ──────────────────────────

app.post('/api/plan/generate', async (req, res) => {
  try {
    const [paystubs, bills, savingsGoals, accounts, debts, paychecks, settingsRows] = await Promise.all([
      query('SELECT * FROM paystubs ORDER BY check_date ASC'),
      query('SELECT * FROM bills WHERE active=1'),
      query('SELECT * FROM savings_goals WHERE active=1'),
      query('SELECT * FROM accounts WHERE active=1'),
      query('SELECT * FROM debts WHERE active=1'),
      query('SELECT * FROM paychecks ORDER BY date ASC'),
      query('SELECT key, value FROM settings'),
    ]);
    const settings = {};
    settingsRows.forEach(r => settings[r.key] = r.value);

    const plan = generatePlan({ paystubs, bills, savingsGoals, accounts, debts, paychecks, settings });
    const snapshot = { paystubs_count: paystubs.length, bills_count: bills.length,
                       debts_count: debts.length, accounts_count: accounts.length };
    await run('INSERT INTO financial_plans (snapshot_json, plan_json) VALUES (?, ?)',
      [JSON.stringify(snapshot), JSON.stringify(plan)]);
    res.json(plan);
  } catch(e) {
    console.error(e);
    res.status(500).json({error: e.message});
  }
});

app.get('/api/plan/latest', async (req, res) => {
  try {
    const row = await get('SELECT * FROM financial_plans ORDER BY id DESC LIMIT 1');
    if (!row) return res.json(null);
    res.json({ ...JSON.parse(row.plan_json), _id: row.id, _generated_at: row.generated_at });
  } catch(e) { res.status(500).json({error: e.message}); }
});

// One-click: create the suggested savings goals from the plan
app.post('/api/plan/apply-goals', async (req, res) => {
  try {
    const { goals } = req.body;
    if (!Array.isArray(goals)) return res.status(400).json({ error: 'goals[] required' });
    let created = 0;
    for (const g of goals) {
      // Skip if a goal with same name already exists
      const existing = await get('SELECT id FROM savings_goals WHERE name=?', [g.name]);
      if (existing) continue;
      await run(
        `INSERT INTO savings_goals (name, target_amount, current_amount, per_check_contribution, color, auto_allocate, priority, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
        [g.name, g.target_amount, g.current_amount || 0, g.per_check_contribution || 0,
         g.color || '#14b8a6', g.auto_allocate ?? 1, g.priority || 0]
      );
      created++;
    }
    res.json({ ok: true, created });
  } catch(e) { res.status(500).json({error: e.message}); }
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n✅ Budget App running at http://localhost:${PORT}`);
  console.log(`   Press Ctrl+C to stop.\n`);
});
