// High-level LinkedIn steps, executed in your own Chrome by the extension.
// Mirrors the recorded workflow:
//  Sales Navigator saved search / lead list (your LinkedIn tab) -> lead -> LinkedIn profile in a
//  new tab -> Connect (or More -> Connect for 3rd degree) -> Add a note -> paste -> Send -> close tab
const bridge = require('./bridge');
const { RestrictedError } = require('./safety');

/** Stops everything if LinkedIn shows a security check / restriction page in this tab */
async function assertSafe(tab) {
  const seen = await bridge.call('exec', { tab, action: 'securityCheck' }, 30000).catch(() => '');
  if (seen) throw new RestrictedError(`LinkedIn showed a security / restriction page: "${seen}"`);
}

// What Sales Navigator shows once the subscription has ended (upgrade / reactivate / free trial pages)
const NO_SALES_NAV = /(subscription (has )?(ended|expired|been cancell?ed)|reactivate (your )?(sales navigator|subscription|account|plan)|start (your |a )?free trial|try (sales navigator|premium) (for )?free|upgrade to sales navigator|unlock sales navigator|(choose|select) (your |a )?plan|get sales navigator)/i;

/** Sales Navigator subscription ended: every campaign stops until it works again */
class SubscriptionError extends Error {
  constructor(message = 'Your Sales Navigator subscription has ended') {
    super(message);
    this.kind = 'sales_nav';
  }
}

/** '' when the tab shows Sales Navigator normally, else what gave the ended subscription away.
 *  Only called when the expected Sales Navigator content did not show up. */
async function salesNavGone(tab) {
  const snap = await bridge.call('exec', { tab, action: 'snapshot' }).catch(() => null);
  if (!snap) return '';
  const url = String(snap.url || '');
  if (/\/(login|checkpoint|authwall|uas\/)/.test(url)) return '';
  // LinkedIn sends you from /sales/ pages to its Premium / product pages once the plan is gone
  if (/linkedin\.com\/(premium|products|sales\/(upsell|reactivat|checkout|payments))/i.test(url) || /business\.linkedin\.com/.test(url)) return `LinkedIn redirected to ${url.split('?')[0]}`;
  const text = [snap.title, ...(snap.dialogs || []).map((d) => d.text), ...(snap.controls || []).map((c) => `${c.text} ${c.aria} ${c.href}`)].join(' \n ');
  const m = text.match(NO_SALES_NAV);
  return m ? `Sales Navigator shows "${m[0]}"` : '';
}

class LimitReachedError extends Error {
  constructor(message, kind = 'weekly') {
    super(message);
    this.kind = kind; // 'weekly' | 'notes'
  }
}

/** Picks the tab where LinkedIn is open (active LinkedIn tab first). Returns { tabId, url, loggedIn }. */
const useWorkTab = () => bridge.call('useWorkTab');

// Profile / chat tabs open next to an "anchor" tab of the bot: a tab opened alone in the hidden group gets frozen
// by Chrome within seconds. The anchor is the Sales Navigator tab when lists are read, else a blank
// linkedin.com/robots.txt page (the same trick the prospect finder uses) – see openAnchorTab
let anchor = 'work';
const ANCHOR_ROLE = 'canchor';
/** Opens the light anchor tab (no Sales Navigator) for chats, profiles and acceptance checks */
async function openAnchorTab() {
  const tab = await bridge.call('useWorkTab', { role: ANCHOR_ROLE });
  anchor = ANCHOR_ROLE;
  return tab;
}
/** From now on new tabs open next to the Sales Navigator tab (list pages are read in it) */
const anchorOnWorkTab = () => { anchor = 'work'; };

/** The list's address for page n – Sales Navigator keeps the page number in the URL */
function listPageUrl(url, n) {
  const base = url.replace(/([?&])page=\d+&?/, '$1').replace(/[?&]$/, '');
  return n > 1 ? `${base}${base.includes('?') ? '&' : '?'}page=${n}` : base;
}

/** Opens page n of a list with a fresh page load – that also wakes the bot tab if Chrome froze it.
 *  dwell(seconds, reason): the runner's wait – the hidden tab needs this time to render the results */
async function openListPage(url, n, settings, dwell) {
  await bridge.call('navigate', { tab: 'work', url: listPageUrl(url, n), settle: settings.page_load_wait });
  if (dwell) await dwell(settings.tab_wait_min, 'Viewing the list');
  const shown = await bridge.call('exec', { tab: 'work', action: 'waitFor', args: ['a[href*="/sales/lead/"]', 25000] });
  await assertSafe('work');
  const { url: now } = await bridge.call('tabInfo', { tab: 'work' });
  if (/\/(login|checkpoint|authwall)/.test(now)) throw new Error('Not logged in to LinkedIn in this tab');
  if (!shown) {
    const gone = await salesNavGone('work');
    if (gone) throw new SubscriptionError(`Your Sales Navigator subscription has ended (${gone})`);
  }
}

