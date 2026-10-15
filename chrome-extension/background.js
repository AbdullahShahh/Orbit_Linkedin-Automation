// Connects to the local backend over WebSocket and executes its commands in YOUR Chrome:
// navigating your LinkedIn tab, opening a profile tab, running DOM actions (actions.js).
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
    throw new Error(role === 'work' ? 'Your LinkedIn tab was closed' : 'Profile tab was closed');
  }
  return id;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The bot works in its own Chrome window, created without focus, so it never pulls you away from
// the tab you are using. Its tabs switch only inside that window.
async function botWindow() {
  const { botWin } = await chrome.storage.session.get('botWin');
  if (botWin) {
    const w = await chrome.windows.get(botWin).catch(() => null);
    if (w) return w.id;
  }
  const w = await chrome.windows.create({ url: 'https://www.linkedin.com/sales/home', focused: false, state: 'normal', width: 1280, height: 900 });
  await chrome.storage.session.set({ botWin: w.id });
  return w.id;
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
  async useWorkTab() {
    const winId = await botWindow();
    let tab = null;
    const saved = (await getTabs()).work;
    if (saved) tab = await chrome.tabs.get(saved).catch(() => null);
    if (tab && tab.windowId !== winId) tab = null; // never drive a tab in your own windows
    if (!tab) {
      const inWin = await chrome.tabs.query({ windowId: winId });
      tab = inWin.find((t) => isLinkedIn(t.url || t.pendingUrl)) || null;
    }
    if (!tab) tab = await chrome.tabs.create({ windowId: winId, url: 'https://www.linkedin.com/sales/home', active: true });
    await waitComplete(tab.id);
    tab = await chrome.tabs.get(tab.id);
    await setTab('work', tab.id);
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

  async openTab({ url, settle = 3 }) {
    const work = await chrome.tabs.get(await tabId('work'));
    const t = await chrome.tabs.create({ url, active: true, windowId: work.windowId, index: work.index + 1 });
    await setTab('job', t.id);
    await waitComplete(t.id);
    await sleep(settle * 1000);
    return { tabId: t.id };
  },

  async closeTab({ tab }) {
    const id = (await getTabs())[tab];
    if (id) await chrome.tabs.remove(id).catch(() => {});
    await setTab(tab, null);
    const work = (await getTabs()).work;
    if (work) await chrome.tabs.update(work, { active: true }).catch(() => {});
    return true;
  },

  async tabInfo({ tab }) {
    const t = await chrome.tabs.get(await tabId(tab));
    return { url: t.url, status: t.status };
  },

  async exec({ tab, action, args }) {
    return exec(await tabId(tab), action, args);
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
  (async () => {
    if (msg.type === 'status') {
      const work = (await getTabs()).work;
      const t = work ? await chrome.tabs.get(work).catch(() => null) : null;
      const { port = DEFAULT_PORT } = await chrome.storage.local.get('port');
      reply({ connected: !!ws && ws.readyState === 1, lastError, port, workTab: t ? { title: t.title, url: t.url } : null });
    } else if (msg.type === 'showBotWindow') {
      await chrome.windows.update(await botWindow(), { focused: true, state: 'normal' });
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
