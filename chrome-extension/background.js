// Connects to the local backend over WebSocket and executes its commands in YOUR Chrome:
// navigating your LinkedIn tab, opening a profile tab, running DOM actions (actions.js).
importScripts('linkedin-fetch.js'); // post search without a tab (self.linkedinFetch)
const DEFAULT_PORT = 4000;
let ws = null;
let lastError = '';

// ---------- tab bookkeeping (survives service-worker restarts) ----------
async function getTabs() {
  const { tabs = {} } = await chrome.storage.session.get('tabs');
  return tabs;
}
async function setTab(role, id) {
  const tabs = await getTabs();
  tabs[role] = id;
  await chrome.storage.session.set({ tabs });
}
async function tabId(role) {
  const id = (await getTabs())[role];
  if (!id) throw new Error(`No ${role} tab`);
  try {
    await chrome.tabs.get(id);
  } catch {
    throw new Error(/work$/.test(role) ? 'Your LinkedIn tab was closed' : 'Profile tab was closed');
  }
  return id;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The bot works in a collapsed tab group ("LinkedIn Bot") inside your normal Chrome window – no
// extra window. Its tabs are always opened in the background (active: false), so the tab you are
// looking at never changes; when a job is done the group's tabs are closed.
const GROUP = { title: 'LinkedIn Bot', color: 'blue' };

/** The bot's tab group: the one remembered, else any group called "LinkedIn Bot" (only one is ever kept) */
async function botGroup() {
  const { botGroup: id } = await chrome.storage.session.get('botGroup');
  let g = id == null ? null : await chrome.tabGroups.get(id).catch(() => null);
  if (!g) {
    g = (await chrome.tabGroups.query({ title: GROUP.title }).catch(() => []))[0] || null;
    if (g) await chrome.storage.session.set({ botGroup: g.id });
  }
  return g;
}

/** Window the bot tabs live in: the group's window, else the window you used last */
async function hostWindow() {
  const g = await botGroup();
  if (g) return g.windowId;
  const w = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
  if (w) return w.id;
  // no Chrome window open at all -> one minimized window just for the bot
  return (await chrome.windows.create({ focused: false, state: 'minimized' })).id;
}

/** Puts a bot tab into the "LinkedIn Bot" group (created collapsed the first time) */
async function addToGroup(tabId) {
  const g = await botGroup();
  const t = await chrome.tabs.get(tabId);
  if (g && g.windowId === t.windowId) {
    await chrome.tabs.group({ groupId: g.id, tabIds: [tabId] });
    return g.id;
  }
  const id = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId: t.windowId } });
  await chrome.storage.session.set({ botGroup: id }); // remember first, so a failed update can't make a second group
  await chrome.tabGroups.update(id, { ...GROUP, collapsed: true }).catch(() => {});
  return id;
}

const isLinkedIn = (url = '') => /^https:\/\/(www\.)?linkedin\.com\//.test(url);

async function waitComplete(id, timeout = 45000) {
  const start = Date.now();
  let sawLoading = false;
  while (Date.now() - start < timeout) {
    const t = await chrome.tabs.get(id);
    if (t.status === 'loading') sawLoading = true;
    if (t.status === 'complete' && (sawLoading || Date.now() - start > 1500)) return t;
    await sleep(300);
  }
  return chrome.tabs.get(id);
}

async function exec(id, action, args = []) {
  try {
    await chrome.scripting.executeScript({ target: { tabId: id }, files: ['actions.js'] });
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: id },
      func: async (a, params) => {
        try {
          return { ok: await window.__lcb[a](...params) };
        } catch (e) {
          return { err: String((e && e.message) || e) };
        }
      },
      args: [action, args],
    });
    if (!res || !res.result) return null; // page navigated while running
    if (res.result.err) throw new Error(res.result.err);
    return res.result.ok ?? null;
  } catch (e) {
    if (/frame.*removed|closed|navigat|context|No tab/i.test(e.message)) return null;
    throw e;
  }
}

