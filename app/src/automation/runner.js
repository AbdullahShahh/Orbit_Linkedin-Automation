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
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../db');
const DEBUG_DIR = path.join(DATA_DIR, 'debug');

const state = {
  status: 'idle', // idle | running | paused | stopping
  mode: null, // 'connect' | 'sync'
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

function getStatus() {
  const s = getSettings();
  return { ...state, lastRun: state.lastRun || getState('last_run'), lastAcceptanceCheck: getState('last_acceptance_check'), limitPause: getState('limit_pause'), sentToday: sentToday(), dailyLimit: s.daily_limit, runLimit: s.run_limit, extension: bridge.isConnected() };
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

const upsertLead = db.prepare(`
  INSERT INTO leads (list_id, sales_id, name, first_name, title, company, location, degree, sales_url)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(sales_id) DO UPDATE SET
    title = COALESCE(NULLIF(excluded.title,''), leads.title),
    company = COALESCE(NULLIF(excluded.company,''), leads.company),
    degree = COALESCE(NULLIF(excluded.degree,''), leads.degree),
    updated_at = datetime('now','localtime')
`);

const MAX_DAILY = 100;

function listSentToday(listId) {
  return db
    .prepare("SELECT COUNT(*) c FROM leads WHERE list_id = ? AND status = 'sent' AND date(sent_at) = date('now','localtime')")
    .get(listId).c;
}

/** Daily limit split equally over the currently active lists ({ listId: share }); leftover goes to the oldest lists. */
function dailyShares() {
  const limit = Math.min(getSettings().daily_limit, MAX_DAILY);
  const active = db.prepare('SELECT id FROM lists WHERE active = 1 ORDER BY id').all();
  if (!active.length) return {};
  const base = Math.floor(limit / active.length);
  const extra = limit % active.length;
  return Object.fromEntries(active.map((l, i) => [l.id, base + (i < extra ? 1 : 0)]));
}

function sentSinceOn(list) {
  return db.prepare("SELECT COUNT(*) c FROM leads WHERE list_id = ? AND status = 'sent' AND sent_at >= ?").get(list.id, list.activated_at || '').c;
}

// Leads already handled in this run (dry-run leads stay "pending", so they must not be picked again)
const seenThisRun = new Set();

function pendingFor(listId) {
  const skip = [...seenThisRun];
  return db
    .prepare(`SELECT * FROM leads WHERE list_id = ? AND status = 'pending'
              ${skip.length ? `AND id NOT IN (${skip.map(() => '?').join(',')})` : ''} ORDER BY id LIMIT 1`)
    .get(listId, ...skip);
}

/** Scrape list pages until `need` new leads are found (or the list ends). */
async function syncList(list, need = Infinity) {
  const settings = getSettings();
  logger.info(`Opening list "${list.name}"`, { list_id: list.id });
  await li.openList(list.url, settings, wait);

  let added = 0;
  let pageNo = 1;
  for (;;) {
    await checkpoint();
    const leads = await li.scrapeCurrentPage();
    let newOnPage = 0;
    for (const l of leads) {
      const exists = db.prepare('SELECT id FROM leads WHERE sales_id = ?').get(l.sales_id);
      const v = (x) => (x == null ? '' : String(x));
      upsertLead.run(list.id, v(l.sales_id), v(l.name), cleanName(l.name).first_name, v(l.title), v(l.company), v(l.location), v(l.degree), v(l.sales_url));
      if (!exists) newOnPage++;
    }
    added += newOnPage;
    logger.info(`Page ${pageNo}: ${leads.length} leads found, ${newOnPage} new`, { list_id: list.id });
    emit('leads', { list_id: list.id });

    if (added >= need || pageNo >= list.max_pages) break;
    if (!leads.length) break;
    const moved = await li.goNextPage(settings);
    if (!moved) break;
    pageNo++;
  }
  db.prepare("UPDATE lists SET last_synced_at = datetime('now','localtime') WHERE id = ?").run(list.id);
  logger.success(`List "${list.name}" synced: ${added} new leads`, { list_id: list.id });
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
    if (e instanceof li.LimitReachedError || e instanceof StopSignal || e instanceof NoNotesError) throw e;
    setLead(lead.id, { status: 'skipped', error: String(e.message || e).slice(0, 300), attempts: lead.attempts + 1 });
    logger.warn(`${lead.name}: skipped – ${e.message}. Moving to the next lead (no retry).`, ctx);
    return 'skip';
  }
}

async function run({ listIds, mode = 'connect' } = {}) {
  if (state.status !== 'idle') throw new Error('Already running');
  stopRequested = false;
  paused = false;
  Object.assign(state, { status: 'running', mode, current: null, wait: null, sentThisRun: 0, startedAt: new Date().toISOString() });
  seenThisRun.clear();
  if (mode === 'connect') {
    state.lastRun = { startedAt: state.startedAt, byList: {} };
    setState('last_run', state.lastRun);
  }
  publish();

  let runLists = [];
  (async () => {
    try {
      const tab = await li.useWorkTab();
      if (!tab.loggedIn) throw new Error('LinkedIn is not logged in in your Chrome. Log in, then start again.');
      logger.info(`Using the bot window tab: ${tab.url.slice(0, 80)}`);

      if (mode === 'accept') {
        await checkAcceptances();
        return;
      }

      let lists = db.prepare('SELECT * FROM lists WHERE active = 1 ORDER BY id').all();
      if (listIds && listIds.length) lists = lists.filter((l) => listIds.includes(l.id));
      runLists = lists;
      if (!lists.length) throw new Error('No active lists selected');

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
        logger.info(
          `▶ List "${list.name}" using message type "${type.name}"` +
            (list.send_limit ? ` – limit ${list.send_limit} notes (${sentSinceOn(list)} sent so far)` : ''),
          { list_id: list.id }
        );
        // How many new leads the last sync found (null = not synced yet this run). The saved search
        // can exclude "Viewed profile", so people we visit drop out and a fresh sync shows new ones –
        // keep re-syncing while that still brings new leads.
        let lastSyncAdded = null;

        for (;;) {
          await checkpoint();
          const s = getSettings();
          const fresh = db.prepare('SELECT * FROM lists WHERE id = ?').get(list.id);
          if (!fresh || !fresh.active) {
            logger.info(`List "${list.name}" was turned off, moving on`, { list_id: list.id });
            noteStop(list.id, 'info', 'List was turned OFF during the run');
            break;
          }
          if (fresh.send_limit > 0 && sentSinceOn(fresh) >= fresh.send_limit) {
            db.prepare('UPDATE lists SET active = 0 WHERE id = ?').run(list.id);
            emit('leads', { list_id: list.id });
            logger.success(`List "${list.name}": limit of ${fresh.send_limit} connection notes reached – list turned OFF`, { list_id: list.id });
            noteStop(list.id, 'done', `Limit of ${fresh.send_limit} notes reached ✓ – list turned OFF`);
            break;
          }
          if (sentToday() >= Math.min(s.daily_limit, MAX_DAILY)) {
            logger.warn(`Daily limit reached (${s.daily_limit}). Stopping.`);
            noteRunEnd('limit', `Daily limit of ${s.daily_limit} notes reached – continues tomorrow (change it in Settings)`);
            return;
          }
          const share = dailyShares()[list.id] ?? 0;
          if (listSentToday(list.id) >= share) {
            logger.info(`List "${list.name}": today's share of ${share} notes is done (daily ${s.daily_limit} ÷ active lists)`, { list_id: list.id });
            noteStop(list.id, 'limit', `Today's share of ${share} notes is done (daily limit ${s.daily_limit} ÷ active lists) – continues tomorrow`);
            break;
          }
          if (state.sentThisRun >= s.run_limit) {
            logger.warn(`Run limit reached (${s.run_limit}). Stopping.`);
            noteRunEnd('limit', `Per-run limit of ${s.run_limit} notes reached – press Start again to continue (change it in Settings)`);
            return;
          }

          let lead = pendingFor(list.id);
          if (!lead && lastSyncAdded !== 0) {
            const remaining = Math.min(
              fresh.send_limit > 0 ? fresh.send_limit - sentSinceOn(fresh) : Infinity,
              share - listSentToday(list.id)
            );
            lastSyncAdded = await syncList(list, Math.max(Math.min(s.run_limit - state.sentThisRun, remaining), 10));
            lead = pendingFor(list.id);
          }
          if (!lead) {
            if (fresh.send_limit > 0) {
              logger.warn(
                `"${list.name}": Sales Navigator search has no new people left – ${sentSinceOn(fresh)} of ${fresh.send_limit} notes sent. ` +
                  `Widen the search filters (or raise "Max pages to scan") to reach the limit.`,
                { list_id: list.id }
              );
              noteStop(list.id, 'warn', `Sales Navigator search has no new people left – only ${sentSinceOn(fresh)} of ${fresh.send_limit} notes sent. Widen the search filters.`);
            } else {
              logger.info(`No more pending leads in "${list.name}"`, { list_id: list.id });
              noteStop(list.id, 'warn', 'Sales Navigator search has no new people left – widen the search filters to get more leads');
            }
            break;
          }

          seenThisRun.add(lead.id);
          let outcome;
          try {
            outcome = await processLead(list, lead, type);
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
      } else if (e instanceof li.LimitReachedError) {
        pauseAllForLimit(e);
        noteRunEnd('limit', `${e.message} – all campaigns paused`);
      } else {
        logger.error(`Run failed: ${e.message}`);
        noteRunEnd('error', `Run failed: ${e.message}`);
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
      Object.assign(state, { status: 'idle', mode: null, current: null, wait: null });
      logger.info(`Run finished. Sent this run: ${state.sentThisRun}`);
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

/** Reads your recent connections and marks every invited lead found there as accepted. */
async function checkAcceptances() {
  const settings = getSettings();
  logger.info('Checking who accepted your connection notes…');
  const conns = await li.readRecentConnections(settings, wait);
  if (!conns.length) {
    logger.warn('Could not read your connections page – acceptance check skipped');
    return 0;
  }
  const have = new Set(conns.map((c) => c.vanity));
  const normName = (s) => cleanName(s).full_name.toLowerCase();
  const names = new Set(conns.map((c) => normName(String(c.name).split(/\n| {2,}/)[0])).filter((n) => n.includes(' ')));
  const waiting = db.prepare("SELECT id, name, list_id, profile_url FROM leads WHERE status = 'sent' AND accepted_at IS NULL").all();
  const nowTs = new Date().toLocaleString('sv-SE').replace('T', ' ');
  let found = 0;
  for (const l of waiting) {
    const v = vanityOf(l.profile_url);
    const byLink = v && !/^ac[ow]aa/i.test(v) && have.has(v);
    // Fallback for links like /in/ACwAA… (no readable name): match on full name
    const byName = !byLink && (!v || /^ac[ow]aa/i.test(v)) && names.has(normName(l.name));
    if (!byLink && !byName) continue;
    db.prepare('UPDATE leads SET accepted_at = ? WHERE id = ?').run(nowTs, l.id);
    emit('lead', { id: l.id, accepted_at: nowTs });
    logger.success(`${l.name} accepted your connection note 🎉`, { list_id: l.list_id, lead_id: l.id });
    found++;
  }
  setState('last_acceptance_check', { at: nowTs, scanned: conns.length, found });
  logger.info(`Acceptance check done: ${conns.length} recent connections read, ${found} new acceptance(s)`);
  emit('leads', {});
  return found;
}

/** LinkedIn limit hit: turn every active list OFF, remember which ones, tell the dashboard. */
function pauseAllForLimit(e) {
  const active = db.prepare('SELECT id, name FROM lists WHERE active = 1').all();
  const prev = getState('limit_pause');
  const ids = [...new Set([...(prev ? prev.list_ids : []), ...active.map((l) => l.id)])];
  db.prepare('UPDATE lists SET active = 0 WHERE active = 1').run();
  const info = {
    kind: e.kind,
    reason: e.message,
    at: new Date().toLocaleString('sv-SE').replace('T', ' '),
    list_ids: ids,
    list_names: db.prepare(`SELECT name FROM lists WHERE id IN (${ids.map(() => '?').join(',') || 'NULL'})`).all(...ids).map((l) => l.name),
    sent_today: sentToday(),
  };
  setState('limit_pause', info);
  logger.error(`${e.message}. All campaigns paused (${info.list_names.length} list(s) turned OFF).`);
  emit('limit_pause', info);
  emit('leads', {});
}

function resumeAfterLimit() {
  const info = getState('limit_pause');
  if (info && info.list_ids.length) {
    // activated_at is kept, so each list's round limit continues where it was
    db.prepare(`UPDATE lists SET active = 1 WHERE id IN (${info.list_ids.map(() => '?').join(',')})`).run(...info.list_ids);
    logger.info(`Campaigns resumed: ${info.list_names.join(', ')}`);
  }
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
    run({ mode: 'accept' }).catch(() => {});
  }, 5 * 60000);
}

module.exports = { startAcceptanceScheduler, run, pause, resume, stop, getStatus, resumeAfterLimit, dismissLimitPause, dailyShares, listSentToday, MAX_DAILY };
