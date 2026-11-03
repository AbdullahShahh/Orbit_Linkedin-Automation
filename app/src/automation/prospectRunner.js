// The prospect finder's own runner, separate from campaigns (runner.js), so connection notes can be
// sent while jobs / posts are being found. It has its own status, pause and stop, and its own bot
// tabs ('pwork' + 'pjob'); jobs and the post search need no tab at all with a current extension.
const { spawn } = require('child_process');
const { getSettings, getState, setState } = require('../db');
const { logger, emit } = require('../logger');
const bridge = require('./bridge');
const prospector = require('./prospector');
const safety = require('./safety');
const notify = require('./notify');

const state = { status: 'idle', current: null, wait: null, startedAt: null };
let stopRequested = false;
let paused = false;
let campaignBusy = () => false; // set by runner.js (whether a campaign is sending right now)

const getStatus = () => ({ ...state, mode: state.status === 'idle' ? null : 'prospect' });
const publish = () => emit('prospect_status', getStatus());

class StopSignal extends Error {}

async function checkpoint() {
  while (paused && !stopRequested) await new Promise((r) => setTimeout(r, 500));
  if (stopRequested) throw new StopSignal();
}

async function wait(seconds, reason) {
  const until = Date.now() + seconds * 1000;
  state.wait = { until, seconds: Math.round(seconds), reason };
  publish();
  while (Date.now() < until) {
    if (stopRequested) break;
    if (paused) {
      const left = until - Date.now();
      await checkpoint();
      return wait(left / 1000, reason);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  state.wait = null;
  publish();
  await checkpoint();
}

const closeOwnTabs = () => bridge.call('closeTabs', { roles: [prospector.TABS.work, prospector.TABS.job] }).catch(() => {});

/** Starts the prospect searches (all ON ones, or the given ids) – while a campaign may be running */
function start(searchIds = []) {
  if (state.status !== 'idle') throw new Error('The prospect finder is already running');
  const cool = safety.cooldown() || safety.cooldown('prospects');
  if (cool) throw new Error(`Paused for account safety until ${cool.until}: ${cool.reason}`);
  if (!bridge.isConnected()) throw new Error('Chrome extension not connected. Open Chrome and make sure the "LinkedIn Bot" extension is enabled.');
  stopRequested = false;
  paused = false;
  Object.assign(state, { status: 'running', current: null, wait: null, startedAt: new Date().toISOString() });
  publish();
  let awake = null;
  try { awake = spawn('caffeinate', ['-i'], { stdio: 'ignore' }); awake.on('error', () => {}); } catch { awake = null; }
  (async () => {
    const since = new Date().toLocaleString('sv-SE').replace('T', ' ');
    try {
      const setStep = (search, step) => {
        state.current = { search: search.label || search.name, searchId: search.id, step, done: search.done, total: search.total };
        publish();
      };
      await prospector.runSearches(searchIds, { wait, checkpoint, setStep, campaignBusy: () => campaignBusy() });
      await notify.prospectDigest(since).catch((e) => logger.warn(`Notification failed: ${e.message}`));
    } catch (e) {
      if (e instanceof StopSignal) logger.warn('Prospect search stopped');
      else if (e instanceof safety.RestrictedError || e instanceof safety.RateLimitError) {
        if (e.publicOnly) {
          const c = safety.startCooldown(e.hours || 1, e.message, 'prospects');
          logger.warn(`${e.message} – the prospect finder waits until ${c.until} (your account is fine – Outreach keeps working)`);
        } else {
          const c = safety.startCooldown(e.hours || getSettings().safety_cooldown_hours, e.message);
          logger.error(`${e.message} – the bot pauses everything until ${c.until} to protect your account`);
        }
      } else logger.error(`Prospect search failed: ${e.message}`);
    } finally {
      if (awake) awake.kill();
      if (bridge.isConnected()) await closeOwnTabs();
      Object.assign(state, { status: 'idle', current: null, wait: null });
      publish();
    }
  })();
  return getStatus();
}

function pause() {
  if (state.status !== 'running') return getStatus();
  paused = true;
  state.status = 'paused';
  logger.info('Prospect search paused');
  publish();
  return getStatus();
}
function resume() {
  if (state.status !== 'paused') return getStatus();
  paused = false;
  state.status = 'running';
  logger.info('Prospect search resumed');
  publish();
  return getStatus();
}
function stop() {
  if (state.status === 'idle') return getStatus();
  stopRequested = true;
  paused = false;
  state.status = 'stopping';
  publish();
  return getStatus();
}

// Settings → "Run all ON searches every day at": once a day at that time (also during a campaign)
function startSchedule() {
  setInterval(() => {
    const at = String(getSettings().prospect_auto_run_at || '').trim();
    const m = at.match(/^(\d{1,2}):(\d{2})$/);
    if (!m || state.status !== 'idle' || !bridge.isConnected()) return;
    const now = new Date();
    const today = now.toLocaleDateString('sv-SE');
    if (getState('last_auto_prospect') === today) return;
    if (now.getHours() * 60 + now.getMinutes() < Number(m[1]) * 60 + Number(m[2])) return;
    setState('last_auto_prospect', today);
    logger.info(`Daily prospect run (set for ${at}) starting`);
    try { start(); } catch (e) { logger.warn(`Daily prospect run could not start: ${e.message}`); }
  }, 60000);
}

const isBusy = () => state.status !== 'idle';
const setCampaignBusy = (fn) => { campaignBusy = fn; };

module.exports = { start, pause, resume, stop, getStatus, startSchedule, isBusy, setCampaignBusy };
