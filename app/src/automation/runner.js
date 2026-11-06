// Orchestrates a run: for each selected list -> make sure there are pending leads (scrape the
// Sales Navigator list if needed) -> for each lead: resolve profile, connect with note, wait a
// random delay. All numbers come from Settings and are re-read on every lead, so changing the
// delay in the dashboard takes effect immediately, even mid-run.
const { db, getSettings, getState, setState } = require('../db');
const { logger, emit } = require('../logger');
const { render, cleanName, fitToLimit, pickVariant } = require('../template');
const { checkLocation } = require('../location');
const bridge = require('./bridge');
const li = require('./linkedin');
const prospectRunner = require('./prospectRunner');
const safety = require('./safety');
const { checkThread, words, fixedWords } = require('./followupCheck');
const { categorizeReply } = require('./replyCategory');
const notify = require('./notify');
const crm = require('../crm');
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');
const { DATA_DIR } = require('../db');
const DEBUG_DIR = path.join(DATA_DIR, 'debug');

const state = {
  status: 'idle', // idle | running | paused | stopping
  mode: null, // 'connect' | 'sync' | 'accept' | 'followups' | 'replies' | 'inbox' | 'prospect'
  current: null, // { list, lead }
  wait: null, // { until, seconds, reason }
  sentThisRun: 0,
  startedAt: null,
};

let stopRequested = false;
let paused = false;

const publish = () => emit('status', getStatus());

// Why a list (or the whole run) stopped – shown on the dashboard and the list cards.
// kind: done | info | warn | error | stopped | limit
function noteStop(listId, kind, text) {
  if (!state.lastRun || state.mode !== 'connect') return;
  state.lastRun.reasons = state.lastRun.reasons || {};
  state.lastRun.reasons[listId] = { kind, text, at: nowStamp() };
  setState('last_run', state.lastRun);
}
function noteRunEnd(kind, text) {
  if (!state.lastRun || state.mode !== 'connect') return;
  state.lastRun.end = { kind, text, at: nowStamp() };
  setState('last_run', state.lastRun);
}
const nowStamp = () => new Date().toLocaleString('sv-SE').slice(0, 16);

function sentToday() {
  return db
    .prepare("SELECT COUNT(*) c FROM leads WHERE status = 'sent' AND date(sent_at) = date('now','localtime')")
    .get().c;
}

/** The "sending on hold" notice goes away by itself once LinkedIn's limit has reset (weekly: on Monday) */
function currentLimitPause() {
  const lp = getState('limit_pause');
  if (!lp || lp.kind === 'restricted' || lp.kind === 'sales_nav') return lp; // these wait for you / a renewal
  const ageDays = (Date.now() - new Date(String(lp.at).replace(' ', 'T')).getTime()) / 864e5;
  const reset = lp.kind === 'weekly' ? ageDays >= 7 || lp.at < safety.weekStart({ weekly_window: 'monday' }) : ageDays >= 30;
  if (reset) { setState('limit_pause', null); return null; }
  return lp;
}

function getStatus() {
  const s = getSettings();
  return { ...state, lastRun: state.lastRun || getState('last_run'), lastAcceptanceCheck: getState('last_acceptance_check'), lastQuickAcceptance: getState('last_quick_acceptance'), limitPause: currentLimitPause(), safety: safety.summary(s), sentToday: sentToday(), dailyLimit: s.daily_limit, runLimit: s.run_limit, extension: bridge.isConnected() };
}

async function checkpoint() {
  while (paused && !stopRequested) await new Promise((r) => setTimeout(r, 500));
  if (stopRequested) throw new StopSignal();
}
class StopSignal extends Error {}
class NoNotesError extends Error {}

