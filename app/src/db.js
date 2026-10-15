// SQLite storage (Node built-in, no native modules). File lives in app/data/app.db
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS message_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  template TEXT NOT NULL,
  description TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  type_id INTEGER REFERENCES message_types(id) ON DELETE SET NULL,
  active INTEGER NOT NULL DEFAULT 1,
  max_pages INTEGER NOT NULL DEFAULT 20,
  notes TEXT DEFAULT '',
  last_synced_at TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  list_id INTEGER REFERENCES lists(id) ON DELETE CASCADE,
  sales_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  first_name TEXT DEFAULT '',
  title TEXT DEFAULT '',
  company TEXT DEFAULT '',
  location TEXT DEFAULT '',
  degree TEXT DEFAULT '',
  sales_url TEXT DEFAULT '',
  profile_url TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  message TEXT DEFAULT '',
  error TEXT DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_at TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_leads_list_status ON leads(list_id, status);
CREATE INDEX IF NOT EXISTS idx_leads_sent_at ON leads(sent_at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT DEFAULT (datetime('now','localtime')),
  level TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  list_id INTEGER,
  lead_id INTEGER
);
`);

// Migrations for columns added after the first version
const listCols = db.prepare('PRAGMA table_info(lists)').all().map((c) => c.name);
if (!listCols.includes('target_countries')) db.exec("ALTER TABLE lists ADD COLUMN target_countries TEXT NOT NULL DEFAULT ''");
if (!listCols.includes('send_limit')) db.exec('ALTER TABLE lists ADD COLUMN send_limit INTEGER NOT NULL DEFAULT 0');
if (!listCols.includes('activated_at')) {
  db.exec('ALTER TABLE lists ADD COLUMN activated_at TEXT');
  db.exec('UPDATE lists SET activated_at = created_at');
}

// Every value the automation needs is here, editable from the Settings screen.
const DEFAULT_SETTINGS = {
  delay_min: 30,          // seconds to wait after each invitation (random between min..max)
  delay_max: 50,
  tab_wait_min: 15,       // seconds to stay on every page/tab the bot opens
  tab_wait_max: 20,
  profile_min_seconds: 60, // minimum total time spent on each profile before closing its tab
  batch_size: 25,         // after every N invitations (all lists, per day) take a longer break; 0 = off
  batch_break_min: 10,    // break length in MINUTES (random between min..max)
  batch_break_max: 20,
  acceptance_check_hours: 4,  // when idle, check who accepted every N hours (0 = only manual / after runs)
  acceptance_scan_max: 500,   // how many recent connections to read per check
  skip_unclear_location: 0,   // 1 = skip leads whose location doesn't show a country (when a list has target countries)
  skip_delay_min: 4,      // shorter wait after a lead is skipped (already connected etc.)
  skip_delay_max: 8,
  daily_limit: 100,       // max invitations per calendar day, split equally across active lists (max 100)
  run_limit: 100,         // max invitations per single "Start" click
  note_max_chars: 300,    // LinkedIn note limit (300 premium / 200 free)
  page_load_wait: 4,      // seconds to let pages settle
  dry_run: 0,             // 1 = do everything except clicking the final Send
  max_attempts: 2,        // retries for failed leads
};

const insertDefault = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insertDefault.run(k, String(v));

// Seed one example type so the UI isn't empty on first launch
if (db.prepare('SELECT COUNT(*) c FROM message_types').get().c === 0) {
  db.prepare('INSERT INTO message_types (name, template, description) VALUES (?, ?, ?)').run(
    'Bookkeepers',
    'Hi {first_name}, I work with bookkeepers who serve contractors and trades businesses. Would love to connect and share ideas.',
    'Example type - edit or delete it'
  );
}

// Connection-note variants: each message type holds several notes; one is picked per lead.
db.exec(`
CREATE TABLE IF NOT EXISTS message_variants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type_id INTEGER NOT NULL REFERENCES message_types(id) ON DELETE CASCADE,
  label TEXT DEFAULT '',
  body TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_variants_type ON message_variants(type_id);
`);
const leadCols = db.prepare('PRAGMA table_info(leads)').all().map((c) => c.name);
if (!leadCols.includes('accepted_at')) db.exec('ALTER TABLE leads ADD COLUMN accepted_at TEXT');
if (!leadCols.includes('variant_id')) db.exec('ALTER TABLE leads ADD COLUMN variant_id INTEGER REFERENCES message_variants(id) ON DELETE SET NULL');
// Move old single templates ("---" separated versions) into variant rows, once
for (const t of db.prepare('SELECT * FROM message_types WHERE id NOT IN (SELECT type_id FROM message_variants)').all()) {
  const parts = String(t.template || '').split(/^\s*---\s*$/m).map((p) => p.trim()).filter(Boolean);
  parts.forEach((body, i) => db.prepare('INSERT INTO message_variants (type_id, body, position) VALUES (?, ?, ?)').run(t.id, body, i));
}

// Since 2026-10-15 problems are skipped, never retried
db.exec("UPDATE leads SET status = 'skipped' WHERE status = 'failed'");

function getSettings() {
  const rows = db.prepare("SELECT key, value FROM settings WHERE key NOT LIKE 'state:%'").all();
  const out = { ...DEFAULT_SETTINGS };
  for (const r of rows) out[r.key] = isNaN(Number(r.value)) ? r.value : Number(r.value);
  return out;
}

function updateSettings(patch) {
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    stmt.run(k, String(v));
  }
  return getSettings();
}

// Internal app state (e.g. "paused because of LinkedIn limit") – stored next to settings, not editable there
function getState(key) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(`state:${key}`);
  try { return r ? JSON.parse(r.value) : null; } catch { return null; }
}
function setState(key, value) {
  if (value === null) db.prepare('DELETE FROM settings WHERE key = ?').run(`state:${key}`);
  else db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(`state:${key}`, JSON.stringify(value));
}

module.exports = { db, getSettings, updateSettings, getState, setState, DEFAULT_SETTINGS, DATA_DIR };
