const path = require('path');
const express = require('express');
const { db, getSettings, updateSettings, prospectCap, getState, setState, DEFAULT_SETTINGS, TEXT_SETTINGS } = require('./db');
const cv = require('./prospects/cv');
const { POST_RULES, JOB_RULES } = require('./prospects/filter');
const { needSnippet, prospectScore } = require('./prospects/filter');
const { countryOf } = require('./location');
const { logger, bus, emit } = require('./logger');
const { render, variants, fitToLimit } = require('./template');
const runner = require('./automation/runner');
const prospectRunner = require('./automation/prospectRunner');
const jobApplier = require('./automation/jobApplier');
const pending = require('./pending');
const bridge = require('./automation/bridge');
const fs = require('fs');

const PORT = process.env.PORT || 4000;
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const wrap = (fn) => (req, res) => {
  try {
    const out = fn(req, res);
    if (out && typeof out.then === 'function') out.then((v) => v !== undefined && res.json(v)).catch((e) => fail(res, e));
    else if (out !== undefined) res.json(out);
  } catch (e) {
    fail(res, e);
  }
};
function fail(res, e) {
  const msg = String(e.message || e);
  const code = e.status || (/UNIQUE/.test(msg) ? 409 : 400);
  res.status(code).json({ error: /UNIQUE/.test(msg) ? 'Name already exists' : msg });
}
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const now = "datetime('now','localtime')";

// ---------- Message types (each with several connection-note variants) ----------
const VARIANTS_SQL = `
  SELECT v.*,
    (SELECT COUNT(*) FROM leads d WHERE d.variant_id = v.id AND d.status = 'sent') AS sent,
    (SELECT COUNT(*) FROM leads d WHERE d.variant_id = v.id AND d.accepted_at IS NOT NULL) AS accepted
  FROM message_variants v WHERE v.type_id = ? ORDER BY v.position, v.id`;

