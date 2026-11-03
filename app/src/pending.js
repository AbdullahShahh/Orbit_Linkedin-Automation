// Dashboard "Waiting for you": what the bot still has to do today or waits on you for, each with a
// Yes (run it) / No (not today) button, plus a Mac notification when something new waits.
// And "Daily report": what happened each day (computed from the data, so it is always up to date).
const { db, getSettings, getState, setState } = require('./db');
const { logger } = require('./logger');
const bridge = require('./automation/bridge');
const safety = require('./automation/safety');
const notify = require('./automation/notify');

// required when used: runner.js loads this module's neighbours, so no import cycle at start-up
const runner = () => require('./automation/runner');
const prospectRunner = () => require('./automation/prospectRunner');
const jobApplier = () => require('./automation/jobApplier');

const today = () => new Date().toLocaleDateString('sv-SE');
const count = (sql, ...a) => db.prepare(sql).get(...a).c;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** One row per day, newest first */
function dailyReport(days = 7) {
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const day = d.toLocaleDateString('sv-SE');
    out.push({
      day,
      notes: count("SELECT COUNT(*) c FROM leads WHERE status = 'sent' AND date(sent_at) = ?", day),
      accepted: count('SELECT COUNT(*) c FROM leads WHERE date(accepted_at) = ?', day),
      followups: count('SELECT COUNT(*) c FROM followups_sent WHERE date(sent_at) = ?', day),
      replies: count('SELECT COUNT(*) c FROM leads WHERE date(replied_at) = ?', day),
      crm: count("SELECT COUNT(*) c FROM leads WHERE status = 'crm' AND date(created_at) = ?", day),
      meetings: count("SELECT COUNT(*) c FROM leads WHERE crm_stage = 'meeting' AND date(crm_stage_at) = ?", day),
      jobs: count("SELECT COUNT(*) c FROM job_apps WHERE status = 'applied' AND date(applied_at) = ?", day),
    });
  }
  return out;
}

const dismissed = () => {
  const d = getState('pending_dismissed');
  return d && d.day === today() ? d.ids : [];
};

/**
 * [{ id, kind: 'todo' | 'you' | 'warn' | 'info' | 'running', title, detail, action?: { label, run }, stop?, link? }]
 * 'you' = only you can do it (answer, review) · 'todo' = the bot can do it now if you say yes
 */
