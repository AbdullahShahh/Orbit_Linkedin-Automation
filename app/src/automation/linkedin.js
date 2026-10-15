// High-level LinkedIn steps, executed in your own Chrome by the extension.
// Mirrors the recorded workflow:
//  Sales Navigator saved search / lead list (your LinkedIn tab) -> lead -> LinkedIn profile in a
//  new tab -> Connect (or More -> Connect for 3rd degree) -> Add a note -> paste -> Send -> close tab
const bridge = require('./bridge');

class LimitReachedError extends Error {
  constructor(message, kind = 'weekly') {
    super(message);
    this.kind = kind; // 'weekly' | 'notes'
  }
}

/** Picks the tab where LinkedIn is open (active LinkedIn tab first). Returns { tabId, url, loggedIn }. */
const useWorkTab = () => bridge.call('useWorkTab');

async function openList(url, settings, dwell) {
  await bridge.call('navigate', { tab: 'work', url, settle: settings.page_load_wait });
  if (dwell) await dwell(settings.tab_wait_min, 'Viewing the list');
  await bridge.call('exec', { tab: 'work', action: 'waitFor', args: ['a[href*="/sales/lead/"]', 25000] });
  const { url: now } = await bridge.call('tabInfo', { tab: 'work' });
  if (/\/(login|checkpoint|authwall)/.test(now)) throw new Error('Not logged in to LinkedIn in this tab');
}

async function scrapeCurrentPage() {
  await bridge.call('exec', { tab: 'work', action: 'scrollResults' });
  return bridge.call('exec', { tab: 'work', action: 'extractLeads' });
}

const goNextPage = (settings) =>
  bridge.call('exec', { tab: 'work', action: 'goNextPage', args: [settings.page_load_wait * 1000] });

/**
 * Opens the lead in a new tab (like opening the profile from the Sales Nav panel in the video),
 * resolves the linkedin.com/in/ URL, connects with the note, closes the tab.
 *  dwell(seconds, reason): interruptible wait provided by the runner (shows a countdown on the dashboard)
 * Returns 'sent' | 'dry_run' | 'already_connected' | 'pending_invite' | 'email_required' | 'no_connect' | 'note_limit' | ...
 */
async function connectLead(lead, note, settings, { onProfileUrl, dwell, onDebug }) {
  const settle = settings.page_load_wait;
  const started = Date.now();
  const tabWait = () => settings.tab_wait_min + Math.random() * Math.max(0, settings.tab_wait_max - settings.tab_wait_min);
  let profileUrl = lead.profile_url;

  await bridge.call('openTab', { url: profileUrl || lead.sales_url || `https://www.linkedin.com/in/${lead.sales_id}/`, settle });
  try {
    await dwell(tabWait(), `Viewing ${lead.name}`);

    if (!profileUrl) {
      const { url } = await bridge.call('tabInfo', { tab: 'job' });
      if (/\/sales\/lead\//.test(url)) {
        profileUrl = await bridge.call('exec', { tab: 'job', action: 'findProfileUrl' });
      } else if (/linkedin\.com\/in\//.test(url)) {
        profileUrl = url.split('?')[0];
      }
      if (!profileUrl) profileUrl = `https://www.linkedin.com/in/${lead.sales_id}/`;
      onProfileUrl(profileUrl);
      await bridge.call('navigate', { tab: 'job', url: profileUrl, settle });
      await dwell(tabWait(), `Viewing ${lead.name}'s LinkedIn profile`);
    }

    const result = await invite(lead, note, settings, onDebug);

    // Stay on the profile until the minimum time per profile has passed
    const left = settings.profile_min_seconds - (Date.now() - started) / 1000;
    if (left > 0) await dwell(left, `Staying on ${lead.name}'s profile`);
    return result;
  } finally {
    await bridge.call('closeTab', { tab: 'job' }).catch(() => {});
  }
}

async function invite(lead, note, settings, onDebug) {
  const debug = async (why) => {
    const snap = await bridge.call('exec', { tab: 'job', action: 'snapshot' }).catch(() => null);
    if (snap) onDebug(why, snap);
  };

  let opened;
  try {
    opened = await bridge.call('exec', { tab: 'job', action: 'openInvite', args: [lead.name] }, 60000);
  } catch (e) {
    await debug(`openInvite error: ${e.message}`);
    throw e;
  }
  if (opened === 'no_connect') await debug('Connect button not found');
  if (opened && opened !== 'opened') return opened;
  // null = the Connect link navigated the page (custom-invite route); the dialog is on the new page
  if (opened === null) await new Promise((r) => setTimeout(r, settings.page_load_wait * 1000));

  let result;
  try {
    result = await bridge.call('exec', { tab: 'job', action: 'fillInvite', args: [note, { dryRun: !!settings.dry_run }] }, 90000);
  } catch (e) {
    await debug(`fillInvite error: ${e.message}`);
    throw e;
  }
  if (result === 'weekly_limit') throw new LimitReachedError('LinkedIn weekly invitation limit reached');
  if (!['sent', 'dry_run', 'email_required', 'note_limit'].includes(result)) await debug(`Invite dialog: ${result}`);
  return result || 'no_dialog';
}

/** Reads your most recent connections (My Network -> Connections, recently added first). */
async function readRecentConnections(settings, dwell) {
  await bridge.call('openTab', { url: 'https://www.linkedin.com/mynetwork/invite-connect/connections/', settle: settings.page_load_wait });
  try {
    await dwell(settings.tab_wait_min, 'Opening your connections page');
    return (await bridge.call('exec', { tab: 'job', action: 'scrapeConnections', args: [settings.acceptance_scan_max] }, 300000)) || [];
  } finally {
    await bridge.call('closeTab', { tab: 'job' }).catch(() => {});
  }
}

module.exports = { readRecentConnections, useWorkTab, openList, scrapeCurrentPage, goNextPage, connectLead, LimitReachedError };
