const path = require('path');
const express = require('express');
const { db, getSettings, updateSettings, DEFAULT_SETTINGS } = require('./db');
const { logger, bus } = require('./logger');
const { render, variants, fitToLimit } = require('./template');
const runner = require('./automation/runner');
const bridge = require('./automation/bridge');
const fs = require('fs');
const SHOTS_DIR = path.join(__dirname, '..', '..', 'workflow-screenshots');

const PORT = process.env.PORT || 4000;
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/screenshots', express.static(SHOTS_DIR));

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
  return { ...t, variants: db.prepare(VARIANTS_SQL).all(id) };
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
    SUM(d.status = 'sent') AS sent,
    SUM(d.status IN ('skipped','already_connected','pending_invite')) AS skipped,
    SUM(d.status = 'failed') AS failed,
    SUM(d.status = 'sent' AND d.sent_at >= l.activated_at) AS sent_since_on,
    SUM(d.accepted_at IS NOT NULL) AS accepted
  FROM lists l
  LEFT JOIN message_types t ON t.id = l.type_id
  LEFT JOIN leads d ON d.list_id = l.id`;

function validateList(b) {
  if (!b.name?.trim()) throw bad('List name is required');
  if (!/^https:\/\/(www\.)?linkedin\.com\/sales\//.test(b.url || '')) throw bad('URL must be a Sales Navigator link (https://www.linkedin.com/sales/...)');
}
const withShare = (l) => l && { ...l, daily_share: l.active ? runner.dailyShares()[l.id] ?? 0 : 0, sent_today: runner.listSentToday(l.id) };
app.get('/api/lists', wrap(() => db.prepare(`${LIST_SQL} GROUP BY l.id ORDER BY l.id DESC`).all().map(withShare)));
app.post('/api/lists', wrap((req) => {
  const b = req.body;
  validateList(b);
  const r = db.prepare(`INSERT INTO lists (name, url, type_id, active, max_pages, notes, send_limit, target_countries, activated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${now})`)
    .run(b.name.trim(), b.url.trim(), b.type_id || null, b.active === false ? 0 : 1, Number(b.max_pages) || 20, b.notes || '', Math.max(0, Number(b.send_limit) || 0), String(b.target_countries || '').trim());
  logger.info(`List "${b.name}" added`);
  return db.prepare(`${LIST_SQL} WHERE l.id = ? GROUP BY l.id`).get(r.lastInsertRowid);
}));
app.put('/api/lists/:id', wrap((req) => {
  const b = req.body;
  validateList(b);
  const old = db.prepare('SELECT active FROM lists WHERE id = ?').get(req.params.id);
  if (!old) throw bad('Not found', 404);
  const active = b.active === false || b.active === 0 ? 0 : 1;
  db.prepare(`UPDATE lists SET name = ?, url = ?, type_id = ?, active = ?, max_pages = ?, notes = ?, send_limit = ?, target_countries = ?, updated_at = ${now} WHERE id = ?`)
    .run(b.name.trim(), b.url.trim(), b.type_id || null, active, Number(b.max_pages) || 20, b.notes || '', Math.max(0, Number(b.send_limit) || 0), String(b.target_countries || '').trim(), req.params.id);
  if (active && !old.active) db.prepare(`UPDATE lists SET activated_at = ${now} WHERE id = ?`).run(req.params.id);
  return db.prepare(`${LIST_SQL} WHERE l.id = ? GROUP BY l.id`).get(req.params.id);
}));
app.post('/api/location-check', wrap((req) => {
  const { checkLocation } = require('./location');
  const s = getSettings();
  const rows = req.body.list_id
    ? db.prepare("SELECT name, location FROM leads WHERE list_id = ? AND status = 'pending'").all(req.body.list_id)
    : [];
  const out = rows.map((r) => ({ ...r, ...checkLocation(r.location, req.body.target_countries, s.skip_unclear_location) }));
  return { waiting: rows.length, skip: out.filter((r) => !r.ok).length, unclear: out.filter((r) => r.unclear).length, examples: out.filter((r) => !r.ok).slice(0, 8) };
}));
app.patch('/api/lists/:id/active', wrap((req) => {
  // Turning a list ON starts a new round: its send limit counts from now
  if (req.body.active) db.prepare(`UPDATE lists SET active = 1, activated_at = ${now} WHERE id = ?`).run(req.params.id);
  else db.prepare('UPDATE lists SET active = 0 WHERE id = ?').run(req.params.id);
  return db.prepare(`${LIST_SQL} WHERE l.id = ? GROUP BY l.id`).get(req.params.id);
}));
app.delete('/api/lists/:id', wrap((req) => {
  db.prepare('DELETE FROM lists WHERE id = ?').run(req.params.id);
  return { ok: true };
}));

// ---------- Leads ----------
app.get('/api/leads', wrap((req) => {
  const { list_id, status, q, limit = 50, offset = 0 } = req.query;
  const where = [];
  const args = [];
  if (list_id) { where.push('d.list_id = ?'); args.push(list_id); }
  if (status === 'accepted') where.push('d.accepted_at IS NOT NULL');
  else if (status === 'awaiting') where.push("d.status = 'sent' AND d.accepted_at IS NULL");
  else if (status) { where.push('d.status = ?'); args.push(status); }
  if (q) { where.push('(d.name LIKE ? OR d.company LIKE ? OR d.title LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) c FROM leads d ${w}`).get(...args).c;
  const rows = db.prepare(`SELECT d.*, l.name AS list_name FROM leads d LEFT JOIN lists l ON l.id = d.list_id ${w}
                           ORDER BY d.updated_at DESC, d.id DESC LIMIT ? OFFSET ?`).all(...args, Number(limit), Number(offset));
  return { total, rows };
}));
app.post('/api/leads/:id/reset', wrap((req) => {
  db.prepare(`UPDATE leads SET status = 'pending', error = '', attempts = 0, updated_at = ${now} WHERE id = ?`).run(req.params.id);
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

// ---------- Settings ----------
app.get('/api/settings', wrap(() => getSettings()));
app.put('/api/settings', wrap((req) => {
  const p = { ...req.body };
  for (const k of Object.keys(p)) {
    if (!(k in DEFAULT_SETTINGS)) delete p[k];
    else if (isNaN(Number(p[k])) || Number(p[k]) < 0) throw bad(`${k} must be a positive number`);
  }
  const merged = { ...getSettings(), ...p };
  if (merged.delay_min > merged.delay_max) throw bad('Minimum delay cannot be greater than maximum delay');
  if (merged.daily_limit > runner.MAX_DAILY) throw bad(`Daily limit can be at most ${runner.MAX_DAILY}`);
  if (merged.batch_break_min > merged.batch_break_max) throw bad('Minimum break cannot be greater than maximum break');
  if (merged.tab_wait_min > merged.tab_wait_max) throw bad('Minimum tab wait cannot be greater than maximum tab wait');
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
  send({ type: 'status', data: runner.getStatus() });
  bus.on('event', send);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(ping);
    bus.off('event', send);
  });
});

// ---------- Runner & browser ----------
app.get('/api/runner/status', wrap(() => runner.getStatus()));
app.post('/api/runner/start', wrap((req) => runner.run({ listIds: (req.body.list_ids || []).map(Number), mode: 'connect' })));
app.post('/api/runner/check-acceptances', wrap(() => runner.run({ mode: 'accept' })));
app.post('/api/runner/sync', wrap((req) => runner.run({ listIds: (req.body.list_ids || []).map(Number), mode: 'sync' })));
app.post('/api/runner/pause', wrap(() => runner.pause()));
app.post('/api/runner/resume', wrap(() => runner.resume()));
app.post('/api/runner/stop', wrap(() => runner.stop()));
// After LinkedIn's weekly / notes limit paused everything
app.post('/api/limit-pause/resume', wrap(() => {
  if (runner.getStatus().status !== 'idle') throw bad('Stop the current run first');
  return runner.resumeAfterLimit();
}));
app.post('/api/limit-pause/dismiss', wrap(() => runner.dismissLimitPause()));

app.get('/api/extension', wrap(() => bridge.getInfo()));
app.post('/api/extension/test', wrap(async () => {
  const tab = await bridge.call('useWorkTab');
  logger.info(`Extension test: using tab ${tab.url} (logged in: ${tab.loggedIn ? 'yes' : 'no'})`);
  return tab;
}));

app.get('/api/screenshots', wrap(() =>
  fs.existsSync(SHOTS_DIR) ? fs.readdirSync(SHOTS_DIR).filter((f) => f.endsWith('.png')).sort() : []
));

app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown endpoint' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  LinkedIn Automation dashboard: http://localhost:${PORT}\n`);
});
bridge.attach(server);
runner.startAcceptanceScheduler();