// ---------- commands from the backend ----------
const commands = {
  // Each runner has its own tabs: campaigns use 'work' + 'job', the prospect finder 'pwork' + 'pjob',
  // so both can run at the same time without changing each other's pages.
  async useWorkTab({ role = 'work' } = {}) {
    const g = await botGroup();
    const roles = await getTabs();
    let tab = null;
    if (roles[role]) tab = await chrome.tabs.get(roles[role]).catch(() => null);
    if (tab && (!g || tab.groupId !== g.id)) tab = null; // only ever drive the bot's own tabs, never yours
    if (!tab && g) {
      const taken = new Set(Object.entries(roles).filter(([r, id]) => r !== role && id).map(([, id]) => id));
      const inGroup = await chrome.tabs.query({ groupId: g.id });
      tab = inGroup.find((t) => !taken.has(t.id) && isLinkedIn(t.url || t.pendingUrl)) || null;
    }
    if (!tab) {
      tab = await chrome.tabs.create({ windowId: await hostWindow(), url: role === 'work' ? 'https://www.linkedin.com/sales/home' : 'https://www.linkedin.com/robots.txt', active: false });
      await addToGroup(tab.id);
    }
    await waitComplete(tab.id);
    tab = await chrome.tabs.get(tab.id);
    await setTab(role, tab.id);
    const loggedIn = await exec(tab.id, 'isLoggedIn');
    return { tabId: tab.id, url: tab.url, loggedIn: !!loggedIn };
  },

  async navigate({ tab, url, settle = 3 }) {
    const id = await tabId(tab);
    await chrome.tabs.update(id, { url });
    await waitComplete(id);
    await sleep(settle * 1000);
    return true;
  },

  async openTab({ url, settle = 3, role = 'job', near = 'work' }) {
    const nearId = (await getTabs())[near];
    const by = nearId ? await chrome.tabs.get(nearId).catch(() => null) : null;
    const t = await chrome.tabs.create({ url, active: false, windowId: by ? by.windowId : await hostWindow(), ...(by ? { index: by.index + 1 } : {}) });
    await addToGroup(t.id);
    await setTab(role, t.id);
    await waitComplete(t.id);
    await sleep(settle * 1000);
    return { tabId: t.id };
  },

  async closeTab({ tab }) {
    const id = (await getTabs())[tab];
    if (id) await chrome.tabs.remove(id).catch(() => {});
    await setTab(tab, null);
    return true;
  },

  async tabInfo({ tab }) {
    const t = await chrome.tabs.get(await tabId(tab));
    return { url: t.url, status: t.status };
  },

  async exec({ tab, action, args }) {
    return exec(await tabId(tab), action, args);
  },

  // Read a LinkedIn API with your login, straight from the extension – no tab needed
  async apiGet({ url }) {
    if (!/^https:\/\/www\.linkedin\.com\/voyager\/api\//.test(url)) throw new Error('Only LinkedIn API URLs');
    const c = await chrome.cookies.get({ url: 'https://www.linkedin.com', name: 'JSESSIONID' });
    const res = await fetch(url, {
      credentials: 'include',
      headers: { 'csrf-token': c ? c.value.replace(/"/g, '') : '', accept: 'application/vnd.linkedin.normalized+json+2.1', 'x-restli-protocol-version': '2.0.0' },
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json };
  },

  // Post search read in the background worker – no tab, nothing to freeze
  async bg({ action, args = [] }) {
    const fn = self.linkedinFetch && self.linkedinFetch[action];
    if (!fn) throw new Error(`Unknown background action ${action}`);
    return fn(...args);
  },

  // A runner is done: close only its own tabs (the group goes away when it's empty)
  async closeTabs({ roles = [] }) {
    const tabs = await getTabs();
    for (const r of roles) {
      if (tabs[r]) await chrome.tabs.remove(tabs[r]).catch(() => {});
      await setTab(r, null);
    }
    return true;
  },

  // Job done -> close the bot's tabs (the group disappears with them). Name kept for the backend.
  async closeBotWindow() {
    // every "LinkedIn Bot" group (normally just one) – closing its tabs removes the group
    const groups = await chrome.tabGroups.query({ title: GROUP.title }).catch(() => []);
    for (const g of groups) {
      const tabs = await chrome.tabs.query({ groupId: g.id });
      if (tabs.length) await chrome.tabs.remove(tabs.map((t) => t.id)).catch(() => {});
    }
    // the separate bot window from older versions, if it is still open
    const { botWin } = await chrome.storage.session.get('botWin');
    if (botWin) await chrome.windows.remove(botWin).catch(() => {});
    await chrome.storage.session.set({ botWin: null, botGroup: null, tabs: {} });
    return true;
  },
};

// ---------- WebSocket connection ----------
// Only one connection attempt at a time: connect() is triggered from startup, install,
// alarms and the popup, often simultaneously.
let connecting = null;

function safeSend(socket, data) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(data));
    return true;
  }
  return false;
}

function connect() {
  if (ws && ws.readyState <= WebSocket.OPEN) return Promise.resolve();
  if (connecting) return connecting;
  connecting = (async () => {
    const { port = DEFAULT_PORT } = await chrome.storage.local.get('port');
    let socket;
    try {
      socket = new WebSocket(`ws://localhost:${port}/ext`);
    } catch (e) {
      lastError = e.message;
      return;
    }
    ws = socket;
    // Handlers use their own `socket`, never the global, so a replaced connection can't
    // send on (or null out) the newer one.
    socket.onopen = () => {
      lastError = '';
      safeSend(socket, { type: 'hello', version: chrome.runtime.getManifest().version, userAgent: navigator.userAgent });
      chrome.action.setBadgeText({ text: 'ON' });
      chrome.action.setBadgeBackgroundColor({ color: '#057642' });
    };
    socket.onmessage = async (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type) return; // keepalive / pong
      const fn = commands[msg.cmd];
      try {
        if (!fn) throw new Error(`Unknown command ${msg.cmd}`);
        const result = await fn(msg.args || {});
        safeSend(socket, { id: msg.id, result });
      } catch (err) {
        safeSend(socket, { id: msg.id, error: String(err.message || err) });
      }
    };
    socket.onclose = () => {
      if (ws !== socket) return;
      ws = null;
      chrome.action.setBadgeText({ text: 'OFF' });
      chrome.action.setBadgeBackgroundColor({ color: '#888888' });
    };
    socket.onerror = () => { lastError = 'Dashboard server not running (double-click "Start LinkedIn Bot.command")'; };
  })().finally(() => { connecting = null; });
  return connecting;
}

