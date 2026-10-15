// WebSocket bridge to the Chrome extension running inside YOUR Chrome (your LinkedIn login).
// The backend decides what to do; the extension executes it in the browser and replies.
const { WebSocketServer } = require('ws');
const { logger, emit } = require('../logger');

let socket = null;
let info = null; // { version, userAgent }
let seq = 0;
const waiting = new Map();

function attach(server) {
  const wss = new WebSocketServer({ server, path: '/ext' });
  wss.on('connection', (ws, req) => {
    const origin = req.headers.origin || '';
    if (origin && !origin.startsWith('chrome-extension://')) {
      ws.close(1008, 'Only the extension may connect');
      return;
    }
    if (socket) socket.close(1000, 'Replaced by a newer connection');
    socket = ws;
    ws.isAlive = true;
    logger.success('Chrome extension connected');
    emit('extension', { connected: true });

    ws.on('pong', () => (ws.isAlive = true));
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === 'hello') { info = msg; emit('extension', { connected: true, ...msg }); return; }
      if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }
      const w = waiting.get(msg.id);
      if (!w) return;
      waiting.delete(msg.id);
      clearTimeout(w.timer);
      if (msg.error) w.reject(new Error(msg.error));
      else w.resolve(msg.result);
    });
    ws.on('close', () => {
      if (socket !== ws) return;
      socket = null;
      info = null;
      for (const [, w] of waiting) { clearTimeout(w.timer); w.reject(new Error('Chrome extension disconnected')); }
      waiting.clear();
      logger.warn('Chrome extension disconnected');
      emit('extension', { connected: false });
    });
  });

  // Regular traffic keeps the extension's service worker alive while we wait between leads
  setInterval(() => {
    if (!socket) return;
    if (!socket.isAlive) return socket.terminate();
    socket.isAlive = false;
    socket.ping();
    socket.send(JSON.stringify({ type: 'keepalive' }));
  }, 20000);
}

function call(cmd, args = {}, timeoutMs = 90000) {
  if (!socket) return Promise.reject(new Error('Chrome extension not connected. Open Chrome and make sure the "LinkedIn Connect Bot" extension is enabled.'));
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error(`Browser did not respond to "${cmd}" in time`));
    }, timeoutMs);
    waiting.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, cmd, args }));
  });
}

const isConnected = () => !!socket;
const getInfo = () => (socket ? { connected: true, ...info } : { connected: false });

module.exports = { attach, call, isConnected, getInfo };
