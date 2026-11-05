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
// review_first: 1 = new leads wait for your approval · 0 = the bot sends to them right away
if (!listCols.includes('review_first')) db.exec('ALTER TABLE lists ADD COLUMN review_first INTEGER NOT NULL DEFAULT 1');
// sync_target: how many leads the bot keeps ready (to review / to send) – it syncs by itself to reach it
if (!listCols.includes('sync_target')) db.exec('ALTER TABLE lists ADD COLUMN sync_target INTEGER NOT NULL DEFAULT 100');
// skip_keywords: comma separated – people whose title or company contains one are skipped
if (!listCols.includes('skip_keywords')) db.exec("ALTER TABLE lists ADD COLUMN skip_keywords TEXT NOT NULL DEFAULT ''");
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
  acceptance_poll_minutes: 10, // quick acceptance check (LinkedIn API, no tab) every N minutes; 0 = off
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
  // Account safety (keeps the LinkedIn account away from limits / restrictions)
  weekly_limit: 180,      // max invitations per week (your LinkedIn limit is ~200); 0 = off
  weekly_window: 'monday', // 'monday' = the week starts Monday (LinkedIn resets then) · 'rolling' = last 7 days
  work_hours_start: 0,    // only send between these hours (local time); 0 and 24 = any time
  work_hours_end: 24,
  skip_weekends: 0,       // 1 = no invitations on Saturday / Sunday
  max_pending: 300,       // stop sending while this many invitations (last 3 weeks) are still pending; 0 = off
  min_acceptance_pct: 10, // warn when fewer than this % of invitations get accepted; 0 = off
  safety_cooldown_hours: 24, // after a LinkedIn security check / restriction / rate limit: nothing runs for this long
  followup_daily_limit: 5,  // follow-up messages per day (all message types together); 0 = none
  followup_auto: 1,         // 1 = the bot sends follow-ups by itself when they are due (no Start needed)
  crm_inbox_auto: 1,        // 1 = every 30 min (while idle) the bot reads your inbox and puts everyone who wrote to you in the CRM
  prospect_daily_profile_views: 60, // prospect finder: max profiles opened per day; 0 = no limit
  prospect_job_blocked: '', // jobs in these countries are never kept (posts still are)
  prospect_auto_run_at: '',   // run all ON searches every day at this time ("09:00"); empty = off
  telegram_bot_token: '',     // optional: send the daily list to Telegram
  telegram_chat_id: '',
  prospect_ai_check: 0,       // 1 = Claude reads each post that passed the rules and drops sellers / advice posts
  prospect_blocked: '', // prospect finder: never keep people / jobs in these countries or regions
  prospect_target: '',   // keep only people / jobs in these countries / regions (empty = anywhere not blocked)
  prospect_cv_keywords: '',    // job titles / skills from the uploaded CV, accepted by the filters
  prospect_global_only: 'All countries', // jobs here must be remote + open to applicants worldwide
  prospect_max_experience: 5, // drop jobs that ask for more years of experience than this
  prospect_daily_posts: 10,   // max new post prospects per day
  prospect_daily_jobs: 10,    // max new job prospects per day
  prospect_extra_posts: 0,    // more posts on top of the daily limit – today only (back to 0 tomorrow)
  prospect_extra_jobs: 0,
  prospect_extra_date: '',    // the day the extras were set
  prospect_profile_wait_min: 6, // seconds on each author profile / job page while checking location
  prospect_profile_wait_max: 12,
  // Job applier (/jobs): finds remote jobs and applies with Easy Apply
  jobs_auto: 0,               // 1 = apply by itself every day at jobs_run_at
  jobs_run_at: '11:00',       // daily start time
  jobs_daily: 18,             // applications per day
  jobs_keywords: '',
  jobs_regions: '',
  jobs_pakistan: 0,           // 1 = also remote jobs in Pakistan – only when the post shows a salary of at least jobs_pk_min_salary
  jobs_pk_min_salary: 0, // PKR per month
  jobs_years: 0,              // answer to "how many years of experience" questions
  jobs_salary_pk: 0,     // expected monthly salary for jobs in Pakistan (PKR)
  jobs_salary_usd: 0,       // expected monthly salary for every other job (USD)
  jobs_max_years: 6,          // skip jobs that ask for more years than this
  jobs_wait_min: 60,          // seconds between two applications
  jobs_wait_max: 150,
  profile_country: '',        // the country you live in – answers "where do you live" questions on job forms
  profile_nationality: '',    // e.g. Pakistani – answers nationality / citizenship questions
  jobs_searches: '',          // saved job searches (JSON: [{ id, name, keywords, regions }])
  jobs_search_active: 0,      // id of the one the bot runs; its keywords / regions are copied to jobs_keywords / jobs_regions
};
// Settings that hold text, not numbers
const TEXT_SETTINGS = ['profile_country', 'profile_nationality', 'jobs_searches', 'jobs_run_at', 'jobs_keywords', 'jobs_regions','prospect_job_blocked', 'prospect_auto_run_at', 'telegram_bot_token', 'telegram_chat_id', 'weekly_window', 'prospect_blocked', 'prospect_target', 'prospect_global_only', 'prospect_cv_keywords', 'prospect_extra_date'];

