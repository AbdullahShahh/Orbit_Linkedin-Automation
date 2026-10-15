// Logs go to the DB and are pushed live to the dashboard via Server-Sent Events.
const { EventEmitter } = require('events');
const { db } = require('./db');

const bus = new EventEmitter();
bus.setMaxListeners(50);

const insert = db.prepare('INSERT INTO logs (level, message, list_id, lead_id) VALUES (?, ?, ?, ?)');

function log(level, message, ctx = {}) {
  const info = insert.run(level, message, ctx.list_id ?? null, ctx.lead_id ?? null);
  const entry = {
    id: Number(info.lastInsertRowid),
    ts: new Date().toLocaleString('sv-SE').replace('T', ' '),
    level,
    message,
    list_id: ctx.list_id ?? null,
    lead_id: ctx.lead_id ?? null,
  };
  console.log(`[${entry.ts}] ${level.toUpperCase()} ${message}`);
  bus.emit('event', { type: 'log', data: entry });
  return entry;
}

const logger = {
  info: (m, c) => log('info', m, c),
  success: (m, c) => log('success', m, c),
  warn: (m, c) => log('warn', m, c),
  error: (m, c) => log('error', m, c),
};

function emit(type, data) {
  bus.emit('event', { type, data });
}

module.exports = { logger, bus, emit };