/** After a renewal: does Sales Navigator show this list's people again? (true = yes, or no sign it is still off) */
async function salesNavActive(url, settings) {
  await bridge.call('navigate', { tab: 'work', url: listPageUrl(url, 1), settle: settings.page_load_wait });
  const shown = await bridge.call('exec', { tab: 'work', action: 'waitFor', args: ['a[href*="/sales/lead/"]', 25000] });
  return shown || !(await salesNavGone('work'));
}

async function scrapeCurrentPage() {
  await bridge.call('exec', { tab: 'work', action: 'scrollResults' });
  return bridge.call('exec', { tab: 'work', action: 'extractLeads' });
}

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

  await bridge.call('openTab', { url: profileUrl || lead.sales_url || `https://www.linkedin.com/in/${lead.sales_id}/`, settle, near: anchor });
  try {
    await dwell(tabWait(), `Viewing ${lead.name}`);

    if (!profileUrl) {
      const { url } = await bridge.call('tabInfo', { tab: 'job' });
      if (/\/sales\/lead\//.test(url)) {
        profileUrl = await bridge.call('exec', { tab: 'job', action: 'findProfileUrl' });
      } else if (/linkedin\.com\/in\//.test(url)) {
        profileUrl = url.split('?')[0];
      }
      // the Sales Navigator lead page did not open normally – an ended subscription stops everything here,
      // before the lead gets skipped with a wrong profile address
      if (!profileUrl && lead.sales_url) {
        const gone = await salesNavGone('job');
        if (gone) throw new SubscriptionError(`Your Sales Navigator subscription has ended (${gone})`);
      }
      if (!profileUrl) profileUrl = `https://www.linkedin.com/in/${lead.sales_id}/`;
      onProfileUrl(profileUrl);
      await bridge.call('navigate', { tab: 'job', url: profileUrl, settle });
      await dwell(tabWait(), `Viewing ${lead.name}'s LinkedIn profile`);
    }

    await assertSafe('job');
    const result = await invite(lead, note, settings, onDebug, profileUrl);

    // Stay on the profile until the minimum time per profile has passed
    const left = settings.profile_min_seconds - (Date.now() - started) / 1000;
    if (left > 0) await dwell(left, `Staying on ${lead.name}'s profile`);
    return result;
  } finally {
    await bridge.call('closeTab', { tab: 'job' }).catch(() => {});
  }
}

