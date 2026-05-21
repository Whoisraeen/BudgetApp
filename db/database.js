const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = path.join(__dirname, 'budget.db');

let db;

function getDb() {
  if (!db) {
    db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) {
        console.error("Error opening database " + err.message);
      } else {
        db.exec('PRAGMA journal_mode = WAL');
        db.exec('PRAGMA foreign_keys = ON');
        initSchema();
      }
    });
  }
  return db;
}

function addColumnIfMissing(table, column, definition) {
  return new Promise((resolve) => {
    db.all(`PRAGMA table_info(${table})`, (err, rows) => {
      if (err || !rows) return resolve();
      const exists = rows.some(r => r.name === column);
      if (exists) return resolve();
      db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`, () => resolve());
    });
  });
}

function initSchema() {
  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS paychecks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        amount REAL DEFAULT 0,
        label TEXT DEFAULT 'Paycheck',
        note TEXT,
        is_extra INTEGER DEFAULT 0,
        net_remaining REAL,
        rollover_from_prev REAL DEFAULT 0
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS bills (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        total_amount REAL NOT NULL,
        split_count INTEGER DEFAULT 1,
        my_portion REAL,
        due_day INTEGER,
        category TEXT DEFAULT 'Other',
        color TEXT DEFAULT '#ff6b6b',
        recurrence TEXT DEFAULT 'monthly',
        paycheck_slot TEXT DEFAULT 'auto',
        active INTEGER DEFAULT 1,
        note TEXT,
        remaining_payments INTEGER,
        variable INTEGER DEFAULT 0
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        date TEXT NOT NULL,
        estimated_cost REAL DEFAULT 0,
        actual_cost REAL,
        category TEXT DEFAULT 'Other',
        paycheck_id INTEGER,
        color TEXT DEFAULT '#a855f7',
        note TEXT,
        paid INTEGER DEFAULT 0,
        FOREIGN KEY (paycheck_id) REFERENCES paychecks(id) ON DELETE SET NULL
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS savings_goals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        target_amount REAL NOT NULL,
        current_amount REAL DEFAULT 0,
        target_date TEXT,
        per_check_contribution REAL DEFAULT 0,
        color TEXT DEFAULT '#14b8a6',
        note TEXT,
        active INTEGER DEFAULT 1,
        auto_allocate INTEGER DEFAULT 0,
        priority INTEGER DEFAULT 0
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS savings_contributions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        savings_goal_id INTEGER NOT NULL,
        paycheck_id INTEGER,
        amount REAL NOT NULL,
        date TEXT,
        note TEXT,
        auto INTEGER DEFAULT 0,
        FOREIGN KEY (savings_goal_id) REFERENCES savings_goals(id) ON DELETE CASCADE,
        FOREIGN KEY (paycheck_id) REFERENCES paychecks(id) ON DELETE SET NULL
      )
    `);

    // Per-paycheck bill override: lets users reassign a bill to a specific check
    // without changing the bill's default slot. Also stores per-occurrence actual cost.
    db.run(`
      CREATE TABLE IF NOT EXISTS bill_occurrences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bill_id INTEGER NOT NULL,
        paycheck_id INTEGER,
        period_key TEXT,
        estimated_amount REAL,
        actual_amount REAL,
        paid INTEGER DEFAULT 0,
        note TEXT,
        FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE CASCADE,
        FOREIGN KEY (paycheck_id) REFERENCES paychecks(id) ON DELETE SET NULL
      )
    `);

    // Parsed paystubs from uploaded PDFs
    db.run(`
      CREATE TABLE IF NOT EXISTS paystubs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        check_date TEXT NOT NULL,
        pay_period_start TEXT,
        pay_period_end TEXT,
        gross REAL DEFAULT 0,
        net REAL DEFAULT 0,
        tax_total REAL DEFAULT 0,
        deduction_total REAL DEFAULT 0,
        oasdi REAL DEFAULT 0,
        medicare REAL DEFAULT 0,
        federal REAL DEFAULT 0,
        state_tax REAL DEFAULT 0,
        city_tax REAL DEFAULT 0,
        ytd_gross REAL DEFAULT 0,
        ytd_net REAL DEFAULT 0,
        ytd_tax REAL DEFAULT 0,
        ytd_deductions REAL DEFAULT 0,
        deductions_json TEXT,
        hours_worked REAL,
        rate REAL,
        employer TEXT,
        state TEXT,
        city TEXT,
        paycheck_id INTEGER,
        raw_text TEXT,
        source_file TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (paycheck_id) REFERENCES paychecks(id) ON DELETE SET NULL,
        UNIQUE (check_date)
      )
    `);

    // Net worth: accounts (assets) and debts (liabilities)
    db.run(`
      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        balance REAL DEFAULT 0,
        apy REAL DEFAULT 0,
        institution TEXT,
        color TEXT DEFAULT '#22c55e',
        note TEXT,
        active INTEGER DEFAULT 1,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS account_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL,
        date TEXT NOT NULL,
        balance REAL NOT NULL,
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS debts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT DEFAULT 'credit_card',
        balance REAL NOT NULL,
        original_balance REAL,
        apr REAL DEFAULT 0,
        minimum_payment REAL DEFAULT 0,
        due_day INTEGER,
        priority INTEGER DEFAULT 0,
        color TEXT DEFAULT '#ef4444',
        note TEXT,
        active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS financial_plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        generated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        snapshot_json TEXT NOT NULL,
        plan_json TEXT NOT NULL
      )
    `);

    // Manual spending transactions for reconciliation
    db.run(`
      CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        amount REAL NOT NULL,
        description TEXT,
        category TEXT DEFAULT 'Other',
        paycheck_id INTEGER,
        bill_id INTEGER,
        event_id INTEGER,
        note TEXT,
        FOREIGN KEY (paycheck_id) REFERENCES paychecks(id) ON DELETE SET NULL,
        FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE SET NULL,
        FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE SET NULL
      )
    `);

    // Migrations for existing databases (additive)
    Promise.all([
      addColumnIfMissing('paychecks', 'is_extra', 'INTEGER DEFAULT 0'),
      addColumnIfMissing('paychecks', 'net_remaining', 'REAL'),
      addColumnIfMissing('paychecks', 'rollover_from_prev', 'REAL DEFAULT 0'),
      addColumnIfMissing('bills', 'remaining_payments', 'INTEGER'),
      addColumnIfMissing('bills', 'variable', 'INTEGER DEFAULT 0'),
      addColumnIfMissing('savings_goals', 'auto_allocate', 'INTEGER DEFAULT 0'),
      addColumnIfMissing('savings_goals', 'priority', 'INTEGER DEFAULT 0'),
      addColumnIfMissing('savings_contributions', 'auto', 'INTEGER DEFAULT 0'),
    ]);

    // Seed default settings
    db.get("SELECT value FROM settings WHERE key='initialized'", (err, row) => {
      if (!row) {
        db.run("INSERT INTO settings (key, value) VALUES ('initialized', 'true')");
        db.run("INSERT INTO settings (key, value) VALUES ('paycheck_amount', '0')");
        db.run("INSERT INTO settings (key, value) VALUES ('currency', 'USD')");
        db.run("INSERT INTO settings (key, value) VALUES ('pay_frequency', 'biweekly')");
        db.run("INSERT INTO settings (key, value) VALUES ('auto_savings_enabled', 'true')");
        db.run("INSERT INTO settings (key, value) VALUES ('rollover_enabled', 'false')");
      } else {
        // Backfill new defaults if missing
        ['pay_frequency=biweekly', 'auto_savings_enabled=true', 'rollover_enabled=false'].forEach(pair => {
          const [k, v] = pair.split('=');
          db.run("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", [k, v]);
        });
      }
    });
  });
}

const query = (sql, params = []) => {
    return new Promise((resolve, reject) => {
        getDb().all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
};

const get = (sql, params = []) => {
     return new Promise((resolve, reject) => {
        getDb().get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

const run = (sql, params = []) => {
    return new Promise((resolve, reject) => {
        getDb().run(sql, params, function(err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}


module.exports = { getDb, query, get, run };