// keep the worker alive while connected + reconnect if the server restarts
setInterval(() => {
  if (!safeSend(ws, { type: 'ping' })) connect();
}, 20000);
chrome.alarms.create('reconnect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => connect());
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();

// ---------- popup ----------
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  // waits for actions.js (page timers are slowed down in background tabs, this one isn't)
  if (msg.type === 'sleep') {
    setTimeout(() => reply({ ok: true }), Math.max(0, Math.min(Number(msg.ms) || 0, 120000)));
    return true;
  }
  (async () => {
    if (msg.type === 'status') {
      const work = (await getTabs()).work;
      const t = work ? await chrome.tabs.get(work).catch(() => null) : null;
      const { port = DEFAULT_PORT } = await chrome.storage.local.get('port');
      reply({ connected: !!ws && ws.readyState === 1, lastError, port, workTab: t ? { title: t.title, url: t.url } : null });
    } else if (msg.type === 'showBotWindow') {
      // popup button: show the bot's tab (you asked for it)
      const work = (await getTabs()).work;
      const t = work ? await chrome.tabs.get(work).catch(() => null) : null;
      if (t) {
        if (t.groupId > -1) await chrome.tabGroups.update(t.groupId, { collapsed: false }).catch(() => {});
        await chrome.tabs.update(t.id, { active: true });
        await chrome.windows.update(t.windowId, { focused: true });
      }
      reply({ ok: true });
    } else if (msg.type === 'setPort') {
      await chrome.storage.local.set({ port: Number(msg.port) || DEFAULT_PORT });
      if (ws) ws.close();
      await connect();
      reply({ ok: true });
    } else if (msg.type === 'reconnect') {
      await connect();
      reply({ ok: true });
    }
  })();
  return true;
});
