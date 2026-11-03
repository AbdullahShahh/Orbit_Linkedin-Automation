// Tells you about new prospects after a run: a Mac notification and, if set up, a Telegram message.
// Telegram: Settings → Prospect finder → bot token (from @BotFather) and your chat id.
const { execFile } = require('child_process');
const { db, getSettings } = require('../db');
const { logger } = require('../logger');
const { prospectScore } = require('../prospects/filter');

const quoteAS = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

function macNotification(title, text) {
  execFile('osascript', ['-e', `display notification "${quoteAS(text)}" with title "${quoteAS(title)}" sound name "Glass"`], () => {});
}

async function telegram(text) {
  const s = getSettings();
  if (!s.telegram_bot_token || !s.telegram_chat_id) return false;
  const res = await fetch(`https://api.telegram.org/bot${s.telegram_bot_token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: s.telegram_chat_id, text, disable_web_page_preview: true }),
  });
  if (!res.ok) throw new Error(`Telegram answered ${res.status}`);
  return true;
}

/** After a prospect run: what's new since `since` (local "YYYY-MM-DD HH:MM:SS"), best first */
async function prospectDigest(since) {
  const rows = db.prepare("SELECT * FROM prospects WHERE status = 'new' AND found_at >= ?").all(since)
    .map((p) => ({ ...p, score: prospectScore(p) })).sort((a, b) => b.score - a.score);
  const posts = rows.filter((p) => p.kind === 'post').length;
  const jobs = rows.length - posts;
  const title = rows.length ? `${rows.length} new prospect${rows.length === 1 ? '' : 's'}` : 'No new prospects';
  const summary = `${posts} post${posts === 1 ? '' : 's'} · ${jobs} job${jobs === 1 ? '' : 's'}`;
  macNotification(`LinkedIn Bot – ${title}`, rows.length ? `${summary} – open Prospects on the dashboard` : 'Nothing new this time');
  if (!rows.length) return;
  const lines = rows.slice(0, 15).map((p, i) => {
    const who = p.person_name || p.company_name || '—';
    const what = p.kind === 'job' ? `${p.title} @ ${p.company_name}` : `${who}${p.company_name && p.person_name ? ` (${p.company_name})` : ''}`;
    return `${i + 1}. [${p.score}] ${what}${p.location ? ` – ${p.location}` : ''}\n${p.url || p.person_url || ''}`;
  });
  try {
    if (await telegram(`🎯 ${title} (${summary})\n\n${lines.join('\n\n')}${rows.length > 15 ? `\n\n…and ${rows.length - 15} more on the dashboard` : ''}`)) logger.info('Prospect list sent to Telegram');
  } catch (e) {
    logger.warn(`Telegram message failed: ${e.message}`);
  }
}

module.exports = { prospectDigest, macNotification, telegram };