function items() {
  const s = getSettings();
  const r = runner();
  const out = [];
  const st = r.getStatus();
  const ps = prospectRunner().getStatus();
  const js = jobApplier().getStatus();

  // running now – can be stopped
  if (st.status !== 'idle') {
    const what = { connect: 'Sending connection notes', followups: 'Sending follow-ups', accept: 'Checking acceptances', inbox: 'Reading your inbox', sync: 'Syncing leads', replies: 'Checking replies', photos: 'Refreshing photos' }[st.mode] || 'Working';
    out.push({ id: 'run', kind: 'running', title: what, detail: st.current?.lead ? `now: ${st.current.lead.name}` : st.wait ? st.wait.reason : '', stop: 'runner' });
  }
  if (ps.status !== 'idle') out.push({ id: 'prospect', kind: 'running', title: 'Finding prospects', detail: ps.current?.step || '', stop: 'prospect' });
  if (js.status !== 'idle') out.push({ id: 'jobs_run', kind: 'running', title: js.test ? 'Job applier test' : 'Applying to jobs', detail: js.current?.step || '', stop: 'jobs' });

  if (!bridge.isConnected()) out.push({ id: 'extension', kind: 'warn', title: 'Chrome extension not connected', detail: 'Open Chrome – nothing can run until the "LinkedIn Bot" extension connects' });
  const cool = safety.cooldown();
  if (cool) out.push({ id: 'cooldown', kind: 'warn', title: `Paused for account safety until ${cool.until}`, detail: cool.reason });

  // follow-ups
  const due = r.dueFollowups();
  const fToday = r.followupsToday();
  if (due.length) {
    const capped = fToday >= s.followup_daily_limit;
    out.push({
      id: 'followups', kind: capped ? 'info' : 'todo', title: `${plural(due.length, 'follow-up')} due`,
      detail: capped ? `today's limit of ${s.followup_daily_limit} is reached – they go out tomorrow` : st.status === 'idle' ? 'they go out by themselves within 15 minutes' : 'they go out before the next connection note',
      action: capped || st.status !== 'idle' ? null : { label: 'Send now', run: 'followups' },
    });
  } else {
    const next = r.nextFollowup();
    if (next) out.push({ id: 'followups_next', kind: 'info', title: `Next follow-up: ${next.at.slice(5, 16).replace('T', ' ')}`, detail: `${next.name} – sent by itself when due` });
  }

  // connection notes
  const lists = db.prepare('SELECT * FROM lists WHERE active = 1').all();
  if (lists.length) {
    const block = safety.sendBlock(s);
    const left = Math.max(0, Math.min(s.daily_limit, r.MAX_DAILY) - r.sentToday());
    if (block) out.push({ id: 'notes_hold', kind: 'warn', title: 'Connection notes on hold', detail: block });
    else if (left && st.status === 'idle') out.push({ id: 'notes', kind: 'todo', title: `${plural(left, 'connection note')} left for today`, detail: `${plural(lists.length, 'active list')} – starts when you say yes`, action: { label: 'Start', run: 'connect' } });
    const review = count("SELECT COUNT(*) c FROM leads WHERE status = 'review'");
    if (review) out.push({ id: 'review', kind: 'you', title: `${plural(review, 'lead')} ${review === 1 ? 'waits' : 'wait'} for your review`, detail: 'approve the ones you want on the Leads page', link: '/#leads' });
  }

  // acceptances not checked for a long time
  const lastAcc = getState('last_acceptance_check');
  if (st.status === 'idle' && (!lastAcc || Date.now() - new Date(String(lastAcc.at).replace(' ', 'T')).getTime() > Math.max(2, s.acceptance_check_hours * 2) * 3600000)) {
    out.push({ id: 'accept', kind: 'todo', title: 'Acceptances not checked for a while', detail: lastAcc ? `last check ${lastAcc.at.slice(0, 16)}` : 'never checked', action: { label: 'Check now', run: 'accept' } });
  }

  // job applications
  const questions = count("SELECT COUNT(*) c FROM job_answers WHERE answer = ''");
  if (questions) out.push({ id: 'job_questions', kind: 'you', title: `${plural(questions, 'job form question')} to answer`, detail: (() => { const n = count("SELECT COUNT(*) c FROM job_apps WHERE status = 'needs_answers'"); return `${plural(n, 'job')} ${n === 1 ? 'waits' : 'wait'} for your answers`; })(), link: '/jobs#jobs' });
  const applied = js.appliedToday;
  if (applied < s.jobs_daily && js.status === 'idle') {
    out.push({
      id: 'jobs', kind: 'todo', title: `${plural(s.jobs_daily - applied, 'job application')} left for today`,
      detail: s.jobs_auto ? (s.jobs_run_at ? `applies by itself from ${s.jobs_run_at}` : 'applies by itself when the bot is free') : 'daily applying is off – applies when you say yes',
      action: st.status === 'idle' ? { label: 'Apply now', run: 'jobs' } : null,
    });
  }

  const no = dismissed();
  return out.filter((i) => i.kind === 'running' || !no.includes(i.id));
}

function dismiss(id) {
  const ids = dismissed();
  setState('pending_dismissed', { day: today(), ids: [...new Set([...ids, id])] });
}

function runItem(id) {
  const r = runner();
  if (id === 'followups') return r.run({ mode: 'followups' });
  if (id === 'notes') return r.run({ mode: 'connect' });
  if (id === 'accept') return r.run({ mode: 'accept' });
  if (id === 'jobs') {
    if (r.getStatus().status !== 'idle') throw new Error('A campaign is running – the job applier starts when it is done');
    return jobApplier().start({ reason: 'started from the dashboard' });
  }
  throw new Error('Nothing to run for this item');
}

function stopItem(which) {
  if (which === 'runner') return runner().stop();
  if (which === 'prospect') return prospectRunner().stop();
  if (which === 'jobs') return jobApplier().stop();
  throw new Error('Unknown task');
}

// Mac notification when something new waits for you (again every 3 hours if it still waits, 9:00–23:00 only)
function startNotifier() {
  setInterval(() => {
    try {
      const h = new Date().getHours();
      if (h < 9 || h >= 23) return;
      const list = items().filter((i) => ['todo', 'you', 'warn'].includes(i.kind));
      const last = getState('pending_notified') || { ids: [], at: 0 };
      if (!list.length) { if (last.ids.length) setState('pending_notified', { ids: [], at: 0 }); return; }
      const ids = list.map((i) => i.id);
      const fresh = ids.some((id) => !last.ids.includes(id));
      if (!fresh && Date.now() - last.at < 3 * 3600000) return;
      notify.macNotification('LinkedIn Bot – waiting for you', list.slice(0, 3).map((i) => i.title).join(' · ') + (list.length > 3 ? ` · +${list.length - 3} more` : '') + ' – open the dashboard to say yes or no');
      setState('pending_notified', { ids, at: Date.now() });
    } catch (e) {
      logger.warn(`Pending check failed: ${e.message}`);
    }
  }, 5 * 60000);
}

module.exports = { items, dailyReport, dismiss, runItem, stopItem, startNotifier };
