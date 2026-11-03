// Before a follow-up goes out, the bot reads the whole chat with the person and decides here.
// Follow-up N is sent only when the chat holds exactly: your connection note, then follow-ups 1..N-1
// (sent by the bot or typed by you), and nothing from them. Anything else -> skipped, with the reason.

/** Lower-case words of 3+ letters, accents removed ("Ángel" -> "angel") */
const words = (t) => String(t || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9]{3,}/g) || [];

/** The words of a template that are the same for everyone: no {variables}, no [spin|options] */
const fixedWords = (tpl) => words(String(tpl || '').replace(/\{\w+\}/g, ' ').replace(/\[[^\]]*\|[^\]]*\]/g, ' '));

/** true when `text` holds at least 75 % of the expected words (an extra greeting or name does not matter) */
function covers(text, expected) {
  if (!expected.length) return false;
  const have = new Set(words(text));
  return expected.filter((w) => have.has(w)).length / expected.length >= 0.75;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const stampOf = (d) => d.toLocaleString('sv-SE').slice(0, 19);

/**
 * When a chat message was sent, from LinkedIn's day heading ("Today", "Yesterday", "Monday", "Oct 21", "Oct 21, 2025")
 * and time ("4:05 PM"). Returns local "YYYY-MM-DD HH:MM:SS", or '' when the day can't be read.
 */
function chatDate(day = '', time = '', now = new Date()) {
  const d = String(day).trim().toLowerCase();
  let at = null;
  if (/^today\b/.test(d)) at = new Date(now);
  else if (/^yesterday\b/.test(d)) at = new Date(now.getTime() - 864e5);
  else if (DAYS.some((w) => d.startsWith(w))) {
    // a weekday = within the last week
    const want = DAYS.findIndex((w) => d.startsWith(w));
    at = new Date(now);
    const back = (now.getDay() - want + 7) % 7 || 7;
    at.setDate(at.getDate() - back);
  } else {
    const m = d.match(/^([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?/) || d.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (m && MONTHS.includes(m[1])) {
      at = new Date(m[3] ? Number(m[3]) : now.getFullYear(), MONTHS.indexOf(m[1]), Number(m[2]));
      if (!m[3] && at > now) at.setFullYear(at.getFullYear() - 1); // "Dec 30" seen in January = last year
    } else if (m) {
      at = new Date(Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]), Number(m[1]) - 1, Number(m[2]));
    }
  }
  if (!at || Number.isNaN(at.getTime())) return '';
  const t = String(time).trim().match(/^(\d{1,2}):(\d{2})\s*([ap]m)?/i);
  if (t) {
    let h = Number(t[1]) % (t[3] ? 12 : 24);
    if (t[3] && /pm/i.test(t[3])) h += 12;
    at.setHours(h, Number(t[2]), 0, 0);
  } else at.setHours(12, 0, 0, 0);
  return stampOf(at);
}

const short = (t, n = 70) => {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

/**
 * messages: [{ other, body, day?, time? }] oldest first (other = written by them; day / time = LinkedIn's labels)
 * note:     the connection note the bot sent
 * steps:    [{ step, words }] every follow-up of the message type (words of the text the bot sent, or of the template)
 * step:     the follow-up about to be sent
 * Returns { send: true, sentAt } or { send: false, state, reason, synced?, sentAt }
 *   state 'replied' | 'manual' | 'missing' – no more follow-ups · '' with synced = N: follow-up N is already in the chat
 *   sentAt = { step: "YYYY-MM-DD HH:MM:SS" } when each follow-up found in the chat was sent (0 = the note)
 */
function checkThread(messages, { note, steps, step }) {
  const theirs = messages.filter((m) => m.other);
  if (theirs.length) {
    const reply = theirs[theirs.length - 1].body;
    return { send: false, state: 'replied', reply, reason: `they replied: "${short(reply)}"` };
  }

  // which of your messages is the note / which follow-up. Messages sent one after the other are read together,
  // so a greeting sent on its own ("Hi Daniel, hope you are well!") followed by the follow-up still counts as it
  const expected = [{ key: 0, words: words(note) }, ...steps.map((s) => ({ key: s.step, words: s.words }))];
  const found = new Set();
  const sentAt = {};
  let buffer = '';
  for (const m of messages) {
    buffer = `${buffer} ${m.body}`;
    const hit = expected.find((e) => !found.has(e.key) && covers(buffer, e.words));
    if (hit) {
      found.add(hit.key);
      const at = chatDate(m.day, m.time);
      if (at) sentAt[hit.key] = at;
      buffer = '';
    }
  }
  if (buffer.trim()) return { send: false, state: 'manual', sentAt, reason: `you sent another message: "${short(buffer)}"` };

  const later = [...found].filter((k) => k >= step);
  if (later.length) {
    const n = Math.max(...later);
    return { send: false, state: '', synced: n, sentAt, reason: `follow-up ${n} is already in the chat (sent by you${sentAt[n] ? ` on ${sentAt[n].slice(0, 10)}` : ''}) – counted as sent` };
  }
  if (!found.has(0)) return { send: false, state: 'missing', sentAt, reason: 'the connection note is not in the chat' };
  for (let k = 1; k < step; k++) {
    if (!found.has(k)) return { send: false, state: 'missing', sentAt, reason: `follow-up ${k} is not in the chat` };
  }
  return { send: true, sentAt };
}

module.exports = { checkThread, chatDate, words, fixedWords };