async function invite(lead, note, settings, onDebug, profileUrl = '') {
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
  // Connect hidden under "More": in the bot's background tab that menu often doesn't open. LinkedIn's
  // own invite page (what the Connect link opens) needs no menu – open it directly for this person.
  const vanity = (String(profileUrl || lead.profile_url || '').match(/linkedin\.com\/in\/([^/?#]+)/) || [])[1];
  let direct = false;
  if (opened === 'no_connect' && vanity) {
    require('../logger').logger.info(`${lead.name}: Connect is under "More" – opening LinkedIn's invite page directly`);
    await bridge.call('navigate', { tab: 'job', url: `https://www.linkedin.com/preload/custom-invite/?vanityName=${encodeURIComponent(decodeURIComponent(vanity))}`, settle: settings.page_load_wait });
    await assertSafe('job');
    opened = null;
    direct = true;
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
  if (!['sent', 'dry_run', 'email_required', 'note_limit'].includes(result)) await debug(`Invite dialog${direct ? ' (direct invite page)' : ''}: ${result}`);
  if (direct && (!result || result === 'no_dialog')) return 'no_connect';
  return result || 'no_dialog';
}

/**
 * Opens the chat with a lead, reads it, and sends `text` when decide(messages) says so (see followupCheck.js).
 * The chat is opened straight from lead.chat_url when the bot has been there before (no profile visit);
 * the first time it goes through their profile and reports the chat's address with onChatUrl.
 * text = null: only read the chat (check for replies).
 * Returns { result, check }: result 'sent' | 'dry_run' | 'no_reply' | 'skipped' (check = why) | 'not_connected' |
 * 'no_message_button' | 'no_box' | 'thread_unreadable' | 'not_sent'
 */
async function messageLead(lead, text, settings, { decide, dwell, onDebug, onChatUrl }) {
  const settle = settings.page_load_wait;
  const debug = async (why) => {
    const snap = await bridge.call('exec', { tab: 'job', action: 'snapshot' }).catch(() => null);
    if (snap) onDebug(why, snap);
  };
  if (lead.chat_url) {
    await bridge.call('openTab', { url: lead.chat_url, settle, near: anchor });
    await dwell(settle + 2, `Opening the chat with ${lead.name}`);
  } else {
    await bridge.call('openTab', { url: lead.profile_url, settle, near: anchor });
    await dwell(settings.tab_wait_min + Math.random() * Math.max(0, settings.tab_wait_max - settings.tab_wait_min), `Viewing ${lead.name}`);
  }
  try {
    await assertSafe('job');
    if (!lead.chat_url) {
      const opened = await bridge.call('exec', { tab: 'job', action: 'openMessage', args: [lead.name] }, 60000);
      if (opened && opened.href) {
        // "Message" is a link to the messaging page: load it fresh (a click in the hidden tab often does nothing)
        await bridge.call('navigate', { tab: 'job', url: opened.href, settle });
        await dwell(settle + 3, `Opening the chat with ${lead.name}`);
        onChatUrl(opened.href);
      } else if (opened && opened !== 'opened') {
        await debug(`Chat: ${opened}`);
        return { result: opened };
      } else {
        await new Promise((r) => setTimeout(r, settle * 1000));
        // the click opened the full messaging page: in the hidden bot tab it stays blank until loaded fresh
        const { url: now } = await bridge.call('tabInfo', { tab: 'job' });
        if (/linkedin\.com\/messaging\//.test(now)) {
          await bridge.call('navigate', { tab: 'job', url: now, settle });
          await dwell(settle + 3, `Opening the chat with ${lead.name}`);
        }
      }
      await assertSafe('job');
    }
    const chat = await bridge.call('exec', { tab: 'job', action: 'readThread', args: [lead.name] }, 90000);
    if (!chat || !chat.messages) {
      await debug(`Chat: ${chat || 'no_box'}`);
      return { result: chat || 'no_box' };
    }
    const check = decide(chat.messages);
    if (!check.send) {
      await debug(`Chat checked: ${check.reason}`); // the chat as the bot read it, to check the reason
      return { result: 'skipped', check };
    }
    if (text == null) return { result: 'no_reply', check };
    const result = await bridge.call('exec', { tab: 'job', action: 'sendInThread', args: [text, { dryRun: !!settings.dry_run }] }, 90000);
    if (!['sent', 'dry_run'].includes(result)) await debug(`Follow-up: ${result}`);
    return { result: result || 'no_box', check };
  } finally {
    await bridge.call('closeTab', { tab: 'job' }).catch(() => {});
  }
}

/** Reads your most recent connections (My Network -> Connections, recently added first). */
async function readRecentConnections(settings, dwell) {
  await bridge.call('openTab', { url: 'https://www.linkedin.com/mynetwork/invite-connect/connections/', settle: settings.page_load_wait, near: anchor });
  try {
    await dwell(settings.tab_wait_min, 'Opening your connections page');
    return (await bridge.call('exec', { tab: 'job', action: 'scrapeConnections', args: [settings.acceptance_scan_max] }, 300000)) || [];
  } finally {
    await bridge.call('closeTab', { tab: 'job' }).catch(() => {});
  }
}

// LinkedIn's ids for its inbox queries (page by page / the newest 20); when they stop working, the newest-20 one
// is read again from the messaging page
const INBOX_QUERY = { pages: 'messengerConversations.9501074288a12f3ae9e3c7ea243bccbf', latest: 'messengerConversations.0d5e6781bbee71c3e51c8843c6519f48', messages: 'messengerMessages.5846eeb71c981f11e0134cb6626cc314' };

/** Reads the newest conversations in your LinkedIn inbox from LinkedIn's own inbox API – no chat is opened,
 *  nothing is sent or marked as read. See readInbox in actions.js.
 *  needReplies(items) -> the conversations (urns) to look into for the last message the other person wrote;
 *  those items get their_last = { body, at } | null. */
async function readInbox(settings, dwell, max = 60, needReplies = () => []) {
  const settle = settings.page_load_wait;
  // a light LinkedIn page is enough to ask the API (the messaging page would open – and mark read – your newest chat)
  await bridge.call('openTab', { url: 'https://www.linkedin.com/robots.txt', settle, near: anchor });
  try {
    await dwell(2, 'Reading your LinkedIn inbox');
    let items = await bridge.call('exec', { tab: 'job', action: 'readInbox', args: [max, INBOX_QUERY] }, 300000);
    if (items === 'bad_query') {
      // LinkedIn changed the query: take the new one from the messaging page
      await bridge.call('navigate', { tab: 'job', url: 'https://www.linkedin.com/messaging/', settle });
      await dwell(settle + 2, 'Opening your LinkedIn inbox');
      await assertSafe('job');
      items = await bridge.call('exec', { tab: 'job', action: 'readInbox', args: [max, { pages: INBOX_QUERY.pages, latest: null }] }, 300000);
    }
    if (!Array.isArray(items)) throw new Error(`Could not read your inbox (${items || 'no answer'})`);
    const urns = needReplies(items);
    if (urns.length) {
      await dwell(1, `Reading ${urns.length} chat(s) for replies`);
      const replies = (await bridge.call('exec', { tab: 'job', action: 'inboxReplies', args: [urns, INBOX_QUERY] }, 600000)) || {};
      for (const it of items) if (it.urn in replies && replies[it.urn] !== 'error') it.their_last = replies[it.urn];
      const failed = Object.values(replies).filter((r) => r === 'error').length;
      if (failed) require('../logger').logger.warn(`Inbox: ${failed} of ${urns.length} chat(s) could not be read – tried again next time`);
    }
    return items;
  } finally {
    await bridge.call('closeTab', { tab: 'job' }).catch(() => {});
  }
}

module.exports = { openAnchorTab, anchorOnWorkTab, ANCHOR_ROLE, assertSafe, messageLead, readInbox, readRecentConnections, useWorkTab, openListPage, salesNavActive, scrapeCurrentPage, connectLead, LimitReachedError, SubscriptionError };