async function wait(seconds, reason) {
  const until = Date.now() + seconds * 1000;
  state.wait = { until, seconds: Math.round(seconds), reason };
  publish();
  while (Date.now() < until) {
    if (stopRequested) break;
    if (paused) {
      const left = until - Date.now();
      await checkpoint();
      state.wait = { until: Date.now() + left, seconds: Math.round(left / 1000), reason };
      publish();
      return wait(left / 1000, reason);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  state.wait = null;
  publish();
  await checkpoint();
}

const randBetween = (a, b) => {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return lo + Math.random() * (hi - lo);
};

// New leads go to 'review' (wait for your approval) or straight to 'pending' (the list sends right away)
const upsertLead = db.prepare(`
  INSERT INTO leads (list_id, sales_id, name, first_name, title, company, location, degree, sales_url, photo_url, status)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(sales_id) DO UPDATE SET
    title = COALESCE(NULLIF(excluded.title,''), leads.title),
    company = COALESCE(NULLIF(excluded.company,''), leads.company),
    degree = COALESCE(NULLIF(excluded.degree,''), leads.degree),
    photo_url = COALESCE(NULLIF(excluded.photo_url,''), leads.photo_url),
    updated_at = datetime('now','localtime')
`);

const MAX_DAILY = 100;

function listSentToday(listId) {
  return db
    .prepare("SELECT COUNT(*) c FROM leads WHERE list_id = ? AND status = 'sent' AND date(sent_at) = date('now','localtime')")
    .get(listId).c;
}

/** Daily limit split equally over the currently active lists ({ listId: share }); leftover goes to the oldest lists. */
/** Today's notes per active list: a list with its own daily limit gets that (capped by the overall
 *  daily limit), the lists without one split what is left equally. Counts reset at midnight. */
function dailyShares() {
  const limit = Math.min(getSettings().daily_limit, MAX_DAILY);
  const active = db.prepare('SELECT id, send_limit FROM lists WHERE active = 1 ORDER BY id').all();
  const own = active.filter((l) => l.send_limit > 0);
  const rest = active.filter((l) => !(l.send_limit > 0));
  const shares = Object.fromEntries(own.map((l) => [l.id, Math.min(l.send_limit, limit)]));
  const left = Math.max(0, limit - own.reduce((n, l) => n + shares[l.id], 0));
  rest.forEach((l, i) => { shares[l.id] = Math.floor(left / rest.length) + (i < left % rest.length ? 1 : 0); });
  return shares;
}

const shareText = (list, share, s) =>
  list.send_limit > 0 ? `daily limit of ${share} notes for this list` : `today's share of ${share} notes (daily limit ${s.daily_limit} ÷ active lists)`;

/** The list's "skip" keyword found in the lead's title or company, or '' */
function skipKeyword(lead, keywords) {
  const text = `${lead.title || ''} ${lead.company || ''}`.toLowerCase();
  return String(keywords || '').split(',').map((k) => k.trim()).filter(Boolean).find((k) => text.includes(k.toLowerCase())) || '';
}

const toReview = (listId) => db.prepare("SELECT COUNT(*) c FROM leads WHERE list_id = ? AND status = 'review'").get(listId).c;

// Leads already handled in this run (dry-run leads stay "pending", so they must not be picked again)
const seenThisRun = new Set();

// review_first lists send approved leads only; the others also take leads nobody reviewed
function pendingFor(listId, withReview = false) {
  const skip = [...seenThisRun];
  return db
    .prepare(`SELECT * FROM leads WHERE list_id = ? AND status IN ('pending'${withReview ? ", 'review'" : ''})
              ${skip.length ? `AND id NOT IN (${skip.map(() => '?').join(',')})` : ''} ORDER BY id LIMIT 1`)
    .get(listId, ...skip);
}

const MAX_PAGES = 100; // Sales Navigator never shows more than 100 pages (2,500 people)
const leadsReady = (list) => db.prepare(`SELECT COUNT(*) c FROM leads WHERE list_id = ? AND status IN ('pending', 'review')`).get(list.id).c;

/**
 * Reads a list page by page (each page loaded fresh by its URL, so a tab Chrome froze wakes up).
 * Yields { pageNo, leads }; ends at an empty page, at maxPages, or when Sales Navigator ignores the page number.
 */
async function* listPages(list, maxPages = MAX_PAGES) {
  const settings = getSettings();
  let prevFirst = null;
  for (let pageNo = 1; pageNo <= Math.min(maxPages, MAX_PAGES); pageNo++) {
    await checkpoint();
    let leads = [];
    for (let attempt = 1; ; attempt++) {
      try {
        await li.openListPage(list.url, pageNo, settings, wait);
        leads = await li.scrapeCurrentPage();
        // a page that is still loading shows fewer than 25 people – look again before calling it the end
        for (let retry = 0; retry < 2 && leads.length < 25; retry++) {
          await wait(settings.page_load_wait, 'Waiting for the page to finish loading');
          const again = await li.scrapeCurrentPage();
          if (again.length > leads.length) leads = again;
        }
        // nobody shown is usually a page Chrome froze before it rendered – load it again before calling it the end
        if (!leads.length && attempt < 3) {
          logger.info(`Page ${pageNo}: no people shown yet – loading the page again`, { list_id: list.id });
          continue;
        }
        break;
      } catch (e) {
        if (!/did not respond/i.test(e.message) || attempt >= 3) throw e;
        logger.info(`Page ${pageNo}: the bot tab was asleep – loading the page again`, { list_id: list.id });
      }
    }
    if (!leads.length) {
      // keep a record of what the tab showed, so an empty page can be told apart from the end of the search
      const snap = await bridge.call('exec', { tab: 'work', action: 'snapshot' }).catch((e) => ({ error: e.message }));
      fs.mkdirSync(DEBUG_DIR, { recursive: true });
      fs.writeFileSync(path.join(DEBUG_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}-list${list.id}-page${pageNo}.json`), JSON.stringify(snap, null, 2));
      logger.info(`Page ${pageNo}: no people shown (${(snap && (snap.title || snap.error)) || 'unknown page'})`, { list_id: list.id });
    }
    if (pageNo > 1 && leads[0] && leads[0].sales_id === prevFirst) {
      logger.warn(`"${list.name}": page ${pageNo} shows the same people as page ${pageNo - 1} – stopping here`, { list_id: list.id });
      return;
    }
    prevFirst = leads[0] && leads[0].sales_id;
    yield { pageNo, leads };
    if (!leads.length) return;
  }
}

/** Scrape list pages until `need` new leads are found (or the search ends). */
async function syncList(list, need = Math.max(25, list.sync_target - leadsReady(list))) {
  const settings = getSettings();
  const fresh = db.prepare('SELECT * FROM lists WHERE id = ?').get(list.id) || list;
  const newStatus = fresh.review_first ? 'review' : 'pending';
  logger.info(`Opening list "${list.name}" – collecting ${need} new lead(s)`, { list_id: list.id });

  let added = 0;
  let skipped = 0;
  for await (const { pageNo, leads } of listPages(list)) {
    let newOnPage = 0;
    for (const l of leads) {
      const exists = db.prepare('SELECT id FROM leads WHERE sales_id = ?').get(l.sales_id);
      const v = (x) => (x == null ? '' : String(x));
      upsertLead.run(list.id, v(l.sales_id), v(l.name), cleanName(l.name).first_name, v(l.title), v(l.company), v(l.location), v(l.degree), v(l.sales_url), v(l.photo_url), newStatus);
      if (exists) continue;
      // your list rules: wrong country or a skip keyword -> skipped right away, never shown for review
      const kw = skipKeyword(l, fresh.skip_keywords);
      const loc = checkLocation(l.location, fresh.target_countries, settings.skip_unclear_location);
      if (kw || !loc.ok) {
        db.prepare("UPDATE leads SET status = 'skipped', error = ? WHERE sales_id = ?").run(kw ? 'skip_keyword' : 'outside_target_location', v(l.sales_id));
        skipped++;
      } else newOnPage++;
    }
    added += newOnPage;
    logger.info(`Page ${pageNo}: ${leads.length} leads found, ${newOnPage} new`, { list_id: list.id });
    emit('leads', { list_id: list.id });

    if (added >= need) break;
  }
  db.prepare("UPDATE lists SET last_synced_at = datetime('now','localtime') WHERE id = ?").run(list.id);
  logger.success(`List "${list.name}" synced: ${added} new leads${skipped ? ` (${skipped} skipped by your list rules)` : ''}`, { list_id: list.id });
  return added;
}

function setLead(id, fields) {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE leads SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now','localtime') WHERE id = ?`).run(
    ...keys.map((k) => fields[k]),
    id
  );
  emit('lead', { id, ...fields });
}

const STATUS_FOR = {
  sent: 'sent',
  dry_run: 'pending',
  already_connected: 'already_connected',
  pending_invite: 'pending_invite',
  email_required: 'skipped',
  no_connect: 'skipped',
  no_dialog: 'skipped',
  no_note_button: 'skipped',
  no_note_box: 'skipped',
  note_limit: 'pending', // not this lead's fault – it is retried after you resume
};

// Every problem is a one-time skip: no retries, move straight to the next lead
const SKIP_REASON = {
  email_required: 'LinkedIn asked for their email address',
  no_connect: 'no Connect option on the profile',
  no_dialog: 'the invite popup did not open',
  no_note_button: 'the invite popup had no "Add a note" option',
  no_note_box: 'the note box did not appear',
  already_connected: 'already connected',
  pending_invite: 'an invitation is already pending',
};

async function processLead(list, lead, type) {
  const settings = getSettings();
  const ctx = { list_id: list.id, lead_id: lead.id };
  state.current = { list: { id: list.id, name: list.name }, lead: { id: lead.id, name: lead.name } };
  publish();
  // you may have excluded the person a moment ago on the Leads page
  const cur = db.prepare('SELECT status FROM leads WHERE id = ?').get(lead.id)?.status;
  if (cur !== 'pending' && !(cur === 'review' && !list.review_first)) {
    logger.info(`${lead.name}: not in the queue any more (excluded) – skipped`, ctx);
    return 'skip';
  }

  if (/^1st/.test(lead.degree)) {
    setLead(lead.id, { status: 'already_connected' });
    logger.info(`${lead.name}: already a 1st-degree connection, skipped`, ctx);
    return 'skip';
  }

  const loc = checkLocation(lead.location, list.target_countries, settings.skip_unclear_location);
  if (!loc.ok) {
    setLead(lead.id, { status: 'skipped', error: 'outside_target_location' });
    logger.info(`${lead.name}: skipped – ${loc.reason}`, ctx);
    return 'skip';
  }

  const kw = skipKeyword(lead, list.skip_keywords);
  if (kw) {
    setLead(lead.id, { status: 'skipped', error: 'skip_keyword' });
    logger.info(`${lead.name}: skipped – "${kw}" in title / company`, ctx);
    return 'skip';
  }

  const firstName = cleanName(lead.first_name || lead.name).first_name;
  if (!firstName) {
    setLead(lead.id, { status: 'skipped', error: 'no_first_name' });
    logger.warn(`${lead.name}: could not work out a first name, skipped (note must be personalised)`, ctx);
    return 'skip';
  }
  const variant = pickVariant(db, type.id);
  if (!variant) throw new NoNotesError(`Message type "${type.name}" has no connection note turned ON`);
  const { text: note, truncated } = fitToLimit(render(variant.body, { ...lead, first_name: firstName }), settings.note_max_chars);
  if (truncated) logger.warn(`${lead.name}: message trimmed to ${settings.note_max_chars} chars`, ctx);

  try {
    logger.info(`${lead.name}: opening profile...`, ctx);
    const vName = variant.label || `note #${variant.position + 1}`;
    logger.info(`${lead.name}: ${vName} → "${note.slice(0, 70)}${note.length > 70 ? '…' : ''}"`, ctx);
    const result = await li.connectLead(lead, note, settings, {
      onProfileUrl: (url) => setLead(lead.id, { profile_url: url }),
      dwell: (seconds, reason) => wait(seconds, reason),
      onDebug: (why, snap) => {
        fs.mkdirSync(DEBUG_DIR, { recursive: true });
        const file = path.join(DEBUG_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}-lead${lead.id}.json`);
        fs.writeFileSync(file, JSON.stringify({ why, lead: { id: lead.id, name: lead.name, degree: lead.degree }, ...snap }, null, 2));
        logger.warn(`${lead.name}: ${why} – page details saved to data/debug/${path.basename(file)}`, ctx);
      },
    });
    const status = STATUS_FOR[result] || 'failed';
    const fields = { status, message: note, variant_id: variant.id, error: result === 'sent' ? '' : result, attempts: lead.attempts + 1 };
    if (result === 'sent') fields.sent_at = new Date().toLocaleString('sv-SE').replace('T', ' ');
    if (result === 'dry_run') fields.attempts = lead.attempts;
    setLead(lead.id, fields);

    if (result === 'sent') {
      state.sentThisRun++;
      if (getState('limit_pause')?.kind === 'weekly') { setState('limit_pause', null); logger.info('LinkedIn accepted a new invitation – the weekly limit has reset, notice cleared'); publish(); }
      if (state.lastRun) {
        state.lastRun.byList[list.id] = (state.lastRun.byList[list.id] || 0) + 1;
        setState('last_run', state.lastRun); // survives server restarts
      }
      logger.success(`${lead.name}: invitation sent ✓`, ctx);
      return 'sent';
    }
    if (result === 'dry_run') {
      logger.info(`${lead.name}: DRY RUN - note filled, Send not clicked`, ctx);
      return 'sent';
    }
    if (result === 'note_limit') throw new li.LimitReachedError('LinkedIn says you are out of personalized notes', 'notes');
    logger.warn(`${lead.name}: skipped – ${SKIP_REASON[result] || result.replace(/_/g, ' ')}. Moving to the next lead.`, ctx);
    return 'skip';
  } catch (e) {
    if (e instanceof li.LimitReachedError || e instanceof li.SubscriptionError || e instanceof StopSignal || e instanceof NoNotesError) throw e;
    if (e instanceof safety.RestrictedError || e instanceof safety.RateLimitError) throw e; // stop everything, see run()
    if (BROWSER_PROBLEM.test(e.message || '')) {
      // Not the lead's fault (bot tab closed, extension reloaded, Chrome busy): keep the lead, fix the tab, try again
      seenThisRun.delete(lead.id);
      await recoverBotTab(e, ctx);
      return 'retry';
    }
    browserTrouble = 0;
    setLead(lead.id, { status: 'skipped', error: String(e.message || e).slice(0, 300), attempts: lead.attempts + 1 });
    logger.warn(`${lead.name}: skipped – ${e.message}. Moving to the next lead (no retry).`, ctx);
    return 'skip';
  }
}

/** Close only the campaign's own bot tabs (the prospect finder may be using its tabs right now) */
async function closeOwnTabs() {
  try { await bridge.call('closeTabs', { roles: ['work', 'job', li.ANCHOR_ROLE] }); } catch (e) {
    if (/Unknown command/.test(e.message) && !prospectRunner.isBusy()) await bridge.call('closeBotWindow').catch(() => {}); // older extension
  }
}

// Problems with the browser side, not with the lead
const BROWSER_PROBLEM = /No work tab|tab was closed|Profile tab was closed|did not respond|not connected|disconnected|No tab with id|Frame with ID|showing error page/i;
let browserTrouble = 0;
let workTabOpen = false; // the Sales Navigator tab – only opened for list pages (notes, sync, photos)

/** Opens the Sales Navigator tab the list pages are read in (a fresh one: Chrome freezes an idle background tab) */
async function openWorkTab() {
  const tab = await li.useWorkTab();
  workTabOpen = true;
  li.anchorOnWorkTab();
  if (!tab.loggedIn) throw new Error('LinkedIn is not logged in in your Chrome. Log in, then start again.');
  logger.info(`Using the bot tab: ${tab.url.slice(0, 80)}`);
}

/** Logged in to LinkedIn? Asked in the background (no tab) – chats, profiles and acceptances need no Sales Navigator tab */
async function assertLoggedIn() {
  const res = await bridge.call('apiGet', { url: 'https://www.linkedin.com/voyager/api/me' }, 30000);
  if (res && (res.status === 401 || res.status === 403)) throw new Error('LinkedIn is not logged in in your Chrome. Log in, then start again.');
}

/** The bot tab is gone / Chrome stopped answering: wait for the extension, open a fresh bot tab. Gives up after 3 times in a row. */
async function recoverBotTab(e, ctx) {
  browserTrouble++;
  logger.warn(`Browser problem (${e.message}) – the lead stays in the queue; reopening the bot tab (try ${browserTrouble} of 3)`, ctx);
  if (browserTrouble > 3) throw new Error(`The bot tab kept failing (${e.message}). Check that Chrome is open and the extension is ON, then press Start again`);
  for (let i = 0; i < 12 && !bridge.isConnected(); i++) await wait(10, 'Waiting for the Chrome extension');
  await wait(5, 'Reopening the bot tab');
  if (workTabOpen) await li.useWorkTab();
  else await li.openAnchorTab();
}

// ---------- follow-up messages ----------
// Each message type can have up to 3 follow-ups. They go to people who accepted that type's connection
// note, one step at a time, and stop for good once the person writes back.
const FOLLOWUP_STEPS = 3;
const followupsToday = () => db.prepare("SELECT COUNT(*) c FROM followups_sent WHERE date(sent_at) = date('now','localtime')").get().c;
const toMs = (ts) => new Date(String(ts).replace(' ', 'T')).getTime();

/** [{ lead, f }] whose next follow-up is due: accepted, no reply yet, the step is ON and its wait is over */
// a lead + the message type of its campaign (the note's type, else the list's)
const FTYPE_SQL = `SELECT d.*, COALESCE(v.type_id, l.type_id) AS ftype FROM leads d
  LEFT JOIN message_variants v ON v.id = d.variant_id LEFT JOIN lists l ON l.id = d.list_id`;

function dueFollowups() {
  const rows = db.prepare(`${FTYPE_SQL}
    WHERE d.status = 'sent' AND d.accepted_at IS NOT NULL AND d.replied_at IS NULL AND d.followup_state = ''
      AND d.followup_step < ? AND d.profile_url LIKE '%linkedin.com/in/%' ORDER BY d.accepted_at`).all(FOLLOWUP_STEPS);
  const stepOf = db.prepare("SELECT * FROM message_followups WHERE type_id = ? AND step = ? AND active = 1 AND body <> ''");
  if (crm.isSunday()) return []; // no follow-ups on Sundays – they go out on Monday
  const now = Date.now();
  return rows.map((lead) => ({ lead, f: lead.ftype && stepOf.get(lead.ftype, lead.followup_step + 1) }))
    .filter(({ lead, f }) => f && dueDayMs(lead, f) <= now);
}

/** Follow-ups go by the date, not the hour, and never on a Sunday: due from the start of the day its wait ends
 *  (accepted on the 5th + 1 day = any time on the 6th; a Sunday becomes the Monday) */
const dueDayMs = (lead, f) => crm.followupDayMs(lead.followup_step ? lead.followup_at : lead.accepted_at, f.delay_days);

/** The next follow-up that will come due: { at: "YYYY-MM-DD HH:MM", name } or null */
function nextFollowup() {
  const rows = db.prepare(`${FTYPE_SQL}
    WHERE d.status = 'sent' AND d.accepted_at IS NOT NULL AND d.replied_at IS NULL AND d.followup_state = ''
      AND d.followup_step < ? AND d.profile_url LIKE '%linkedin.com/in/%'`).all(FOLLOWUP_STEPS);
  const stepOf = db.prepare("SELECT * FROM message_followups WHERE type_id = ? AND step = ? AND active = 1 AND body <> ''");
  let best = null;
  for (const lead of rows) {
    const f = lead.ftype && stepOf.get(lead.ftype, lead.followup_step + 1);
    if (!f) continue;
    let at = dueDayMs(lead, f);
    // on a Sunday the ones already due wait for Monday
    if (crm.isSunday() && at <= Date.now()) { const d = new Date(); d.setHours(24, 0, 0, 0); at = d.getTime(); }
    if (at > Date.now() && (!best || at < best.ms)) best = { ms: at, name: lead.name };
  }
  return best && { at: new Date(best.ms).toLocaleString('sv-SE').slice(0, 10), name: best.name };
}

const FOLLOWUP_FAIL = {
  not_connected: 'not a 1st-degree connection on their profile',
  no_message_button: 'no Message button on their profile',
  no_box: 'the message box did not open',
  thread_unreadable: 'could not read the conversation to check for a reply',
  not_sent: 'the message did not go out',
};

/** What the chat with this lead must hold before follow-up `step` of its campaign's message type goes out:
 *  this campaign's note + its earlier follow-ups (see followupCheck.js) */
function followupExpectations(lead, typeId, step) {
  const sent = Object.fromEntries(db.prepare('SELECT step, message FROM followups_sent WHERE lead_id = ?').all(lead.id).map((r) => [r.step, r.message]));
  const steps = db.prepare('SELECT step, body FROM message_followups WHERE type_id = ?').all(typeId || 0)
    // a follow-up the bot sent: its exact words · one you typed yourself: the template's fixed words
    .map((x) => ({ step: x.step, words: sent[x.step] ? words(sent[x.step]) : fixedWords(x.body) }));
  return { note: lead.message, steps, step };
}

const SKIP_TALLY = { replied: 'replied', manual: 'other message from you', missing: 'note / earlier follow-up missing', '': 'follow-up already sent by you' };

/**
 * Opens the chat with one lead (straight from its saved chat link when there is one), reads it and stores what it
 * shows: a reply (with its category), a follow-up you sent yourself, or why follow-ups stop.
 * f = the follow-up to send ({ step, body }), or null to only check for a reply. Returns a word for the run's tally.
 */
async function handleChat(lead, s, f) {
  const ctx = { list_id: lead.list_id, lead_id: lead.id };
  const step = f ? f.step : lead.followup_step + 1;
  const text = f ? render(f.body, { ...lead, first_name: cleanName(lead.first_name || lead.name).first_name }) : null;
  if (f) logger.info(`${lead.name}: follow-up ${f.step} → "${text.slice(0, 70)}${text.length > 70 ? '…' : ''}"`, ctx);
  let result;
  let check;
  try {
    const expect = followupExpectations(lead, lead.ftype, step);
    ({ result, check } = await li.messageLead(lead, text, s, {
      decide: (messages) => checkThread(messages, expect),
      dwell: (seconds, reason) => wait(seconds, reason),
      onChatUrl: (url) => { setLead(lead.id, { chat_url: url }); lead.chat_url = url; },
      onDebug: (why, snap) => {
        fs.mkdirSync(DEBUG_DIR, { recursive: true });
        const file = path.join(DEBUG_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}-chat${lead.id}.json`);
        fs.writeFileSync(file, JSON.stringify({ why, lead: { id: lead.id, name: lead.name }, ...snap }, null, 2));
      },
    }));
    browserTrouble = 0;
  } catch (e) {
    if (e instanceof StopSignal || e instanceof safety.RestrictedError || e instanceof safety.RateLimitError) throw e;
    if (BROWSER_PROBLEM.test(e.message || '')) { await recoverBotTab(e, ctx); return 'retry'; }
    result = e.message;
  }
  const nowTs = new Date().toLocaleString('sv-SE').replace('T', ' ');
  if (['sent', 'dry_run', 'no_reply', 'skipped'].includes(result)) setLead(lead.id, { chat_checked_at: nowTs, followup_tries: 0 });
  // a follow-up you typed yourself: count the next one's days from when you really sent it (read from the chat)
  const realAt = check && check.sentAt && lead.followup_step && check.sentAt[lead.followup_step];
  const botSent = db.prepare('SELECT 1 FROM followups_sent WHERE lead_id = ? AND step = ?').get(lead.id, lead.followup_step);
  if (realAt && !botSent && realAt !== lead.followup_at) {
    setLead(lead.id, { followup_at: realAt });
    logger.info(`${lead.name}: follow-up ${lead.followup_step} was sent by you on ${realAt.slice(0, 16)} – the next one counts from then`, ctx);
    lead.followup_at = realAt;
  }

  if (result === 'sent') {
    db.prepare('INSERT INTO followups_sent (lead_id, step, message) VALUES (?, ?, ?)').run(lead.id, f.step, text);
    setLead(lead.id, { followup_step: f.step, followup_at: nowTs, followup_error: '' });
    logger.success(`${lead.name}: follow-up ${f.step} sent ✓`, ctx);
    return 'sent';
  }
  if (result === 'dry_run') {
    logger.info(`${lead.name}: DRY RUN – chat checked (note${f.step > 1 ? ` + follow-up 1${f.step > 2 ? '–' + (f.step - 1) : ''}` : ''}, no reply) – follow-up ${f.step} typed, Send not clicked`, ctx);
    return 'ready to send (dry run)';
  }
  if (result === 'no_reply') {
    logger.info(`${lead.name}: no reply yet`, ctx);
    return 'no reply yet';
  }
  if (result === 'skipped') {
    if (check.state === 'replied') {
      const keep = lead.reply_category_by === 'you' && lead.reply_category;
      const category = keep ? lead.reply_category : categorizeReply(check.reply);
      setLead(lead.id, { replied_at: lead.replied_at || nowTs, reply_text: String(check.reply).slice(0, 1000), reply_category: category,
        reply_category_by: keep ? 'you' : 'auto', followup_state: 'replied', followup_error: check.reason.slice(0, 300) });
      logger.success(`${lead.name}: ${check.reason} 💬 (${category}) – no more follow-ups`, ctx);
    } else if (check.synced) {
      // you sent this follow-up yourself: counted as sent, the next one waits its days from when you sent it
      if (check.synced > lead.followup_step) setLead(lead.id, { followup_step: check.synced, followup_at: check.sentAt[check.synced] || nowTs, followup_error: '' });
      logger.info(`${lead.name}: ${check.reason}`, ctx);
    } else {
      setLead(lead.id, { followup_state: check.state, followup_error: check.reason.slice(0, 300) });
      logger.info(`${lead.name}: follow-up ${step} skipped – ${check.reason} – no more follow-ups`, ctx);
    }
    return SKIP_TALLY[check.state];
  }
  // two failures in a row -> this person gets no more follow-ups
  const tries = lead.followup_tries + 1;
  const giveUp = tries >= 2;
  setLead(lead.id, { followup_error: String(FOLLOWUP_FAIL[result] || result).slice(0, 300), followup_tries: tries, followup_state: giveUp ? 'failed' : lead.followup_state });
  logger.warn(`${lead.name}: chat could not be checked – ${FOLLOWUP_FAIL[result] || result}${giveUp ? ' (no more follow-ups for this person)' : ' (tried again next time)'}`, ctx);
  return 'could not be checked';
}

/** Runs handleChat over `items` ([{ lead, f }]) with the safety checks, limits and pauses. Returns the tally. */
async function chatRun(items, { max = 0, dryRun = false, sending = true } = {}) {
  const tally = {};
  let done = 0;
  for (const { lead, f } of items) {
    if (max && done >= max) break;
    await checkpoint();
    const s = { ...getSettings(), ...(dryRun ? { dry_run: 1 } : {}) };
    if (safety.cooldown()) break;
    if (!safety.inWorkingHours(s)) { logger.warn('Outside working hours – chats wait (Settings → Account safety)'); break; }
    if (sending && crm.isSunday()) { logger.warn('It is Sunday – no follow-ups today, the rest go out on Monday'); break; }
    if (sending && !s.dry_run && followupsToday() >= s.followup_daily_limit) {
      logger.warn(`Follow-up limit of ${s.followup_daily_limit} per day reached – the rest go out tomorrow (Settings → Account safety)`);
      break;
    }
    state.current = { list: { id: lead.list_id, name: f ? `Follow-up ${f.step}` : 'Checking replies' }, lead: { id: lead.id, name: lead.name } };
    publish();
    const outcome = await handleChat(lead, s, f);
    if (outcome === 'retry') continue;
    done++;
    tally[outcome] = (tally[outcome] || 0) + 1;
    emit('leads', {});
    if (outcome === 'sent') await wait(randBetween(s.delay_min, s.delay_max), 'Delay before the next message');
    else await wait(randBetween(s.skip_delay_min, s.skip_delay_max), 'Short pause');
  }
  logger.success(`${sending ? 'Follow-ups' : 'Reply check'}: ${Object.entries(tally).map(([k, n]) => `${n} ${k}`).join(' · ') || 'nothing done'}`);
  return tally;
}

/** Sends every follow-up that is due (within the daily follow-up limit). Returns how many went out.
 *  max: try at most this many people · dryRun: type the message but never press Send (this run only) */
async function sendFollowups({ max = 0, dryRun = false } = {}) {
  const due = dueFollowups();
  if (!due.length) { logger.info('No follow-ups due'); return 0; }
  logger.info(`${due.length} follow-up message(s) due${max ? ` – checking ${Math.min(max, due.length)}` : ''}${dryRun ? ' (DRY RUN – nothing is sent)' : ''}`);
  return (await chatRun(due, { max, dryRun })).sent || 0;
}

/** Reads the chats of people who accepted and have not replied (only those) and files any reply in the pipeline.
 *  Chats never read come first, then the ones read longest ago. */
async function checkReplies({ listIds = [], max = 0 } = {}) {
  const leads = db.prepare(`${FTYPE_SQL} WHERE d.status = 'sent' AND d.accepted_at IS NOT NULL AND d.replied_at IS NULL
      AND d.followup_state <> 'replied' AND d.profile_url LIKE '%linkedin.com/in/%'
      ${listIds.length ? `AND d.list_id IN (${listIds.map(() => '?').join(',')})` : ''}
    ORDER BY d.chat_checked_at IS NOT NULL, d.chat_checked_at`).all(...listIds);
  if (!leads.length) { logger.info('Nobody to check – everyone who accepted has replied already'); return; }
  logger.info(`Checking ${max ? Math.min(max, leads.length) : leads.length} chat(s) for replies (people who accepted and have not replied)`);
  await chatRun(leads.map((lead) => ({ lead, f: null })), { max, sending: false });
}

// ---------- connection notes straight from the Prospects page ----------
const DIRECT_LIST = 'direct';
/** The hidden list that holds people contacted from the Prospects page (never runs as a campaign) */
function directList(typeId) {
  let l = db.prepare('SELECT * FROM lists WHERE url = ?').get(DIRECT_LIST);
  if (!l) {
    const r = db.prepare("INSERT INTO lists (name, url, type_id, active, notes) VALUES ('Prospects page', ?, ?, 0, 'People you sent a note from the Prospects page')").run(DIRECT_LIST, typeId);
    l = db.prepare('SELECT * FROM lists WHERE id = ?').get(r.lastInsertRowid);
  }
  return l;
}

/** Sends a connection note to each chosen post author, with the same checks and limits as a campaign */
async function sendDirect(prospectIds, typeId) {
  const type = db.prepare('SELECT * FROM message_types WHERE id = ?').get(typeId);
  if (!type) throw new Error('Pick a message type for the connection note');
  const list = directList(type.id);
  let n = 0;
  for (const pid of prospectIds) {
    await checkpoint();
    const p = db.prepare('SELECT * FROM prospects WHERE id = ?').get(pid);
    const vanity = p && vanityOf(p.person_url);
    if (!p || !vanity) { logger.warn(`Prospect ${p ? p.person_name || p.company_name : pid}: no personal LinkedIn profile – can't send a connection note`); continue; }
    const unsafe = safety.sendBlock(getSettings());
    if (unsafe) { logger.warn(unsafe); noteRunEnd('limit', unsafe); return; }
    const s = getSettings();
    if (sentToday() >= Math.min(s.daily_limit, MAX_DAILY)) { logger.warn(`Daily limit reached (${s.daily_limit}). Stopping.`); return; }
    // the same person may already be a lead from a Sales Navigator list – never invite twice
    let lead = db.prepare("SELECT * FROM leads WHERE lower(rtrim(profile_url, '/')) = ? OR sales_id = ?").get(`https://www.linkedin.com/in/${vanity}`, `in:${vanity}`);
    if (!lead) {
      const name = cleanName(p.person_name);
      const r = db.prepare(`INSERT INTO leads (list_id, sales_id, name, first_name, title, company, location, degree, sales_url, profile_url)
                            VALUES (?, ?, ?, ?, ?, ?, ?, '', '', ?)`).run(list.id, `in:${vanity}`, p.person_name, name.first_name, p.headline || '', p.company_name || '', p.location || '', `https://www.linkedin.com/in/${vanity}`);
      lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(r.lastInsertRowid);
    }
    db.prepare('UPDATE prospects SET lead_id = ? WHERE id = ?').run(lead.id, pid);
    if (lead.status !== 'pending') {
      logger.info(`${lead.name}: already ${lead.status === 'sent' ? 'invited' : lead.status} – not sent again`);
      if (lead.status === 'sent') db.prepare("UPDATE prospects SET status = 'contacted' WHERE id = ? AND status = 'new'").run(pid);
      continue;
    }
    const outcome = await processLead(list, lead, type);
    if (db.prepare('SELECT status FROM leads WHERE id = ?').get(lead.id).status === 'sent') {
      db.prepare(`UPDATE prospects SET status = CASE WHEN status = 'new' THEN 'contacted' ELSE status END, updated_at = datetime('now','localtime') WHERE id = ?`).run(pid);
      emit('prospects', {});
      n++;
    }
    if (outcome === 'sent' && pid !== prospectIds[prospectIds.length - 1]) await wait(randBetween(s.delay_min, s.delay_max), 'Delay before next connection');
  }
  logger.success(`Connection notes from the Prospects page: ${n} sent`);
}

// ---- profile pictures straight from LinkedIn's API (no tab – works for every lead, also ones
// your saved search no longer shows, e.g. people you already invited) ----
const PHOTO_URLS = (id) => [
  `https://www.linkedin.com/voyager/api/identity/dash/profiles/${encodeURIComponent(`urn:li:fsd_profile:${id}`)}`,
  `https://www.linkedin.com/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(id)}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.WebTopCardCore-16`,
  `https://www.linkedin.com/voyager/api/identity/profiles/${encodeURIComponent(id)}`,
];
let photoUrlIndex = null; // which of PHOTO_URLS answered last time

/** The profile picture URL inside an API answer (smallest size of at least 100px), or '' */
function photoFromJson(json) {
  let best = '';
  let bestW = Infinity;
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (typeof o.rootUrl === 'string' && Array.isArray(o.artifacts) && /profile-displayphoto/.test(o.rootUrl + JSON.stringify(o.artifacts[0] || ''))) {
      for (const a of o.artifacts) {
        const w = a.width || 0;
        if (w >= 100 && w < bestW && a.fileIdentifyingUrlPathSegment) { bestW = w; best = o.rootUrl + a.fileIdentifyingUrlPathSegment; }
      }
    }
    for (const v of Object.values(o)) walk(v);
  };
  walk(json);
  return best;
}

/** The lead's photo URL, '-' when LinkedIn shows none, or null when the API didn't answer */
async function fetchPhoto(lead) {
  const vanity = (String(lead.profile_url || '').match(/linkedin\.com\/in\/([^/?#]+)/) || [])[1];
  const id = /^ACo|^ACw/.test(lead.sales_id) ? lead.sales_id : vanity && decodeURIComponent(vanity);
  if (!id) return null;
  const urls = PHOTO_URLS(id);
  const order = photoUrlIndex == null ? urls.map((_, i) => i) : [photoUrlIndex, ...urls.map((_, i) => i).filter((i) => i !== photoUrlIndex)];
  for (const i of order) {
    const res = await bridge.call('apiGet', { url: urls[i] }, 30000);
    if (res.status === 429 || res.status === 999) throw new safety.RateLimitError(`LinkedIn answered ${res.status} while reading profile pictures`, 1);
    if (res.status !== 200 || !res.json) continue;
    photoUrlIndex = i;
    return photoFromJson(res.json) || '-';
  }
  return null;
}

/** Fills in missing profile pictures of a list's leads. maxLeads = 0 -> all of them. */
async function refreshPhotos(list, maxLeads) {
  const leads = db.prepare(`SELECT id, name, sales_id, profile_url FROM leads WHERE list_id = ? AND COALESCE(photo_url, '') = ''
                            ORDER BY status = 'review' DESC, id${maxLeads ? ` LIMIT ${Number(maxLeads)}` : ''}`).all(list.id);
  logger.info(`Refreshing photos for "${list.name}" – ${leads.length} lead(s) without a photo`, { list_id: list.id });
  const setPhoto = db.prepare('UPDATE leads SET photo_url = ? WHERE id = ?');
  let saved = 0;
  let none = 0;
  let failed = 0;
  for (const [i, lead] of leads.entries()) {
    await checkpoint();
    const url = await fetchPhoto(lead);
    if (url === null) failed++;
    else {
      setPhoto.run(url, lead.id);
      if (url === '-') none++; else saved++;
    }
    if ((i + 1) % 25 === 0 || i === leads.length - 1) {
      logger.info(`Photos: ${i + 1} of ${leads.length} checked – ${saved} saved, ${none} without a photo${failed ? `, ${failed} could not be read` : ''}`, { list_id: list.id });
      emit('leads', { list_id: list.id });
    }
    // calm pace – one profile every few seconds
    if (i < leads.length - 1) await wait(randBetween(2, 4), 'Reading profile pictures');
  }
  logger.success(`"${list.name}": ${saved} photo(s) saved · ${none} people have no LinkedIn photo${failed ? ` · ${failed} could not be read` : ''}`, { list_id: list.id });
}

async function run({ listIds, searchIds, prospectIds, typeId, maxLeads, dryRun, mode = 'connect' } = {}) {
  // the prospect finder has its own runner, so it can work while a campaign sends notes
  if (mode === 'prospect') return prospectRunner.start(searchIds);
  if (state.status !== 'idle') throw new Error('Already running');
  const cool = safety.cooldown();
  if (cool) throw new Error(`Paused for account safety until ${cool.until}: ${cool.reason}. (Dashboard → Settings → Account safety to clear it early.)`);
  stopRequested = false;
  paused = false;
  Object.assign(state, { status: 'running', mode, current: null, wait: null, sentThisRun: 0, startedAt: new Date().toISOString() });
  seenThisRun.clear();
  browserTrouble = 0;
  if (mode === 'connect') {
    state.lastRun = { startedAt: state.startedAt, byList: {} };
    setState('last_run', state.lastRun);
  }
  publish();

  let runLists = [];
  // Keep the Mac from idle-sleeping while the bot works (closing the lid still sleeps it)
  let awake = null;
  try { awake = spawn('caffeinate', ['-i'], { stdio: 'ignore' }); awake.on('error', () => {}); } catch { awake = null; }
  (async () => {
    try {
      // start clean; the Sales Navigator tab is opened only when list pages are read (see openWorkTab)
      await closeOwnTabs();
      workTabOpen = false;
      await assertLoggedIn();
      // a light anchor tab keeps Chrome from freezing the profile / chat tabs (lists switch to the Sales Navigator tab)
      await li.openAnchorTab();

      if (mode === 'direct') {
        await sendDirect(prospectIds || [], typeId);
        return;
      }
      if (mode === 'accept') {
        await checkAcceptances();
        return;
      }
      if (mode === 'inbox') {
        // read only: the CRM shows these chats so you can pick who to add
        const items = await li.readInbox(getSettings(), wait, maxLeads || 60, crm.inboxNeedsReplies);
        setState('inbox_scan', { at: new Date().toLocaleString('sv-SE'), items: items.map(({ their_last, ...it }) => it) });
        // everyone who wrote to you goes on the board
        const added = crm.syncInbox(items);
        logger.success(`Inbox read: ${items.length} chat(s)${added.length ? ` – added to the CRM: ${added.join(', ')}` : ' – nobody new to add to the CRM'}`);
        emit('inbox', { n: items.length });
        if (added.length) emit('leads', {});
        return;
      }

      if (mode === 'photos') {
        // paused lists too – it only reads search pages
        let all = db.prepare("SELECT * FROM lists WHERE url <> 'direct' ORDER BY id").all();
        if (listIds && listIds.length) all = all.filter((l) => listIds.includes(l.id));
        await openWorkTab();
        for (const list of all) await refreshPhotos(list, maxLeads);
        return;
      }

      // follow-ups first (people who accepted and have not replied), then new connection notes
      if (mode === 'replies') {
        await checkReplies({ listIds: listIds || [], max: maxLeads });
        return;
      }
      if (mode === 'followups' || mode === 'connect') {
        const n = await sendFollowups(mode === 'followups' ? { max: maxLeads, dryRun } : {});
        if (mode === 'followups') { logger.success(`Follow-ups done: ${n} sent`); return; }
        state.current = null;
      }
      let followupCheckAt = Date.now();

      let lists = db.prepare('SELECT * FROM lists WHERE active = 1 ORDER BY id').all();
      if (listIds && listIds.length) lists = lists.filter((l) => listIds.includes(l.id));
      runLists = lists;
      if (!lists.length) throw new Error('No active lists selected');
      await openWorkTab();

      // Sales Navigator was off: after a renewal the hold clears itself as soon as a list shows people again
      if (getState('limit_pause')?.kind === 'sales_nav') {
        logger.info('Checking if Sales Navigator works again');
        if (!(await li.salesNavActive(lists[0].url, getSettings()))) throw new li.SubscriptionError('Sales Navigator subscription is still not active');
        setState('limit_pause', null);
        logger.success('Sales Navigator works again – campaigns continue');
        publish();
      }

      if (mode === 'sync') {
        for (const list of lists) await syncList(list);
        return;
      }

      for (const list of lists) {
        await checkpoint();
        const type = list.type_id && db.prepare('SELECT * FROM message_types WHERE id = ?').get(list.type_id);
        if (!type) {
          logger.warn(`List "${list.name}" has no message type assigned, skipped`, { list_id: list.id });
          noteStop(list.id, 'error', 'No message type assigned – edit the list and pick one');
          continue;
        }
        let lastSyncAdded = null; // 0 = the last sync found nobody new -> the search is used up
        logger.info(
          `▶ List "${list.name}" using message type "${type.name}"` +
            ` – today ${listSentToday(list.id)} / ${dailyShares()[list.id] ?? 0} notes`,
          { list_id: list.id }
        );
        for (;;) {
          await checkpoint();
          // a follow-up that came due during the run goes out before the next note (checked every 10 min)
          if (mode === 'connect' && Date.now() - followupCheckAt > 10 * 60000) {
            followupCheckAt = Date.now();
            if (dueFollowups().length && followupsToday() < getSettings().followup_daily_limit) {
              logger.info('Follow-ups came due – sending them before the next connection note');
              await sendFollowups();
              state.current = null;
            }
          }
          const s = getSettings();
          const fresh = db.prepare('SELECT * FROM lists WHERE id = ?').get(list.id);
          if (!fresh || !fresh.active) {
            logger.info(`List "${list.name}" was paused, moving on`, { list_id: list.id });
            noteStop(list.id, 'info', 'You paused this list during the run');
            break;
          }
          const hold = currentLimitPause();
          if (hold) {
            const why = `${hold.reason} on ${hold.at} – sending is on hold. Press "Resume sending" on the dashboard once LinkedIn lets you send again`;
            logger.warn(why);
            noteRunEnd('limit', why);
            return;
          }
          const unsafe = safety.sendBlock(getSettings());
          if (unsafe) {
            logger.warn(unsafe);
            noteRunEnd('limit', unsafe);
            return;
          }
          if (sentToday() >= Math.min(s.daily_limit, MAX_DAILY)) {
            logger.warn(`Daily limit reached (${s.daily_limit}). Stopping.`);
            noteRunEnd('limit', `Daily limit of ${s.daily_limit} notes reached – continues tomorrow (change it in Settings)`);
            return;
          }
          const share = dailyShares()[list.id] ?? 0;
          if (listSentToday(list.id) >= share) {
            logger.success(`List "${list.name}": ${shareText(fresh, share, s)} reached – continues after midnight`, { list_id: list.id });
            noteStop(list.id, 'done', `${shareText(fresh, share, s)} reached ✓ – continues after midnight`);
            break;
          }
          if (state.sentThisRun >= s.run_limit) {
            logger.warn(`Run limit reached (${s.run_limit}). Stopping.`);
            noteRunEnd('limit', `Per-run limit of ${s.run_limit} notes reached – press Start again to continue (change it in Settings)`);
            return;
          }

          // review_first: only leads you approved are sent · otherwise new leads go out right away
          let lead = pendingFor(list.id, !fresh.review_first);
          if (!lead && fresh.review_first) {
            // keep your review queue filled up to the list's target, then wait for you
            if (toReview(list.id) < fresh.sync_target) await syncList(fresh);
            const review = toReview(list.id);
            const msg = review
              ? `No approved leads left – ${review} lead(s) wait for your review on the Leads page. Approve the ones you want, then press Start again`
              : 'Sales Navigator search has no new people left – widen the search filters to get more leads';
            logger.warn(`"${list.name}": ${msg}`, { list_id: list.id });
            noteStop(list.id, 'warn', msg);
            break;
          }
          if (!lead && lastSyncAdded !== 0) {
            lastSyncAdded = await syncList(fresh);
            lead = pendingFor(list.id, true);
          }
          if (!lead) {
            const msg = 'Sales Navigator search has no new people left – widen the search filters to get more leads';
            logger.warn(`"${list.name}": ${msg}`, { list_id: list.id });
            noteStop(list.id, 'warn', msg);
            break;
          }

          seenThisRun.add(lead.id);
          let outcome;
          try {
            outcome = await processLead(fresh, lead, type);
            if (outcome !== 'retry') browserTrouble = 0;
          } catch (e) {
            if (!(e instanceof NoNotesError)) throw e;
            logger.warn(`${e.message} – list "${list.name}" skipped`, { list_id: list.id });
            noteStop(list.id, 'error', `${e.message} – turn one ON in Message Types`);
            break;
          }
          const s2 = getSettings();
          const done = sentToday();
          if (outcome === 'sent' && !s2.dry_run && s2.batch_size > 0 && done > 0 && done % s2.batch_size === 0) {
            let mins = randBetween(s2.batch_break_min, s2.batch_break_max);
            logger.info(`${done} notes sent today – taking a ${Math.round(mins)} minute break, then continuing automatically`);
            const breakEnds = Date.now() + mins * 60000;
            try { await checkAcceptances(); } catch (err) { if (err instanceof StopSignal) throw err; logger.warn(`Acceptance check failed: ${err.message}`); }
            mins = Math.max(0, (breakEnds - Date.now()) / 60000);
            await wait(mins * 60, `Break after ${s2.batch_size} notes – resumes automatically`);
            logger.info('Break over – resuming connection notes');
          } else if (outcome === 'sent') {
            await wait(randBetween(s2.delay_min, s2.delay_max), 'Delay before next connection');
          } else {
            await wait(randBetween(s2.skip_delay_min, s2.skip_delay_max), 'Short pause after skip');
          }
        }
      }
      logger.success('All selected lists processed');
      noteRunEnd('done', 'All selected lists processed');
    } catch (e) {
      if (e instanceof StopSignal) {
        logger.warn('Run stopped');
        noteRunEnd('stopped', 'You pressed Stop');
      } else if (e instanceof li.SubscriptionError) {
        holdForLimit(e);
        const why = `${e.message} – all campaigns stopped. Renew Sales Navigator, then press Start: the bot checks it and continues by itself`;
        noteRunEnd('limit', why);
        notify.macNotification('LinkedIn Bot – campaigns stopped', 'Sales Navigator subscription has ended');
        notify.telegram(`⛔ ${why}`).catch((err) => logger.warn(`Telegram message failed: ${err.message}`));
      } else if (e instanceof li.LimitReachedError) {
        holdForLimit(e);
        noteRunEnd('limit', `${e.message} – sending on hold, lists stay Active`);
      } else if (e instanceof safety.RestrictedError || e instanceof safety.RateLimitError) {
        // LinkedIn is checking / limiting the account: stop everything and wait before doing anything again
        const hours = e.hours || getSettings().safety_cooldown_hours;
        const c = safety.startCooldown(hours, e.message);
        if (e instanceof safety.RestrictedError) holdForLimit(e);
        logger.error(`${e.message} – the bot pauses everything until ${c.until} to protect your account`);
        noteRunEnd('limit', `${e.message} – paused until ${c.until}. Open LinkedIn yourself and solve any check it shows`);
      } else {
        logger.error(`Run failed: ${e.message}`);
        noteRunEnd('error', `Run failed: ${e.message}`);
        // the internet / Chrome went away: start the same run again once they are back
        if (CONNECTION_ERROR.test(e.message) && ['connect', 'followups'].includes(mode)) {
          setState('resume_run', { mode, listIds: listIds || [], since: Date.now() });
          logger.warn('Connection lost – the run starts again by itself as soon as the internet and Chrome are back');
        }
      }
    } finally {
      // lists the run ended on (or never reached) get the run's reason
      const end = state.lastRun && state.lastRun.end;
      if (mode === 'connect' && end && end.kind !== 'done') {
        for (const l of runLists) if (!state.lastRun.reasons?.[l.id]) noteStop(l.id, end.kind, end.text);
      }
      if (mode === 'connect' && state.sentThisRun > 0 && !stopRequested && bridge.isConnected()) {
        try { await checkAcceptances(); } catch (err) { if (!(err instanceof StopSignal)) logger.warn(`Acceptance check failed: ${err.message}`); }
      }
      if (awake) awake.kill();
      // job done -> close the bot tabs so they are not left open (opened again in the background next time)
      if (bridge.isConnected()) await closeOwnTabs();
      Object.assign(state, { status: 'idle', mode: null, current: null, wait: null });
      if (mode === 'connect' || mode === 'sync') logger.info(`Run finished. Sent this run: ${state.sentThisRun}`);
      publish();
    }
  })();
  return getStatus();
}

// ---------- who accepted? ----------
const vanityOf = (url = '') => {
  const m = String(url).match(/linkedin\.com\/in\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]).toLowerCase() : '';
};

/** Marks every invited lead that appears in `conns` ({ vanity, name }) as accepted; returns how many */
function markAccepted(conns) {
  const have = new Set(conns.map((c) => c.vanity));
  const normName = (s) => cleanName(s).full_name.toLowerCase();
  // names for the fallback match – only of connections whose link belongs to none of your leads, so a person you
  // invited twice (two links, one account) is not marked twice
  const leadLinks = new Set(db.prepare("SELECT profile_url FROM leads WHERE profile_url <> ''").all().map((r) => vanityOf(r.profile_url)).filter(Boolean));
  const names = new Set(conns.filter((c) => !leadLinks.has(c.vanity)).map((c) => normName(String(c.name).split(/\n| {2,}/)[0])).filter((n) => n.includes(' ')));
  const waiting = db.prepare("SELECT id, name, list_id, profile_url FROM leads WHERE status = 'sent' AND accepted_at IS NULL").all();
  const nowTs = new Date().toLocaleString('sv-SE').replace('T', ' ');
  let found = 0;
  for (const l of waiting) {
    const v = vanityOf(l.profile_url);
    const byLink = v && !/^ac[ow]aa/i.test(v) && have.has(v);
    // Fallback: match on the full name – for links like /in/ACwAA… (no readable name) and for people who changed
    // their profile link after you invited them
    const byName = !byLink && names.has(normName(l.name));
    if (!byLink && !byName) continue;
    db.prepare('UPDATE leads SET accepted_at = ? WHERE id = ?').run(nowTs, l.id);
    emit('lead', { id: l.id, accepted_at: nowTs });
    logger.success(`${l.name} accepted your connection note 🎉`, { list_id: l.list_id, lead_id: l.id });
    found++;
  }
  if (found) emit('leads', {});
  return found;
}

// Quick check: LinkedIn's own "recently added connections" API, read by the extension in the background
// (no tab, no page). Runs every few minutes, also during a campaign, so acceptances show up right away.
const RECENT_CONNECTIONS = 'https://www.linkedin.com/voyager/api/relationships/dash/connections?decorationId=com.linkedin.voyager.dash.deco.web.mynetwork.ConnectionListWithProfile-16&count=40&q=search&sortType=RECENTLY_ADDED';
// deep: page through up to acceptance_scan_max connections (the "Check acceptances" button), else only the newest 40
async function quickAcceptanceCheck({ deep = false } = {}) {
  const max = deep ? Math.max(40, getSettings().acceptance_scan_max) : 40;
  const conns = [];
  for (let start = 0; start < max; start += 40) {
    if (start) await new Promise((r) => setTimeout(r, 1000 + Math.random() * 1500));
    const res = await bridge.call('apiGet', { url: `${RECENT_CONNECTIONS}&start=${start}` }, 30000);
    if (!res || res.status !== 200 || !res.json) throw new Error(`LinkedIn answered ${res ? res.status : 'nothing'}`);
    const page = (res.json.included || []).filter((x) => x.publicIdentifier)
      .map((x) => ({ vanity: decodeURIComponent(x.publicIdentifier).toLowerCase(), name: `${x.firstName || ''} ${x.lastName || ''}`.trim() }));
    conns.push(...page);
    if (page.length < 20) break; // the end of your connections
  }
  const found = markAccepted(conns);
  setState('last_quick_acceptance', { at: new Date().toLocaleString('sv-SE').replace('T', ' '), scanned: conns.length, found });
  publish();
  return found;
}
function startQuickAcceptancePoll() {
  let busy = false;
  let lastRun = 0;
  setInterval(async () => {
    const mins = getSettings().acceptance_poll_minutes;
    if (!mins || busy || !bridge.isConnected() || Date.now() - lastRun < mins * 60000) return;
    if (!db.prepare("SELECT 1 FROM leads WHERE status = 'sent' AND accepted_at IS NULL LIMIT 1").get()) return;
    busy = true;
    lastRun = Date.now();
    try { await quickAcceptanceCheck(); } catch (e) {
      if (/Unknown command/.test(e.message)) logger.warn('Reload the "LinkedIn Bot" extension (chrome://extensions) for instant acceptance checks');
    } finally { busy = false; }
  }, 30000);
}

/** Reads your recent connections and marks every invited lead found there as accepted. */
async function checkAcceptances() {
  const settings = getSettings();
  logger.info('Checking who accepted your connection notes…');
  const conns = await li.readRecentConnections(settings, wait);
  if (!conns.length) {
    logger.warn('Could not read your connections page – acceptance check skipped');
    return 0;
  }
  const nowTs = new Date().toLocaleString('sv-SE').replace('T', ' ');
  const found = markAccepted(conns);
  setState('last_acceptance_check', { at: nowTs, scanned: conns.length, found });
  logger.info(`Acceptance check done: ${conns.length} recent connections read, ${found} new acceptance(s)`);
  emit('leads', {});
  return found;
}

/** LinkedIn limit hit: put sending on hold for the whole account and tell the dashboard.
 *  Lists keep their Active / Paused state – only you pause a list. */
function holdForLimit(e) {
  const active = db.prepare('SELECT id, name FROM lists WHERE active = 1').all();
  const prev = getState('limit_pause');
  const ids = [...new Set([...(prev ? prev.list_ids : []), ...active.map((l) => l.id)])];
  const info = {
    kind: e.kind,
    reason: e.message,
    at: new Date().toLocaleString('sv-SE').replace('T', ' '),
    list_ids: ids,
    list_names: db.prepare(`SELECT name FROM lists WHERE id IN (${ids.map(() => '?').join(',') || 'NULL'})`).all(...ids).map((l) => l.name),
    sent_today: sentToday(),
  };
  setState('limit_pause', info);
  logger.error(`${e.message}. Sending is on hold until you resume (lists stay Active).`);
  emit('limit_pause', info);
  emit('leads', {});
}

function resumeAfterLimit() {
  if (getState('limit_pause')) logger.info('Sending resumed – press Start to continue the Active lists');
  setState('limit_pause', null);
  publish();
  return getStatus();
}

function dismissLimitPause() {
  setState('limit_pause', null);
  publish();
  return getStatus();
}

function pause() {
  if (state.status !== 'running') return getStatus();
  paused = true;
  state.status = 'paused';
  logger.info('Paused');
  publish();
  return getStatus();
}

function resume() {
  if (state.status !== 'paused') return getStatus();
  paused = false;
  state.status = 'running';
  logger.info('Resumed');
  publish();
  return getStatus();
}

function stop() {
  if (state.status === 'idle') return getStatus();
  stopRequested = true;
  paused = false;
  state.status = 'stopping';
  logger.info('Stopping after current step...');
  publish();
  return getStatus();
}

// When idle, check acceptances every N hours on its own
function startAcceptanceScheduler() {
  setInterval(() => {
    const s = getSettings();
    if (!s.acceptance_check_hours || state.status !== 'idle' || !bridge.isConnected()) return;
    const anySent = db.prepare("SELECT 1 FROM leads WHERE status = 'sent' AND accepted_at IS NULL LIMIT 1").get();
    if (!anySent) return;
    const last = getState('last_acceptance_check');
    if (last && Date.now() - new Date(last.at.replace(' ', 'T')).getTime() < s.acceptance_check_hours * 3600000) return;
    // a failed check is not retried for an hour (each try opens the bot tab group)
    const tried = getState('last_acceptance_try');
    if (tried && Date.now() - tried < 3600000) return;
    setState('last_acceptance_try', Date.now());
    run({ mode: 'accept' }).catch(() => {});
  }, 5 * 60000);
}

// Follow-ups always go out by themselves when due: every 15 minutes, only while the bot
// is idle – a campaign you started is never interrupted, and it sends the due follow-ups first anyway.
// Lost internet / Chrome: these errors end a run, which then resumes by itself (startResumeWatcher)
const CONNECTION_ERROR = /did not respond|not connected|disconnected|failed to fetch|network|ERR_INTERNET|ERR_NAME|ERR_CONNECTION|ETIMEDOUT|ENOTFOUND|showing error page|Tabs cannot be edited/i;

/** true when linkedin.com answers (the Mac is online) */
async function online() {
  try {
    const r = await fetch('https://www.linkedin.com/robots.txt', { method: 'HEAD', signal: AbortSignal.timeout(10000) });
    return r.status > 0;
  } catch { return false; }
}

// Every minute: a run that a lost connection ended starts again once everything is back (for up to 12 hours)
function startResumeWatcher() {
  setInterval(async () => {
    const r = getState('resume_run');
    if (!r) return;
    if (Date.now() - r.since > 12 * 3600000) { setState('resume_run', null); return; }
    if (state.status !== 'idle' || !bridge.isConnected() || require('./jobApplier').isBusy() || safety.cooldown()) return;
    if (!(await online())) return;
    setState('resume_run', null);
    logger.info('Connection is back – starting the run again');
    run({ mode: r.mode, listIds: r.listIds }).catch((e) => logger.warn(`Could not start again: ${e.message}`));
  }, 60000);
}

function startFollowupScheduler() {
  setInterval(() => {
    const s = getSettings();
    if (state.status !== 'idle' || !bridge.isConnected() || prospectRunner.getStatus().status !== 'idle' || require('./jobApplier').isBusy()) return;
    if (safety.cooldown() || !safety.inWorkingHours(s) || followupsToday() >= s.followup_daily_limit) return;
    const due = dueFollowups();
    if (!due.length) return;
    logger.info(`${due.length} follow-up(s) due – sending them now`);
    run({ mode: 'followups' }).catch((e) => logger.warn(`Automatic follow-ups not started: ${e.message}`));
  }, 15 * 60000);
  // your chats into the CRM: the inbox every 30 min while the bot is idle (the newest 40 chats; 100 the first time)
  setInterval(() => {
    crmDigest();
    const s = getSettings();
    if (!s.crm_inbox_auto || state.status !== 'idle' || !bridge.isConnected() || prospectRunner.getStatus().status !== 'idle' || require('./jobApplier').isBusy() || safety.cooldown()) return;
    const last = getState('inbox_scan');
    if (last && Date.now() - new Date(String(last.at).replace(' ', 'T')).getTime() < 30 * 60000) return;
    run({ mode: 'inbox', maxLeads: last ? 40 : 100 }).catch((e) => logger.warn(`Inbox not read: ${e.message}`));
  }, 5 * 60000);
}

/** Once a day (from 9 PM, or the next morning if the Mac was asleep): how many people went into the CRM by themselves */
function crmDigest() {
  const today = new Date().toLocaleString('sv-SE').slice(0, 10);
  let log = getState('crm_added');
  if (!log || (log.notified && log.day < today)) log = { day: today, names: [], notified: false }; // a new day
  if (log.notified || (log.day === today && new Date().getHours() < 21)) return;
  const { day, names = [] } = log;
  const title = `${names.length} lead${names.length === 1 ? '' : 's'} added to the CRM ${day === today ? 'today' : `on ${day}`}`;
  notify.macNotification('LinkedIn Bot – CRM', names.length ? `${title}: ${names.slice(0, 5).join(', ')}${names.length > 5 ? '…' : ''}` : title);
  notify.telegram(`📇 ${title}${names.length ? `\n\n${names.map((n, i) => `${i + 1}. ${n}`).join('\n')}` : ''}`).catch((e) => logger.warn(`Telegram message failed: ${e.message}`));
  logger.info(`CRM summary: ${title}`);
  setState('crm_added', { day, names, notified: true });
}

prospectRunner.setCampaignBusy(() => state.status !== 'idle' && ['connect', 'direct', 'followups', 'replies'].includes(state.mode));

module.exports = { CONNECTION_ERROR, online, startResumeWatcher, dueFollowups, nextFollowup, followupsToday, sentToday, startFollowupScheduler, startQuickAcceptancePoll, quickAcceptanceCheck, startAcceptanceScheduler, run, pause, resume, stop, getStatus, resumeAfterLimit, dismissLimitPause, dailyShares, listSentToday, MAX_DAILY };