function typeWithVariants(id) {
  const t = db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM lists l WHERE l.type_id = t.id) AS list_count,
                               (SELECT GROUP_CONCAT(name, ', ') FROM lists l WHERE l.type_id = t.id) AS list_names
                        FROM message_types t WHERE t.id = ?`).get(id);
  if (!t) return null;
  return { ...t, variants: db.prepare(VARIANTS_SQL).all(id), followups: db.prepare(FOLLOWUPS_SQL).all(id) };
}

// Follow-ups 1–3 of a type, with how many went out and how many people replied after that step
const FOLLOWUPS_SQL = `
  SELECT f.*,
    (SELECT COUNT(*) FROM followups_sent s JOIN leads d ON d.id = s.lead_id
       LEFT JOIN message_variants v ON v.id = d.variant_id LEFT JOIN lists l ON l.id = d.list_id
       WHERE s.step = f.step AND COALESCE(v.type_id, l.type_id) = f.type_id) AS sent,
    (SELECT COUNT(*) FROM leads d LEFT JOIN message_variants v ON v.id = d.variant_id LEFT JOIN lists l ON l.id = d.list_id
       WHERE d.replied_at IS NOT NULL AND d.followup_step = f.step AND COALESCE(v.type_id, l.type_id) = f.type_id) AS replied
  FROM message_followups f WHERE f.type_id = ? ORDER BY f.step`;

/** Saves follow-ups 1–3 ([{ body, delay_days, active }] in step order) */
function saveFollowups(typeId, list) {
  if (!Array.isArray(list)) return;
  // empty boxes are dropped, so the filled ones always run 1, 2, 3 without a gap
  const fs = list.filter((f) => String(f.body || '').trim()).slice(0, 3)
    .map((f, i) => ({ step: i + 1, body: String(f.body).trim(), delay_days: Math.min(60, Math.max(0, Number(f.delay_days) || 0)), active: f.active === false || f.active === 0 ? 0 : 1 }));
  db.prepare('DELETE FROM message_followups WHERE type_id = ?').run(typeId);
  const add = db.prepare('INSERT INTO message_followups (type_id, step, body, delay_days, active) VALUES (?, ?, ?, ?, ?)');
  for (const f of fs) add.run(typeId, f.step, f.body, f.delay_days, f.active);
}

function cleanVariants(list) {
  const vs = (Array.isArray(list) ? list : [])
    .map((v, i) => ({ id: v.id ? Number(v.id) : null, label: String(v.label || '').trim(), body: String(v.body || '').trim(), active: v.active === false || v.active === 0 ? 0 : 1, position: i }))
    .filter((v) => v.body);
  if (!vs.length) throw bad('Add at least one connection note');
  if (!vs.some((v) => v.active)) throw bad('At least one note must be ON');
  return vs;
}

function saveVariants(typeId, vs) {
  const keep = vs.filter((v) => v.id).map((v) => v.id);
  const existing = db.prepare('SELECT id FROM message_variants WHERE type_id = ?').all(typeId).map((r) => r.id);
  for (const id of existing) if (!keep.includes(id)) db.prepare('DELETE FROM message_variants WHERE id = ?').run(id);
  for (const v of vs) {
    if (v.id && existing.includes(v.id)) {
      db.prepare(`UPDATE message_variants SET label = ?, body = ?, active = ?, position = ?, updated_at = ${now} WHERE id = ?`)
        .run(v.label, v.body, v.active, v.position, v.id);
    } else {
      db.prepare('INSERT INTO message_variants (type_id, label, body, active, position) VALUES (?, ?, ?, ?, ?)')
        .run(typeId, v.label, v.body, v.active, v.position);
    }
  }
  // keep the legacy column filled (first active note) for exports / older code
  db.prepare('UPDATE message_types SET template = ? WHERE id = ?').run(vs.find((v) => v.active).body, typeId);
}

app.get('/api/types', wrap(() =>
  db.prepare('SELECT id FROM message_types ORDER BY name').all().map((r) => typeWithVariants(r.id))
));
app.get('/api/types/:id', wrap((req) => typeWithVariants(req.params.id) || Promise.reject(bad('Not found', 404))));
app.post('/api/types', wrap((req) => {
  const { name, description = '' } = req.body;
  if (!name?.trim()) throw bad('Type name is required');
  const vs = cleanVariants(req.body.variants);
  const r = db.prepare('INSERT INTO message_types (name, template, description) VALUES (?, ?, ?)').run(name.trim(), vs[0].body, description);
  saveVariants(Number(r.lastInsertRowid), vs);
  saveFollowups(Number(r.lastInsertRowid), req.body.followups);
  logger.info(`Message type "${name}" created with ${vs.length} note(s)`);
  return typeWithVariants(r.lastInsertRowid);
}));
app.put('/api/types/:id', wrap((req) => {
  const { name, description = '' } = req.body;
  if (!name?.trim()) throw bad('Type name is required');
  const vs = cleanVariants(req.body.variants);
  const r = db.prepare(`UPDATE message_types SET name = ?, description = ?, updated_at = ${now} WHERE id = ?`).run(name.trim(), description, req.params.id);
  if (!r.changes) throw bad('Not found', 404);
  saveVariants(Number(req.params.id), vs);
  saveFollowups(Number(req.params.id), req.body.followups);
  logger.info(`Message type "${name}" saved – ${vs.filter((v) => v.active).length} of ${vs.length} notes ON`);
  return typeWithVariants(req.params.id);
}));
// Turn a single note ON/OFF without opening the editor
app.patch('/api/variants/:id', wrap((req) => {
  const v = db.prepare('SELECT * FROM message_variants WHERE id = ?').get(req.params.id);
  if (!v) throw bad('Not found', 404);
  if (!req.body.active) {
    const others = db.prepare('SELECT COUNT(*) c FROM message_variants WHERE type_id = ? AND active = 1 AND id != ?').get(v.type_id, v.id).c;
    if (!others) throw bad('At least one note must stay ON');
  }
  db.prepare(`UPDATE message_variants SET active = ?, updated_at = ${now} WHERE id = ?`).run(req.body.active ? 1 : 0, v.id);
  return typeWithVariants(v.type_id);
}));
app.delete('/api/types/:id', wrap((req) => {
  db.prepare('DELETE FROM message_types WHERE id = ?').run(req.params.id);
  return { ok: true };
}));

// ---------- Lists ----------
const LIST_SQL = `
  SELECT l.*, t.name AS type_name,
    COUNT(d.id) AS total,
    SUM(d.status = 'pending') AS pending,
    SUM(d.status = 'review') AS review,
    SUM(d.status = 'sent') AS sent,
    SUM(d.status IN ('skipped','already_connected','pending_invite')) AS skipped,
    SUM(d.status = 'failed') AS failed,
    SUM(d.accepted_at IS NOT NULL) AS accepted
  FROM lists l
  LEFT JOIN message_types t ON t.id = l.type_id
  LEFT JOIN leads d ON d.list_id = l.id`;

function validateList(b) {
  if (!b.name?.trim()) throw bad('List name is required');
  if (!/^https:\/\/(www\.)?linkedin\.com\/sales\//.test(b.url || '')) throw bad('URL must be a Sales Navigator link (https://www.linkedin.com/sales/...)');
  // a saved-search id alone points to something Sales Navigator deletes when the subscription ends
  if (/[?&]savedSearchId=/.test(b.url) && !/filters/i.test(b.url)) {
    throw bad('This link only points to a saved search, which Sales Navigator deletes when the subscription ends. Open the search, change any filter once so the filters show in the address bar, and copy that link instead.');
  }
}
// review_first, sync_target (leads to keep ready, 25–2500), skip_keywords
const listRules = (b) => [b.review_first === false || b.review_first === 0 ? 0 : 1, Math.min(2500, Math.max(25, Number(b.sync_target) || 100)), String(b.skip_keywords || '').trim()];
const withShare = (l) => l && { ...l, daily_share: l.active ? runner.dailyShares()[l.id] ?? 0 : 0, sent_today: runner.listSentToday(l.id) };
app.get('/api/lists', wrap(() => db.prepare(`${LIST_SQL} GROUP BY l.id ORDER BY l.id DESC`).all().map(withShare)));
app.post('/api/lists', wrap((req) => {
  const b = req.body;
  validateList(b);
  const r = db.prepare(`INSERT INTO lists (name, url, type_id, active, notes, send_limit, target_countries, review_first, sync_target, skip_keywords, activated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${now})`)
    .run(b.name.trim(), b.url.trim(), b.type_id || null, b.active === false ? 0 : 1, b.notes || '', Math.max(0, Number(b.send_limit) || 0), String(b.target_countries || '').trim(), ...listRules(b));
  logger.info(`List "${b.name}" added`);
  return db.prepare(`${LIST_SQL} WHERE l.id = ? GROUP BY l.id`).get(r.lastInsertRowid);
}));
app.put('/api/lists/:id', wrap((req) => {
  const b = req.body;
  validateList(b);
  const old = db.prepare('SELECT active FROM lists WHERE id = ?').get(req.params.id);
  if (!old) throw bad('Not found', 404);
  const active = b.active === false || b.active === 0 ? 0 : 1;
  db.prepare(`UPDATE lists SET name = ?, url = ?, type_id = ?, active = ?, notes = ?, send_limit = ?, target_countries = ?, review_first = ?, sync_target = ?, skip_keywords = ?, updated_at = ${now} WHERE id = ?`)
    .run(b.name.trim(), b.url.trim(), b.type_id || null, active, b.notes || '', Math.max(0, Number(b.send_limit) || 0), String(b.target_countries || '').trim(), ...listRules(b), req.params.id);
  return db.prepare(`${LIST_SQL} WHERE l.id = ? GROUP BY l.id`).get(req.params.id);
}));
app.post('/api/location-check', wrap((req) => {
  const { checkLocation } = require('./location');
  const s = getSettings();
  const rows = req.body.list_id
    ? db.prepare("SELECT name, location FROM leads WHERE list_id = ? AND status IN ('pending', 'review')").all(req.body.list_id)
    : [];
  const out = rows.map((r) => ({ ...r, ...checkLocation(r.location, req.body.target_countries, s.skip_unclear_location) }));
  return { waiting: rows.length, skip: out.filter((r) => !r.ok).length, unclear: out.filter((r) => r.unclear).length, examples: out.filter((r) => !r.ok).slice(0, 8) };
}));
app.patch('/api/lists/:id/active', wrap((req) => {
  if (db.prepare('SELECT url FROM lists WHERE id = ?').get(req.params.id)?.url === 'direct') throw bad('This list only holds people you contacted from the Prospects page');
  // Active / Paused is only ever changed by you – the bot never pauses a list itself
  db.prepare('UPDATE lists SET active = ? WHERE id = ?').run(req.body.active ? 1 : 0, req.params.id);
  return db.prepare(`${LIST_SQL} WHERE l.id = ? GROUP BY l.id`).get(req.params.id);
}));
app.delete('/api/lists/:id', wrap((req) => {
  db.prepare('DELETE FROM lists WHERE id = ?').run(req.params.id);
  return { ok: true };
}));

// ---------- Leads ----------
// Lead tabs: each one is a group of statuses
const LEAD_GROUPS = {
  review: "d.status = 'review'",
  pending: "d.status = 'pending'",
  awaiting: "d.status = 'sent' AND d.accepted_at IS NULL",
  accepted: 'd.accepted_at IS NOT NULL',
  sent: "d.status = 'sent'",
  skipped: "d.status IN ('skipped', 'failed', 'already_connected', 'pending_invite')",
  excluded: "d.status = 'excluded'",
};
// Fixed order: what still needs doing first (your review, then approved), then sent, accepted, skipped, excluded
const GROUP_ORDER = `CASE WHEN d.status = 'review' THEN -1 WHEN d.status = 'pending' THEN 0 WHEN d.status = 'sent' AND d.accepted_at IS NULL THEN 1
  WHEN d.accepted_at IS NOT NULL THEN 2 WHEN d.status = 'excluded' THEN 4 ELSE 3 END`;
const LEAD_SORT = {
  status: `${GROUP_ORDER}, d.name COLLATE NOCASE`,
  name: 'd.name COLLATE NOCASE',
  company: "NULLIF(d.company, '') IS NULL, d.company COLLATE NOCASE, d.name COLLATE NOCASE",
  sent: 'd.sent_at IS NULL, d.sent_at DESC, d.name COLLATE NOCASE',
  recent: 'd.updated_at DESC, d.id DESC',
};
app.get('/api/leads', wrap((req) => {
  const { list_id, status, q, sort = 'status', limit = 50, offset = 0 } = req.query;
  const base = ["d.status <> 'crm'"]; // people you added to the CRM yourself are not campaign leads
  const args = [];
  if (list_id) { base.push('d.list_id = ?'); args.push(list_id); }
  if (q) { base.push('(d.name LIKE ? OR d.company LIKE ? OR d.title LIKE ? OR d.location LIKE ?)'); args.push(...Array(4).fill(`%${q}%`)); }
  const where = [...base];
  const wargs = [...args];
  if (LEAD_GROUPS[status]) where.push(LEAD_GROUPS[status]);
  else if (status) { where.push('d.status = ?'); wargs.push(status); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) c FROM leads d ${w}`).get(...wargs).c;
  const rows = db.prepare(`SELECT d.*, l.name AS list_name FROM leads d LEFT JOIN lists l ON l.id = d.list_id ${w}
                           ORDER BY ${LEAD_SORT[sort] || LEAD_SORT.status} LIMIT ? OFFSET ?`).all(...wargs, Number(limit), Number(offset));
  // counts for the tabs (same list / search, every group)
  const bw = base.length ? `WHERE ${base.join(' AND ')}` : '';
  const counts = { all: db.prepare(`SELECT COUNT(*) c FROM leads d ${bw}`).get(...args).c };
  for (const [k, cond] of Object.entries(LEAD_GROUPS)) counts[k] = db.prepare(`SELECT COUNT(*) c FROM leads d ${bw ? `${bw} AND` : 'WHERE'} ${cond}`).get(...args).c;
  return { total, rows, counts };
}));
app.post('/api/leads/:id/reset', wrap((req) => {
  db.prepare(`UPDATE leads SET status = 'pending', error = '', attempts = 0, updated_at = ${now} WHERE id = ?`).run(req.params.id);
  return { ok: true };
}));
// Your review: approved leads go into the send queue ('pending'); the rest you mark "Don't contact"
app.post('/api/leads/approve', wrap((req) => {
  const ids = (req.body.ids || []).map(Number).filter(Boolean);
  let r;
  if (ids.length) r = db.prepare(`UPDATE leads SET status = 'pending', updated_at = ${now} WHERE status = 'review' AND id IN (${ids.map(() => '?').join(',')})`).run(...ids);
  else if (req.body.all) {
    r = req.body.list_id
      ? db.prepare(`UPDATE leads SET status = 'pending', updated_at = ${now} WHERE status = 'review' AND list_id = ?`).run(req.body.list_id)
      : db.prepare(`UPDATE leads SET status = 'pending', updated_at = ${now} WHERE status = 'review'`).run();
  } else throw bad('Nothing to approve');
  return { approved: r.changes };
}));
app.post('/api/leads/exclude', wrap((req) => {
  const ids = (req.body.ids || []).map(Number).filter(Boolean);
  if (!ids.length) throw bad('Nothing selected');
  const r = db.prepare(`UPDATE leads SET status = 'excluded', error = '', updated_at = ${now} WHERE status <> 'sent' AND id IN (${ids.map(() => '?').join(',')})`).run(...ids);
  return { excluded: r.changes };
}));
// "Never contact this person": the lead stays in the database as excluded, so a later sync (in any
// list – a person is stored once) can't bring them back into the queue
app.post('/api/leads/:id/exclude', wrap((req) => {
  const lead = db.prepare('SELECT status FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) throw bad('Lead not found', 404);
  if (lead.status === 'sent') throw bad('A connection note was already sent to this person');
  db.prepare(`UPDATE leads SET status = 'excluded', error = '', updated_at = ${now} WHERE id = ?`).run(req.params.id);
  return { ok: true };
}));
app.post('/api/leads/reset-failed', wrap((req) => {
  const r = req.body.list_id
    ? db.prepare(`UPDATE leads SET status='pending', error='', attempts=0 WHERE status='skipped' AND error NOT IN ('', 'email_required', 'no_first_name') AND list_id = ?`).run(req.body.list_id)
    : db.prepare(`UPDATE leads SET status='pending', error='', attempts=0 WHERE status='skipped' AND error NOT IN ('', 'email_required', 'no_first_name')`).run();
  return { reset: r.changes };
}));
app.patch('/api/leads/:id', wrap((req) => {
  const allowed = ['status', 'first_name', 'profile_url'];
  const keys = Object.keys(req.body).filter((k) => allowed.includes(k));
  if (!keys.length) throw bad('Nothing to update');
  db.prepare(`UPDATE leads SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ${now} WHERE id = ?`)
    .run(...keys.map((k) => req.body[k]), req.params.id);
  return db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
}));
app.delete('/api/leads/:id', wrap((req) => {
  db.prepare('DELETE FROM leads WHERE id = ?').run(req.params.id);
  return { ok: true };
}));
app.get('/api/leads/export.csv', (req, res) => {
  const rows = db.prepare(`SELECT d.name, d.first_name, d.title, d.company, d.location, d.degree, d.status, d.sent_at, d.accepted_at, d.profile_url, d.message, l.name AS list
                           FROM leads d LEFT JOIN lists l ON l.id = d.list_id ORDER BY d.id`).all();
  const cols = ['list', 'name', 'first_name', 'title', 'company', 'location', 'degree', 'status', 'sent_at', 'accepted_at', 'profile_url', 'message'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="leads.csv"');
  res.send([cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n'));
});

// ---------- Prospect finder ----------
const SEARCH_SQL = `
  SELECT s.*,
    (SELECT COUNT(*) FROM prospects p WHERE p.search_id = s.id AND p.status != 'rejected') AS kept,
    (SELECT COUNT(*) FROM prospects p WHERE p.search_id = s.id AND p.status = 'rejected') AS rejected,
    (SELECT COUNT(*) FROM prospects p WHERE p.search_id = s.id AND p.status IN ('contacted', 'replied', 'meeting', 'client')) AS useful
  FROM prospect_searches s`;
const listOf = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,\n]/)).map((x) => String(x).trim()).filter(Boolean).slice(0, 40);
const pick = (v, allowed) => listOf(v).filter((x) => allowed.includes(x));
// on/off rules: only known keys, booleans, missing = default (on)
const rulesOf = (r = {}, defaults) => Object.fromEntries(Object.keys(defaults).map((k) => [k, r[k] === undefined ? defaults[k] : !!r[k]]));
// Filters from the search builder (jobs: titles × locations …, posts: keywords …)
function cleanFilters(kind, f = {}) {
  if (kind === 'jobs') {
    const out = {
      titles: listOf(f.titles),
      locations: listOf(f.locations),
      workplace: pick(f.workplace, ['remote', 'hybrid', 'onsite']),
      levels: pick(f.levels, ['internship', 'entry', 'associate', 'mid', 'director', 'executive']),
      jobTypes: pick(f.jobTypes, ['full', 'part', 'contract', 'temporary', 'internship', 'volunteer']),
      easyApply: !!f.easyApply,
      // where you can apply from: world = must say anywhere / worldwide, europe = Europe-wide is fine too, any = no rule
      applyFrom: ['world', 'europe', 'any'].includes(f.applyFrom) ? f.applyFrom : (f.worldwide ? 'world' : 'any'),
      worldwide: f.applyFrom ? f.applyFrom !== 'any' : !!f.worldwide,
      englishOnly: f.englishOnly !== false,
      maxYears: f.maxYears === '' || f.maxYears == null ? null : Math.max(0, Math.min(30, Number(f.maxYears) || 0)),
      excludeWords: listOf(f.excludeWords),
      excludeCompanies: listOf(f.excludeCompanies),
      maxResults: Math.min(100, Math.max(5, Number(f.maxResults) || 40)),
      sort: f.sort === 'relevance' ? 'relevance' : 'recent',
      fewApplicants: !!f.fewApplicants,
      rules: rulesOf(f.rules, JOB_RULES),
    };
    if (!out.titles.length) throw bad('Add at least one job title');
    return out;
  }
  const out = {
    keywords: listOf(f.keywords),
    exact: f.exact !== false,
    excludeWords: listOf(f.excludeWords),
    authorTitles: listOf(f.authorTitles),
    postType: ['any', 'buyer', 'hiring'].includes(f.postType) ? f.postType : 'any',
    remoteHiring: f.remoteHiring !== false,
    countries: listOf(f.countries),
    sort: f.sort === 'relevance' ? 'relevance' : 'latest',
    maxResults: Math.min(200, Math.max(5, Number(f.maxResults) || 80)),
    topics: listOf(f.topics),
    excludeHeadline: listOf(f.excludeHeadline),
    rules: rulesOf(f.rules, POST_RULES),
  };
  if (!out.keywords.length) throw bad('Add at least one keyword or phrase');
  return out;
}

function cleanSearch(b) {
  if (!b.name?.trim()) throw bad('Search name is required');
  const kind = b.kind === 'jobs' ? 'jobs' : 'posts';
  const date_window = ['day', 'week'].includes(b.date_window) ? b.date_window : 'week';
  const active = b.active === false || b.active === 0 ? 0 : 1;
  if (b.filters) {
    const f = cleanFilters(kind, b.filters);
    return {
      name: b.name.trim(), kind, date_window, active, filters: JSON.stringify(f), max_results: f.maxResults,
      // short summary for older screens / exports
      keywords: (kind === 'jobs' ? f.titles : f.keywords).join(' | '),
      location: kind === 'jobs' ? f.locations.join(', ') : '',
    };
  }
  if (!b.keywords?.trim()) throw bad('Keywords are required');
  return {
    name: b.name.trim(),
    kind,
    keywords: b.keywords.trim(),
    location: kind === 'jobs' ? String(b.location || '').trim() : '',
    date_window,
    max_results: Math.min(100, Math.max(5, Number(b.max_results) || 40)),
    active,
    filters: '',
  };
}
// ---------- CV -> searches ----------
// The browser reads the file (PDF / Word / text) and sends its text; we find the skills in it.
// Several CVs can be kept; each one makes its own searches, named "CV <id> · <file>: …".
const cvTag = (c) => `CV ${c.id} · ${String(c.name).replace(/\.[a-z0-9]+$/i, '').slice(0, 40)}: `;
function getCvs() {
  let list = getState('cvs');
  if (!list) { // one CV from before: becomes CV 1, its searches keep working
    const old = getState('cv');
    list = old ? [{ id: 1, ...old }] : [];
    if (old) db.prepare("UPDATE prospect_searches SET name = ? || substr(name, 5) WHERE name LIKE 'CV: %'").run(cvTag(list[0]));
    setState('cvs', list);
    setState('cv', null);
  }
  return list;
}
const cvSearchIds = (c) => db.prepare('SELECT id FROM prospect_searches WHERE substr(name, 1, ?) = ?').all(cvTag(c).length, cvTag(c)).map((r) => r.id);
// the filters accept the job titles of every CV
function saveCvKeywords(list) {
  const titles = [...new Set(list.flatMap((c) => cv.searchesFor(c.chosen || [], c.regions || []).titles))];
  updateSettings({ prospect_cv_keywords: titles.join(', ') });
}
app.get('/api/cv', wrap(() => ({ cvs: getCvs().map((c) => ({ ...c, searches: cvSearchIds(c).length })), regions: cv.REGIONS })));
app.post('/api/cv/analyze', wrap((req) => {
  const text = String(req.body.text || '').slice(0, 60000);
  if (text.trim().length < 50) throw bad('Could not read any text from this CV – try a PDF, Word (.docx) or .txt file');
  const skills = cv.analyzeCv(text);
  const list = getCvs();
  const id = Math.max(0, ...list.map((c) => c.id)) + 1;
  list.push({ id, name: String(req.body.name || 'CV').slice(0, 120), at: new Date().toISOString(), skills, chosen: [], regions: [] });
  setState('cvs', list);
  return { id, skills, regions: cv.REGIONS };
}));
// Replace this CV's searches with searches for the chosen skills (other CVs' searches stay)
app.post('/api/cv/apply', wrap((req) => {
  const list = getCvs();
  const c = list.find((x) => x.id === Number(req.body.id));
  if (!c) throw bad('CV not found', 404);
  const chosen = (req.body.skills || []).map(String);
  const regions = (req.body.regions || []).map(String).filter((r) => r in cv.REGIONS);
  if (!chosen.length) throw bad('Pick at least one skill');
  const { searches } = cv.searchesFor(chosen, regions);
  const add = db.prepare("INSERT INTO prospect_searches (name, kind, keywords, location, date_window, max_results, active) VALUES (@name, @kind, @keywords, @location, 'week', 40, 1)");
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM prospect_searches WHERE substr(name, 1, ?) = ?').run(cvTag(c).length, cvTag(c));
    searches.forEach((x) => add.run({ ...x, name: cvTag(c) + x.name.replace(/^CV: /, '') }));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  Object.assign(c, { chosen, regions });
  setState('cvs', list);
  saveCvKeywords(list);
  logger.info(`CV "${c.name}": ${searches.length} prospect searches created (${chosen.length} skills)`);
  return { created: searches.length, searchIds: cvSearchIds(c) };
}));
// Remove a CV and the searches made from it (prospects already found stay)
app.delete('/api/cv/:id', wrap((req) => {
  const list = getCvs();
  const c = list.find((x) => x.id === Number(req.params.id));
  if (!c) throw bad('CV not found', 404);
  const n = db.prepare('DELETE FROM prospect_searches WHERE substr(name, 1, ?) = ?').run(cvTag(c).length, cvTag(c)).changes;
  const rest = list.filter((x) => x !== c);
  setState('cvs', rest);
  saveCvKeywords(rest);
  logger.info(`CV "${c.name}" deleted with its ${n} searches`);
  return { ok: true, deleted: n };
}));

app.get('/api/prospect-searches', wrap(() => db.prepare(`${SEARCH_SQL} ORDER BY s.kind DESC, s.id`).all()));
app.post('/api/prospect-searches', wrap((req) => {
  const v = cleanSearch(req.body);
  const r = db.prepare('INSERT INTO prospect_searches (name, kind, keywords, location, date_window, max_results, active, filters) VALUES (@name, @kind, @keywords, @location, @date_window, @max_results, @active, @filters)').run(v);
  logger.info(`Prospect search "${v.name}" added`);
  return db.prepare(`${SEARCH_SQL} WHERE s.id = ?`).get(r.lastInsertRowid);
}));
app.put('/api/prospect-searches/:id', wrap((req) => {
  const v = cleanSearch(req.body);
  const r = db.prepare('UPDATE prospect_searches SET name = @name, kind = @kind, keywords = @keywords, location = @location, date_window = @date_window, max_results = @max_results, active = @active, filters = @filters WHERE id = @id').run({ ...v, id: Number(req.params.id) });
  if (!r.changes) throw bad('Not found', 404);
  return db.prepare(`${SEARCH_SQL} WHERE s.id = ?`).get(req.params.id);
}));
app.patch('/api/prospect-searches/:id/active', wrap((req) => {
  db.prepare('UPDATE prospect_searches SET active = ? WHERE id = ?').run(req.body.active ? 1 : 0, req.params.id);
  return db.prepare(`${SEARCH_SQL} WHERE s.id = ?`).get(req.params.id);
}));
app.delete('/api/prospect-searches/:id', wrap((req) => {
  db.prepare('DELETE FROM prospect_searches WHERE id = ?').run(req.params.id);
  return { ok: true };
}));

function prospectWhere(qs) {
  const where = [];
  const args = [];
  if (qs.status === 'all') where.push("p.status != 'rejected'");
  else if (qs.status) { where.push('p.status = ?'); args.push(qs.status); }
  else where.push("p.status = 'new'");
  if (qs.kind) { where.push('p.kind = ?'); args.push(qs.kind); }
  if (qs.search_id) { where.push('p.search_id = ?'); args.push(qs.search_id); }
  if (qs.q) {
    where.push('(p.person_name LIKE ? OR p.company_name LIKE ? OR p.text LIKE ? OR p.title LIKE ? OR p.reject_reason LIKE ?)');
    args.push(...Array(5).fill(`%${qs.q}%`));
  }
  return { w: `WHERE ${where.join(' AND ')}`, args };
}
const titleCase = (c) => (c ? c.replace(/\b\w/g, (x) => x.toUpperCase()) : '');
// Extra fields for the dashboard: country, and for posts the sentence where they state the need
const today = () => new Date().toLocaleDateString('sv-SE');
const enrich = (p) => ({
  ...p, country: titleCase(countryOf(p.location)), highlight: p.kind === 'post' ? needSnippet(p.text) : '',
  score: p.status === 'rejected' ? 0 : prospectScore(p),
  followUpDue: !!p.follow_up && p.follow_up <= today() && !['client', 'not_relevant', 'rejected'].includes(p.status),
});
// status tabs of the small CRM; "followup" = a follow-up date that has come
const OPEN_STATUSES = ['new', 'contacted', 'replied', 'meeting'];

app.get('/api/prospects', wrap((req) => {
  const { limit = 50, offset = 0, country, sort = 'score' } = req.query;
  const followup = req.query.status === 'followup';
  const { w, args } = prospectWhere(followup ? { ...req.query, status: 'all' } : req.query);
  const SQL = `SELECT p.*, s.name AS search_name FROM prospects p LEFT JOIN prospect_searches s ON s.id = p.search_id ${w} ORDER BY p.found_at DESC, p.id DESC`;
  // score / country / follow-ups are worked out here, so filter + sort in JS (a few thousand rows at most)
  let all = db.prepare(SQL).all(...args).map(enrich);
  if (followup) all = all.filter((p) => p.followUpDue);
  if (country) all = all.filter((p) => p.country.toLowerCase() === String(country).toLowerCase());
  if (sort === 'score') all.sort((a, b) => b.score - a.score || (a.found_at < b.found_at ? 1 : -1));
  const total = all.length;
  const rows = all.slice(Number(offset), Number(offset) + Number(limit));
  const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) c FROM prospects GROUP BY status').all().map((r) => [r.status, r.c]));
  counts.followup = db.prepare(`SELECT COUNT(*) c FROM prospects WHERE follow_up != '' AND follow_up <= ? AND status IN (${OPEN_STATUSES.map(() => '?').join(',')})`).get(today(), ...OPEN_STATUSES).c;
  const k = prospectWhere({ ...(followup ? { ...req.query, status: 'all' } : req.query), kind: '' });
  const kinds = Object.fromEntries(db.prepare(`SELECT p.kind, COUNT(*) c FROM prospects p ${k.w} GROUP BY p.kind`).all(...k.args).map((r) => [r.kind, r.c]));
  return { total, rows, counts, kinds };
}));

