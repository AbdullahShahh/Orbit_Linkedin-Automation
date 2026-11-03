// Account safety: limits and checks that keep the LinkedIn account away from restrictions.
// All numbers are in Settings → Account safety.
//   - weekly invitation cap (rolling 7 days) below LinkedIn's own limit
//   - only send during working hours (optionally not at weekends)
//   - stop sending while too many invitations are still pending
//   - warn when the acceptance rate is low (LinkedIn flags accounts whose invites get ignored)
//   - cap on profiles the prospect finder opens per day
//   - cool-down: after a security check / restriction / rate limit nothing runs for a while
const { db, getSettings, getState, setState } = require('../db');

class RestrictedError extends Error {
  constructor(message) { super(message); this.kind = 'restricted'; }
}
class RateLimitError extends Error {
  // publicOnly: LinkedIn limited its public pages (jobs / posts) – your account is fine, only the prospect finder waits
  constructor(message, hours, publicOnly = false) { super(message); this.kind = 'rate_limit'; this.hours = hours; this.publicOnly = publicOnly; }
}

const stamp = (d = new Date()) => d.toLocaleString('sv-SE').slice(0, 16);

/** Start of the counting week: last Monday 00:00 (LinkedIn's weekly limit resets on Monday) or 7 days ago */
function weekStart(s = getSettings()) {
  const d = new Date();
  if (s.weekly_window === 'rolling') { d.setDate(d.getDate() - 7); return d.toLocaleString('sv-SE'); }
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // back to Monday
  return d.toLocaleString('sv-SE');
}
const sentLast7Days = (s = getSettings()) => db.prepare("SELECT COUNT(*) c FROM leads WHERE status = 'sent' AND sent_at >= ?").get(weekStart(s)).c;
// invitations sent in the last 3 weeks that nobody accepted yet (older ones LinkedIn drops or you withdraw)
const pendingInvites = () => db.prepare("SELECT COUNT(*) c FROM leads WHERE status = 'sent' AND accepted_at IS NULL AND sent_at >= datetime('now','localtime','-21 days')").get().c;

/** Acceptance rate of invitations sent 7–60 days ago (newer ones haven't had time yet) */
function acceptance() {
  const r = db.prepare(`SELECT COUNT(*) n, SUM(accepted_at IS NOT NULL) a FROM leads WHERE status = 'sent'
                        AND sent_at < datetime('now','localtime','-7 days') AND sent_at >= datetime('now','localtime','-60 days')`).get();
  return { sample: r.n, accepted: r.a || 0, pct: r.n ? Math.round(((r.a || 0) / r.n) * 100) : null };
}

function inWorkingHours(s = getSettings(), d = new Date()) {
  const h = d.getHours() + d.getMinutes() / 60;
  const day = d.getDay();
  if (s.skip_weekends && (day === 0 || day === 6)) return false;
  const from = Number(s.work_hours_start);
  const to = Number(s.work_hours_end);
  if (!(to > from) || (from <= 0 && to >= 24)) return true; // 0–24 = always
  return h >= from && h < to;
}

/**
 * Cool-down after a restriction / rate limit: { until, reason } while it lasts, else null.
 * scope 'all' = your account (blocks both apps); 'prospects' = LinkedIn's public pages limited the
 * prospect finder (not your account) – only the prospect finder waits.
 */
// 'jobs' = only LinkedIn's public job pages are limited – job searches wait, post searches go on
const COOL_KEY = { all: 'safety_cooldown', prospects: 'prospect_cooldown', jobs: 'jobs_cooldown' };
function cooldown(scope = 'all') {
  const key = COOL_KEY[scope] || COOL_KEY.all;
  const c = getState(key);
  if (!c) return null;
  if (Date.now() >= c.untilMs) { setState(key, null); return null; }
  return c;
}
function startCooldown(hours, reason, scope = 'all') {
  const untilMs = Date.now() + hours * 3600000;
  const c = { untilMs, until: stamp(new Date(untilMs)), reason, at: stamp() };
  setState(COOL_KEY[scope] || COOL_KEY.all, c);
  return c;
}
const clearCooldown = () => Object.values(COOL_KEY).forEach((k) => setState(k, null));

/** Why the bot must not send another invitation now (text for the dashboard), or '' */
function sendBlock(s = getSettings()) {
  const c = cooldown();
  if (c) return `Paused for account safety until ${c.until} (${c.reason})`;
  if (s.weekly_limit > 0 && sentLast7Days(s) >= s.weekly_limit) {
    return s.weekly_window === 'rolling'
      ? `Weekly safety limit of ${s.weekly_limit} notes reached (last 7 days) – continues when older invites drop out of the 7 days (Settings → Account safety)`
      : `Weekly safety limit of ${s.weekly_limit} notes reached this week – continues automatically on Monday (Settings → Account safety)`;
  }
  if (s.max_pending > 0 && pendingInvites() >= s.max_pending) {
    return `${pendingInvites()} invitations are still pending (limit ${s.max_pending}) – too many open invites look like spam to LinkedIn. Wait for acceptances or withdraw old ones`;
  }
  if (!inWorkingHours(s)) {
    return `Outside working hours (${s.work_hours_start}:00–${s.work_hours_end}:00${s.skip_weekends ? ', weekdays' : ''}) – the bot only sends during these hours (Settings → Account safety)`;
  }
  return '';
}

// ---- prospect finder: profiles opened per day ----
function profileViewsToday() {
  const v = getState('profile_views');
  const today = new Date().toLocaleDateString('sv-SE');
  return v && v.day === today ? v.n : 0;
}
function countProfileView() {
  const today = new Date().toLocaleDateString('sv-SE');
  setState('profile_views', { day: today, n: profileViewsToday() + 1 });
}
const profileViewsLeft = (s = getSettings()) => (s.prospect_daily_profile_views > 0 ? s.prospect_daily_profile_views - profileViewsToday() : Infinity);

/** Everything the dashboard shows about account safety */
function summary(s = getSettings()) {
  const acc = acceptance();
  return {
    weekSent: sentLast7Days(s),
    weekWindow: s.weekly_window === 'rolling' ? 'last 7 days' : 'since Monday',
    weeklyLimit: s.weekly_limit,
    pending: pendingInvites(),
    maxPending: s.max_pending,
    acceptance: acc,
    lowAcceptance: s.min_acceptance_pct > 0 && acc.sample >= 50 && acc.pct < s.min_acceptance_pct,
    minAcceptance: s.min_acceptance_pct,
    workingHours: inWorkingHours(s),
    hours: `${s.work_hours_start}:00–${s.work_hours_end}:00${s.skip_weekends ? ' (weekdays)' : ''}`,
    cooldown: cooldown(),
    prospectCooldown: cooldown('prospects'),
    jobsCooldown: cooldown('jobs'),
    profileViewsToday: profileViewsToday(),
    profileViewsLimit: s.prospect_daily_profile_views,
  };
}

module.exports = {
  RestrictedError, RateLimitError, sendBlock, cooldown, startCooldown, clearCooldown, summary,
  countProfileView, profileViewsLeft, inWorkingHours, sentLast7Days, weekStart, pendingInvites, acceptance,
};
