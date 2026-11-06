// CRM: every lead who accepted a connection note, from any campaign, on one board.
// The bot places each lead by itself from what it read in the chat; you can drag a lead to another stage.
//   accepted       – accepted, chat not read yet
//   not_responded  – chat read, no reply
//   positive / negative / other – replied (the reply's category)
//   meeting – meeting booked, set by you
//   won / closed / cold – set by you (cold also by itself: no reply 7 days after the last follow-up)
// People the bot never contacted can be added too (from your inbox, or by hand): status 'crm', no list,
// no follow-ups – they stay in the stage you give them.
// A stage you set stays, except that a new reply after it moves the lead to the right reply column –
// meeting booked, won and closed never move.
const { db, getState, setState } = require('./db');
const { categorizeReply } = require('./automation/replyCategory');

const STAGES = ['accepted', 'not_responded', 'positive', 'negative', 'other', 'meeting', 'won', 'closed', 'cold'];
const REPLY_STAGE = { positive: 'positive', negative: 'negative', unclear: 'other' };
const FINAL = ['meeting', 'won', 'closed'];
// stages where the bot's follow-ups stop (you are handling the person yourself)
const NO_FOLLOWUPS = ['positive', 'negative', 'other', 'meeting', 'won', 'closed', 'cold'];
const COLD_AFTER_DAYS = 7;

const toMs = (ts) => (ts ? new Date(String(ts).replace(' ', 'T')).getTime() : 0);
const nowStamp = () => new Date().toLocaleString('sv-SE').replace('T', ' ');

/** The last follow-up step that is ON for each message type: { typeId: step } */
function lastSteps() {
  const out = {};
  for (const r of db.prepare("SELECT type_id, MAX(step) s FROM message_followups WHERE active = 1 AND body <> '' GROUP BY type_id").all()) out[r.type_id] = r.s;
  return out;
}

/** Where the bot would put this lead from the chat alone */
function autoStage(d, last) {
  if (d.replied_at) return REPLY_STAGE[d.reply_category] || 'other';
  if (!d.chat_checked_at) return 'accepted';
  const done = last[d.ftype] && d.followup_step >= last[d.ftype];
  if (done && d.followup_at && Date.now() - toMs(d.followup_at) > COLD_AFTER_DAYS * 864e5) return 'cold';
  return 'not_responded';
}

/** The stage shown: yours if you set one (unless a reply came in after it), else the bot's */
function stageOf(d, last) {
  const auto = autoStage(d, last);
  if (!STAGES.includes(d.crm_stage)) return { stage: auto, by: 'auto' };
  if (FINAL.includes(d.crm_stage)) return { stage: d.crm_stage, by: 'you' };
  if (d.replied_at && toMs(d.replied_at) > toMs(d.crm_stage_at)) return { stage: auto, by: 'auto' };
  return { stage: d.crm_stage, by: 'you' };
}

const LEADS_SQL = `
  SELECT d.id, d.status, d.created_at, d.name, d.title, d.company, d.photo_url, d.profile_url, d.chat_url, d.list_id, l.name AS list_name,
    d.accepted_at, d.replied_at, d.reply_text, d.reply_category, d.chat_checked_at,
    d.followup_step, d.followup_at, d.followup_state, d.followup_error, d.crm_stage, d.crm_stage_at,
    COALESCE(v.type_id, l.type_id) AS ftype
  FROM leads d LEFT JOIN message_variants v ON v.id = d.variant_id LEFT JOIN lists l ON l.id = d.list_id
  WHERE (d.accepted_at IS NOT NULL OR d.status = 'crm') AND d.crm_hidden = 0`;

const stampOf = (ms) => new Date(ms).toLocaleString('sv-SE').slice(0, 16);