// Installs from before the profile fields always answered as living in Pakistan: keep that
if (db.prepare('SELECT COUNT(*) c FROM settings').get().c && !db.prepare("SELECT 1 FROM settings WHERE key = 'profile_country'").get()) {
  db.prepare("INSERT INTO settings (key, value) VALUES ('profile_country', 'Pakistan'), ('profile_nationality', 'Pakistani')").run();
}

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
if (!leadCols.includes('photo_url')) {
  db.exec("ALTER TABLE leads ADD COLUMN photo_url TEXT DEFAULT ''");
  // leads synced from now on wait for your review ('review') before the bot may send; the ones
  // collected earlier and never tried go to review too
  db.exec("UPDATE leads SET status = 'review' WHERE status = 'pending' AND attempts = 0 AND sent_at IS NULL");
}
// Move old single templates ("---" separated versions) into variant rows, once
for (const t of db.prepare('SELECT * FROM message_types WHERE id NOT IN (SELECT type_id FROM message_variants)').all()) {
  const parts = String(t.template || '').split(/^\s*---\s*$/m).map((p) => p.trim()).filter(Boolean);
  parts.forEach((body, i) => db.prepare('INSERT INTO message_variants (type_id, body, position) VALUES (?, ?, ?)').run(t.id, body, i));
}