// Numbers for the cards on top of the Prospects page
app.get('/api/prospects/summary', wrap(() => {
  const st = getSettings();
  const today = db.prepare("SELECT kind, location FROM prospects WHERE status != 'rejected' AND date(found_at) = date('now','localtime')").all();
  const open = db.prepare("SELECT kind, location FROM prospects WHERE status = 'new'").all();
  const countries = {};
  for (const p of open) {
    const c = titleCase(countryOf(p.location)) || 'Unknown';
    countries[c] = (countries[c] || 0) + 1;
  }
  return {
    postsToday: today.filter((p) => p.kind === 'post').length,
    jobsToday: today.filter((p) => p.kind === 'job').length,
    capPosts: prospectCap('post', st),
    capJobs: prospectCap('job', st),
    contactedWeek: db.prepare("SELECT COUNT(*) c FROM prospects WHERE status = 'contacted' AND updated_at >= datetime('now','localtime','-7 days')").get().c,
    rejected: db.prepare("SELECT COUNT(*) c FROM prospects WHERE status = 'rejected'").get().c,
    lastRun: db.prepare('SELECT MAX(last_run_at) t FROM prospect_searches').get().t,
    target: st.prospect_target,
    countries,
  };
}));

app.patch('/api/prospects/:id', wrap((req) => {
  const allowed = { status: ['new', 'contacted', 'replied', 'meeting', 'client', 'not_relevant'], notes: null, follow_up: null, feedback: null };
  const keys = Object.keys(req.body).filter((k) => k in allowed);
  if (!keys.length) throw bad('Nothing to update');
  if (keys.includes('status') && !allowed.status.includes(req.body.status)) throw bad('Unknown status');
  db.prepare(`UPDATE prospects SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ${now} WHERE id = ?`)
    .run(...keys.map((k) => String(req.body[k])), req.params.id);
  return db.prepare('SELECT * FROM prospects WHERE id = ?').get(req.params.id);
}));
// "Bad result": skip this prospect and teach its search – the words go into the search's skip lists
app.post('/api/prospects/:id/feedback', wrap((req) => {
  const p = db.prepare('SELECT * FROM prospects WHERE id = ?').get(req.params.id);
  if (!p) throw bad('Not found', 404);
  const reason = String(req.body.reason || '').slice(0, 80);
  const headWords = listOf(req.body.headline_words);
  const textWords = listOf(req.body.text_words);
  let learned = '';
  const s = p.search_id && db.prepare('SELECT * FROM prospect_searches WHERE id = ?').get(p.search_id);
  if (s && s.filters && (headWords.length || textWords.length)) {
    const f = JSON.parse(s.filters);
    const add = (key, ws) => { f[key] = [...new Set([...(f[key] || []), ...ws])]; };
    if (p.kind === 'job') add('excludeWords', [...headWords, ...textWords]); // jobs: skip title words
    else { add('excludeHeadline', headWords); add('excludeWords', textWords); }
    db.prepare('UPDATE prospect_searches SET filters = ? WHERE id = ?').run(JSON.stringify(f), s.id);
    learned = `"${s.name}" now skips: ${[...headWords, ...textWords].join(', ')}`;
  }
  db.prepare(`UPDATE prospects SET status = 'not_relevant', feedback = ?, updated_at = ${now} WHERE id = ?`).run(reason, p.id);
  if (learned) logger.info(`Bad result (${p.person_name || p.company_name}): ${learned}`);
  return { ok: true, learned };
}));
app.delete('/api/prospects/:id', wrap((req) => {
  db.prepare('DELETE FROM prospects WHERE id = ?').run(req.params.id);
  return { ok: true };
}));
app.get('/api/prospects/export.csv', (req, res) => {
  const { w, args } = prospectWhere(req.query);
  const rows = db.prepare(`SELECT p.*, s.name AS search FROM prospects p LEFT JOIN prospect_searches s ON s.id = p.search_id ${w} ORDER BY p.found_at DESC`).all(...args);
  const cols = ['kind', 'person_name', 'person_url', 'company_name', 'company_url', 'headline', 'location', 'title', 'url', 'text', 'reasons', 'posted', 'found_at', 'status', 'reject_reason', 'search'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="prospects.csv"');
  res.send([cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n'));
});

// ---------- Settings ----------
app.get('/api/settings', wrap(() => getSettings()));
app.put('/api/settings', wrap((req) => {
  const p = { ...req.body };
  for (const k of Object.keys(p)) {
    if (!(k in DEFAULT_SETTINGS)) delete p[k];
    else if (TEXT_SETTINGS.includes(k)) p[k] = String(p[k]).trim();
    else if (isNaN(Number(p[k])) || Number(p[k]) < 0) throw bad(`${k} must be a positive number`);
  }
  const merged = { ...getSettings(), ...p };
  if (merged.delay_min > merged.delay_max) throw bad('Minimum delay cannot be greater than maximum delay');
  if (merged.daily_limit > runner.MAX_DAILY) throw bad(`Daily limit can be at most ${runner.MAX_DAILY}`);
  if (merged.batch_break_min > merged.batch_break_max) throw bad('Minimum break cannot be greater than maximum break');
  if (merged.tab_wait_min > merged.tab_wait_max) throw bad('Minimum tab wait cannot be greater than maximum tab wait');
  if (merged.prospect_profile_wait_min > merged.prospect_profile_wait_max) throw bad('Minimum profile check wait cannot be greater than maximum');
  const s = updateSettings(p);
  logger.info(`Settings updated: ${Object.entries(p).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  return s;
}));

// ---------- Template preview ----------
app.post('/api/preview', wrap((req) => {
  const s = getSettings();
  const lead = req.body.lead || { name: 'Martin Fletcher', company: 'Modern Back Office Co.', title: 'Fractional CFO' };
  const vs = req.body.body !== undefined ? [String(req.body.body)] : variants(req.body.template || '');
  return {
    max: s.note_max_chars,
    variants: vs.map((v) => {
      const text = render(v, lead, () => 0);
      return { text, length: text.length, over: text.length > s.note_max_chars, fitted: fitToLimit(text, s.note_max_chars).text };
    }),
  };
}));

// ---------- Stats & logs ----------
app.get('/api/stats', wrap(() => {
  const by = db.prepare('SELECT status, COUNT(*) c FROM leads GROUP BY status').all();
  const daily = db.prepare(`SELECT date(sent_at) AS day, COUNT(*) AS sent FROM leads WHERE status='sent' AND sent_at >= date('now','localtime','-13 days')
                            GROUP BY day ORDER BY day`).all();
  return {
    byStatus: Object.fromEntries(by.map((r) => [r.status, r.c])),
    lists: db.prepare('SELECT COUNT(*) c FROM lists').get().c,
    accepted: db.prepare('SELECT COUNT(*) c FROM leads WHERE accepted_at IS NOT NULL').get().c,
    acceptedDaily: db.prepare(`SELECT date(accepted_at) AS day, COUNT(*) AS n FROM leads WHERE accepted_at >= date('now','localtime','-13 days')
                               GROUP BY day ORDER BY day`).all(),
    types: db.prepare('SELECT COUNT(*) c FROM message_types').get().c,
    daily,
    runner: runner.getStatus(),
  };
}));
app.get('/api/logs', wrap((req) =>
  db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?').all(Number(req.query.limit) || 200)
));
app.delete('/api/logs', wrap(() => {
  db.prepare('DELETE FROM logs').run();
  return { ok: true };
}));

app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const send = (ev) => res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`);
  send({ type: 'status', data: { ...runner.getStatus(), prospect: prospectRunner.getStatus() } });
  bus.on('event', send);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(ping);
    bus.off('event', send);
  });
});

// ---------- Runner & browser ----------
// Account safety: end a cool-down early (you checked LinkedIn yourself)
app.post('/api/safety/clear-cooldown', wrap(() => { require('./automation/safety').clearCooldown(); return runner.getStatus(); }));
// Instant acceptance check (LinkedIn API through the extension, no tab)
// Send connection notes to post authors from the Prospects page (same checks as a campaign)
app.post('/api/prospects/connect', wrap((req) => runner.run({ mode: 'direct', prospectIds: (req.body.ids || []).map(Number), typeId: Number(req.body.type_id) })));
app.post('/api/acceptances/check-now', wrap(async () => ({ found: await runner.quickAcceptanceCheck({ deep: true }), status: runner.getStatus() })));
// ---------- CRM: every accepted lead of every campaign, by stage (crm.js) ----------
const crm = require('./crm');
app.get('/api/crm', wrap((req) => crm.board({ listId: req.query.list_id === 'added' ? 'added' : Number(req.query.list_id) || 0, q: String(req.query.q || '').trim() })));
// your LinkedIn inbox: the bot reads it (nothing is sent), you pick who goes on the board
app.get('/api/crm/inbox', wrap(() => crm.inbox(getState('inbox_scan'))));
app.post('/api/crm/inbox/read', wrap((req) => runner.run({ mode: 'inbox', maxLeads: Math.min(200, Number(req.body?.max) || 60) })));
app.post('/api/crm/add', wrap((req) => {
  const people = Array.isArray(req.body?.people) ? req.body.people : [];
  if (!people.length) throw bad('Pick at least one person');
  const ids = crm.addContacts(people);
  emit('leads', {});
  return { ok: true, ids };
}));
app.delete('/api/crm/:id', wrap((req) => { crm.removeContact(Number(req.params.id)); emit('leads', {}); return { ok: true }; }));
app.post('/api/crm/:id/stage', wrap((req) => {
  try {
    const fields = crm.setStage(Number(req.params.id), String(req.body?.stage || ''));
    const d = db.prepare('SELECT name FROM leads WHERE id = ?').get(req.params.id);
    logger.info(`CRM: ${d.name} → ${req.body.stage === 'auto' ? 'placed by the bot again' : String(req.body.stage).replace('_', ' ')}${fields.followup_state === 'crm' ? ' (bot follow-ups stopped)' : ''}`, { lead_id: Number(req.params.id) });
    return { ok: true };
  } catch (e) { throw bad(e.message); }
}));

// ---------- Dashboard: waiting for you + daily report ----------
app.get('/api/pending', wrap(() => ({ items: pending.items(), report: pending.dailyReport(7) })));
app.post('/api/pending/:id/run', wrap((req) => pending.runItem(req.params.id)));
app.post('/api/pending/:id/dismiss', wrap((req) => pending.dismiss(req.params.id)));
app.post('/api/pending/stop/:which', wrap((req) => pending.stopItem(req.params.which)));

// ---------- Job applier ----------
const { cvText, saveCv } = require('./jobs/aiAnswer');
const parseJson = (t, d) => { try { return JSON.parse(t || ''); } catch { return d; } };
app.get('/api/jobs', wrap((req) => {
  const status = String(req.query.status || 'applied');
  const where = status === 'all' ? '1' : status === 'skipped' ? "status IN ('skipped', 'failed')" : status === 'queued' ? "status IN ('queued', 'tested')" : 'status = ?';
  const args = where === 'status = ?' ? [status] : [];
  const rows = db.prepare(`SELECT id, job_id, title, company, location, region, keyword, url, status, reason, resume, questions, found_at, applied_at, updated_at
    FROM job_apps WHERE ${where} ORDER BY COALESCE(applied_at, updated_at) DESC LIMIT 300`).all(...args)
    .map((r) => ({ ...r, questions: parseJson(r.questions, []) }));
  const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) c FROM job_apps GROUP BY status').all().map((r) => [r.status, r.c]));
  // which jobs asked each question (the ones still waiting first, then any job that asked it)
  const askedBy = {};
  for (const j of db.prepare("SELECT title, company, url, status, questions FROM job_apps WHERE questions != '' ORDER BY status = 'needs_answers' DESC, updated_at DESC").all()) {
    for (const q of parseJson(j.questions, [])) {
      if (!q.key) continue;
      (askedBy[q.key] = askedBy[q.key] || []).length < 3 && askedBy[q.key].push({ title: j.title, company: j.company, url: j.url, waiting: j.status === 'needs_answers' });
    }
  }
  const questions = db.prepare("SELECT key, label, kind, options, answer, seen, source FROM job_answers ORDER BY answer != '', seen DESC, updated_at DESC").all()
    .map((q) => ({ ...q, options: parseJson(q.options, []), jobs: askedBy[q.key] || [] }));
  const st = getSettings();
  const { list, active } = jobSearches();
  return { rows, counts, questions, status: jobApplier.getStatus(), search: { keywords: active.keywords, regions: active.regions, activeId: active.id, searches: list.map(({ id, name }) => ({ id, name })) } };
}));
// saved job searches (Jobs page): the bot runs the selected one. The search you had before they existed becomes the first.
function jobSearches() {
  const st = getSettings();
  let list = parseJson(st.jobs_searches, []);
  if (!list.length) {
    list = [{ id: 1, name: 'My search', keywords: st.jobs_keywords, regions: st.jobs_regions }];
    updateSettings({ jobs_searches: JSON.stringify(list), jobs_search_active: 1 });
  }
  return { list, active: list.find((x) => x.id === Number(st.jobs_search_active)) || list[0] };
}
/** Makes a search the one the bot runs, right away (also a run in progress). Jobs skipped only because of the
 *  old title / region rules are looked at again. */
function useJobSearch(list, s) {
  updateSettings({ jobs_searches: JSON.stringify(list), jobs_search_active: s.id, jobs_keywords: s.keywords, jobs_regions: s.regions });
  jobApplier.updateSearch(getSettings());
  db.prepare("DELETE FROM job_apps WHERE status = 'skipped' AND (reason = 'title does not fit your skills' OR reason LIKE 'based in % – not one of your regions')").run();
}
const jobSearchName = (name, list, id) => {
  const n = String(name || '').trim().slice(0, 60);
  if (!n) throw bad('Give the search a name');
  if (list.some((x) => x.id !== id && x.name.toLowerCase() === n.toLowerCase())) throw bad(`You already have a search called "${n}"`);
  return n;
};
const findJobSearch = (list, id) => {
  const s = list.find((x) => x.id === Number(id));
  if (!s) throw bad('Search not found', 404);
  return s;
};
// keywords + regions of the selected search
app.put('/api/jobs/search', wrap((req) => {
  const keywords = String(req.body.keywords || '').split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
  const regions = String(req.body.regions || '').split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
  if (!keywords.length) throw bad('Add at least one keyword');
  if (!regions.length) throw bad('Add at least one region');
  const { list, active } = jobSearches();
  Object.assign(active, { keywords: keywords.join(', '), regions: regions.join(', ') });
  useJobSearch(list, active);
  return { keywords, regions };
}));
// a new search starts as a copy of the selected one and becomes the selected one
app.post('/api/jobs/searches', wrap((req) => {
  const { list, active } = jobSearches();
  const s = { id: Math.max(...list.map((x) => x.id)) + 1, name: jobSearchName(req.body.name, list), keywords: active.keywords, regions: active.regions };
  list.push(s);
  useJobSearch(list, s);
  return s;
}));
app.post('/api/jobs/searches/:id/select', wrap((req) => {
  const { list } = jobSearches();
  const s = findJobSearch(list, req.params.id);
  useJobSearch(list, s);
  return s;
}));
app.put('/api/jobs/searches/:id', wrap((req) => {
  const { list } = jobSearches();
  const s = findJobSearch(list, req.params.id);
  s.name = jobSearchName(req.body.name, list, s.id);
  updateSettings({ jobs_searches: JSON.stringify(list) });
  return s;
}));
app.delete('/api/jobs/searches/:id', wrap((req) => {
  const { list, active } = jobSearches();
  const s = findJobSearch(list, req.params.id);
  if (list.length === 1) throw bad('Keep at least one search');
  const rest = list.filter((x) => x !== s);
  if (s === active) useJobSearch(rest, rest[0]);
  else updateSettings({ jobs_searches: JSON.stringify(rest) });
  return { ok: true };
}));
app.get('/api/jobs/:id/trace', wrap((req) => {
  const r = db.prepare('SELECT trace FROM job_apps WHERE id = ?').get(Number(req.params.id));
  if (!r) throw bad('Job not found', 404);
  return parseJson(r.trace, null);
}));
// your CV as text: Claude uses it to answer form questions that have no saved answer
app.get('/api/jobs/cv', wrap(() => ({ text: cvText() })));
app.put('/api/jobs/cv', wrap((req) => {
  const text = String(req.body.text || '').slice(0, 20000);
  saveCv(text);
  return { text };
}));
app.post('/api/jobs/run', wrap((req) => {
  if (runner.getStatus().status !== 'idle') throw bad('A campaign is running – start the job applier when it is done');
  return jobApplier.start({ test: !!req.body.test, manual: true });
}));
app.post('/api/jobs/stop', wrap(() => jobApplier.stop()));
app.put('/api/jobs/answers', wrap((req) => {
  const { key, answer = '', label = '' } = req.body;
  if (!key) throw bad('key is required');
  db.prepare(`INSERT INTO job_answers (key, label, answer, updated_at) VALUES (?, ?, ?, datetime('now','localtime'))
    ON CONFLICT(key) DO UPDATE SET answer = excluded.answer, source = '', updated_at = excluded.updated_at`).run(String(key), String(label || key), String(answer).trim());
  const requeued = jobApplier.requeueAnswered();
  // jobs that only waited for this answer: apply now (a running applier picks them up by itself)
  let started = false;
  if (requeued && !jobApplier.isBusy() && !jobApplier.getStatus().stopped && runner.getStatus().status === 'idle') {
    try { jobApplier.start({ reason: 'you answered questions' }); started = true; } catch { /* limit reached / not connected */ }
  }
  return { requeued, started };
}));
app.delete('/api/jobs/answers/:key', wrap((req) => db.prepare('DELETE FROM job_answers WHERE key = ?').run(req.params.key)));
app.post('/api/jobs/:id/retry', wrap((req) => db.prepare("UPDATE job_apps SET status = 'queued', reason = 'tried again by you', updated_at = datetime('now','localtime') WHERE id = ?").run(Number(req.params.id))));

app.get('/api/runner/status', wrap(() => ({ ...runner.getStatus(), prospect: prospectRunner.getStatus() })));
app.post('/api/runner/start', wrap((req) => jobApplier.isBusy() ? Promise.reject(bad('The job applier is running – stop it first or wait until it is done')) : runner.run({ listIds: (req.body.list_ids || []).map(Number), mode: 'connect' })));
app.post('/api/runner/check-acceptances', wrap(() => runner.run({ mode: 'accept' })));
app.post('/api/runner/check-replies', wrap((req) => runner.run({ mode: 'replies', listIds: (req.body?.list_ids || []).map(Number), maxLeads: Number(req.body?.max) || 0 })));
app.post('/api/runner/followups', wrap((req) => runner.run({ mode: 'followups', maxLeads: Number(req.body?.max) || 0, dryRun: !!req.body?.dry_run })));
// The prospect finder runs on its own (it can work while a campaign sends notes)
app.post('/api/runner/prospects', wrap((req) => prospectRunner.start((req.body.search_ids || []).map(Number))));
app.post('/api/prospects/run/:act', wrap((req) => {
  const fn = { pause: prospectRunner.pause, resume: prospectRunner.resume, stop: prospectRunner.stop }[req.params.act];
  if (!fn) throw bad('Unknown action');
  return fn();
}));
app.post('/api/runner/photos', wrap((req) => runner.run({ listIds: (req.body.list_ids || []).map(Number), maxLeads: Number(req.body.max_leads) || 0, mode: 'photos' })));
app.post('/api/runner/sync', wrap((req) => runner.run({ listIds: (req.body.list_ids || []).map(Number), mode: 'sync' })));
app.post('/api/runner/pause', wrap(() => runner.pause()));
app.post('/api/runner/resume', wrap(() => runner.resume()));
app.post('/api/runner/stop', wrap(() => runner.stop()));
// After LinkedIn's weekly / notes limit put sending on hold
app.post('/api/limit-pause/resume', wrap(() => {
  if (runner.getStatus().status !== 'idle') throw bad('Stop the current run first');
  return runner.resumeAfterLimit();
}));
app.post('/api/limit-pause/dismiss', wrap(() => runner.dismissLimitPause()));

app.get('/api/extension', wrap(() => bridge.getInfo()));
app.post('/api/extension/test', wrap(async () => {
  const tab = await bridge.call('useWorkTab');
  logger.info(`Extension test: using tab ${tab.url} (logged in: ${tab.loggedIn ? 'yes' : 'no'})`);
  // a test only – don't leave the tab in the bot's group (a running campaign keeps its own)
  if (runner.getStatus().status === 'idle') await bridge.call('closeTabs', { roles: ['work', 'job'] }).catch(() => {});
  return tab;
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown endpoint' }));
// Plain shareable list of prospects (names, companies, links)
app.get('/list', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'list.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  LinkedIn Automation dashboard: http://localhost:${PORT}\n`);
});
bridge.attach(server);
runner.startAcceptanceScheduler();
runner.startQuickAcceptancePoll();
runner.startFollowupScheduler();
runner.startResumeWatcher();
prospectRunner.startSchedule();
jobApplier.startSchedule(() => runner.getStatus().status !== 'idle');
pending.startNotifier();