// Follow-ups go by the date, not the hour, and never on a Sunday: the day a wait ends (from its start, 00:00);
// a Sunday becomes the Monday. Never earlier than the wait.
const isSunday = (d = new Date()) => d.getDay() === 0;
function followupDayMs(base, delayDays) {
  const d = new Date(toMs(base) + delayDays * 864e5);
  d.setHours(0, 0, 0, 0);
  if (isSunday(d)) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** Notes sent / accepted / replied for one campaign (or all), and the follow-up plan of its message type */
function stats(listId) {
  const where = listId ? 'AND list_id = ?' : '';
  const args = listId ? [listId] : [];
  const r = db.prepare(`SELECT COUNT(*) sent, SUM(accepted_at IS NOT NULL) accepted, SUM(replied_at IS NOT NULL) replied
                        FROM leads WHERE status = 'sent' ${where}`).get(...args);
  const list = listId ? db.prepare('SELECT l.name, l.type_id, t.name AS type_name FROM lists l LEFT JOIN message_types t ON t.id = l.type_id WHERE l.id = ?').get(listId) : null;
  const followups = list ? db.prepare("SELECT step, delay_days, active FROM message_followups WHERE type_id = ? AND body <> '' ORDER BY step").all(list.type_id || 0) : [];
  return { sent: r.sent, accepted: r.accepted || 0, replied: r.replied || 0, waiting: r.sent - (r.accepted || 0), type_name: list && list.type_name, followups };
}

/** The board: { stages: { stage: [lead] }, counts, stats, lists } – filtered by campaign (list) and search text */
function board({ listId, q } = {}) {
  const args = [];
  let sql = LEADS_SQL;
  if (listId === 'added') sql += " AND d.status = 'crm'";
  else if (listId) { sql += ' AND d.list_id = ?'; args.push(listId); }
  if (q) { sql += ' AND (d.name LIKE ? OR d.company LIKE ? OR d.title LIKE ? OR d.reply_text LIKE ?)'; args.push(...Array(4).fill(`%${q}%`)); }
  sql += ' ORDER BY COALESCE(d.crm_stage_at, d.replied_at, d.followup_at, d.accepted_at) DESC';
  const last = lastSteps();
  const steps = {};
  const stepsOf = (typeId) => (steps[typeId] ||= db.prepare("SELECT step, delay_days FROM message_followups WHERE type_id = ? AND active = 1 AND body <> ''").all(typeId || 0));
  const stages = Object.fromEntries(STAGES.map((s) => [s, []]));
  for (const d of db.prepare(sql).all(...args)) {
    const { stage, by } = stageOf(d, last);
    // when the bot sends this person's next follow-up (only while follow-ups are still going on)
    const next = !d.replied_at && !d.followup_state && stepsOf(d.ftype).find((f) => f.step === d.followup_step + 1);
    const base = d.followup_step ? d.followup_at : d.accepted_at;
    const next_followup = next && base ? { step: next.step, due: stampOf(followupDayMs(base, next.delay_days)).slice(0, 10) } : null;
    stages[stage].push({ ...d, stage, stage_by: by, next_followup, added: d.status === 'crm' });
  }
  const counts = Object.fromEntries(STAGES.map((s) => [s, stages[s].length]));
  const lists = db.prepare('SELECT id, name FROM lists WHERE id IN (SELECT DISTINCT list_id FROM leads WHERE accepted_at IS NOT NULL AND crm_hidden = 0) ORDER BY id DESC').all();
  if (db.prepare("SELECT 1 FROM leads WHERE status = 'crm' LIMIT 1").get()) lists.push({ id: 'added', name: 'Added by you' });
  return { stages, counts, lists, stats: stats(listId === 'added' ? null : listId) };
}

/**
 * You moved a lead. 'auto' hands it back to the bot. Moving to a reply / meeting / won / closed / cold stage stops the bot's
 * follow-ups for this person; moving back to accepted / not responded lets them go on.
 */
function setStage(id, stage) {
  const d = db.prepare("SELECT * FROM leads WHERE id = ? AND (accepted_at IS NOT NULL OR status = 'crm')").get(id);
  if (!d) throw new Error('Lead not found (or not accepted yet)');
  if (stage !== 'auto' && !STAGES.includes(stage)) throw new Error(`Unknown stage "${stage}"`);
  if (stage === 'auto' && d.status === 'crm' && !d.replied_at) throw new Error('You added this person yourself – pick a stage for them');
  const now = nowStamp();
  const fields = stage === 'auto' ? { crm_stage: '', crm_stage_at: null } : { crm_stage: stage, crm_stage_at: now };
  // a reply moved between positive / negative / other: that is its category now
  const cat = { positive: 'positive', negative: 'negative', other: 'unclear' }[stage];
  if (cat && d.replied_at) Object.assign(fields, { reply_category: cat, reply_category_by: 'you' });
  if (NO_FOLLOWUPS.includes(stage) && !d.followup_state) {
    Object.assign(fields, { followup_state: 'crm', followup_error: `you moved them to ${stage.replace('_', ' ')} in the CRM` });
  } else if (!NO_FOLLOWUPS.includes(stage) && d.followup_state === 'crm') {
    Object.assign(fields, { followup_state: '', followup_error: '' });
  }
  const keys = Object.keys(fields);
  db.prepare(`UPDATE leads SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now','localtime') WHERE id = ?`)
    .run(...keys.map((k) => fields[k]), id);
  return fields;
}

// names: "Cynthia Crosby, MBA" = "Cynthia Crosby"; Sales Navigator often gives only "Cynthia C." – then first name + initial
const nameKey = (n) => String(n || '').split(',')[0].normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
// stored = a name on the board: it gets an initial key only when it IS shortened ("Daniel H."), so that
// "Leah DB Higgins" never matches a full "Leah Halbina"
function nameKeys(n, stored = false) {
  const k = nameKey(n);
  const w = k.split(' ');
  if (!k) return [];
  if (stored) return [`n:${k}`, ...(w.length > 1 && w[w.length - 1].length === 1 ? [`i:${w[0]} ${w[w.length - 1]}`] : [])];
  return [`n:${k}`, ...w.slice(1).map((x) => `i:${w[0]} ${x[0]}`)]; // "Daniel Hernández Reyes" = "Daniel H."
}
const threadOf = (url) => (String(url).match(/\/messaging\/thread\/([^/?#]+)/) || [])[1] || '';
const vanityOf = (url) => (String(url).match(/linkedin\.com\/in\/([^/?#]+)/i) || [])[1] || '';

/** People already on the board (by chat, profile or name) – to mark inbox chats that are in the CRM */
function boardIndex() {
  const rows = db.prepare("SELECT id, name, chat_url, profile_url FROM leads WHERE accepted_at IS NOT NULL OR status = 'crm'").all(); // hidden ones too: never added twice
  const idx = new Map();
  for (const r of rows) for (const k of [threadOf(r.chat_url), vanityOf(r.profile_url).toLowerCase(), ...nameKeys(r.name, true)]) if (k) idx.set(k, r.id);
  return idx;
}
/** The board lead this person is (by chat, profile, full name, then first name + last initial) */
function findIn(idx, { chat_url = '', profile_url = '', name = '' }) {
  for (const k of [threadOf(chat_url), vanityOf(profile_url).toLowerCase(), ...nameKeys(name)]) if (k && idx.has(k)) return idx.get(k);
  return null;
}

/** The last inbox read by the bot, each chat marked when its person is already on the board */
function inbox(scan) {
  if (!scan) return { at: null, items: [] };
  const idx = boardIndex();
  return { at: scan.at, items: (scan.items || []).map((it) => ({ ...it, in_crm: findIn(idx, it), removed: !findIn(idx, it) && isRemoved(it) })) };
}

/**
 * Puts people on the board that the bot did not find by itself: { name, link?, title?, company?, photo_url?, snippet?, stage }.
 * link = their profile or the chat. Someone the bot sent a note to (but did not see accept) is moved onto the board;
 * anyone else is added as your own contact (no campaign, no follow-ups). Returns the ids.
 */
function addContacts(people, { byInbox = false } = {}) {
  const ids = [];
  const now = nowStamp();
  const idx = boardIndex();
  for (const p of people) {
    const name = String(p.name || '').trim();
    if (!name) throw new Error('Every person needs a name');
    if (!byInbox) unremove({ ...p, chat_url: p.chat_url || p.link, profile_url: p.profile_url || p.link });
    const stage = STAGES.includes(p.stage) ? p.stage : 'other';
    const link = String(p.link || p.chat_url || p.profile_url || '').trim();
    if (link && !/linkedin\.com\/(in|messaging)\//i.test(link)) throw new Error(`"${link}" is not a LinkedIn profile or chat link`);
    const chat = /\/messaging\//.test(link) ? link.split('?')[0] : '';
    const profile = vanityOf(link) ? `https://www.linkedin.com/in/${vanityOf(link)}` : '';
    const known = findIn(idx, { chat_url: chat, profile_url: profile, name });
    if (known) {
      if (!byInbox) db.prepare('UPDATE leads SET crm_hidden = 0 WHERE id = ?').run(known); // added back by you
      setStage(known, stage);
      ids.push(known);
      continue;
    }
    const fields = {
      crm_stage: stage, crm_stage_at: now, followup_state: 'crm', followup_error: 'you added them to the CRM yourself',
      ...(chat ? { chat_url: chat } : {}), ...(profile ? { profile_url: profile } : {}),
      ...(p.photo_url ? { photo_url: p.photo_url } : {}), ...(p.title ? { title: String(p.title).slice(0, 200) } : {}),
      ...(p.company ? { company: String(p.company).slice(0, 200) } : {}),
      ...(p.snippet && !/^you:/i.test(p.snippet) ? { reply_text: String(p.snippet).slice(0, 500) } : {}),
    };
    // the bot sent them a note but never saw them accept: that lead goes on the board (counted as accepted)
    const sentIdx = new Map();
    for (const r of db.prepare("SELECT id, name, profile_url FROM leads WHERE status = 'sent' AND accepted_at IS NULL").all()) {
      for (const k of [vanityOf(r.profile_url).toLowerCase(), ...nameKeys(r.name, true)]) if (k) sentIdx.set(k, r.id);
    }
    const sentId = findIn(sentIdx, { profile_url: profile, name });
    const sent = sentId && { id: sentId };
    if (sent) {
      const keys = Object.keys(fields);
      db.prepare(`UPDATE leads SET ${keys.map((k) => `${k} = ?`).join(', ')}, accepted_at = ?, updated_at = datetime('now','localtime') WHERE id = ?`)
        .run(...keys.map((k) => fields[k]), now, sent.id);
      ids.push(sent.id);
      continue;
    }
    const key = threadOf(chat) || vanityOf(profile).toLowerCase() || `${nameKey(name)}-${Date.now()}`;
    const row = { sales_id: `crm:${key}`, name, first_name: name.split(/\s+/)[0], status: 'crm', ...fields };
    const keys = Object.keys(row);
    const r = db.prepare(`INSERT INTO leads (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => row[k]));
    ids.push(Number(r.lastInsertRowid));
    for (const k of nameKeys(name, true)) idx.set(k, Number(r.lastInsertRowid));
  }
  return ids;
}

// people you took off the board: the inbox never brings them back (adding them again yourself does)
const removedKeys = (p) => [threadOf(p.chat_url), vanityOf(p.profile_url).toLowerCase(), `n:${nameKey(p.name)}`].filter((k) => k && k !== 'n:');
function isRemoved(p) {
  const gone = new Set(getState('crm_removed') || []);
  return removedKeys(p).some((k) => gone.has(k));
}
function unremove(p) {
  const drop = new Set(removedKeys(p));
  setState('crm_removed', (getState('crm_removed') || []).filter((k) => !drop.has(k)));
}

/** Takes someone off the board for good. People you added are deleted; a campaign lead stays in its campaign
 *  (hidden from the board, and the bot sends them no more follow-ups) */
function removeContact(id) {
  const d = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
  if (!d) throw new Error('Lead not found');
  if (d.status === 'crm') db.prepare('DELETE FROM leads WHERE id = ?').run(id);
  else {
    db.prepare(`UPDATE leads SET crm_hidden = 1, followup_state = CASE WHEN followup_state = '' THEN 'crm' ELSE followup_state END,
      followup_error = CASE WHEN followup_state = '' THEN 'you removed them from the CRM' ELSE followup_error END,
      updated_at = datetime('now','localtime') WHERE id = ?`).run(id);
  }
  setState('crm_removed', [...new Set([...(getState('crm_removed') || []), ...removedKeys(d)])]);
  // and out of today's "added to the CRM" count
  const log = getState('crm_added');
  if (log && log.names) setState('crm_added', { ...log, names: log.names.filter((n) => n !== d.name) });
}

// ---------- people you are talking to go on the board by themselves ----------
const stampMs = (ms) => new Date(ms).toLocaleString('sv-SE').slice(0, 19);

/** Inbox chats whose other person's messages must be read: not on the board yet (or added from the inbox before),
 *  and not already read with no reply from them since their last activity */
function inboxNeedsReplies(items) {
  const idx = boardIndex();
  const noReply = getState('inbox_noreply') || {};
  const crmRows = new Map(db.prepare("SELECT id, replied_at FROM leads WHERE status = 'crm'").all().map((r) => [r.id, r]));
  return items.filter((it) => {
    const on = findIn(idx, it);
    if (on && !crmRows.has(on)) return false; // a campaign lead: "Check replies" reads their chats
    if (on && crmRows.get(on).replied_at && toMs(crmRows.get(on).replied_at) >= it.at) return false; // nothing new
    if (!on && isRemoved(it)) return false; // you took them off the board
    if (!it.mine && it.snippet) return false; // their message is the last one – it is the snippet already
    return noReply[it.urn] !== it.at;
  }).map((it) => it.urn);
}

/**
 * Puts everyone you are talking to (they wrote at least once) on the board, and moves people added from the inbox
 * when they write again. Returns the names added.
 */
function syncInbox(items) {
  const now = nowStamp();
  const idx = boardIndex();
  const noReply = getState('inbox_noreply') || {};
  const added = [];
  for (const it of items) {
    let last = it.their_last;
    if (last === undefined && !it.mine && it.snippet) last = { body: it.snippet, at: it.at };
    if (last === null) { noReply[it.urn] = it.at; continue; }
    if (!last) continue;
    const reply = { replied_at: stampMs(last.at), reply_text: String(last.body || '').slice(0, 500), chat_checked_at: now };
    const on = findIn(idx, it);
    if (on) {
      const d = db.prepare('SELECT * FROM leads WHERE id = ?').get(on);
      if (d.status !== 'crm' || (d.replied_at && toMs(d.replied_at) >= last.at)) continue;
      const fields = { ...reply, ...(d.reply_category_by === 'you' ? {} : { reply_category: categorizeReply(last.body) }) };
      const keys = Object.keys(fields);
      db.prepare(`UPDATE leads SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now','localtime') WHERE id = ?`).run(...keys.map((k) => fields[k]), on);
      continue;
    }
    if (isRemoved(it)) continue; // you took them off the board
    const [id] = addContacts([{ ...it, link: it.chat_url, stage: 'other' }], { byInbox: true });
    // the bot places them from their reply (positive / negative / other) and moves them when they write again
    const fields = { ...reply, reply_category: categorizeReply(last.body), crm_stage: '', crm_stage_at: null };
    const keys = Object.keys(fields);
    db.prepare(`UPDATE leads SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
    for (const k of nameKeys(it.name, true)) idx.set(k, id);
    added.push(it.name);
  }
  setState('inbox_noreply', noReply);
  if (added.length) {
    const day = now.slice(0, 10);
    const log = getState('crm_added') || {};
    if (log.day !== day) Object.assign(log, { day, names: [], notified: false });
    log.names = [...new Set([...log.names, ...added])];
    setState('crm_added', log);
  }
  return added;
}

module.exports = { isSunday, followupDayMs, STAGES, board, setStage, inbox, addContacts, removeContact, inboxNeedsReplies, syncInbox };