// Follow-up messages: up to 3 per message type, sent to people who accepted that type's connection note
// and have not replied. Step 1 waits delay_days after the acceptance, each next step after the previous one
// (the days are set per message type, so every campaign can have its own timing).
db.exec(`
CREATE TABLE IF NOT EXISTS message_followups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type_id INTEGER NOT NULL REFERENCES message_types(id) ON DELETE CASCADE,
  step INTEGER NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  delay_days REAL NOT NULL DEFAULT 2,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE(type_id, step)
);
CREATE TABLE IF NOT EXISTS followups_sent (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  step INTEGER NOT NULL,
  message TEXT NOT NULL,
  sent_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_followups_sent_at ON followups_sent(sent_at);
`);
{
  const cols = db.prepare('PRAGMA table_info(leads)').all().map((c) => c.name);
  if (!cols.includes('followup_step')) db.exec('ALTER TABLE leads ADD COLUMN followup_step INTEGER NOT NULL DEFAULT 0'); // follow-ups sent so far
  if (!cols.includes('followup_at')) db.exec('ALTER TABLE leads ADD COLUMN followup_at TEXT');                            // last one sent
  if (!cols.includes('replied_at')) db.exec('ALTER TABLE leads ADD COLUMN replied_at TEXT');                              // they answered -> no more follow-ups
  // '' = going on · 'replied' · 'manual' (another message of yours in the chat) · 'missing' (the note / an earlier
  // follow-up is not in the chat) · 'failed' (could not message them twice in a row). followup_error = the reason
  if (!cols.includes('followup_state')) db.exec("ALTER TABLE leads ADD COLUMN followup_state TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('followup_error')) db.exec("ALTER TABLE leads ADD COLUMN followup_error TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('followup_tries')) db.exec('ALTER TABLE leads ADD COLUMN followup_tries INTEGER NOT NULL DEFAULT 0');
  // the chat with them (opened directly next time – no profile visit), and when the bot last read it
  if (!cols.includes('chat_url')) db.exec("ALTER TABLE leads ADD COLUMN chat_url TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('chat_checked_at')) db.exec('ALTER TABLE leads ADD COLUMN chat_checked_at TEXT');
  // their latest reply and its category: positive | negative | unclear (set by the bot, or by you – then the bot keeps it)
  if (!cols.includes('reply_text')) db.exec("ALTER TABLE leads ADD COLUMN reply_text TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('reply_category')) db.exec("ALTER TABLE leads ADD COLUMN reply_category TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('reply_category_by')) db.exec("ALTER TABLE leads ADD COLUMN reply_category_by TEXT NOT NULL DEFAULT ''");
  // CRM stage you set by dragging the lead (empty = the bot places it, see crm.js) and when
  if (!cols.includes('crm_stage')) db.exec("ALTER TABLE leads ADD COLUMN crm_stage TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('crm_stage_at')) db.exec('ALTER TABLE leads ADD COLUMN crm_stage_at TEXT');
  // 1 = you removed this campaign lead from the CRM board (the lead itself stays in its campaign)
  if (!cols.includes('crm_hidden')) db.exec('ALTER TABLE leads ADD COLUMN crm_hidden INTEGER NOT NULL DEFAULT 0');
}

// ---------- Prospect finder: LinkedIn posts / jobs that show a need for lead gen & outreach ----------
db.exec(`
CREATE TABLE IF NOT EXISTS prospect_searches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'posts',      -- posts | jobs
  keywords TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',       -- jobs only: LinkedIn job location filter
  date_window TEXT NOT NULL DEFAULT 'week', -- day | week | month
  max_results INTEGER NOT NULL DEFAULT 40, -- cards to read per run
  active INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  last_result TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS prospects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  search_id INTEGER REFERENCES prospect_searches(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,                       -- post | job
  source_key TEXT NOT NULL UNIQUE,          -- dedupe key (job id / author + text)
  url TEXT DEFAULT '',                      -- post or job link
  person_name TEXT DEFAULT '',
  person_url TEXT DEFAULT '',
  headline TEXT DEFAULT '',
  company_name TEXT DEFAULT '',
  company_url TEXT DEFAULT '',
  location TEXT DEFAULT '',
  title TEXT DEFAULT '',                    -- job title
  text TEXT DEFAULT '',                     -- post text / job summary
  posted TEXT DEFAULT '',
  score INTEGER NOT NULL DEFAULT 0,
  reasons TEXT DEFAULT '',                  -- why it was kept (comma separated)
  status TEXT NOT NULL DEFAULT 'new',       -- new | contacted | not_relevant | rejected (filtered out)
  reject_reason TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  found_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_prospects_status ON prospects(status, kind);
CREATE INDEX IF NOT EXISTS idx_prospects_person ON prospects(person_url);
`);
if (db.prepare('SELECT COUNT(*) c FROM prospect_searches').get().c === 0) {
  const add = db.prepare('INSERT INTO prospect_searches (name, kind, keywords, location, date_window) VALUES (?, ?, ?, ?, ?)');
  [
    ['Looking for lead gen help', 'posts', '"looking for" "lead generation"', ''],
    ['Need lead gen help', 'posts', '"need help" "lead generation"', ''],
    ['Recommend cold email agency', 'posts', 'recommend "cold email" agency', ''],
    ['Looking for appointment setter', 'posts', '"looking for" "appointment setter"', ''],
    ['Looking for email marketing agency', 'posts', '"looking for" "email marketing" agency', ''],
    ['Outsource outbound / lead gen', 'posts', 'outsource "lead generation" OR outbound', ''],
    ['Hiring appointment setter (posts)', 'posts', '"we are hiring" "appointment setter" OR "lead generation specialist"', ''],
    ['Jobs: Lead Generation (US)', 'jobs', 'Lead Generation Specialist remote', 'United States'],
    ['Jobs: Appointment Setter (US)', 'jobs', 'Appointment Setter remote', 'United States'],
    ['Jobs: Cold Email / Outreach (US)', 'jobs', 'Cold Email Outreach remote', 'United States'],
    ['Jobs: Email Marketing (US)', 'jobs', 'Email Marketing Specialist remote', 'United States'],
  ].forEach(([n, k, q, l]) => add.run(n, k, q, l, 'week'));
}
// Searches added later (inserted once, by name)
{
  const add = db.prepare(`INSERT INTO prospect_searches (name, kind, keywords, location, date_window)
                          SELECT ?, 'jobs', ?, ?, 'week' WHERE NOT EXISTS (SELECT 1 FROM prospect_searches WHERE name = ?)`);
  [
    ['Jobs: Lead Generation (UK)', 'Lead Generation remote', 'United Kingdom'],
    ['Jobs: Lead Generation (Canada)', 'Lead Generation remote', 'Canada'],
    ['Jobs: Lead Generation (Europe)', 'Lead Generation', 'European Union'],
    ['Jobs: Appointment Setter (Europe)', 'Appointment Setter', 'European Union'],
    ['Jobs: Cold Email / Outreach (Europe)', 'Cold Email Outreach', 'European Union'],
    // more lead gen style roles (2026-10-16)
    ['Jobs: Cold Caller (US)', 'Cold Caller remote', 'United States'],
    ['Jobs: Outreach Specialist (US)', 'Outreach Specialist remote', 'United States'],
    ['Jobs: Setter / Closer (US)', 'Setter remote', 'United States'],
    ['Jobs: LinkedIn Outreach (US)', 'LinkedIn Outreach remote', 'United States'],
    ['Jobs: Lead Researcher (US)', 'Lead Research remote', 'United States'],
    ['Jobs: Telemarketing (US)', 'Telemarketer remote', 'United States'],
    ['Jobs: Appointment Setter (UK)', 'Appointment Setter remote', 'United Kingdom'],
    ['Jobs: Cold Caller (UK)', 'Cold Caller remote', 'United Kingdom'],
    ['Jobs: Outreach Specialist (UK)', 'Outreach Specialist remote', 'United Kingdom'],
    ['Jobs: Email Marketing (UK)', 'Email Marketing remote', 'United Kingdom'],
    ['Jobs: Appointment Setter (Canada)', 'Appointment Setter remote', 'Canada'],
    ['Jobs: Cold Caller (Canada)', 'Cold Caller remote', 'Canada'],
    ['Jobs: Outreach Specialist (Canada)', 'Outreach Specialist remote', 'Canada'],
    ['Jobs: Lead Generation Specialist (Europe)', 'Lead Generation Specialist', 'European Union'],
    ['Jobs: Cold Caller (Europe)', 'Cold Caller', 'European Union'],
    ['Jobs: Outreach Specialist (Europe)', 'Outreach Specialist', 'European Union'],
    ['Jobs: Email Marketing (Europe)', 'Email Marketing Specialist', 'European Union'],
    ['Jobs: LinkedIn Outreach (Europe)', 'LinkedIn Outreach', 'European Union'],
    ['Jobs: Lead Researcher (Europe)', 'Lead Research', 'European Union'],
    ['Jobs: Telemarketing (Europe)', 'Telemarketing', 'European Union'],
  ].forEach(([n, q, l]) => add.run(n, q, l, n));
}

// Europe focus (2026-10-16): job searches per country (LinkedIn's "European Union" leaves out UK, Switzerland, Norway)
{
  const add = db.prepare(`INSERT INTO prospect_searches (name, kind, keywords, location, date_window, max_results)
                          SELECT ?, 'jobs', ?, ?, 'week', 15 WHERE NOT EXISTS (SELECT 1 FROM prospect_searches WHERE name = ?)`);
  for (const country of ['Ireland', 'Netherlands', 'Germany', 'Spain', 'Portugal', 'Poland', 'Switzerland', 'Norway']) {
    for (const role of ['Lead Generation', 'Appointment Setter']) {
      const n = `Jobs: ${role} (${country})`;
      add.run(n, role, country, n);
    }
  }
}

// New instructions (2026-10-17): more buyer keywords for posts, and job searches for every target country
{
  const addPost = db.prepare(`INSERT INTO prospect_searches (name, kind, keywords, location, date_window, max_results)
                              SELECT ?, 'posts', ?, '', 'week', 80 WHERE NOT EXISTS (SELECT 1 FROM prospect_searches WHERE name = ?)`);
  for (const q of ['need appointment setter', 'looking for lead generation', 'need help with outbound', 'looking for cold email expert',
    'need someone for LinkedIn outreach', 'hiring appointment setter remote', 'looking for BDR remote', 'need more sales meetings',
    'pipeline is dry', 'need B2B leads', 'recommend a lead gen agency', 'looking for outreach help']) {
    const n = `Posts: ${q}`;
    addPost.run(n, `"${q}"`, n);
  }
  const addJob = db.prepare(`INSERT INTO prospect_searches (name, kind, keywords, location, date_window, max_results)
                             SELECT ?, 'jobs', ?, ?, 'week', 40 WHERE NOT EXISTS (SELECT 1 FROM prospect_searches WHERE name = ?)`);
  for (const country of ['Denmark', 'Sweden', 'Finland', 'Belgium', 'Austria', 'Estonia', 'Czech Republic']) {
    for (const role of ['Lead Generation', 'Appointment Setter']) {
      const n = `Jobs: ${role} (${country})`;
      addJob.run(n, `${role} remote`, country, n);
    }
  }
}

// BDR / business development / growth roles (2026-10-17)
{
  const add = db.prepare(`INSERT INTO prospect_searches (name, kind, keywords, location, date_window, max_results)
                          SELECT ?, 'jobs', ?, ?, 'week', 40 WHERE NOT EXISTS (SELECT 1 FROM prospect_searches WHERE name = ?)`);
  const where = { Europe: 'European Union', Switzerland: 'Switzerland', Norway: 'Norway', UK: 'United Kingdom' };
  for (const role of ['Business Development Representative', 'BDR', 'Associate Business Developer', 'Growth Executive', 'Inside Sales Representative', 'Lead Generation Specialist']) {
    for (const [label, loc] of Object.entries(where)) {
      const n = `Jobs: ${role} (${label})`;
      add.run(n, `${role} remote`, loc, n);
    }
  }
}

// Pain-point post searches (2026-10-16): people describing a problem or the person they need
{
  const add = db.prepare(`INSERT INTO prospect_searches (name, kind, keywords, location, date_window)
                          SELECT ?, 'posts', ?, '', 'week' WHERE NOT EXISTS (SELECT 1 FROM prospect_searches WHERE name = ?)`);
  [
    ['Struggling to get clients', '"struggling to get clients" OR "struggling to find clients"'],
    ['Struggling with lead generation', '"struggling with lead generation" OR "struggling to generate leads"'],
    ['Need more leads', '"need more leads" OR "not enough leads"'],
    ['Cold email not working', '"cold email" "not working" OR "cold emails" "no replies"'],
    ['Outbound not working', '"outbound" "not working" OR "outreach" "no responses"'],
    ['Can anyone recommend lead gen', '"can anyone recommend" "lead generation" OR "appointment setting" OR "cold email"'],
    ['Looking to hire appointment setter', '"looking to hire" "appointment setter" OR "lead generation"'],
    ['Looking for someone for outreach', '"looking for someone" outreach OR "lead generation" OR "cold email"'],
    ['Need help with email marketing', '"need help" "email marketing" OR "email campaigns"'],
    ['Looking for lead gen agency', '"looking for" "lead generation agency" OR "outbound agency" OR "cold email agency"'],
  ].forEach(([n, q]) => add.run(n, q, n));
}

// Prospects as a small CRM: follow-up date, when the status last changed, and the lead a note was sent with
{
  const cols = db.prepare('PRAGMA table_info(prospects)').all().map((c) => c.name);
  if (!cols.includes('follow_up')) db.exec("ALTER TABLE prospects ADD COLUMN follow_up TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('lead_id')) db.exec('ALTER TABLE prospects ADD COLUMN lead_id INTEGER');
  if (!cols.includes('feedback')) db.exec("ALTER TABLE prospects ADD COLUMN feedback TEXT NOT NULL DEFAULT ''");
  // posts: the job attached to the post (checked with your login) – shown on the post card
  if (!cols.includes('job_id')) db.exec("ALTER TABLE prospects ADD COLUMN job_id TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('job_title')) db.exec("ALTER TABLE prospects ADD COLUMN job_title TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('job_info')) db.exec("ALTER TABLE prospects ADD COLUMN job_info TEXT NOT NULL DEFAULT ''");
}

// Searches made with the filter builder keep all their filters as JSON (titles, locations, workplace …)
if (!db.prepare('PRAGMA table_info(prospect_searches)').all().some((c) => c.name === 'filters')) {
  db.exec("ALTER TABLE prospect_searches ADD COLUMN filters TEXT NOT NULL DEFAULT ''");
}

// Job applier: every job looked at (applied, skipped, waiting for answers) and the answers to form questions
db.exec(`
CREATE TABLE IF NOT EXISTS job_apps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT '',
  keyword TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued',
  reason TEXT NOT NULL DEFAULT '',
  resume TEXT NOT NULL DEFAULT '',
  questions TEXT NOT NULL DEFAULT '',
  trace TEXT NOT NULL DEFAULT '',
  found_at TEXT DEFAULT (datetime('now','localtime')),
  applied_at TEXT,
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_job_apps_status ON job_apps(status, applied_at);
CREATE TABLE IF NOT EXISTS job_answers (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT '',
  options TEXT NOT NULL DEFAULT '',
  answer TEXT NOT NULL DEFAULT '',
  seen INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
`);

{
  const cols = db.prepare('PRAGMA table_info(job_answers)').all().map((c) => c.name);
  if (!cols.includes('source')) db.exec("ALTER TABLE job_answers ADD COLUMN source TEXT NOT NULL DEFAULT ''"); // 'cv' = written by Claude from your CV
}

// Since 2026-10-15 problems are skipped, never retried
db.exec("UPDATE leads SET status = 'skipped' WHERE status = 'failed'");

function getSettings() {
  const rows = db.prepare("SELECT key, value FROM settings WHERE key NOT LIKE 'state:%'").all();
  const out = { ...DEFAULT_SETTINGS };
  for (const r of rows) out[r.key] = TEXT_SETTINGS.includes(r.key) || isNaN(Number(r.value)) ? r.value : Number(r.value);
  // "extra for today" only counts on the day it was set
  if (out.prospect_extra_date !== today()) Object.assign(out, { prospect_extra_posts: 0, prospect_extra_jobs: 0 });
  return out;
}
const today = () => new Date().toLocaleString('sv-SE').slice(0, 10);

/** Today's limit of new prospects for 'post' / 'job': daily limit + today's extra (0 = no limit) */
function prospectCap(kind, st = getSettings()) {
  const [daily, extra] = kind === 'job' ? [st.prospect_daily_jobs, st.prospect_extra_jobs] : [st.prospect_daily_posts, st.prospect_extra_posts];
  return daily > 0 ? daily + (Number(extra) || 0) : 0;
}

function updateSettings(patch) {
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    stmt.run(k, String(v));
  }
  if ('prospect_extra_posts' in patch || 'prospect_extra_jobs' in patch) stmt.run('prospect_extra_date', today());
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

module.exports = { db, getSettings, updateSettings, prospectCap, getState, setState, DEFAULT_SETTINGS, TEXT_SETTINGS, DATA_DIR };
