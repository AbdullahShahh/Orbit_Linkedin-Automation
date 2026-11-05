// Dashboard front-end (no build step). Talks to the local API on the same port.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ERROR_LABEL = {
  outside_target_location: 'lives outside target countries',
  skip_keyword: 'title / company has a skip keyword',
  email_required: 'LinkedIn asked for their email',
  no_connect: 'no Connect option',
  no_dialog: 'invite popup did not open',
  no_note_button: 'no "Add a note" option',
  no_note_box: 'note box did not appear',
  no_first_name: 'no first name found',
  pending_invite: 'invite already pending',
};
const STATUS_LABEL = {
  review: 'To review', pending: 'Approved', sent: 'Sent', skipped: 'Skipped', failed: 'Failed',
  already_connected: 'Already connected', pending_invite: 'Invite pending', excluded: 'Excluded',
};

// thin progress bar at the top while requests run (shown only when one takes longer than 150 ms)
let inFlight = 0;
let barTimer = null;
function busy(delta) {
  inFlight = Math.max(0, inFlight + delta);
  clearTimeout(barTimer);
  if (inFlight) barTimer = setTimeout(() => document.body.classList.add('is-loading'), 150);
  else document.body.classList.remove('is-loading');
}

async function api(path, opts = {}) {
  busy(1);
  try {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  } finally {
    busy(-1);
  }
}

function toast(msg, err = false) {
  const t = $('#toast');
  t.innerHTML = `<span class="toast-ico">${err ? '!' : '✓'}</span><span>${esc(msg)}</span>`;
  t.className = 'toast' + (err ? ' err' : '');
  void t.offsetWidth; // restart the slide-in when a new toast replaces the old one
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => { t.classList.remove('show'); t._h = setTimeout(() => t.classList.add('hidden'), 250); }, err ? 6000 : 3500);
}
$('#toast').addEventListener('click', (e) => { e.currentTarget.classList.remove('show'); setTimeout(() => e.currentTarget.classList.add('hidden'), 250); });

// numbers on the stat tiles count up when you open a page
function countUp(root) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  root.querySelectorAll('.stat b, .crm-stat b, .pr-stat b, .ls-sum b').forEach((el) => {
    const m = el.textContent.trim().match(/^(\d{1,6})(.*)$/s);
    if (!m || Number(m[1]) < 2) return;
    const end = Number(m[1]);
    const rest = m[2];
    const t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / 650);
      el.textContent = `${Math.round(end * (1 - Math.pow(1 - k, 3)))}${rest}`;
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}
const guard = (fn) => async (...a) => {
  try { await fn(...a); } catch (e) { toast(e.message, true); }
};

// ---------------- which app: Outreach (/) or Prospect Finder (/finder) ----------------
const APP = location.pathname.startsWith('/finder') ? 'finder' : location.pathname.startsWith('/jobs') ? 'jobs' : 'connect';
const HOME = { connect: 'dashboard', finder: 'prospects', jobs: 'jobs' };
document.body.dataset.app = APP;
document.title = { finder: 'Prospect Finder', jobs: 'Job Applier', connect: 'Outreach' }[APP];
{
  const sub = document.querySelector('#view-settings .page-head p');
  if (sub) sub.textContent = APP === 'jobs'
    ? 'Which jobs, how many a day and when. Changes apply immediately.'
    : APP === 'finder'
    ? 'Where to look, job rules, limits and the daily run. Changes apply immediately.'
    : 'Campaign delays, limits and account safety. Changes apply immediately – even during a running session.';
}
$$('[data-app-link]').forEach((a) => a.classList.toggle('on', a.dataset.appLink === APP));
const viewAllowed = (view) => { const el = document.getElementById(`view-${view}`); return !!el && (!el.dataset.app || el.dataset.app === APP); };

// ---------------- navigation ----------------
const loaders = {};
function show(view) {
  if (!viewAllowed(view)) view = HOME[APP];
  $$('nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  location.hash = view;
  const el = document.getElementById(`view-${view}`);
  el.classList.remove('enter');
  void el.offsetWidth;
  el.classList.add('enter');
  Promise.resolve(loaders[view] && loaders[view]()).then(() => countUp(el));
}
$$('nav a').forEach((a) => a.addEventListener('click', () => show(a.dataset.view)));
document.addEventListener('click', (e) => {
  const g = e.target.closest('[data-goto]');
  if (g) show(g.dataset.goto);
});

// ---------------- modal ----------------
function openModal(title, html) {
  $('#modalBg .modal')?.classList.remove('wide');
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = html;
  const bg = $('#modalBg');
  bg.classList.remove('hidden', 'closing');
  void bg.offsetWidth;
  bg.classList.add('open');
}
function closeModal() {
  const bg = $('#modalBg');
  if (bg.classList.contains('hidden')) return;
  bg.classList.remove('open');
  bg.classList.add('closing');
  setTimeout(() => { if (bg.classList.contains('closing')) bg.classList.add('hidden'); bg.classList.remove('closing'); }, 160);
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
$('#modalClose').onclick = closeModal;
$('#modalBg').addEventListener('mousedown', (e) => e.target.id === 'modalBg' && closeModal());

// ---------------- state ----------------
let TYPES = [];
let LISTS = [];
let SETTINGS = {};
let STATUS = {};

// ---------------- dashboard ----------------
// ---------------- dashboard: waiting for you + daily report ----------------
const shortDay = (d) => new Date(`${d}T12:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
let pendTimer = null;
const pendSoon = () => {
  if (APP !== 'connect' || (location.hash.slice(1) || 'dashboard') !== 'dashboard') return;
  clearTimeout(pendTimer);
  pendTimer = setTimeout(() => loadPending().catch(() => {}), 1500);
};
async function loadPending() {
  const { items, report } = await api('/api/pending');
  $('#pendList').innerHTML = items.length ? items.map((i) => `<li class="${esc(i.kind)}"><span class="pend-dot"></span>
    <div class="pend-txt"><b>${esc(i.title)}</b>${i.detail ? `<small>${esc(i.detail)}</small>` : ''}</div>
    <div class="pend-act">${i.stop ? `<button class="btn sm danger" data-pstop="${esc(i.stop)}">Stop</button>` : ''}${i.action ? `<button class="btn sm primary" data-prun="${esc(i.id)}">${esc(i.action.label)}</button>` : ''}${i.link ? `<a class="btn sm${i.kind === 'you' ? ' primary' : ''}" href="${esc(i.link)}">Open</a>` : ''}${i.kind !== 'running' && i.kind !== 'warn' && (i.action || i.kind === 'you') ? `<button class="btn sm ghost" data-pno="${esc(i.id)}" title="Hide it for today">Not today</button>` : ''}</div></li>`).join('')
    : '<li class="pend-empty">Nothing waiting – all done for now.</li>';
  const cols = [['notes', 'Notes'], ['accepted', 'Accepted'], ['followups', 'Follow-ups'], ['replies', 'Replies'], ['crm', 'Into CRM'], ['meetings', 'Meetings'], ['jobs', 'Jobs applied']];
  $('#reportTbl').innerHTML = `<thead><tr><th>Day</th>${cols.map(([, t]) => `<th>${t}</th>`).join('')}</tr></thead><tbody>${report.map((r, n) => `<tr class="${n ? '' : 'today'}"><td>${n ? shortDay(r.day) : 'Today'}</td>${cols.map(([k]) => `<td class="${r[k] ? '' : 'zero'}">${r[k]}</td>`).join('')}</tr>`).join('')}</tbody>`;
}
document.addEventListener('click', guard(async (e) => {
  const run = e.target.closest('[data-prun]');
  const no = e.target.closest('[data-pno]');
  const stop = e.target.closest('[data-pstop]');
  if (!run && !no && !stop) return;
  if (run) {
    if (run.dataset.prun === 'jobs' && !confirm('Apply to jobs now? Real applications go out with your LinkedIn resume.')) return;
    await api(`/api/pending/${run.dataset.prun}/run`, { method: 'POST' });
    toast('Started');
  } else if (no) {
    await api(`/api/pending/${no.dataset.pno}/dismiss`, { method: 'POST' });
    toast('Hidden for today');
  } else {
    await api(`/api/pending/stop/${stop.dataset.pstop}`, { method: 'POST' });
    toast('Stopping…');
  }
  setTimeout(() => loadPending().catch(() => {}), 600);
}));

loaders.dashboard = guard(async () => {
  loadPending().catch(() => {});
  const [stats, lists] = await Promise.all([api('/api/stats'), api('/api/lists')]);
  LISTS = lists;
  const b = stats.byStatus;
  $('#stPending').textContent = b.pending || 0;
  $('#stReview').textContent = b.review ? `ready to send · ${b.review} to review on Leads` : 'ready to send';
  renderStatus(stats.runner);
  const sent = b.sent || 0;
  const rate = sent ? Math.round((stats.accepted / sent) * 100) : 0;
  $('#stAccepted').textContent = stats.accepted;
  $('#stAcceptRate').textContent = `of ${sent} notes sent · ${rate}%`;
  $('#stAcceptBar').style.width = rate + '%';
  renderChart(stats.daily, stats.acceptedDaily);

  renderCampaigns();

  const box = $('#runLists');
  const checked = new Set($$('input:checked', box).map((i) => i.value));
  const active = lists.filter((l) => l.active);
  box.innerHTML = active.length
    ? active.map((l) => `<label><input type="checkbox" value="${l.id}" ${checked.has(String(l.id)) ? 'checked' : ''}/> ${esc(l.name)} <small class="muted">(${l.pending || 0} approved${l.review ? ` · ${l.review} to review` : ''})</small></label>`).join('')
    : '<span class="muted">No active lists yet – <a class="link" data-goto="lists">add one</a>.</span>';

  const logs = await api('/api/logs?limit=40');
  $('#liveLog').innerHTML = logs.map(logItem).join('');
});

// One table with every campaign's numbers – the only place run numbers appear
function renderCampaigns() {
  const box = $('#campaignTbl');
  if (!box) return;
  const run = STATUS.lastRun;
  const running = STATUS.status && STATUS.status !== 'idle' && STATUS.mode === 'connect';
  const runHead = running ? 'This run' : 'Last run';
  box.innerHTML = LISTS.length
    ? `<tr><th>Campaign</th><th>Status</th><th title="Notes sent today / this campaign's share of the daily limit">Today</th>
         <th title="Notes sent by ${running ? 'the run that is going on now' : 'the most recent run'}">${runHead}</th>
         <th>Total sent</th><th>Accepted</th><th>Acceptance rate</th></tr>` +
      LISTS.map((l) => {
        const sent = l.sent || 0;
        const acc = l.accepted || 0;
        const r = sent ? Math.round((acc / sent) * 100) : 0;
        const today = l.active ? `${l.sent_today || 0} <span class="sub">/ ${l.daily_share || 0}</span>` : `${l.sent_today || 0}`;
        const inRun = run ? run.byList[l.id] || 0 : 0;
        return `<tr><td><b>${esc(l.name)}</b><div class="sub">${esc(l.type_name || '')}</div></td>
          <td>${l.active ? '<span class="badge sent">ON</span>' : '<span class="badge">OFF</span>'}</td>
          <td>${today}</td>
          <td>${run ? inRun : '<span class="sub">—</span>'}</td>
          <td>${sent}</td>
          <td class="acc-txt"><b>${acc}</b></td>
          <td><div class="rate"><div class="bar"><div style="width:${r}%;background:var(--green)"></div></div><span>${r}%</span></div></td></tr>`;
      }).join('')
    : '<tr><td class="empty">No campaigns yet.</td></tr>';
}

function renderChart(daily, acceptedDaily = []) {
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5);
    days.push(d.toLocaleDateString('sv-SE'));
  }
  const map = Object.fromEntries(daily.map((d) => [d.day, d.sent]));
  const acc = Object.fromEntries(acceptedDaily.map((d) => [d.day, d.n]));
  const max = Math.max(1, ...days.map((d) => Math.max(map[d] || 0, acc[d] || 0)));
  $('#chart').innerHTML = days
    .map((d) => {
      const v = map[d] || 0;
      const a = acc[d] || 0;
      return `<div class="col" title="${d}: ${v} sent, ${a} accepted"><span class="v">${v || a ? `${v}/<span class="acc">${a}</span>` : ''}</span>
        <div class="pair"><div class="b" style="height:${(v / max) * 100}%"></div><div class="b acc" style="height:${(a / max) * 100}%"></div></div><span>${d.slice(8)}</span></div>`;
    })
    .join('');
}

function renderStatus(s) {
  if (!s) return;
  STATUS = s;
  notifyRunEnd(s);
  const pill = $('#runPill');
  pill.textContent = { idle: 'Idle', running: s.mode === 'sync' ? 'Syncing leads' : s.mode === 'photos' ? 'Refreshing photos' : s.mode === 'accept' ? 'Checking acceptances' : s.mode === 'inbox' ? 'Reading inbox' : s.mode === 'prospect' ? 'Finding prospects' : 'Running', paused: 'Paused', stopping: 'Stopping…' }[s.status];
  pill.className = 'status-pill ' + s.status;
  $('#stToday').textContent = s.sentToday;
  $('#stTodayOf').textContent = `notes sent of ${s.dailyLimit} daily limit`;
  $('#stTodayBar').style.width = Math.min(100, (s.sentToday / Math.max(1, s.dailyLimit)) * 100) + '%';
  renderCampaigns();
  $('#runNow').innerHTML = s.current?.search
    ? `Prospect search <b>${esc(s.current.search)}</b> → ${esc(s.current.step)}`
    : s.current
    ? `List <b>${esc(s.current.list?.name)}</b> → <b>${esc(s.current.lead?.name)}</b>`
    : s.status === 'idle' ? 'Nothing running.' : 'Working…';

  const idle = s.status === 'idle';
  $('#btnStart').disabled = !idle;
  $('#btnSync').disabled = !idle;
  $('#btnFollowups').disabled = !idle;
  $('#btnCheckReplies').disabled = !idle;
  $('#btnCrmFollowups').disabled = !idle;
  const la = [s.lastQuickAcceptance, s.lastAcceptanceCheck].filter(Boolean).sort((a, b) => (a.at < b.at ? 1 : -1))[0];
  $('#lastAccept').textContent = la ? `Acceptances checked ${la.at.slice(11, 16)} – ${la.scanned} recent connections read, ${la.found} new · checked again every ${SETTINGS.acceptance_poll_minutes || 10} min` : 'Acceptances not checked yet';
  $('#btnPause').disabled = s.status !== 'running';
  $('#btnResume').disabled = s.status !== 'paused';
  $('#btnStop').disabled = idle || s.status === 'stopping';
  const ep = $('#extPill');
  ep.textContent = s.extension ? 'Extension connected' : 'Extension not connected';
  ep.className = 'ext-pill ' + (s.extension ? 'on' : 'off');

  $('#sideStatus').innerHTML = `<div><span>Status</span><b class="st st-${s.status}">${pill.textContent}</b></div><div><span>Today</span><b>${s.sentToday}/${s.dailyLimit}</b></div><div><span>Extension</span><b>${s.extension ? 'connected' : 'offline'}</b></div>`;

  renderLimitPause(s.limitPause);
  renderSafety(s.safety);
  renderRunReport(s);

  if (s.wait) startCountdown(s.wait);
  else stopCountdown();
  if (s.prospect) PSTATUS = s.prospect;
  renderProspectRun(PSTATUS);
  if (APP === 'finder') renderFinderSide();
}

// ---------- why the last run / each list stopped ----------
const REASON_ICON = { done: '✓', info: 'ℹ', warn: '⚠', error: '✕', stopped: '■', limit: '⏸' };
const REASON_TITLE = { done: 'Run finished', info: 'Run finished', warn: 'Run stopped early', error: 'Run failed', stopped: 'Run stopped by you', limit: 'Run paused – limit reached' };
const listName = (id) => (LISTS.find((l) => l.id == id) || {}).name || `List #${id}`;
// a run that "finished" but where a list fell short is still worth a warning
function runTone(run) {
  const kinds = Object.values(run.reasons || {}).map((r) => r.kind);
  if (run.end.kind !== 'done') return run.end.kind;
  return kinds.includes('error') ? 'error' : kinds.includes('warn') ? 'warn' : 'done';
}
function reportBody(run) {
  const rows = Object.entries(run.reasons || {}).map(([id, r]) =>
    `<li class="rr-${r.kind}"><i>${REASON_ICON[r.kind] || '•'}</i><div><b>${esc(listName(id))}</b>` +
    `<span class="sub"> · ${run.byList?.[id] || 0} sent this run</span><div>${esc(r.text)}</div></div></li>`).join('');
  return `<p class="rr-end">${esc(run.end.text)} <span class="sub">· ${esc(run.end.at)}</span></p>${rows ? `<ul class="rr-list">${rows}</ul>` : ''}`;
}
const seenReport = () => { try { return localStorage.getItem('runReportSeen'); } catch { return null; } };
function renderRunReport(s) {
  const box = $('#runReport');
  const run = s.lastRun;
  if (s.status !== 'idle' || !run || !run.end || seenReport() === run.end.at) return box.classList.add('hidden');
  const tone = runTone(run);
  box.className = `run-report rr-${tone}`;
  box.innerHTML = `<div class="rr-head"><b>${REASON_ICON[tone]} ${REASON_TITLE[tone]}</b><button class="btn sm ghost" data-rr="dismiss">Dismiss</button></div>${reportBody(run)}`;
}
// popup + desktop notification the moment a sending run ends
let prevRun = null;
function notifyRunEnd(s) {
  const wasSending = prevRun && prevRun.status !== 'idle' && prevRun.mode === 'connect';
  prevRun = { status: s.status, mode: s.mode };
  const run = s.lastRun;
  if (!wasSending || s.status !== 'idle' || !run || !run.end) return;
  const tone = runTone(run);
  const lines = [run.end.text, ...Object.entries(run.reasons || {}).map(([id, r]) => `${listName(id)}: ${r.text}`)];
  try { if ('Notification' in window && Notification.permission === 'granted') new Notification(`LinkedIn bot – ${REASON_TITLE[tone]}`, { body: lines.join('\n') }); } catch {}
  if (!s.limitPause || run.end.kind !== 'limit') openModal(`${REASON_ICON[tone]} ${REASON_TITLE[tone]}`, `<div class="run-report-pop">${reportBody(run)}</div>`);
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('[data-rr="dismiss"]')) return;
  try { localStorage.setItem('runReportSeen', STATUS.lastRun.end.at); } catch {}
  $('#runReport').classList.add('hidden');
});

// ---------- LinkedIn limit -> sending on hold (lists stay Active) ----------
let limitShownAt = null;
function limitText(p) {
  if (p.kind === 'restricted') return { title: 'LinkedIn showed a security check / restriction', summary: `${p.reason || ''} Open LinkedIn yourself, solve any check it shows, and wait before resuming.` };
  if (p.kind === 'sales_nav') return { title: 'Sales Navigator subscription has ended', summary: 'All campaigns are stopped. Renew Sales Navigator, then press Start – the bot checks it works and continues by itself. Your lists, filters and leads are kept.' };
  return p.kind === 'notes'
    ? { title: 'Personalized notes limit reached', summary: 'LinkedIn says the connection notes limit is reached, so sending is on hold.' }
    : { title: 'LinkedIn weekly invitation limit reached', summary: 'LinkedIn says the weekly invitation limit is reached, so sending is on hold. It resumes by itself on Monday.' };
}
// Account safety strip on the dashboard: weekly count, pending invites, acceptance, cool-down
function renderSafety(x) {
  const bar = $('#safetyBar');
  if (!bar || !x) return;
  const warn = [];
  if (x.cooldown) warn.push(`<b>Paused for account safety until ${esc(x.cooldown.until)}</b> – ${esc(x.cooldown.reason)} <button class="btn sm" data-safety="clear">I checked LinkedIn – clear</button>`);
  if (x.lowAcceptance) warn.push(`<b>Low acceptance: ${x.acceptance.pct}%</b> of your last ${x.acceptance.sample} invitations were accepted (warning below ${x.minAcceptance}%). LinkedIn may restrict accounts whose invites are ignored – target people closer to you, improve the note, or send fewer.`);
  if (x.weeklyLimit && x.weekSent >= x.weeklyLimit) warn.push(`<b>Weekly limit reached</b> – ${x.weekSent} of ${x.weeklyLimit} this week; continues ${x.weekWindow === 'since Monday' ? 'on Monday' : 'as older invites drop out'}.`);
  if (x.maxPending && x.pending >= x.maxPending) warn.push(`<b>${x.pending} invitations still pending</b> (limit ${x.maxPending}) – sending is on hold.`);
  if (!x.workingHours) warn.push(`Outside sending hours (${esc(x.hours)}) – invitations wait until then.`);
  const pct = (a, b) => (b ? Math.min(100, Math.round((a / b) * 100)) : 0);
  bar.classList.remove('hidden');
  bar.classList.toggle('warn', warn.length > 0);
  bar.innerHTML = `<div class="sb-stats">
      <span title="Invitations sent this week (${esc(x.weekWindow)})">This week <b>${x.weekSent}${x.weeklyLimit ? ` / ${x.weeklyLimit}` : ''}</b><i class="sb-meter"><i style="width:${pct(x.weekSent, x.weeklyLimit)}%"></i></i></span>
      <span title="Sent in the last 3 weeks, not accepted yet">Pending <b>${x.pending}${x.maxPending ? ` / ${x.maxPending}` : ''}</b></span>
      <span title="Invitations sent 7–60 days ago that were accepted">Acceptance <b>${x.acceptance.pct === null ? '—' : `${x.acceptance.pct}%`}</b>${x.acceptance.sample ? ` <small>of ${x.acceptance.sample}</small>` : ' <small>(after 7 days)</small>'}</span>
      <span title="Author profiles the prospect finder opened today">Profile visits <b>${x.profileViewsToday}${x.profileViewsLimit ? ` / ${x.profileViewsLimit}` : ''}</b></span>
      <a class="link" data-goto="settings">Safety settings</a>
    </div>${warn.map((w) => `<div class="sb-warn">${w}</div>`).join('')}`;
}
document.addEventListener('click', guard(async (e) => {
  const b = e.target.closest('[data-safety="clear"]');
  if (!b) return;
  if (!confirm('Clear the safety pause? Only do this after you opened LinkedIn yourself and it works normally.')) return;
  renderStatus(await api('/api/safety/clear-cooldown', { method: 'POST' }));
}));

function renderLimitPause(p) {
  const banner = $('#limitBanner');
  if (!p) {
    banner.classList.add('hidden');
    limitShownAt = null;
    return;
  }
  const t = limitText(p);
  banner.classList.remove('hidden');
  banner.innerHTML = `<div><b>⏸ ${esc(t.title)} – sending on hold</b><div class="sub">${esc(t.summary)} Since ${esc(p.at)} · your lists stay Active</div></div>
    <div class="row gap"><button class="btn sm primary" data-limit="resume">Resume sending</button><button class="btn sm" data-limit="details">Details</button></div>`;
  if (limitShownAt !== p.at) {
    limitShownAt = p.at;
    showLimitPopup(p);
  }
}
function showLimitPopup(p) {
  const t = limitText(p);
  openModal('⏸ Sending on hold', `
    <div class="limit-pop">
      <p class="lp-title">${esc(t.title)}</p>
      <p class="lp-summary">${esc(t.summary)}</p>
      <p>LinkedIn stopped accepting more invitations, so the bot put <b>sending on hold</b> to protect your account.
         Your lists stay Active – nothing is sent until you resume (or the limit resets).</p>
      <table class="lp-facts">
        <tr><td>On hold since</td><td>${esc(p.at)}</td></tr>
        <tr><td>Sent today</td><td>${p.sent_today}</td></tr>
        <tr><td>Active lists</td><td>${p.list_names.map(esc).join('<br/>') || '—'}</td></tr>
      </table>
      <p class="sub">${p.kind === 'sales_nav'
        ? 'Your lists keep their full search filters here, so nothing has to be set up again after the renewal. Leads already sent to are never invited twice.'
        : p.kind === 'notes'
        ? 'Personalized-note quota usually resets monthly (or with Premium). Resume once LinkedIn lets you add notes again.'
        : 'LinkedIn resets the weekly limit on Monday – the hold clears itself then and the lists continue where they stopped.'}</p>
      <div class="row gap mt"><button class="btn primary" data-limit="resume">Resume sending now</button>
        <button class="btn" data-limit="close">Keep on hold</button></div>
    </div>`);
}
document.addEventListener('click', guard(async (e) => {
  const b = e.target.closest('[data-limit]');
  if (!b) return;
  const act = b.dataset.limit;
  if (act === 'details') return STATUS.limitPause && showLimitPopup(STATUS.limitPause);
  if (act === 'close') return closeModal();
  if (act === 'resume' && !confirm('Resume sending? Make sure LinkedIn lets you send invitations again.')) return;
  const s = await api(`/api/limit-pause/${act}`, { method: 'POST' });
  closeModal();
  renderStatus(s);
  toast(act === 'resume' ? 'Campaigns resumed – press Start sending' : 'Notice dismissed – lists stay OFF');
  loaders.dashboard();
}));

let cdTimer = null;
function startCountdown(w) {
  stopCountdown();
  $('#countdown').classList.remove('hidden');
  $('#cdLabel').textContent = w.reason;
  const tick = () => {
    const left = Math.max(0, (w.until - Date.now()) / 1000);
    const sec = Math.ceil(left);
    $('#cdNum').textContent = STATUS.status === 'paused' ? 'paused' : sec >= 60 ? `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s` : `${sec}s`;
    $('#cdBar').style.width = `${100 - (left / Math.max(1, w.seconds)) * 100}%`;
  };
  tick();
  cdTimer = setInterval(tick, 250);
}
function stopCountdown() {
  clearInterval(cdTimer);
  $('#countdown').classList.add('hidden');
}

const selectedListIds = () => $$('#runLists input:checked').map((i) => Number(i.value));
$('#btnStart').onclick = guard(async () => {
  try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch {}
  renderStatus(await api('/api/runner/start', { method: 'POST', body: { list_ids: selectedListIds() } }));
  toast('Started');
});
$('#btnAccept').onclick = guard(async () => {
  try {
    const r = await api('/api/acceptances/check-now', { method: 'POST' });
    renderStatus(r.status);
    toast(r.found ? `${r.found} new acceptance(s)` : 'Checked – no new acceptances yet');
  } catch {
    // older extension: read the connections page instead
    renderStatus(await api('/api/runner/check-acceptances', { method: 'POST' }));
    toast('Checking your connections page…');
  }
});
$('#btnFollowups').onclick = guard(async () => {
  renderStatus(await api('/api/runner/followups', { method: 'POST' }));
  toast('Sending the follow-ups that are due…');
});
$('#btnSync').onclick = guard(async () => {
  renderStatus(await api('/api/runner/sync', { method: 'POST', body: { list_ids: selectedListIds() } }));
  toast('Collecting leads from lists…');
});
$('#btnPause').onclick = guard(async () => renderStatus(await api('/api/runner/pause', { method: 'POST' })));
$('#btnResume').onclick = guard(async () => renderStatus(await api('/api/runner/resume', { method: 'POST' })));
$('#btnStop').onclick = guard(async () => renderStatus(await api('/api/runner/stop', { method: 'POST' })));
$('#btnBrowser').onclick = guard(async () => {
  const r = await api('/api/extension/test', { method: 'POST' });
  toast(r.loggedIn ? `Bot tab ready, logged in ✓ (${r.url.slice(0, 60)})` : 'LinkedIn is not logged in – log in in the bot tab', !r.loggedIn);
});

function logItem(l) {
  return `<li><time>${esc((l.ts || '').slice(5, 16))}</time><span class="${l.level}">${esc(l.message)}</span></li>`;
}

// ---------------- live events ----------------
function connectEvents() {
  const es = new EventSource('/api/events');
  es.addEventListener('status', (e) => {
    const s = JSON.parse(e.data);
    renderStatus(s);
    pendSoon();
    // the inbox read ended without a result (an error – it is in the Activity Log)
    if (inboxReading && s.status === 'idle') setTimeout(() => { if (inboxReading) { inboxReading = false; toast('Could not read the inbox – see the Activity Log', true); renderCrmAdd().catch(() => {}); } }, 1500);
  });
  es.addEventListener('jobs_status', (e) => {
    pendSoon();
    renderJobsRun(JSON.parse(e.data));
    if (APP === 'jobs' && (location.hash.slice(1) || 'jobs') === 'jobs') loadJobsSoon();
  });
  es.addEventListener('prospect_status', (e) => { PSTATUS = JSON.parse(e.data); renderProspectRun(PSTATUS); if (APP === 'finder') renderFinderSide(); });
  es.addEventListener('log', (e) => {
    const l = JSON.parse(e.data);
    for (const id of ['#liveLog', '#fullLog']) {
      const ul = $(id);
      ul.insertAdjacentHTML('afterbegin', logItem(l));
      while (ul.children.length > (id === '#liveLog' ? 40 : 500)) ul.lastChild.remove();
    }
  });
  let t;
  const refresh = () => {
    clearTimeout(t);
    t = setTimeout(() => {
      const v = location.hash.slice(1) || 'dashboard';
      if (v === 'dashboard' || v === 'leads' || v === 'lists') loaders[v]();
    }, 800);
  };
  es.addEventListener('extension', (e) => renderStatus({ ...STATUS, extension: JSON.parse(e.data).connected }));
  es.addEventListener('limit_pause', (e) => renderStatus({ ...STATUS, limitPause: JSON.parse(e.data) }));
  let pt;
  es.addEventListener('prospects', () => {
    clearTimeout(pt);
    pt = setTimeout(() => (location.hash.slice(1) === 'prospects') && loaders.prospects(), 800);
  });
  es.addEventListener('lead', refresh);
  let plt;
  es.addEventListener('leads', () => {
    clearTimeout(plt);
    plt = setTimeout(() => {
      if (location.hash.slice(1) === 'crm' && !document.querySelector('.crm-card.dragging')) loaders.crm();
    }, 1500);
  });
  es.addEventListener('leads', refresh);
  es.addEventListener('inbox', () => { inboxReading = false; renderCrmAdd().catch(() => {}); });
  es.onerror = () => { es.close(); setTimeout(connectEvents, 3000); };
}

const day = (ts) => (ts ? String(ts).slice(0, 16) : '');

// ---------------- CRM: all accepted leads by stage, drag & drop ----------------
const CRM_COLS = [
  { key: 'accepted', title: 'Accepted', hint: 'Chat not checked yet' },
  { key: 'not_responded', title: 'Not responded', hint: 'Follow-ups go out by date' },
  { key: 'positive', title: 'Positive', group: 'Responded' },
  { key: 'negative', title: 'Negative', group: 'Responded' },
  { key: 'other', title: 'Other', group: 'Responded' },
  { key: 'meeting', title: 'Meeting booked', hint: 'Call or meeting set' },
  { key: 'won', title: 'Won', hint: 'Deal done' },
  { key: 'closed', title: 'Closed', hint: 'No deal' },
  { key: 'cold', title: 'Cold', hint: 'No reply 7 days after the last follow-up' },
];
const CRM_LABEL = Object.fromEntries(CRM_COLS.map((c) => [c.key, c.group ? `${c.group} · ${c.title}` : c.title]));
let crmTimer;

// "Today 04:07", "Tomorrow 04:07", "Yesterday", "Oct 22" (and the year when it is not this year) – the full time is in the tooltip
function niceDate(ts) {
  if (!ts) return '';
  const d = new Date(String(ts).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return String(ts);
  const t = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 864e5);
  if (days === 0) return `Today ${t}`;
  if (days === 1) return 'Yesterday';
  if (days === -1) return `Tomorrow ${t}`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
}

function crmCard(r) {
  const link = r.chat_url || r.profile_url;
  const avatar = `<span class="crm-av">${r.photo_url ? `<img src="${esc(r.photo_url)}" alt="" loading="lazy" onerror="this.remove()">` : ''}<i>${esc(initials(r.name))}</i></span>`;
  const name = link ? `<a class="crm-name" href="${esc(link)}" target="_blank" rel="noopener" draggable="false" title="${r.chat_url ? 'Open the chat on LinkedIn' : 'Open the profile on LinkedIn'}">${esc(r.name)}</a>` : `<span class="crm-name">${esc(r.name)}</span>`;
  const role = [r.title, r.company].filter(Boolean).join(' · ');
  const chips = [];
  if (r.followup_state === 'crm') chips.push('<span class="crm-chip">Follow-ups paused</span>');
  else if (r.followup_state && r.followup_state !== 'replied') chips.push(`<span class="crm-chip warn" title="${esc(r.followup_error)}">Follow-ups stopped</span>`);
  else if (r.followup_step) chips.push(`<span class="crm-chip" title="Sent ${esc(r.followup_at || '')}">Follow-up ${r.followup_step} · ${esc(niceDate(r.followup_at))}</span>`);
  if (r.next_followup) chips.push(`<span class="crm-chip next" title="The bot sends it by itself">Next: FU ${r.next_followup.step} · ${esc(niceDate(r.next_followup.due))}</span>`);
  const move = `<select class="crm-move" data-crm-move="${r.id}" title="Move to another stage" aria-label="Move ${esc(r.name)} to another stage">
      <option value="">⋯</option>${CRM_COLS.filter((c) => c.key !== r.stage).map((c) => `<option value="${c.key}">${esc(CRM_LABEL[c.key])}</option>`).join('')}
      ${!r.added && r.stage_by === 'you' ? '<option value="auto">Let the bot place it</option>' : ''}<option value="remove">Remove from CRM</option></select>`;
  return `<article class="crm-card" draggable="true" data-crm-id="${r.id}">
      <header class="crm-card-head">${avatar}<div class="crm-who">${name}<div class="crm-role" title="${esc(role)}">${esc(role) || '&nbsp;'}</div></div></header>
      ${r.reply_text
        ? `<blockquote class="crm-quote" title="Click the card to read the whole message"><span class="crm-qt">${esc(r.reply_text)}</span></blockquote>`
        : '<blockquote class="crm-quote empty">No reply yet</blockquote>'}
      <div class="crm-chips">${chips.join('')}</div>
      <footer class="crm-card-foot">
        <span class="crm-meta" title="${r.added ? 'You added this person yourself' : `Campaign: ${esc(r.list_name || '—')}`}">${r.added ? `Added ${esc(niceDate(r.created_at))}` : r.replied_at ? `Replied ${esc(niceDate(r.replied_at))}` : `Accepted ${esc(niceDate(r.accepted_at))}`}${$('#crmList').value || r.added ? '' : `<span class="crm-camp"> · ${esc(r.list_name || '—')}</span>`}</span>
        <span class="crm-actions"><span class="crm-by ${r.stage_by}" title="${r.stage_by === 'you' ? 'You put this lead here' : 'The bot put this lead here from the chat'}">${r.stage_by === 'you' ? 'Manual' : 'Auto'}</span>${move}</span>
      </footer>
    </article>`;
}

loaders.crm = guard(async () => {
  const listId = $('#crmList').value;
  const q = $('#crmQ').value.trim();
  const b = await api(`/api/crm?${new URLSearchParams({ list_id: listId, q })}`);
  $('#crmList').innerHTML = `<option value="">All campaigns</option>${b.lists.map((l) => `<option value="${l.id}" ${String(l.id) === listId ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}`;
  // numbers for the campaign chosen (or all): notes sent → accepted → replied
  const st = b.stats;
  const pct = (x, y) => (y ? `${Math.round((x / y) * 100)}%` : '—');
  const plan = st.type_name
    ? `<b>${esc(st.type_name)}</b> · ${st.followups.length
      ? st.followups.map((f) => `Follow-up ${f.step}: ${f.delay_days} day${f.delay_days == 1 ? '' : 's'} after ${f.step === 1 ? 'accepting' : `follow-up ${f.step - 1}`}${f.active ? '' : ' (off)'}`).map(esc).join(' <span class="crm-sep">→</span> ')
      : 'no follow-ups – add them in Message Types'}`
    : 'Showing all campaigns – pick one to see its follow-up plan';
  const tile = (value, label, sub = '', cls = '') => `<div class="crm-stat ${cls}"><span>${label}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
  $('#crmSummary').innerHTML = `
    <div class="crm-stats">
      ${tile(st.sent, 'Notes sent', `${st.waiting} waiting to accept`)}
      ${tile(st.accepted, 'Accepted', `${pct(st.accepted, st.sent)} of notes`)}
      ${tile(st.replied, 'Replied', `${pct(st.replied, st.accepted)} of accepted`)}
      ${tile(b.counts.positive, 'Positive', 'want to talk', 'pos')}
      ${tile(b.counts.meeting, 'Meetings', 'booked', 'meet')}
      ${tile(b.counts.won, 'Won', 'deals', 'won')}
    </div>
    <div class="crm-plan"><span class="crm-plan-label">Follow-up plan</span>${plan}</div>`;
  const col = (c) => `
    <section class="crm-col crm-${c.key}" data-crm-stage="${c.key}">
      <header class="crm-col-head"><span class="crm-dot"></span><b>${c.title}</b><span class="crm-count">${b.counts[c.key]}</span></header>
      ${c.hint ? `<p class="crm-hint">${c.hint}</p>` : ''}
      <div class="crm-cards">${b.stages[c.key].map(crmCard).join('') || '<div class="crm-empty">Drop a lead here</div>'}</div>
    </section>`;
  const replied = CRM_COLS.filter((c) => c.group);
  $('#crmBoard').innerHTML = `
    ${CRM_COLS.slice(0, 2).map(col).join('')}
    <div class="crm-group"><div class="crm-group-head"><b>Responded</b><span class="crm-count">${replied.reduce((n, c) => n + b.counts[c.key], 0)}</span></div>
      <div class="crm-group-cols">${replied.map(col).join('')}</div></div>
    ${CRM_COLS.slice(5).map(col).join('')}`;
});

async function crmMove(id, stage) {
  if (stage === 'remove') {
    if (!confirm('Remove this person from the CRM for good? The bot will not add them again or send them follow-ups. (Nothing changes on LinkedIn.)')) return loaders.crm();
    await api(`/api/crm/${id}`, { method: 'DELETE' });
    toast('Removed from the CRM');
    return loaders.crm();
  }
  await api(`/api/crm/${id}/stage`, { method: 'POST', body: { stage } });
  toast(stage === 'auto' ? 'The bot places this lead again' : `Moved to ${CRM_LABEL[stage]}`);
  loaders.crm();
}
$('#crmList').onchange = () => loaders.crm();
$('#btnCheckReplies').onclick = guard(async () => {
  const listId = Number($('#crmList').value);
  renderStatus(await api('/api/runner/check-replies', { method: 'POST', body: { list_ids: listId ? [listId] : [] } }));
  toast('Checking the chats of people who have not replied…');
});
$('#btnCrmFollowups').onclick = guard(async () => {
  renderStatus(await api('/api/runner/followups', { method: 'POST' }));
  toast('Sending the follow-ups that are due…');
});
$('#crmQ').addEventListener('input', () => { clearTimeout(crmTimer); crmTimer = setTimeout(loaders.crm, 300); });

// ---- add people the bot did not contact: from your LinkedIn inbox, or by hand ----
const stageSelect = (name, value) => `<select name="${name}">${CRM_COLS.map((c) => `<option value="${c.key}" ${c.key === value ? 'selected' : ''}>${esc(CRM_LABEL[c.key])}</option>`).join('')}</select>`;
let crmAddTab = 'inbox';
let inboxReading = false;

async function renderCrmAdd() {
  const body = $('#crmAddBody');
  if (!body) return;
  $$('[data-crm-add-tab]').forEach((b) => b.classList.toggle('on', b.dataset.crmAddTab === crmAddTab));
  if (crmAddTab === 'manual') {
    body.innerHTML = `
      <form id="crmManual" class="crm-add-form">
        <label>Name<input name="name" required placeholder="Full name" autocomplete="off"></label>
        <label>LinkedIn profile or chat link<input name="link" placeholder="https://www.linkedin.com/in/… or /messaging/thread/…" autocomplete="off"></label>
        <div class="crm-add-two"><label>Title<input name="title" placeholder="optional"></label><label>Company<input name="company" placeholder="optional"></label></div>
        <label>Stage${stageSelect('stage', 'meeting')}</label>
        <div class="crm-add-foot"><span class="muted">Nothing is sent – they only go on the board.</span><button class="btn primary">Add to CRM</button></div>
      </form>`;
    $('#crmManual input[name=name]').focus();
    return;
  }
  const scan = await api('/api/crm/inbox');
  const busyNow = inboxReading || (STATUS.status !== 'idle' && STATUS.mode === 'inbox');
  const head = `<div class="crm-inbox-head">
      <span class="muted">${busyNow ? '<span class="spin"></span> Reading your inbox in the bot tab… (nothing is sent or marked as read by you)'
        : scan.at ? `Inbox read ${esc(niceDate(scan.at))} · ${scan.items.length} chats` : 'The bot opens your LinkedIn inbox in its hidden tab and lists your latest chats. Nothing is sent.'}</span>
      <button class="btn" id="btnReadInbox" ${busyNow ? 'disabled' : ''}>${scan.at ? 'Read again' : 'Read my inbox'}</button></div>`;
  if (!scan.items.length) { body.innerHTML = head; return; }
  const row = (it, i) => `
    <label class="crm-inbox-row ${it.in_crm ? 'in' : ''}">
      <input type="checkbox" data-inbox="${i}" ${it.in_crm ? 'disabled' : ''}>
      <span class="crm-av">${it.photo_url ? `<img src="${esc(it.photo_url)}" alt="" loading="lazy" onerror="this.remove()">` : ''}<i>${esc(initials(it.name))}</i></span>
      <span class="crm-inbox-who"><b>${esc(it.name)}${it.unread ? ' <em class="crm-unread">new</em>' : ''}${it.removed ? ' <em class="crm-removed" title="You removed them from the CRM – the bot does not add them again">removed</em>' : ''}</b><small title="${esc(it.snippet)}">${esc(it.snippet)}</small></span>
      <span class="crm-inbox-time" title="${esc(it.time)}">${esc(niceDate(it.time))}</span>
      ${it.in_crm ? '<span class="crm-by you">In CRM</span>' : stageSelect(`stage-${i}`, it.mine ? 'not_responded' : 'other')}
    </label>`;
  // people already on the board go last, folded away
  const fresh = scan.items.map((it, i) => [it, i]).filter(([it]) => !it.in_crm);
  const known = scan.items.map((it, i) => [it, i]).filter(([it]) => it.in_crm);
  body.innerHTML = `${head}
    <div class="crm-inbox-list">${fresh.map(([it, i]) => row(it, i)).join('') || '<div class="crm-empty">Everyone in these chats is in the CRM already</div>'}
      ${known.length ? `<details class="crm-inbox-known"><summary>${known.length} already in the CRM</summary>${known.map(([it, i]) => row(it, i)).join('')}</details>` : ''}</div>
    <div class="crm-add-foot"><span class="muted" id="inboxPicked">Tick the people to add</span><button class="btn primary" id="btnInboxAdd" disabled>Add to CRM</button></div>`;
  body.dataset.items = JSON.stringify(scan.items);
}

$('#btnCrmAdd').onclick = () => {
  openModal('Add people to the CRM', `
    <div class="pr-tablist crm-add-tabs"><button data-crm-add-tab="inbox">From your inbox</button><button data-crm-add-tab="manual">By hand</button></div>
    <div id="crmAddBody" class="crm-add-body"></div>`);
  $('#modalBg .modal').classList.add('wide');
  renderCrmAdd().catch((e) => toast(e.message, true));
};
document.addEventListener('click', guard(async (e) => {
  const tab = e.target.closest('[data-crm-add-tab]');
  if (tab) { crmAddTab = tab.dataset.crmAddTab; return renderCrmAdd(); }
  if (e.target.closest('#btnReadInbox')) {
    inboxReading = true;
    try {
      renderStatus(await api('/api/crm/inbox/read', { method: 'POST', body: { max: 100 } }));
    } catch (err) {
      inboxReading = false;
      throw new Error(/Already running/.test(err.message) ? 'The bot is busy right now – read the inbox once it is idle' : err.message);
    }
    return renderCrmAdd();
  }
  if (e.target.closest('#btnInboxAdd')) {
    const items = JSON.parse($('#crmAddBody').dataset.items || '[]');
    const people = $$('[data-inbox]:checked').map((c) => {
      const i = Number(c.dataset.inbox);
      return { ...items[i], link: items[i].chat_url, stage: $(`[name="stage-${i}"]`).value };
    });
    await api('/api/crm/add', { method: 'POST', body: { people } });
    toast(`${people.length} added to the CRM`);
    closeModal();
    loaders.crm();
  }
}));
document.addEventListener('change', (e) => {
  if (!e.target.matches('[data-inbox]')) return;
  const n = $$('[data-inbox]:checked').length;
  $('#btnInboxAdd').disabled = !n;
  $('#inboxPicked').textContent = n ? `${n} selected` : 'Tick the people to add';
});
document.addEventListener('submit', guard(async (e) => {
  if (e.target.id !== 'crmManual') return;
  e.preventDefault();
  const person = Object.fromEntries(new FormData(e.target));
  await api('/api/crm/add', { method: 'POST', body: { people: [person] } });
  toast(`${person.name} added to the CRM`);
  closeModal();
  loaders.crm();
}));
// every card is the same size (a long message shows its first 2 lines) – a click opens the whole message
document.addEventListener('click', (e) => {
  const card = e.target.closest('.crm-card');
  if (!card || e.target.closest('a, select, button')) return;
  card.classList.toggle('open');
});
document.addEventListener('change', guard(async (e) => {
  const sel = e.target.closest('[data-crm-move]');
  if (sel && sel.value) await crmMove(sel.dataset.crmMove, sel.value);
}));
// drag & drop between columns
document.addEventListener('dragstart', (e) => {
  const card = e.target.closest && e.target.closest('[data-crm-id]');
  if (!card) return;
  e.dataTransfer.setData('text/plain', card.dataset.crmId);
  e.dataTransfer.effectAllowed = 'move';
  card.classList.add('dragging');
});
document.addEventListener('dragend', (e) => e.target.closest && e.target.closest('[data-crm-id]')?.classList.remove('dragging'));
// while a card is dragged near an edge, the board scrolls by itself (sideways to the next stages, up / down the
// page) – the closer to the edge, the faster
const dragScroll = { x: 0, y: 0, raf: 0 };
function dragScrollStep() {
  const card = document.querySelector('.crm-card.dragging');
  const board = $('#crmBoard');
  if (!card || !board) { dragScroll.raf = 0; return; }
  const EDGE = 90;
  const speed = (d) => (d < EDGE ? Math.ceil(((EDGE - d) / EDGE) ** 2 * 28) : 0);
  const r = board.getBoundingClientRect();
  const left = Math.max(r.left, 0);
  const right = Math.min(r.right, innerWidth);
  if (dragScroll.y >= r.top && dragScroll.y <= r.bottom) board.scrollLeft += speed(right - dragScroll.x) - speed(dragScroll.x - left);
  scrollBy(0, speed(innerHeight - dragScroll.y) - speed(dragScroll.y));
  dragScroll.raf = requestAnimationFrame(dragScrollStep);
}
document.addEventListener('dragover', (e) => {
  if (!document.querySelector('.crm-card.dragging')) return;
  dragScroll.x = e.clientX;
  dragScroll.y = e.clientY;
  if (!dragScroll.raf) dragScroll.raf = requestAnimationFrame(dragScrollStep);
});
document.addEventListener('dragover', (e) => {
  const col = e.target.closest && e.target.closest('[data-crm-stage]');
  if (!col) return;
  e.preventDefault();
  $$('.crm-col.over').forEach((c) => c !== col && c.classList.remove('over'));
  col.classList.add('over');
});
document.addEventListener('dragleave', (e) => {
  const col = e.target.closest && e.target.closest('[data-crm-stage]');
  if (col && !col.contains(e.relatedTarget)) col.classList.remove('over');
});
document.addEventListener('drop', guard(async (e) => {
  const col = e.target.closest && e.target.closest('[data-crm-stage]');
  if (!col) return;
  e.preventDefault();
  col.classList.remove('over');
  const id = e.dataTransfer.getData('text/plain');
  const card = id && document.querySelector(`[data-crm-id="${id}"]`);
  if (!card || card.closest('[data-crm-stage]') === col) return;
  await crmMove(id, col.dataset.crmStage);
}));

// ---------------- message types & connection-note variants ----------------
const VARS = ['{first_name}', '{last_name}', '{full_name}', '{company}', '{title}', '[Hi|Hello|Hey]'];

loaders.types = guard(async () => {
  TYPES = await api('/api/types');
  $('#typesGrid').innerHTML = TYPES.length
    ? TYPES.map((t) => {
        const on = t.variants.filter((v) => v.active).length;
        return `
      <div class="card type-card">
        <div class="row between"><h4>${esc(t.name)}</h4><span class="badge">${t.list_count} list${t.list_count == 1 ? '' : 's'}</span></div>
        <div class="meta">${t.description ? esc(t.description) + ' · ' : ''}${on} of ${t.variants.length} note${t.variants.length == 1 ? '' : 's'} ON${t.list_names ? ` · used by ${esc(t.list_names)}` : ''}</div>
        <div class="variants">
          ${t.variants.map((v, i) => `
            <div class="variant ${v.active ? '' : 'off'}">
              <div class="row between">
                <b>${esc(v.label || `Note ${i + 1}`)}</b>
                <div class="row gap"><span class="sub">${v.sent} sent · <span class="acc-txt">${v.accepted} accepted${v.sent ? ` (${Math.round((v.accepted / v.sent) * 100)}%)` : ''}</span></span>
                  <label class="toggle" title="Use this note"><input type="checkbox" data-variant="${v.id}" ${v.active ? 'checked' : ''}/><span></span></label></div>
              </div>
              <div class="msg">${esc(v.body)}</div>
            </div>`).join('')}
        </div>
        ${followupSummary(t)}
        <div class="row gap"><button class="btn sm primary" data-edit-type="${t.id}">Edit notes</button><button class="btn sm danger" data-del-type="${t.id}">Delete</button></div>
      </div>`;
      }).join('')
    : '<div class="card empty">No message types yet. Click <b>+ Add message type</b>.</div>';
});

const FU_DEFAULT_DAYS = [1, 3, 5];
const fuWhen = (step, days) => `${days} day${days == 1 ? '' : 's'} after ${step === 1 ? 'they accept' : `follow-up ${step - 1}`}`;
function followupSummary(t) {
  const fs = t.followups || [];
  if (!fs.length) return '<div class="sub fu-none">No follow-ups – <a class="link" data-edit-type="' + t.id + '">add up to 3</a> for people who accept</div>';
  return `<div class="variants">${fs.map((f) => `
    <div class="variant ${f.active ? '' : 'off'}">
      <div class="row between fu-head"><b>Follow-up ${f.step}</b><span class="sub">${fuWhen(f.step, f.delay_days)} · ${f.sent} sent · ${f.replied} replied</span></div>
      <div class="msg">${esc(f.body)}</div>
    </div>`).join('')}</div>`;
}
function followupBlock(f = {}, i = 0) {
  const step = i + 1;
  const days = f.delay_days ?? FU_DEFAULT_DAYS[i];
  return `
    <div class="variant-edit fu-edit ${f.active === 0 ? 'off' : ''}">
      <div class="ve-head">
        <b class="fu-step">Follow-up ${step}</b>
        <label class="fu-days">send <input type="number" class="fu-delay" min="0" max="60" step="0.5" value="${esc(days)}" /> days after ${step === 1 ? 'they accept' : `follow-up ${step - 1}`}</label>
        <label class="toggle" title="ON = this follow-up is sent"><input type="checkbox" class="ve-active" ${f.active === 0 ? '' : 'checked'}/><span></span></label>
      </div>
      <textarea class="ve-body" rows="4" placeholder="${step === 1 ? 'Thanks for connecting, {first_name}! …' : 'Leave empty for no follow-up ' + step}">${esc(f.body)}</textarea>
      <div class="vars">${VARS.map((x) => `<button type="button" data-ins="${esc(x)}">${esc(x)}</button>`).join('')}</div>
    </div>`;
}

function variantBlock(v = {}, i = 0) {
  return `
    <div class="variant-edit ${v.active === 0 ? 'off' : ''}" data-vid="${v.id || ''}">
      <div class="ve-head">
        <input class="ve-label" placeholder="Note ${i + 1}" value="${esc(v.label)}" />
        <label class="toggle" title="ON = this note is used"><input type="checkbox" class="ve-active" ${v.active === 0 ? '' : 'checked'}/><span></span></label>
        <button type="button" class="btn sm danger ve-del" title="Delete this note">✕</button>
      </div>
      <textarea class="ve-body" rows="5" placeholder="Hi {first_name}, ...">${esc(v.body)}</textarea>
      <div class="vars">${VARS.map((x) => `<button type="button" data-ins="${esc(x)}">${esc(x)}</button>`).join('')}</div>
      <div class="preview ve-preview"></div>
    </div>`;
}

function typeForm(t = { variants: [] }) {
  const vs = t.variants && t.variants.length ? t.variants : [{}];
  openModal(t.id ? `Edit "${t.name}"` : 'New message type', `
    <form class="form" id="typeForm">
      <div class="grid-2">
        <label>Type name<input name="name" required value="${esc(t.name)}" placeholder="e.g. Bookkeepers, CPAs" /></label>
        <label>Description <small class="inline">optional</small><input name="description" value="${esc(t.description)}" /></label>
      </div>
      <div class="row between ve-title">
        <b>Connection notes</b>
        <span class="sub">Each lead gets one ON note – they rotate evenly. Preview uses: Martin Fletcher, Modern Back Office Co.</span>
      </div>
      <div id="veList">${vs.map((v, i) => variantBlock(v, i)).join('')}</div>
      <button type="button" class="btn" id="veAdd">+ Add another note</button>
      <div class="row between ve-title">
        <b>Follow-up messages</b>
        <span class="sub">Only to people who accepted this type's note. Stops as soon as they reply. Leave a box empty for fewer follow-ups.</span>
      </div>
      <div id="fuList">${[0, 1, 2].map((i) => followupBlock((t.followups || [])[i], i)).join('')}</div>
      <div class="row gap mt"><button class="btn primary">Save</button><button type="button" class="btn" onclick="closeModal()">Cancel</button></div>
    </form>`);

  const f = $('#typeForm');
  const list = $('#veList');
  const timers = new WeakMap();

  const preview = (block) => {
    clearTimeout(timers.get(block));
    timers.set(block, setTimeout(guard(async () => {
      const body = $('.ve-body', block).value;
      const box = $('.ve-preview', block);
      if (!body.trim()) { box.innerHTML = '<span class="muted">Type the note…</span>'; return; }
      const p = await api('/api/preview', { method: 'POST', body: { body } });
      const v = p.variants[0];
      box.innerHTML = `${esc(v.text)}<span class="cnt ${v.over ? 'over' : ''}">${v.length}/${p.max} characters${v.over ? ' – too long, will be trimmed' : ''}</span>`;
    }), 250));
  };
  const renumber = () => $$('.variant-edit', list).forEach((b, i) => ($('.ve-label', b).placeholder = `Note ${i + 1}`));
  const wire = (block) => {
    const ta = $('.ve-body', block);
    ta.addEventListener('input', () => preview(block));
    $('.ve-active', block).addEventListener('change', (e) => block.classList.toggle('off', !e.target.checked));
    $('.ve-del', block).onclick = () => {
      if ($$('.variant-edit', list).length === 1) return toast('Keep at least one note', true);
      if (ta.value.trim() && !confirm('Delete this note?')) return;
      block.remove();
      renumber();
    };
    $$('[data-ins]', block).forEach((b) => (b.onclick = () => {
      const x = b.dataset.ins;
      const s = ta.selectionStart;
      ta.value = ta.value.slice(0, s) + x + ta.value.slice(ta.selectionEnd);
      ta.focus();
      ta.selectionStart = ta.selectionEnd = s + x.length;
      preview(block);
    }));
    preview(block);
  };
  $$('.variant-edit', list).forEach(wire);
  $$('.fu-edit').forEach((block) => {
    const ta = $('.ve-body', block);
    $('.ve-active', block).addEventListener('change', (e) => block.classList.toggle('off', !e.target.checked));
    $$('[data-ins]', block).forEach((b) => (b.onclick = () => {
      const x = b.dataset.ins;
      const at = ta.selectionStart;
      ta.value = ta.value.slice(0, at) + x + ta.value.slice(ta.selectionEnd);
      ta.focus();
      ta.selectionStart = ta.selectionEnd = at + x.length;
    }));
  });
  $('#veAdd').onclick = () => {
    list.insertAdjacentHTML('beforeend', variantBlock({}, $$('.variant-edit', list).length));
    const block = list.lastElementChild;
    wire(block);
    $('.ve-body', block).focus();
  };

  f.onsubmit = guard(async (e) => {
    e.preventDefault();
    const variants = $$('.variant-edit', list).map((b) => ({
      id: b.dataset.vid ? Number(b.dataset.vid) : undefined,
      label: $('.ve-label', b).value,
      body: $('.ve-body', b).value,
      active: $('.ve-active', b).checked,
    }));
    const followups = $$('.fu-edit').map((b) => ({ body: $('.ve-body', b).value, delay_days: Number($('.fu-delay', b).value), active: $('.ve-active', b).checked }));
    const body = { name: f.name.value, description: f.description.value, variants, followups };
    await api(t.id ? `/api/types/${t.id}` : '/api/types', { method: t.id ? 'PUT' : 'POST', body });
    closeModal();
    toast('Message type saved');
    loaders.types();
    if ((location.hash.slice(1) || 'dashboard') === 'lists') loaders.lists();
  });
}
window.closeModal = closeModal;
$('#btnAddType').onclick = () => typeForm();
$('#typesGrid').addEventListener('click', guard(async (e) => {
  const tg = e.target.closest('[data-variant]');
  if (tg && e.target.matches('input')) {
    try {
      await api(`/api/variants/${tg.dataset.variant}`, { method: 'PATCH', body: { active: tg.checked } });
      toast(tg.checked ? 'Note ON' : 'Note OFF');
    } catch (err) {
      tg.checked = true;
      throw err;
    }
    return loaders.types();
  }
  const ed = e.target.closest('[data-edit-type]');
  const del = e.target.closest('[data-del-type]');
  if (ed) typeForm(await api(`/api/types/${ed.dataset.editType}`));
  if (del && confirm('Delete this message type and all its notes? Lists using it will need a new type.')) {
    await api(`/api/types/${del.dataset.delType}`, { method: 'DELETE' });
    loaders.types();
  }
}));

// ---------------- lists ----------------
loaders.lists = guard(async () => {
  [LISTS, TYPES] = await Promise.all([api('/api/lists'), api('/api/types')]);
  LISTS = LISTS.filter((l) => l.url !== 'direct'); // the hidden list behind "Send connection note" on the Prospects page
  const sum = (k) => LISTS.reduce((n, l) => n + (l[k] || 0), 0);
  const sentAll = sum('sent');
  $('#listsSummary').innerHTML = LISTS.length ? [
    ['Lists', LISTS.length, `${LISTS.filter((l) => l.active).length} ON`],
    ['Leads', sum('total'), `${sum('pending')} waiting`],
    ['Notes sent', sentAll, `${sum('skipped')} skipped · ${sum('failed')} failed`],
    ['Accepted', sum('accepted'), sentAll ? `${Math.round((sum('accepted') / sentAll) * 100)}% of sent` : 'nothing sent yet', 'acc'],
  ].map(([k, v, s, c]) => `<div class="ls-sum ${c || ''}"><span>${k}</span><b>${v}</b><small>${s}</small></div>`).join('') : '';

  $('#listsTbl').innerHTML = LISTS.length ? LISTS.map(listCard).join('')
    : `<div class="card ls-empty"><div class="ls-empty-ico">☰</div><b>No lists yet</b><p class="muted">Click <b>+ Add list</b> and paste a Sales Navigator saved search URL.</p></div>`;
});

function listCard(l) {
  const sent = l.sent || 0, acc = l.accepted || 0, total = l.total || 0;
  const rate = sent ? Math.round((acc / sent) * 100) : 0;
  // stacked bar of where every collected lead ended up
  const seg = (n, c, t) => (n && total ? `<i class="${c}" style="width:${(n / total) * 100}%" title="${t}: ${n}"></i>` : '');
  const host = (() => { try { const u = new URL(l.url); return u.pathname.includes('/lists/') ? 'Open lead list' : u.pathname.includes('/search') ? 'Open search' : 'Open link'; } catch { return 'Link'; } })();
  return `
    <div class="card ls-card ${l.active ? 'on' : 'off'}">
      <div class="ls-top">
        <label class="toggle" title="${l.active ? 'Active – click to pause' : 'Paused – click to make Active'}"><input type="checkbox" data-active="${l.id}" ${l.active ? 'checked' : ''}/><span></span></label>
        <div class="ls-title">
          <h4>${esc(l.name)}</h4>
          <div class="ls-meta">
            ${l.type_name ? `<button class="chip type" ${l.type_id ? `data-notes="${l.type_id}"` : ''} title="Edit the connection notes">✉ ${esc(l.type_name)}</button>` : '<span class="chip bad">No message type – pick one</span>'}
            <a class="chip link-chip" href="${esc(l.url)}" target="_blank" title="${esc(l.url)}">↗ ${host}</a>
            ${l.target_countries ? `<span class="chip" title="Only people living here get a note">${esc(l.target_countries)}</span>` : ''}
          </div>
        </div>
        <span class="ls-state">${l.active ? 'Active' : 'Paused'}</span>
      </div>
      ${l.notes ? `<p class="ls-notes">${esc(l.notes)}</p>` : ''}

      <div class="ls-stats">
        <div><b>${total}</b><span>Leads</span></div>
        <div><b>${l.pending || 0}</b><span>Approved${l.review ? ` · <a href="#" data-review="${l.id}">${l.review} to review</a>` : ''}</span></div>
        <div><b>${sent}</b><span>Sent</span></div>
        <div class="acc"><b>${acc}</b><span>Accepted${sent ? ` · ${rate}%` : ''}</span></div>
      </div>

      <div class="ls-stack" ${total ? '' : 'data-empty'}>
        ${seg(acc, 's-acc', 'Accepted')}${seg(sent - acc, 's-sent', 'Sent, not accepted yet')}${seg(l.pending, 's-pend', 'Waiting')}${seg(l.skipped, 's-skip', 'Skipped')}${seg(l.failed, 's-fail', 'Failed')}
      </div>
      <div class="ls-legend">
        <span><i class="s-acc"></i>Accepted</span><span><i class="s-sent"></i>Sent</span><span><i class="s-pend"></i>Waiting</span>
        <span><i class="s-skip"></i>Skipped ${l.skipped || 0}</span><span><i class="s-fail"></i>Failed ${l.failed || 0}</span>
      </div>

      ${limitBlock(l)}
      ${lastReason(l)}

      <div class="ls-foot">
        <span class="sub">⟳ Synced ${esc(l.last_synced_at || 'never')}</span>
        <div class="row gap">
          <button class="btn sm" data-leads="${l.id}">Leads</button>
          <button class="btn sm" data-edit-list="${l.id}">Edit</button>
          <button class="btn sm icon danger" data-del-list="${l.id}" title="Delete list">Delete</button>
        </div>
      </div>
    </div>`;
}

function lastReason(l) {
  const r = STATUS.lastRun?.reasons?.[l.id];
  if (!r) return '';
  return `<div class="ls-reason rr-${r.kind}"><i>${REASON_ICON[r.kind] || '•'}</i><div><b>Last run stopped:</b> ${esc(r.text)} <span class="sub">· ${esc(r.at)}</span></div></div>`;
}

function limitBlock(l) {
  if (!l.active) return `<div class="ls-limit"><div class="ls-limit-row"><span>Today <b>${l.sent_today || 0}</b> sent</span><span class="muted">paused</span></div></div>`;
  const share = l.daily_share || 0;
  const sent = l.sent_today || 0;
  const label = l.send_limit ? 'Daily limit' : 'Today (share of daily limit)';
  const done = share > 0 && sent >= share;
  const pct = share ? Math.min(100, (sent / share) * 100) : 0;
  return `<div class="ls-limit ${done ? 'done' : ''}">
    <div class="ls-limit-row"><span>${label} <b>${sent} / ${share}</b>${done ? ' <span class="badge sent">done for today</span>' : ''}</span><span class="muted">resets at midnight</span></div>
    <div class="bar"><div style="width:${pct}%"></div></div>
  </div>`;
}

function listForm(l = { active: 1, send_limit: 0, review_first: 1, sync_target: 100 }) {
  if (!TYPES.length) return toast('Create a message type first', true);
  openModal(l.id ? 'Edit list' : 'Add list', `
    <form class="form" id="listForm">
      <label>List name<input name="name" required value="${esc(l.name)}" placeholder="e.g. US Bookkeepers – contractors" /></label>
      <label>Sales Navigator URL
        <input name="url" required value="${esc(l.url)}" placeholder="https://www.linkedin.com/sales/search/people?query=(...filters...)" />
        <small>Run the search with your filters in Sales Navigator and copy the address bar – the filters are inside the link, so it keeps working after Sales Navigator deletes saved searches.</small>
      </label>
      <div class="grid-2">
        <label>Message type
          <select name="type_id" required>${TYPES.map((t) => `<option value="${t.id}" ${t.id == l.type_id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
          <small>the connection notes this list uses</small>
        </label>
        <label>Active
          <select name="active"><option value="1" ${l.active ? 'selected' : ''}>Active</option><option value="0" ${!l.active ? 'selected' : ''}>Paused</option></select>
          <small>only Active lists are processed – only you pause a list</small>
        </label>
        <label>Daily notes limit<input type="number" name="send_limit" min="0" value="${l.send_limit || 0}" /><small>max notes per day for this list – resets at midnight, the list stays ON. 0 = equal share of the daily limit in Settings.</small></label>
        <label>Before sending
          <select name="review_first"><option value="1" ${l.review_first ? 'selected' : ''}>I review new leads first</option><option value="0" ${!l.review_first ? 'selected' : ''}>Send right away (no review)</option></select>
          <small>review: only leads you approve on the Leads page get a note</small>
        </label>
        <label>Leads to keep ready<input type="number" name="sync_target" min="25" max="2500" step="25" value="${l.sync_target || 100}" /><small>the bot syncs Sales Navigator by itself until this many new leads are ready</small></label>
      </div>
      <label>Skip people whose title or company contains <small class="inline">comma separated · they are skipped automatically, also without review</small>
        <input name="skip_keywords" value="${esc(l.skip_keywords || '')}" placeholder="e.g. student, intern, freelance, recruiter" />
      </label>
      <label>Target countries <small class="inline">only people who live here get a note · empty = everyone</small>
        <input name="target_countries" list="countryList" value="${esc(l.target_countries || '')}" placeholder="United States, Canada" />
        <datalist id="countryList"><option value="United States"><option value="Canada"><option value="United States, Canada"><option value="United Kingdom"><option value="Australia"></datalist>
        <small id="locPreview"></small>
      </label>
      <label>Comments <small class="inline">for your own reference</small><input name="notes" value="${esc(l.notes)}" /></label>
      <div class="row gap"><button class="btn primary">Save</button><button type="button" class="btn" onclick="closeModal()">Cancel</button></div>
    </form>`);
  const f = $('#listForm');
  const locPreview = guard(async () => {
    const box = $('#locPreview');
    if (!l.id) return (box.textContent = 'Saved lists show here how many waiting leads would be skipped.');
    if (!f.target_countries.value.trim()) return (box.textContent = 'No country filter – every lead in this list can get a note.');
    const r = await api('/api/location-check', { method: 'POST', body: { list_id: l.id, target_countries: f.target_countries.value } });
    box.innerHTML = `<b>${r.skip}</b> of ${r.waiting} waiting leads live outside these countries and will be skipped` +
      (r.unclear ? ` · ${r.unclear} have an unclear location (see Settings)` : '') +
      (r.examples.length ? `<br/>e.g. ${r.examples.map((x) => esc(x.location || 'no location')).slice(0, 4).join(' · ')}` : '');
  });
  let lt;
  f.target_countries.addEventListener('input', () => { clearTimeout(lt); lt = setTimeout(locPreview, 400); });
  locPreview();
  f.onsubmit = guard(async (e) => {
    e.preventDefault();
    const body = { name: f.name.value, url: f.url.value, type_id: Number(f.type_id.value), review_first: f.review_first.value === '1', sync_target: Number(f.sync_target.value) || 100, skip_keywords: f.skip_keywords.value, send_limit: Number(f.send_limit.value) || 0, target_countries: f.target_countries.value, active: f.active.value === '1', notes: f.notes.value };
    await api(l.id ? `/api/lists/${l.id}` : '/api/lists', { method: l.id ? 'PUT' : 'POST', body });
    closeModal();
    toast('List saved');
    loaders.lists();
  });
}
$('#btnAddList').onclick = guard(async () => { TYPES = await api('/api/types'); listForm(); });
$('#listsTbl').addEventListener('click', guard(async (e) => {
  const t = e.target;
  if (t.dataset.active) {
    await api(`/api/lists/${t.dataset.active}/active`, { method: 'PATCH', body: { active: t.checked } });
    toast(t.checked ? 'List ON – notes limit counts from now' : 'List OFF');
    return loaders.lists();
  }
  const ed = t.closest('[data-edit-list]');
  const del = t.closest('[data-del-list]');
  const ld = t.closest('[data-leads]');
  if (ed) listForm(LISTS.find((x) => x.id == ed.dataset.editList));
  const nt = t.closest('[data-notes]');
  if (nt) typeForm(await api(`/api/types/${nt.dataset.notes}`));
  if (ld) { $('#fList').value = ld.dataset.leads; leadsPage = 0; show('leads'); }
  const rv = t.closest('[data-review]');
  if (rv) { e.preventDefault(); $('#fList').value = rv.dataset.review; leadStatus = 'review'; leadsPage = 0; show('leads'); }
  if (del && confirm('Delete this list and all its collected leads?')) {
    await api(`/api/lists/${del.dataset.delList}`, { method: 'DELETE' });
    loaders.lists();
  }
}));

// ---------------- leads ----------------
let leadsPage = 0;
const PAGE = 50;
let leadStatus = '';
loaders.leads = guard(async () => {
  const lists = await api('/api/lists');
  const sel = $('#fList');
  const cur = sel.value;
  sel.innerHTML = '<option value="">All lists</option>' + lists.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('');
  sel.value = cur;
  const qs = new URLSearchParams({ list_id: sel.value, status: leadStatus, q: $('#fQ').value, sort: $('#fSort').value, limit: PAGE, offset: leadsPage * PAGE });
  const { total, rows, counts } = await api('/api/leads?' + qs);
  $$('#leadTabs button').forEach((b) => {
    b.classList.toggle('on', b.dataset.st === leadStatus);
    b.querySelector('span').textContent = counts[b.dataset.st || 'all'] ?? '';
  });
  const statusCell = (r) => {
    if (r.accepted_at) {
      const fu = r.followup_state ? `${r.replied_at ? '💬 ' : ''}Follow-ups skipped – ${esc(r.followup_error)}`
        : r.followup_step ? `Follow-up ${r.followup_step} sent ${esc(String(r.followup_at || '').slice(0, 16))}` : '';
      return `<span class="badge sent">✓ Accepted</span>${fu ? `<div class="sub ell" title="${fu}">${fu}</div>` : ''}`;
    }
    if (r.status === 'sent') return `<span class="badge awaiting">Sent · waiting</span>`;
    return `<span class="badge ${r.status}">${STATUS_LABEL[r.status] || r.status}</span>${r.error ? `<div class="sub ell" title="${esc(ERROR_LABEL[r.error] || r.error)}">${esc(ERROR_LABEL[r.error] || r.error)}</div>` : ''}`;
  };
  const when = (r) => (r.accepted_at ? ['Accepted', r.accepted_at] : r.sent_at ? ['Sent', r.sent_at] : ['Added', r.created_at]);
  const actions = (r) => {
    if (r.status === 'review') return `<button class="btn sm primary" data-approve="${r.id}" title="The bot may send this person a connection note">Approve</button><button class="btn sm" data-exclude="${r.id}" title="Never send this person a connection note – even after a new sync">Don't contact</button>`;
    if (r.status === 'excluded') return `<button class="btn sm" data-reset="${r.id}" title="Undo – put back in the queue">Undo</button>`;
    return [
      r.status !== 'pending' && r.status !== 'sent' ? `<button class="btn sm" data-reset="${r.id}" title="Put back in the queue">Retry</button>` : '',
      r.status !== 'sent' ? `<button class="btn sm" data-exclude="${r.id}" title="Never send this person a connection note – even after a new sync">Don't contact</button>` : '',
      `<button class="btn sm danger icon" data-del-lead="${r.id}" title="Delete (may come back on the next sync – use Don't contact to block for good)">✕</button>`,
    ].join('');
  };
  const initials = (n) => esc(String(n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase());
  const avatar = (r) => `<span class="avatar"><span>${initials(r.name)}</span>${/^https:/.test(r.photo_url || '') ? `<img src="${esc(r.photo_url)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()"/>` : ''}</span>`;
  const reviewing = rows.some((r) => r.status === 'review');
  $('#reviewBar').classList.toggle('hidden', !counts.review);
  $('#reviewInfo').innerHTML = `<b>${counts.review}</b> lead(s) wait for your review – only approved leads get a connection note.`;
  updateSel();
  $('#leadsTbl').innerHTML = `<colgroup><col class="c-sel"/><col class="c-name"/><col class="c-co"/><col class="c-loc"/><col class="c-st"/><col class="c-date"/><col class="c-note"/><col class="c-act"/></colgroup>
    <tr><th>${reviewing ? '<input type="checkbox" id="selAll" title="Select all to review on this page"/>' : ''}</th><th>Name</th><th>Company / title</th><th>Location · list</th><th>Status</th><th>Date</th><th>Note</th><th></th></tr>` +
    (rows.length ? rows.map((r) => {
      const [wl, wd] = when(r);
      return `<tr class="lr-${r.accepted_at ? 'accepted' : r.status}">
        <td>${r.status === 'review' ? `<input type="checkbox" class="sel" value="${r.id}"/>` : ''}</td>
        <td><div class="lead-who">${avatar(r)}<div class="lead-who-txt"><div class="ell"><b title="${esc(r.name)}">${esc(r.name)}</b> <span class="sub">${esc(r.degree)}</span></div>
          <div class="sub">${r.profile_url ? `<a href="${esc(r.profile_url)}" target="_blank" rel="noopener">profile</a>` : ''}${r.profile_url && r.sales_url ? ' · ' : ''}${r.sales_url ? `<a href="${esc(r.sales_url)}" target="_blank" rel="noopener">sales nav</a>` : ''}</div></div></div></td>
        <td><div class="ell" title="${esc(r.company)}">${esc(r.company || '—')}</div><div class="sub ell" title="${esc(r.title)}">${esc(r.title)}</div></td>
        <td><div class="ell" title="${esc(r.location)}">${esc(r.location || '—')}</div><div class="sub ell" title="${esc(r.list_name)}">${esc(r.list_name || '—')}</div></td>
        <td>${statusCell(r)}</td>
        <td><div class="sub">${wl}</div><div class="sub mono">${esc((wd || '').slice(0, 16))}</div></td>
        <td><div class="sub clamp2" title="${esc(r.message)}">${esc(r.message || '—')}</div></td>
        <td><div class="lead-acts">${actions(r)}</div></td>
      </tr>`;
    }).join('') : `<tr><td colspan="8" class="empty">${leadStatus ? 'No leads in this group.' : 'No leads. Add a list and click "Sync leads only" or "Start sending" on the Dashboard.'}</td></tr>`);
  $('#leadsCount').textContent = `${total} leads${total > PAGE ? ` · page ${leadsPage + 1} of ${Math.ceil(total / PAGE)}` : ''}`;
  $('#pgPrev').disabled = leadsPage === 0;
  $('#pgNext').disabled = (leadsPage + 1) * PAGE >= total;
});
$('#leadTabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-st]');
  if (!b) return;
  leadStatus = b.dataset.st;
  leadsPage = 0;
  loaders.leads();
});
let qT;
$('#fQ').addEventListener('input', () => { clearTimeout(qT); qT = setTimeout(() => { leadsPage = 0; loaders.leads(); }, 300); });
$('#fList').onchange = $('#fSort').onchange = () => { leadsPage = 0; loaders.leads(); };
$('#pgPrev').onclick = () => { leadsPage--; loaders.leads(); };
$('#pgNext').onclick = () => { leadsPage++; loaders.leads(); };
$('#btnPhotos').onclick = guard(async () => {
  const list = $('#fList');
  await api('/api/runner/photos', { method: 'POST', body: { list_ids: list.value ? [Number(list.value)] : [] } });
  toast(`Reading ${list.value ? `"${list.selectedOptions[0].textContent}"` : 'all lists'} again for profile pictures – follow it in the Activity log`);
});
$('#btnResetFailed').onclick = guard(async () => {
  const r = await api('/api/leads/reset-failed', { method: 'POST', body: { list_id: $('#fList').value || undefined } });
  toast(`${r.reset} skipped leads put back in queue`);
  loaders.leads();
});
// ---- review: approve who the bot may contact ----
const selectedIds = () => $$('#leadsTbl .sel:checked').map((c) => Number(c.value));
function updateSel() {
  const n = selectedIds().length;
  $('#btnApproveSel').disabled = $('#btnExcludeSel').disabled = !n;
  $('#btnApproveSel').textContent = n ? `Approve selected (${n})` : 'Approve selected';
}
$('#leadsTbl').addEventListener('change', (e) => {
  if (e.target.id === 'selAll') $$('#leadsTbl .sel').forEach((c) => (c.checked = e.target.checked));
  updateSel();
});
$('#btnApproveSel').onclick = guard(async () => {
  const r = await api('/api/leads/approve', { method: 'POST', body: { ids: selectedIds() } });
  toast(`${r.approved} lead(s) approved – the bot sends to them on the next Start`);
  loaders.leads();
});
$('#btnExcludeSel').onclick = guard(async () => {
  const ids = selectedIds();
  if (!confirm(`Never contact these ${ids.length} people?`)) return;
  const r = await api('/api/leads/exclude', { method: 'POST', body: { ids } });
  toast(`${r.excluded} lead(s) excluded`);
  loaders.leads();
});
$('#btnApproveAll').onclick = guard(async () => {
  const list = $('#fList');
  const where = list.value ? `in "${list.selectedOptions[0].textContent}"` : 'in all lists';
  if (!confirm(`Approve every lead to review ${where}?`)) return;
  const r = await api('/api/leads/approve', { method: 'POST', body: { all: true, list_id: list.value || undefined } });
  toast(`${r.approved} lead(s) approved`);
  loaders.leads();
});
$('#leadsTbl').addEventListener('click', guard(async (e) => {
  const ap = e.target.closest('[data-approve]');
  if (ap) {
    await api('/api/leads/approve', { method: 'POST', body: { ids: [Number(ap.dataset.approve)] } });
    return loaders.leads();
  }
  const r = e.target.closest('[data-reset]');
  const d = e.target.closest('[data-del-lead]');
  const x = e.target.closest('[data-exclude]');
  if (x) {
    await api(`/api/leads/${x.dataset.exclude}/exclude`, { method: 'POST' });
    toast('Excluded – this person will never get a connection note, even after a new sync');
    return loaders.leads();
  }
  if (r) await api(`/api/leads/${r.dataset.reset}/reset`, { method: 'POST' });
  if (d && confirm('Delete this lead? It may be collected again on next sync.')) await api(`/api/leads/${d.dataset.delLead}`, { method: 'DELETE' });
  if (r || d) loaders.leads();
}));

// ---------------- prospects (posts & jobs that need lead gen / outreach help) ----------------
let SEARCHES = [];
let prPage = 0;
const WINDOW_LABEL = { day: 'Last 24 h', week: 'Last week', month: 'Last month' };
const searchName = (id) => (SEARCHES.find((s) => s.id == id) || {}).name || '';

let SETTINGS_PR = {};
let PSTATUS = { status: 'idle' }; // the prospect finder's own runner
/** Prospect Finder sidebar: its own status (campaigns may be running at the same time) */
function renderFinderSide() {
  const p = PSTATUS || {};
  const label = { idle: 'Idle', running: 'Searching', paused: 'Paused', stopping: 'Stopping…' }[p.status] || 'Idle';
  const campaign = STATUS && STATUS.status !== 'idle' ? ({ connect: 'sending notes', direct: 'sending notes', sync: 'syncing', accept: 'checking acceptances' }[STATUS.mode] || 'busy') : 'idle';
  $('#sideStatus').innerHTML = `<div><span>Prospects</span><b>${label}</b></div><div><span>Campaigns</span><b>${campaign}</b></div><div><span>Extension</span><b>${STATUS && STATUS.extension ? 'connected' : 'offline'}</b></div>`;
}
loaders.prospects = guard(async () => {
  const [searches, settings] = await Promise.all([api('/api/prospect-searches'), api('/api/settings')]);
  SEARCHES = searches;
  SETTINGS_PR = settings;
  await Promise.all([loadProspects(), renderCvBox()]);
  renderProspectRun(PSTATUS);
});

const PR_PAGE = 25;
let prTab = 'post';
let prCountry = '';
let prSelected = null;
let PR_ROWS = [];
let PR_SUMMARY = null;

const initials = (n = '') => n.replace(/[^\p{L}\s]/gu, ' ').trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';
const linkTo = (url, text) => (url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text)}</a>` : esc(text));
function agoText(posted = '') {
  const p = String(posted).trim();
  let days = null;
  if (/^\d{4}-\d{2}-\d{2}/.test(p)) days = Math.max(0, Math.floor((Date.now() - Date.parse(p)) / 864e5));
  else {
    const m = p.match(/(\d+)\s*(h|hours?|d|days?|w|weeks?|mo|months?)\b/i);
    if (m) days = /^h/i.test(m[2]) ? 0 : /^w/i.test(m[2]) ? m[1] * 7 : /^mo/i.test(m[2]) ? m[1] * 30 : Number(m[1]);
  }
  if (days === null) return p;
  return days === 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`;
}
const shortAgo = (posted) => agoText(posted).replace(/^today$/, '0d').replace(/ days? ago$/, 'd');
const reasonList = (p) => String(p.reasons || '').split(', ').filter(Boolean);
// "open worldwide ("Work from anywhere")" -> "Worldwide" / "Contractor" / …
function remoteBadge(p) {
  const m = String(p.reasons || '').match(/open worldwide \("([^"]+)"\)/);
  if (!m) return '';
  const t = m[1].toLowerCase();
  if (/contractor/.test(t)) return 'Contractor';
  if (/freelanc/.test(t)) return 'Freelance';
  if (/any country|all countries/.test(t)) return 'Any country';
  if (/anywhere/.test(t)) return 'Anywhere';
  if (/global/.test(t)) return 'Global';
  if (/international/.test(t)) return 'International';
  return 'Worldwide';
}
const experienceOf = (p) => (String(p.reasons || '').match(/(\d+) yrs experience/) || [])[1];
const JOB_KEYWORDS = ['Lead generation', 'Appointment setting', 'Cold email', 'Cold calling', 'Outbound', 'LinkedIn outreach', 'Email marketing', 'Sales Navigator',
  'HubSpot', 'Salesforce', 'Apollo', 'Instantly', 'Lemlist', 'Clay', 'Pipedrive', 'B2B', 'SaaS', 'CRM', 'Prospecting', 'Deliverability'];
const keywordsIn = (text = '') => JOB_KEYWORDS.filter((k) => new RegExp(`\\b${k.replace(/\s+/g, '[\\s-]?')}\\b`, 'i').test(text));
// How well a job fits your rules (shown as "Match"): core lead gen title, open worldwide, low experience, hiring person known
function matchScore(p) {
  let s = 55;
  if (/lead[\s-]?gen|appointment|setter|cold|outreach|outbound|telemarket|e-?mail/i.test(p.title || '')) s += 15;
  if (remoteBadge(p)) s += 12;
  const y = experienceOf(p);
  if (y === undefined) s += 5; else if (Number(y) <= 3) s += 10; else s += 4;
  if (p.person_name) s += 6;
  return Math.min(99, s);
}

function prospectQuery() {
  const status = prTab === 'rejected' ? 'rejected' : $('#prStatusSel').value;
  return new URLSearchParams({ status, kind: prTab === 'rejected' ? '' : prTab, q: $('#prQ').value, country: prCountry, sort: $('#prSortSel').value });
}

function renderStats() {
  const s = PR_SUMMARY;
  if (!s) return;
  $('#prSub').textContent = `Remote, English only, ${s.target || 'anywhere'} first.${s.lastRun ? ` Last run ${s.lastRun.slice(0, 16)}.` : ''}`;
  $('#prStats').innerHTML = [
    ['Posts found today', `${s.postsToday} <small>/ ${s.capPosts || '∞'}</small>`, `Today's limit ${s.capPosts || '∞'}`],
    ['Jobs found today', `${s.jobsToday} <small>/ ${s.capJobs || '∞'}</small>`, `Today's limit ${s.capJobs || '∞'}`],
    ['Contacted this week', s.contactedWeek, 'From posts and jobs'],
  ].map(([l, v, sub]) => `<div class="pr-stat"><span>${l}</span><b>${v}</b><small>${sub}</small></div>`).join('');
}

function renderChips() {
  const c = (PR_SUMMARY && PR_SUMMARY.countries) || {};
  const list = Object.entries(c).filter(([k]) => k !== 'Unknown').sort((a, b) => (a[0] === 'United Kingdom') - (b[0] === 'United Kingdom') || b[1] - a[1]);
  if (prCountry && !list.some(([k]) => k === prCountry)) list.push([prCountry, 0]);
  $('#prChips').innerHTML = `<button class="chip-btn ${prCountry ? '' : 'on'}" data-country="">All ${esc(PR_SUMMARY?.target || 'countries')}</button>` +
    list.map(([k, n]) => `<button class="chip-btn ${prCountry === k ? 'on' : ''}" data-country="${esc(k)}">${esc(k === 'United Kingdom' ? 'UK' : k)}${n ? ` <i>${n}</i>` : ''}</button>`).join('');
}

async function loadProspects() {
  if (prTab === 'searches') return renderSearchTab();
  const qs = prospectQuery();
  $('#btnExportProspects').href = '/api/prospects/export.csv?' + qs;
  qs.set('limit', PR_PAGE);
  qs.set('offset', prPage * PR_PAGE);
  const [{ total, rows, counts, kinds }, summary] = await Promise.all([api('/api/prospects?' + qs), api('/api/prospects/summary')]);
  PR_ROWS = rows;
  PR_SUMMARY = summary;
  renderStats();
  renderChips();
  const tabCount = { post: kinds.post || 0, job: kinds.job || 0, rejected: counts.rejected || 0, searches: SEARCHES.filter((x) => x.active).length };
  if (prTab === 'rejected') { tabCount.post = ''; tabCount.job = ''; }
  $$('#prTabs button').forEach((b) => {
    b.classList.toggle('on', b.dataset.tab === prTab);
    const sp = b.querySelector('span');
    sp.textContent = tabCount[b.dataset.tab];
    sp.hidden = sp.textContent === '';
  });
  $('#prStatusSel').classList.toggle('hidden', prTab === 'rejected');
  $('#prToolbar').classList.remove('hidden');
  $('.pr-keys').classList.toggle('hidden', prTab === 'rejected');
  if (prTab === 'post') renderPostCards(rows);
  else if (prTab === 'job') renderJobs(rows);
  else renderRejected(rows);
  const word = prTab === 'rejected' ? 'filtered out' : prTab === 'job' ? 'jobs' : 'posts';
  $('#prCount').textContent = `${total} ${word}${total > PR_PAGE ? ` · page ${prPage + 1} of ${Math.ceil(total / PR_PAGE)}` : ''}`;
  $('#prPrev').disabled = prPage === 0;
  $('#prNext').disabled = (prPage + 1) * PR_PAGE >= total;
}

const emptyBox = (msg) => `<div class="card pr-empty">${msg}</div>`;
const CRM = { new: 'New', contacted: 'Contacted', replied: 'Replied', meeting: 'Meeting', client: 'Client', not_relevant: 'Skipped' };
/** Status, note / follow-up and "bad result" for one prospect (the small CRM) */
function crmControls(p) {
  return `<select class="pr-crm" data-crm="${p.id}" title="Where this prospect is">${Object.entries(CRM).map(([k, l]) => `<option value="${k}" ${p.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <div class="pr-pair">
      <button class="btn" data-note="${p.id}" title="Notes and a follow-up date">${p.follow_up ? `Follow up ${p.follow_up.slice(5)}` : 'Note'}</button>
      <button class="btn pr-skip" data-bad="${p.id}" title="Wrong result – skip it and teach the search">Not a fit</button>
    </div>
    ${p.notes ? `<div class="pr-note-preview" title="${esc(p.notes)}">Note: ${esc(p.notes)}</div>` : ''}`;
}
const scoreBadge = (p) => (p.score ? `<span class="pr-score-badge s${p.score >= 75 ? 'hi' : p.score >= 55 ? 'mid' : 'lo'}" title="How promising (0–100): clear ask, new post, decision maker">${p.score}</span>` : '');

// ----- posts: one card per person, the sentence with their need highlighted -----
function postText(p) {
  const t = String(p.text || '').replace(/\s+/g, ' ');
  const h = String(p.highlight || '').replace(/\s+/g, ' ');
  const i = h ? t.indexOf(h) : -1;
  if (i === -1) return esc(t.length > 380 ? t.slice(0, 380) + '…' : t);
  const start = Math.max(0, i - 160);
  const end = Math.min(t.length, i + h.length + 200);
  return `${start ? '…' : ''}${esc(t.slice(start, i))}<mark>${esc(h)}</mark>${esc(t.slice(i + h.length, end))}${end < t.length ? '…' : ''}`;
}
function postChips(p) {
  const r = reasonList(p).filter((x) => !/^claude:/i.test(x)).filter((x) => !/^(looking for help|needs help|asks |struggling|can't get|not enough|is hiring$|open to)/i.test(x));
  if (/\bhiring\b/i.test(p.reasons || '')) r.unshift('Hiring');
  if (/\bremote\b/i.test(p.text || '')) r.push('Remote');
  return [...new Set(r.map((x) => x.replace(/^cv: /, '').replace(/^\w/, (c) => c.toUpperCase())))].slice(0, 6);
}
function renderPostCards(rows) {
  if (!rows.length) { $('#prBody').innerHTML = emptyBox('No posts here yet – press "Run now" to search LinkedIn.'); return; }
  $('#prBody').innerHTML = rows.map((p) => {
    const who = p.person_name || p.company_name || '—';
    const at = p.person_name && p.company_name ? ` <span class="muted">at</span> ${linkTo(p.company_url, p.company_name)}` : '';
    const profile = p.person_url || p.company_url;
    return `<article class="pr-card ${p.followUpDue ? 'due' : ''}" data-card="${p.id}">
      <div class="pr-main">
        <div class="pr-who"><span class="pr-avatar">${esc(initials(who))}</span>
          <div><div class="pr-name">${linkTo(profile, who)}${at}</div>${p.headline ? `<div class="pr-headline">${esc(p.headline)}</div>` : ''}</div></div>
        <p class="pr-post">${postText(p)}</p>
        <div class="pr-tags">${postChips(p).map((c) => `<span>${esc(c)}</span>`).join('')}</div>
        ${/Claude: /.test(p.reasons || '') ? `<div class="pr-job muted">${esc((p.reasons.match(/Claude: [^,]*/) || [''])[0])}</div>` : ''}
        ${p.job_id ? `<div class="pr-job">Job in this post: ${linkTo(`https://www.linkedin.com/jobs/view/${p.job_id}/`, p.job_title || 'open job')}${p.job_info ? ` <span class="muted">· ${esc(p.job_info)}</span>` : ''}</div>` : ''}
      </div>
      <aside class="pr-side">
        <div class="pr-side-top"><div><b>${esc(p.location || 'Location unknown')}</b><div class="muted">Posted ${esc(agoText(p.posted) || '—')}</div></div>${scoreBadge(p)}</div>
        <div class="pr-pair">
          ${p.url ? `<a class="btn primary" href="${esc(p.url)}" target="_blank" rel="noopener">Open post</a>` : ''}
          ${profile ? `<a class="btn" href="${esc(profile)}" target="_blank" rel="noopener">Profile</a>` : ''}
        </div>
        ${p.person_url ? `<button class="btn pr-wide pr-connect" data-connect="${p.id}" title="Send a connection note with one of your message types">${p.lead_id ? 'Connection note sent' : 'Send connection note'}</button>` : ''}
        ${crmControls(p)}
      </aside>
    </article>`;
  }).join('');
}

// ----- jobs: table + details of the selected job -----
function renderJobs(rows) {
  if (!rows.length) { $('#prBody').innerHTML = emptyBox('No jobs here yet – every job must be remote and open to applicants anywhere, so they are rare.'); return; }
  if (!rows.some((p) => p.id === prSelected)) prSelected = rows[0].id;
  $('#prBody').innerHTML = `<div class="pr-jobs">
    <div class="card p0 pr-jobtable"><table class="tbl"><tr><th>Role and company</th><th>Location</th><th>Remote</th><th>Experience</th><th>Posted</th><th title="How well the job fits your rules">Match</th></tr>
      ${rows.map((p) => {
        const m = p.score || matchScore(p);
        const y = experienceOf(p);
        return `<tr class="pr-jobrow ${p.id === prSelected ? 'sel' : ''}" data-job="${p.id}">
          <td><b>${esc(p.title)}</b><div class="sub">${esc(p.company_name)}</div></td>
          <td>${esc(p.country || p.location || '—')}</td>
          <td>${remoteBadge(p) ? `<span class="pr-badge">${remoteBadge(p)}</span>` : '<span class="sub">—</span>'}</td>
          <td class="mono">${y !== undefined ? `${y}+ yrs` : '<span class="sub">not stated</span>'}</td>
          <td class="sub">${esc(shortAgo(p.posted))}</td>
          <td><div class="pr-match"><i style="width:${m}%"></i></div><b class="pr-score">${m}</b></td>
        </tr>`;
      }).join('')}</table></div>
    <aside class="card pr-detail" id="prDetail"></aside>
  </div>`;
  renderJobDetail();
}
function renderJobDetail() {
  const p = PR_ROWS.find((x) => x.id === prSelected);
  const box = $('#prDetail');
  if (!p || !box) return;
  const y = experienceOf(p);
  const rb = remoteBadge(p);
  const why = [
    rb ? `Remote, open to applicants anywhere ("${(String(p.reasons).match(/open worldwide \("([^"]+)"\)/) || [])[1]}")` : 'Remote',
    'English only, no other language',
    y !== undefined ? `Asks ${y} year${y === '1' ? '' : 's'} of experience` : 'No experience requirement stated',
    'Not a senior role',
    'Not staffing or BPO',
    `Posted ${agoText(p.posted) || 'in the last 7 days'}`,
  ];
  const kw = keywordsIn(`${p.title} ${p.text}`);
  box.innerHTML = `<div class="pr-label">Selected</div>
    <h3>${esc(p.title)}</h3>
    <div class="muted">${linkTo(p.company_url, p.company_name)}${p.location ? ` · ${esc(p.location)}` : ''}</div>
    <div class="pr-label mt">Why it passed</div>
    <ul class="pr-why">${why.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>
    ${kw.length ? `<div class="pr-kw"><b>Matched keywords</b><div>${kw.map((k) => `<span>${esc(k)}</span>`).join('')}</div></div>` : ''}
    ${p.person_name ? `<div class="pr-who mt"><span class="pr-avatar">${esc(initials(p.person_name))}</span><div><div class="pr-name">${linkTo(p.person_url, p.person_name)}</div><div class="pr-headline">Hiring person</div></div></div>` : ''}
    <a class="btn primary pr-wide mt" href="${esc(p.url)}" target="_blank" rel="noopener">Open job</a>
    ${p.person_url ? `<a class="btn pr-wide" href="${esc(p.person_url)}" target="_blank" rel="noopener">Message hirer</a>` : `<a class="btn pr-wide" href="${esc(p.company_url || p.url)}" target="_blank" rel="noopener">Company page</a>`}
    ${crmControls(p)}`;
}

// ----- filtered out: what was dropped and why -----
function renderRejected(rows) {
  if (!rows.length) { $('#prBody').innerHTML = emptyBox('Nothing filtered out yet.'); return; }
  $('#prBody').innerHTML = `<div class="card p0"><table class="tbl pr-tbl"><tr><th>Who</th><th>Post / job</th><th>Why it was dropped</th><th>Found</th></tr>
    ${rows.map((p) => `<tr>
      <td class="pr-name">${linkTo(p.person_url || p.company_url, p.person_name || p.company_name || '—')}${p.location ? `<div class="sub">${esc(p.location)}</div>` : ''}</td>
      <td style="max-width:420px">${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.kind === 'job' ? p.title || 'Job' : 'Post')} ↗</a>` : esc(p.kind === 'job' ? p.title : 'Post')}
        ${p.kind === 'post' && p.text ? `<div class="sub pr-clip">${esc(p.text.slice(0, 160))}</div>` : ''}</td>
      <td class="pr-why-drop">${esc(p.reject_reason)}</td>
      <td class="sub">${esc((p.found_at || '').slice(0, 16))}</td>
    </tr>`).join('')}</table></div>`;
}

function renderProspectRun(s) {
  const box = $('#prRun');
  if (!box || !s) return;
  const busy = s.status && s.status !== 'idle';
  $('#btnFindProspects').disabled = busy;
  const pc = STATUS && STATUS.safety && STATUS.safety.prospectCooldown;
  if (!busy && pc) {
    box.classList.remove('hidden');
    box.innerHTML = `<span class="status-pill paused">Waiting</span><span>LinkedIn's public pages asked to slow down – the prospect finder waits until <b>${esc(pc.until)}</b>. Your account is fine; Outreach keeps working.</span>`;
    return;
  }
  const jc = STATUS && STATUS.safety && STATUS.safety.jobsCooldown;
  if (!busy && jc) {
    box.classList.remove('hidden');
    box.innerHTML = `<span class="status-pill paused">Jobs waiting</span><span>LinkedIn's public job pages asked to slow down – job searches wait until <b>${esc(jc.until)}</b>. Post searches and Outreach keep working; your account is fine.</span>`;
    return;
  }
  if (!busy) {
    box.classList.add('hidden');
    if (prTab === 'searches' && box.dataset.was === 'running') renderSearchTab();
    box.dataset.was = 'idle';
    return;
  }
  box.classList.remove('hidden');
  const c = s.current || {};
  const pct = c.total ? Math.round(((c.done - 1) / c.total) * 100) : 0;
  const step = c.search ? `<b>${esc(c.search)}</b> – ${esc(c.step)}` : 'Starting…';
  const w = s.wait ? ` · ${esc(s.wait.reason)}${s.wait.seconds ? ` (${s.wait.seconds}s)` : ''}` : '';
  // time left: average time per finished search × searches left
  let eta = '';
  if (c.total && c.done > 1 && s.startedAt) {
    const per = (Date.now() - Date.parse(s.startedAt)) / (c.done - 1);
    const left = Math.round((per * (c.total - c.done + 1)) / 60000);
    eta = left >= 60 ? ` · about ${Math.floor(left / 60)} h ${left % 60} min left` : ` · about ${Math.max(1, left)} min left`;
  }
  box.innerHTML = `<span class="status-pill ${s.status}">${s.status === 'paused' ? 'Paused' : 'Searching'}</span>
    <div class="pr-progress">${c.total ? `<div class="pr-progress-top"><b>Search ${c.done} of ${c.total}</b><span>${pct}% done${eta}</span></div><div class="pr-bar-track"><i style="width:${pct}%"></i></div>` : ''}<div class="pr-progress-step">${step}${w}</div></div>
    <div class="row gap"><button class="btn sm" data-pr-run="${s.status === 'paused' ? 'resume' : 'pause'}">${s.status === 'paused' ? 'Resume' : 'Pause'}</button><button class="btn sm danger" data-pr-run="stop">Stop</button></div>`;
  // the running search is marked on the Searches tab
  if (box.dataset.was !== 'running' || box.dataset.sid !== String(c.searchId)) {
    box.dataset.was = 'running';
    box.dataset.sid = String(c.searchId);
    if (prTab === 'searches') renderSearchTab();
  }
}

async function runProspects(ids) {
  PSTATUS = await api('/api/runner/prospects', { method: 'POST', body: { search_ids: ids } });
  renderProspectRun(PSTATUS);
  toast(ids.length === 1 ? `Running "${searchName(ids[0])}" – results appear live` : 'Searching LinkedIn with all searches that are ON – results appear live');
}
$('#btnFindProspects').onclick = guard(() => runProspects([]));
$('#prRun').addEventListener('click', guard(async (e) => {
  const b = e.target.closest('[data-pr-run]');
  if (b) { PSTATUS = await api(`/api/prospects/run/${b.dataset.prRun}`, { method: 'POST' }); renderProspectRun(PSTATUS); }
}));
$('#prTabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (!b) return;
  prTab = b.dataset.tab;
  prPage = 0;
  guard(loadProspects)();
});
$('#prChips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-country]');
  if (!b) return;
  prCountry = b.dataset.country;
  prPage = 0;
  guard(loadProspects)();
});
let prT;
$('#prQ').addEventListener('input', () => { clearTimeout(prT); prT = setTimeout(() => { prPage = 0; guard(loadProspects)(); }, 300); });
$('#prStatusSel').onchange = $('#prSortSel').onchange = () => { prPage = 0; guard(loadProspects)(); };

// ----- small CRM: status, notes / follow-up, bad result, connection note -----
const prRow = (id) => PR_ROWS.find((x) => x.id == id) || {};
async function setProspect(id, body, msg) {
  await api(`/api/prospects/${id}`, { method: 'PATCH', body });
  if (msg) toast(msg);
  await loadProspects();
}
$('#prBody').addEventListener('change', guard(async (e) => {
  const sel = e.target.closest('[data-crm]');
  if (sel) await setProspect(sel.dataset.crm, { status: sel.value }, `Moved to ${CRM[sel.value]}`);
}));

function noteModal(p) {
  const d = (n) => { const x = new Date(); x.setDate(x.getDate() + n); return x.toLocaleDateString('sv-SE'); };
  openModal(`Notes – ${p.person_name || p.company_name || p.title || ''}`, `<form id="noteForm" class="form">
    <label>Notes<textarea name="notes" rows="5" placeholder="What you said, what they answered, next step…">${esc(p.notes || '')}</textarea></label>
    <label>Follow up on<input type="date" name="follow_up" value="${esc(p.follow_up || '')}" /></label>
    <div class="row gap wrap">${[['Tomorrow', 1], ['In 3 days', 3], ['In a week', 7], ['In 2 weeks', 14]].map(([l, n]) => `<button type="button" class="btn sm" data-fu="${d(n)}">${l}</button>`).join('')}<button type="button" class="btn sm" data-fu="">No follow-up</button></div>
    <div class="row gap mt"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-close>Cancel</button></div></form>`);
  const f = $('#noteForm');
  f.addEventListener('click', (e) => { const b = e.target.closest('[data-fu]'); if (b) f.follow_up.value = b.dataset.fu; });
  $('[data-close]', f).onclick = closeModal;
  f.onsubmit = guard(async (e) => { e.preventDefault(); closeModal(); await setProspect(p.id, { notes: f.notes.value, follow_up: f.follow_up.value }, 'Saved'); });
}

function badModal(p) {
  const words = [...new Set(String(p.kind === 'job' ? p.title : p.headline || '').split(/[\s|•·,/@()–-]+/).map((w) => w.trim()).filter((w) => w.length > 2 && !/^(and|the|for|with|at|of|in)$/i.test(w)))].slice(0, 18);
  openModal('Bad result – skip and teach the search', `<form id="badForm" class="form">
    <div class="fb-field"><b>What is wrong?</b><div class="check-row">${['Seller / agency', 'Recruiter / staffing', 'Job seeker', 'Not about lead gen', 'Wrong country', 'Other'].map((r, i) => `<label class="check"><input type="radio" name="reason" value="${r}" ${i === 0 ? 'checked' : ''}/> ${r}</label>`).join('')}</div></div>
    ${words.length ? `<div class="fb-field"><b>Skip ${p.kind === 'job' ? 'job titles' : 'authors whose headline has'} these words from now on</b><small>Click to choose – they are added to the search "${esc(p.search_name || '')}"</small>
      <div class="pr-wordpick">${words.map((w) => `<label><input type="checkbox" value="${esc(w)}"/> ${esc(w)}</label>`).join('')}</div></div>` : ''}
    <label>Skip ${p.kind === 'job' ? 'jobs' : 'posts'} that contain this word / phrase (optional)<input name="extra" placeholder="e.g. webinar, commission only" /><small>only a word that appears in bad ${p.kind === 'job' ? 'jobs' : 'posts'} – not a name or a reason ("What is wrong?" above is the reason)</small></label>
    <div class="row gap mt"><button class="btn primary" type="submit">Skip it</button><button class="btn" type="button" data-close>Cancel</button></div></form>`);
  const f = $('#badForm');
  $('[data-close]', f).onclick = closeModal;
  f.onsubmit = guard(async (e) => {
    e.preventDefault();
    const picked = $$('.pr-wordpick input:checked', f).map((i) => i.value);
    const extra = f.extra.value.trim();
    const r = await api(`/api/prospects/${p.id}/feedback`, { method: 'POST', body: { reason: $('input[name=reason]:checked', f).value, headline_words: picked, text_words: extra ? [extra] : [] } });
    closeModal();
    toast(r.learned ? `Skipped · ${r.learned}` : 'Skipped');
    await loadProspects();
  });
}

async function connectModal(p) {
  const types = (await api('/api/types')).filter((t) => (t.variants || []).some((v) => v.active !== 0));
  if (!types.length) return toast('Make a Message Type with a connection note first (Message Types page)', true);
  const first = String(p.person_name || '').split(/\s+/)[0];
  const preview = (t) => esc(((t.variants || []).find((v) => v.active !== 0) || {}).body || '').replace(/\{first_name\}/g, esc(first)).replace(/\{company\}/g, esc(p.company_name || '')).replace(/\{title\}/g, esc(p.headline || ''));
  openModal(`Connection note to ${p.person_name}`, `<form id="cnForm" class="form">
    <label>Message type<select name="type">${types.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></label>
    <div class="pr-cn-preview" id="cnPreview"></div>
    <p class="sub">Sent by the bot like a campaign note: same safety limits (daily / weekly), never twice to the same person. ${STATUS && STATUS.status !== 'idle' ? '<b>The bot is busy right now – try again when it is idle.</b>' : ''}</p>
    <div class="row gap mt"><button class="btn primary" type="submit" ${STATUS && STATUS.status !== 'idle' ? 'disabled' : ''}>Send note</button><button class="btn" type="button" data-close>Cancel</button></div></form>`);
  const f = $('#cnForm');
  const show = () => { $('#cnPreview').innerHTML = preview(types.find((t) => t.id == f.type.value)); };
  f.type.onchange = show;
  show();
  $('[data-close]', f).onclick = closeModal;
  f.onsubmit = guard(async (e) => {
    e.preventDefault();
    renderStatus(await api('/api/prospects/connect', { method: 'POST', body: { ids: [p.id], type_id: Number(f.type.value) } }));
    closeModal();
    toast(`Sending a connection note to ${p.person_name} – watch the Dashboard / Activity Log`);
  });
}

$('#prBody').addEventListener('click', guard(async (e) => {
  const n = e.target.closest('[data-note]');
  const b = e.target.closest('[data-bad]');
  const c = e.target.closest('[data-connect]');
  if (n) noteModal(prRow(n.dataset.note));
  if (b) badModal(prRow(b.dataset.bad));
  if (c) await connectModal(prRow(c.dataset.connect));
}));

// ----- keyboard: J / K move, O open, C contacted, S skip, N note, B bad -----
let prFocus = -1;
function focusCard(i) {
  const cards = $$('#prBody [data-card], #prBody [data-job]');
  if (!cards.length) return;
  prFocus = Math.max(0, Math.min(cards.length - 1, i));
  cards.forEach((c, k) => c.classList.toggle('kb', k === prFocus));
  const el = cards[prFocus];
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  if (el.dataset.job) el.click();
}
document.addEventListener('keydown', guard(async (e) => {
  if (location.hash !== '#prospects' || prTab === 'searches' || prTab === 'rejected') return;
  if (e.target.closest('input, textarea, select') || !$('#modalBg').classList.contains('hidden') || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'j') return focusCard(prFocus + 1);
  if (k === 'k') return focusCard(prFocus - 1);
  const cards = $$('#prBody [data-card], #prBody [data-job]');
  const el = cards[prFocus];
  if (!el) return;
  const p = prRow(el.dataset.card || el.dataset.job);
  if (k === 'o' && (p.url)) window.open(p.url, '_blank');
  if (k === 'c') await setProspect(p.id, { status: 'contacted' }, 'Moved to Contacted');
  if (k === 's') await setProspect(p.id, { status: 'not_relevant' }, 'Skipped');
  if (k === 'n') noteModal(p);
  if (k === 'b') badModal(p);
}));
$('#prPrev').onclick = () => { prPage--; guard(loadProspects)(); };
$('#prNext').onclick = () => { prPage++; guard(loadProspects)(); };
$('#prBody').addEventListener('click', guard(async (e) => {
  const b = e.target.closest('[data-pr-status]');
  if (b) {
    await api(`/api/prospects/${b.dataset.id}`, { method: 'PATCH', body: { status: b.dataset.prStatus } });
    toast({ contacted: 'Marked as contacted', not_relevant: 'Skipped', new: 'Back in New' }[b.dataset.prStatus]);
    await loadProspects();
    return;
  }
  const row = e.target.closest('[data-job]');
  if (row && !e.target.closest('a')) {
    prSelected = Number(row.dataset.job);
    $$('.pr-jobrow').forEach((r) => r.classList.toggle('sel', r === row));
    renderJobDetail();
  }
}));

// ---------------- saved searches + filter builder ----------------
const JOB_TITLE_PRESETS = ['BDR', 'Business Development Representative', 'Associate Business Developer', 'Junior Business Developer', 'Business Development Associate',
  'Business Development Executive', 'Lead Generation Specialist', 'Lead Generation Executive', 'Appointment Setter', 'Growth Executive', 'Growth Associate',
  'Inside Sales Representative', 'Cold Caller', 'Outreach Specialist', 'LinkedIn Outreach Specialist', 'Email Marketing Specialist', 'Telemarketer', 'Partnerships Executive'];
const LOCATION_PRESETS = ['Netherlands', 'Germany', 'Ireland', 'Denmark', 'Sweden', 'Finland', 'Norway', 'Belgium', 'Switzerland', 'Austria', 'Spain', 'Portugal',
  'Poland', 'Estonia', 'Czech Republic', 'European Union', 'United Kingdom', 'United States', 'Canada'];
const POST_KEYWORD_PRESETS = ['need appointment setter', 'looking for lead generation', 'need help with outbound', 'looking for cold email expert',
  'need someone for LinkedIn outreach', 'hiring appointment setter remote', 'looking for BDR remote', 'need more sales meetings', 'pipeline is dry',
  'need B2B leads', 'recommend a lead gen agency', 'looking for outreach help', 'struggling to get clients', 'need more leads'];
const AUTHOR_PRESETS = ['Founder', 'Co-Founder', 'CEO', 'Owner', 'Managing Director', 'Head of Sales', 'VP Sales', 'Head of Growth', 'Marketing Director', 'CMO'];
const COUNTRY_PRESETS = ['Europe', 'United Kingdom', 'Netherlands', 'Germany', 'Ireland', 'Denmark', 'Sweden', 'Norway', 'Switzerland', 'Spain', 'Poland', 'United States', 'Canada', 'Australia'];
const LABELS = {
  workplace: { remote: 'Remote', hybrid: 'Hybrid', onsite: 'On-site' },
  levels: { internship: 'Internship', entry: 'Entry level', associate: 'Associate', mid: 'Mid-Senior', director: 'Director', executive: 'Executive' },
  jobTypes: { full: 'Full-time', part: 'Part-time', contract: 'Contract', temporary: 'Temporary' },
  postType: { any: 'Any post', buyer: 'Asking for help', hiring: 'Hiring' },
};
const filtersOf = (s) => { try { return s.filters ? JSON.parse(s.filters) : null; } catch { return null; } };
function partsCount(s) {
  const f = filtersOf(s);
  if (!f) return 1;
  return s.kind === 'jobs' ? (f.titles || []).length * Math.max(1, (f.locations || []).length) : (f.keywords || []).length;
}

function renderSearchTab() {
  $$('#prTabs button').forEach((b) => {
    b.classList.toggle('on', b.dataset.tab === 'searches');
    const sp = b.querySelector('span');
    sp.textContent = b.dataset.tab === 'searches' ? SEARCHES.filter((x) => x.active).length : '';
    sp.hidden = sp.textContent === '';
  });
  $('#prStatusSel').classList.add('hidden');
  $('#prToolbar').classList.add('hidden');
  $('.pr-keys').classList.add('hidden');
  const running = PSTATUS && PSTATUS.status !== 'idle' ? PSTATUS.current?.searchId : null;
  const card = (s) => {
    const f = filtersOf(s);
    const chips = [];
    if (f && s.kind === 'jobs') {
      chips.push(...f.titles.map((t) => ['title', t]), ...f.locations.map((l) => ['loc', `${l}`]));
      chips.push(...(f.workplace || []).map((w) => ['opt', LABELS.workplace[w]]), ...(f.levels || []).map((w) => ['opt', LABELS.levels[w]]), ...(f.jobTypes || []).map((w) => ['opt', LABELS.jobTypes[w]]));
      const af = f.applyFrom || (f.worldwide ? 'world' : 'any');
      if (af !== 'any') chips.push(['opt', af === 'europe' ? 'Apply from anywhere in Europe or the world' : 'Apply from anywhere in the world']);
      if (f.englishOnly !== false) chips.push(['opt', 'No other language']);
      if (f.maxYears != null) chips.push(['opt', `Max ${f.maxYears} yrs`]);
      if (f.easyApply) chips.push(['opt', 'Easy Apply']);
      chips.push(...(f.excludeWords || []).map((w) => ['no', `not "${w}"`]), ...(f.excludeCompanies || []).map((w) => ['no', `not ${w}`]));
      if (f.fewApplicants) chips.push(['opt', '< 10 applicants']);
      chips.push(...Object.entries(f.rules || {}).filter(([, v]) => v === false).map(([k]) => ['off', `off: ${JOB_RULE_LABELS[k].split(' (')[0]}`]));
    } else if (f) {
      chips.push(...f.keywords.map((k) => ['title', f.exact === false ? k : `"${k}"`]));
      if (f.postType && f.postType !== 'any') chips.push(['opt', LABELS.postType[f.postType]]);
      chips.push(...(f.authorTitles || []).map((a) => ['opt', `by ${a}`]), ...(f.countries || []).map((c) => ['loc', `${c}`]));
      if (f.remoteHiring !== false) chips.push(['opt', 'Hiring posts must be remote']);
      chips.push(...(f.excludeWords || []).map((w) => ['no', `not "${w}"`]), ...(f.topics || []).map((t) => ['opt', `about ${t}`]), ...(f.excludeHeadline || []).map((w) => ['no', `headline not "${w}"`]));
      chips.push(...Object.entries(f.rules || {}).filter(([, v]) => v === false).map(([k]) => ['off', `off: ${(POST_RULE_LABELS[k] || 'built-in topics').split(' (')[0]}`]));
    } else {
      chips.push(['title', s.keywords]);
      if (s.location) chips.push(['loc', `${s.location}`]);
    }
    const n = partsCount(s);
    return `<article class="pr-scard ${s.active ? '' : 'off'} ${running === s.id ? 'running' : ''}">
      <div class="pr-search-main">
        <div class="pr-search-head"><span class="pr-kind ${s.kind}">${s.kind === 'jobs' ? 'Jobs' : 'Posts'}</span><b>${esc(s.name)}</b>
          ${running === s.id ? '<span class="pr-running">● Running now</span>' : ''}${f ? '' : '<span class="sub">simple search</span>'}</div>
        <div class="pr-search-chips">${chips.map(([k, t]) => `<span class="c-${k}">${esc(t)}</span>`).join('')}</div>
        <div class="sub">${WINDOW_LABEL[s.date_window] || 'Last week'} · ${n} LinkedIn search${n === 1 ? '' : 'es'} per run · found <b>${s.kept}</b>${s.kept ? ` (${s.useful || 0} worth contacting – ${Math.round(((s.useful || 0) / s.kept) * 100)}%)` : ''}, filtered out ${s.rejected}
          ${s.last_run_at ? ` · last run ${esc(s.last_run_at.slice(5, 16))}: ${esc(s.last_result)}` : ' · never run'}</div>
      </div>
      <div class="pr-search-acts">
        <label class="toggle" title="ON = included when you press Run now"><input type="checkbox" data-search-active="${s.id}" ${s.active ? 'checked' : ''}/><span></span></label>
        <button class="btn sm" data-run-search="${s.id}" ${running ? 'disabled' : ''}>Run</button>
        <button class="btn sm" data-edit-search="${s.id}">Edit</button>
        <button class="btn sm" data-copy-search="${s.id}" title="Make a copy to change">Copy</button>
        <button class="btn sm danger" data-del-search="${s.id}" title="Delete">✕</button>
      </div>
    </article>`;
  };
  // ON first, then searches made with the builder; older simple searches go in a closed section
  const order = (a, b) => b.active - a.active || !!b.filters - !!a.filters || b.id - a.id;
  const section = (list) => {
    const main = list.filter((s) => s.active || s.filters).sort(order);
    const old = list.filter((s) => !s.active && !s.filters).sort(order);
    return (main.map(card).join('') || emptyBox('None yet – press "+ Job search" / "+ Post search".'))
      + (old.length ? `<details class="pr-old"><summary>${old.length} older simple searches (off)</summary>${old.map(card).join('')}</details>` : '');
  };
  const jobs = SEARCHES.filter((s) => s.kind === 'jobs');
  const posts = SEARCHES.filter((s) => s.kind !== 'jobs');
  const st = SETTINGS_PR;
  $('#prBody').innerHTML = `<div class="pr-search-top">
      <p class="muted">Build your own searches. Every search that is <b>ON</b> runs when you press <b>Run now</b> (or press ▶ Run on one). Always applied: English only, not in ${esc(st.prospect_blocked || '—')}, sellers / recruiters / job seekers dropped, at most ${st.prospect_daily_posts || '∞'} posts and ${st.prospect_daily_jobs || '∞'} jobs a day.</p>
      <div class="row gap"><button class="btn primary" data-new-search="jobs">New job search</button><button class="btn primary" data-new-search="posts">New post search</button></div>
    </div>
    <h3 class="pr-sec">Job searches <span>${jobs.filter((s) => s.active).length} on</span></h3>${section(jobs)}
    <h3 class="pr-sec">Post searches <span>${posts.filter((s) => s.active).length} on</span></h3>${section(posts)}`;
  $('#prCount').textContent = '';
  $('#prPrev').disabled = true;
  $('#prNext').disabled = true;
}

$('#prBody').addEventListener('change', guard(async (e) => {
  const t = e.target.closest('[data-search-active]');
  if (!t) return;
  await api(`/api/prospect-searches/${t.dataset.searchActive}/active`, { method: 'PATCH', body: { active: t.checked } });
  SEARCHES = await api('/api/prospect-searches');
  renderSearchTab();
}));
$('#prBody').addEventListener('click', guard(async (e) => {
  const nw = e.target.closest('[data-new-search]');
  const ed = e.target.closest('[data-edit-search]');
  const del = e.target.closest('[data-del-search]');
  const run = e.target.closest('[data-run-search]');
  const cp = e.target.closest('[data-copy-search]');
  if (cp) {
    const o = SEARCHES.find((x) => x.id == cp.dataset.copySearch);
    searchBuilder({ ...o, id: undefined, name: `${o.name} (copy)`, active: 1 });
  }
  if (nw) searchBuilder({ kind: nw.dataset.newSearch });
  if (ed) searchBuilder(SEARCHES.find((s) => s.id == ed.dataset.editSearch));
  if (run) await runProspects([Number(run.dataset.runSearch)]);
  if (del && confirm(`Delete the search "${searchName(del.dataset.delSearch)}"? Prospects it found are kept.`)) {
    await api(`/api/prospect-searches/${del.dataset.delSearch}`, { method: 'DELETE' });
    SEARCHES = await api('/api/prospect-searches');
    renderSearchTab();
  }
}));

/** Tag input: type and press Enter (or comma) to add; click a suggestion to add it; × removes */
function tagField(name, values = [], presets = [], placeholder = 'Type and press Enter') {
  return `<div class="tagfield" data-tags="${name}">
    <div class="tag-box">${values.map((v) => `<span class="tag">${esc(v)}<button type="button" data-untag>×</button></span>`).join('')}<input placeholder="${esc(placeholder)}" /></div>
    ${presets.length ? `<div class="tag-presets">${presets.map((p) => `<button type="button" data-preset="${esc(p)}" class="${values.includes(p) ? 'used' : ''}">+ ${esc(p)}</button>`).join('')}</div>` : ''}
  </div>`;
}
function wireTags(root, onChange) {
  const valuesOf = (f) => $$('.tag', f).map((t) => t.firstChild.textContent);
  const add = (f, v) => {
    v = v.trim();
    if (!v || valuesOf(f).some((x) => x.toLowerCase() === v.toLowerCase())) return;
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.innerHTML = `${esc(v)}<button type="button" data-untag>×</button>`;
    $('.tag-box', f).insertBefore(tag, $('.tag-box input', f));
    $$(`[data-preset]`, f).forEach((b) => b.classList.toggle('used', valuesOf(f).includes(b.dataset.preset)));
    onChange();
  };
  $$('.tagfield', root).forEach((f) => {
    const input = $('.tag-box input', f);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); input.value.split(',').forEach((v) => add(f, v)); input.value = ''; }
      if (e.key === 'Backspace' && !input.value) { const last = $$('.tag', f).pop(); if (last) { last.remove(); onChange(); } }
    });
    input.addEventListener('blur', () => { if (input.value.trim()) { input.value.split(',').forEach((v) => add(f, v)); input.value = ''; } });
    f.addEventListener('click', (e) => {
      const x = e.target.closest('[data-untag]');
      const p = e.target.closest('[data-preset]');
      if (x) { x.parentElement.remove(); $$('[data-preset]', f).forEach((b) => b.classList.toggle('used', valuesOf(f).includes(b.dataset.preset))); onChange(); }
      if (p) add(f, p.dataset.preset);
      if (e.target === f || e.target.classList.contains('tag-box')) input.focus();
    });
  });
  return (name) => valuesOf($(`[data-tags="${name}"]`, root));
}
const JOB_RULE_LABELS = {
  similarTitles: 'Also accept similar lead gen / business development titles (not only the exact titles above)',
  skipSdr: 'Skip SDR / Sales Development roles (unless you put that title above)',
  skipSenior: 'Skip senior roles (Senior, Director, VP, Head of, Principal …)',
  skipStaffing: 'Skip staffing / recruiting / BPO / VA companies',
  skipAgencyPosts: 'Skip jobs an agency posts for a client ("on behalf of our client")',
  skipNonSales: 'Skip non-sales roles (engineer, technician, nurse, teacher, intern …)',
  skipInternships: 'Skip internships',
};
const POST_RULE_LABELS = {
  need: 'The author must ask for something (looking for / need / recommend / struggling / hiring …)',
  nearTopic: 'The ask must be about the topic (not the topic mentioned somewhere else in the post)',
  firstPerson: 'Written by the buyer themselves (I / we), not advice or news',
  sellers: 'Skip sellers, agencies and freelancers offering these services',
  seekers: 'Skip job seekers (#opentowork, "looking for my next role")',
  recruiters: 'Skip recruiters posting for a client',
  spam: 'Skip courses, webinars, events, work-from-home and money spam',
  english: 'English only',
};
const ruleToggles = (labels, rules = {}) => Object.entries(labels).map(([k, l]) =>
  `<label class="check"><input type="checkbox" data-rule="${k}" ${rules[k] === false ? '' : 'checked'}/> ${l}</label>`).join('');
const checks = (name, map, chosen = []) => `<div class="check-row">${Object.entries(map).map(([k, l]) => `<label class="check"><input type="checkbox" name="${name}" value="${k}" ${chosen.includes(k) ? 'checked' : ''}/> ${l}</label>`).join('')}</div>`;

function searchBuilder(s) {
  const kind = s.kind === 'jobs' ? 'jobs' : 'posts';
  const old = filtersOf(s);
  const f = old || (kind === 'jobs'
    ? { titles: s.id ? [s.keywords.replace(/\s*remote$/i, '')] : [], locations: s.location ? [s.location] : [], workplace: ['remote'], levels: ['entry', 'associate'], jobTypes: [], applyFrom: 'europe', englishOnly: true, maxYears: 5, excludeWords: [], excludeCompanies: [], maxResults: 40 }
    : { keywords: s.id ? [s.keywords.replace(/^"|"$/g, '')] : [], exact: true, excludeWords: [], authorTitles: [], postType: 'any', remoteHiring: true, countries: [], sort: 'latest', maxResults: 80 });
  const body = kind === 'jobs' ? `
      <label>Search name<input name="name" value="${esc(s.name || '')}" placeholder="e.g. Junior BD roles – Europe" required /></label>
      <div class="fb-field"><b>Job titles</b><small>Each title is searched on LinkedIn. Similar lead gen / BD titles are accepted too.</small>${tagField('titles', f.titles, JOB_TITLE_PRESETS, 'e.g. Business Development Representative')}</div>
      <div class="fb-field"><b>Locations</b><small>Each title is searched in each location. Empty = anywhere (blocked countries are still dropped).</small>${tagField('locations', f.locations, LOCATION_PRESETS, 'e.g. Netherlands')}</div>
      <div class="fb-grid">
        <div class="fb-field"><b>Workplace</b>${checks('workplace', LABELS.workplace, f.workplace)}</div>
        <div class="fb-field"><b>Experience level (LinkedIn)</b>${checks('levels', LABELS.levels, f.levels)}</div>
        <div class="fb-field"><b>Job type</b>${checks('jobTypes', LABELS.jobTypes, f.jobTypes)}<small>none ticked = any</small></div>
        <div class="fb-field"><b>Posted</b><select name="date_window"><option value="day">Last 24 hours</option><option value="week">Last week</option></select>
          <b class="mt">Max years asked</b><input type="number" name="maxYears" min="0" max="30" value="${f.maxYears ?? ''}" placeholder="no limit" /></div>
      </div>
      <div class="fb-field"><b>Rules</b>
        <div class="check-row fb-apply"><span>Where you can apply from</span>
          ${[['world', 'Anywhere in the world – the posting must say worldwide / any country / contractor / freelance'], ['europe', 'Anywhere in Europe (or the world) – "remote within Europe", "based in Europe", "EU/EEA", European time zones'], ['any', 'No rule']]
            .map(([v, l]) => `<label class="check"><input type="radio" name="applyFrom" value="${v}" ${(f.applyFrom || (f.worldwide ? 'world' : 'any')) === v ? 'checked' : ''}/> ${l}</label>`).join('')}
          <small>Jobs tied to one country ("must be based in Germany", "right to work in the UK") are always dropped when a rule is set.</small></div>
        <label class="check"><input type="checkbox" name="englishOnly" ${f.englishOnly !== false ? 'checked' : ''}/> Skip jobs that ask for any other language (German speaker, fluent French, Dutch is a plus …)</label>
        <label class="check"><input type="checkbox" name="easyApply" ${f.easyApply ? 'checked' : ''}/> Easy Apply only</label>
        <label class="check"><input type="checkbox" name="fewApplicants" ${f.fewApplicants ? 'checked' : ''}/> Fewer than 10 applicants</label>
        ${ruleToggles(JOB_RULE_LABELS, f.rules)}</div>
      <div class="fb-grid two">
        <div class="fb-field"><b>Skip titles with these words</b>${tagField('excludeWords', f.excludeWords, ['Senior', 'Manager', 'Director', 'Intern', 'German', 'French'], 'e.g. Senior')}</div>
        <div class="fb-field"><b>Skip these companies</b>${tagField('excludeCompanies', f.excludeCompanies, [], 'e.g. Concentrix')}</div>
      </div>
      <div class="fb-grid two"><label class="fb-small">Jobs to read per title × location<input type="number" name="maxResults" min="5" max="100" value="${f.maxResults || 40}" /></label>
        <label class="fb-small">Order<select name="sort"><option value="recent">Most recent first</option><option value="relevance">Most relevant</option></select></label></div>` : `
      <label>Search name<input name="name" value="${esc(s.name || '')}" placeholder="e.g. Founders asking for outbound help" required /></label>
      <div class="fb-field"><b>Keywords / phrases</b><small>Each one is searched on LinkedIn posts separately.</small>${tagField('keywords', f.keywords, POST_KEYWORD_PRESETS, 'e.g. need appointment setter')}
        <label class="check"><input type="checkbox" name="exact" ${f.exact !== false ? 'checked' : ''}/> Exact phrase (in quotes) – off = any of the words</label></div>
      <div class="fb-grid two">
        <div class="fb-field"><b>Posted by people with these job titles</b><small>LinkedIn's author filter – empty = anyone</small>${tagField('authorTitles', f.authorTitles, AUTHOR_PRESETS, 'e.g. Founder')}</div>
        <div class="fb-field"><b>Where the author lives</b><small>Empty = Settings → target (${esc(SETTINGS_PR.prospect_target || 'anywhere')})</small>${tagField('countries', f.countries, COUNTRY_PRESETS, 'e.g. Europe')}</div>
      </div>
      <div class="fb-grid">
        <div class="fb-field"><b>Kind of post</b><div class="check-row">${Object.entries(LABELS.postType).map(([k, l]) => `<label class="check"><input type="radio" name="postType" value="${k}" ${f.postType === k ? 'checked' : ''}/> ${l}</label>`).join('')}</div>
          <label class="check"><input type="checkbox" name="remoteHiring" ${f.remoteHiring !== false ? 'checked' : ''}/> Hiring posts must be for a remote role</label></div>
        <div class="fb-field"><b>Posted</b><select name="date_window"><option value="day">Last 24 hours</option><option value="week">Last week</option></select></div>
        <div class="fb-field"><b>Order</b><select name="sort"><option value="latest">Latest first</option><option value="relevance">Most relevant</option></select></div>
        <div class="fb-field"><b>Posts to read per keyword</b><input type="number" name="maxResults" min="5" max="200" value="${f.maxResults || 80}" /></div>
      </div>
      <div class="fb-grid two">
        <div class="fb-field"><b>The post must be about</b><small>Your own topics – a post must mention one of them (or a built-in one if ticked below).</small>${tagField('topics', f.topics || [], ['lead generation', 'appointment setting', 'cold email', 'cold calling', 'LinkedIn outreach', 'email marketing', 'outbound', 'sales meetings', 'B2B leads', 'pipeline'], 'e.g. appointment setting')}
          <label class="check"><input type="checkbox" data-rule="builtinTopics" ${(f.rules || {}).builtinTopics === false ? '' : 'checked'}/> Also use the built-in lead gen topics (lead generation, outbound, outreach, cold email, email marketing, appointment setting, prospecting, pipeline, clients)</label></div>
        <div class="fb-field"><b>Skip authors whose headline has</b><small>e.g. skip recruiters or agencies by their headline</small>${tagField('excludeHeadline', f.excludeHeadline || [], ['Recruiter', 'Talent Acquisition', 'HR', 'Freelancer', 'Agency', 'Lead Generation', 'Appointment Setter', 'Coach'], 'e.g. Recruiter')}</div>
      </div>
      <div class="fb-field"><b>Skip posts with these words</b>${tagField('excludeWords', f.excludeWords, ['course', 'webinar', 'free training', 'crypto', 'MLM'], 'e.g. webinar')}</div>
      <div class="fb-field"><b>Rules</b>${ruleToggles(POST_RULE_LABELS, f.rules)}</div>`;
  openModal(`${s.id ? 'Edit' : 'New'} ${kind === 'jobs' ? 'job' : 'post'} search`, `<form id="fbForm" class="form fb">${body}
      <div class="fb-foot"><span class="muted" id="fbPreview"></span><div class="row gap"><button class="btn" type="button" data-close>Cancel</button><button class="btn" type="submit" name="go" value="save">Save</button><button class="btn primary" type="submit" name="go" value="run">Save &amp; run</button></div></div>
    </form>`);
  $('#modalBg .modal')?.classList.add('wide');
  const form = $('#fbForm');
  form.date_window.value = s.date_window || 'week';
  if (form.sort) form.sort.value = f.sort || (kind === 'jobs' ? 'recent' : 'latest');
  const preview = () => {
    const n = kind === 'jobs' ? tags('titles').length * Math.max(1, tags('locations').length) : tags('keywords').length;
    $('#fbPreview').textContent = n ? `${n} LinkedIn search${n === 1 ? '' : 'es'} each run${kind === 'jobs' ? ` (${tags('titles').length} titles × ${Math.max(1, tags('locations').length)} locations)` : ''}` : '';
  };
  const tags = wireTags(form, preview);
  preview();
  $('[data-close]', form).onclick = closeModal;
  form.onsubmit = guard(async (e) => {
    e.preventDefault();
    const val = (n) => $$(`input[name="${n}"]:checked`, form).map((i) => i.value);
    const on = (n) => !!form.querySelector(`[name="${n}"]`)?.checked;
    const rules = Object.fromEntries($$('[data-rule]', form).map((i) => [i.dataset.rule, i.checked]));
    const filters = kind === 'jobs'
      ? { titles: tags('titles'), locations: tags('locations'), workplace: val('workplace'), levels: val('levels'), jobTypes: val('jobTypes'),
        applyFrom: (val('applyFrom')[0] || 'any'), englishOnly: on('englishOnly'), easyApply: on('easyApply'), maxYears: form.maxYears.value, excludeWords: tags('excludeWords'),
        excludeCompanies: tags('excludeCompanies'), maxResults: form.maxResults.value, sort: form.sort.value, fewApplicants: on('fewApplicants'), rules }
      : { keywords: tags('keywords'), exact: on('exact'), authorTitles: tags('authorTitles'), countries: tags('countries'), postType: (val('postType')[0] || 'any'),
        remoteHiring: on('remoteHiring'), sort: form.sort.value, maxResults: form.maxResults.value, excludeWords: tags('excludeWords'),
        topics: tags('topics'), excludeHeadline: tags('excludeHeadline'), rules };
    const payload = { name: form.name.value, kind, date_window: form.date_window.value, active: s.id ? s.active : 1, filters };
    const saved = await api(s.id ? `/api/prospect-searches/${s.id}` : '/api/prospect-searches', { method: s.id ? 'PUT' : 'POST', body: payload });
    closeModal();
    $('#modalBg .modal')?.classList.remove('wide');
    SEARCHES = await api('/api/prospect-searches');
    prTab = 'searches';
    await loadProspects();
    $$('#prTabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === prTab));
    if (e.submitter?.value === 'run') await runProspects([saved.id]);
    else toast('Search saved');
  });
}

// ---------------- CV -> searches ----------------
// The file is read here in the browser (PDF via pdf.js, Word via mammoth); only its text goes to the server.
const loadScript = (src) => new Promise((ok, fail) => {
  if (document.querySelector(`script[src="${src}"]`)) return ok();
  const s = document.createElement('script');
  s.src = src;
  s.onload = ok;
  s.onerror = () => fail(new Error('Could not load the file reader – check the internet connection'));
  document.head.appendChild(s);
});
const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const MAMMOTH = 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js';

async function cvText(file) {
  const ext = file.name.toLowerCase().split('.').pop();
  if (ext === 'pdf') {
    await loadScript(PDFJS);
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS.replace('pdf.min.js', 'pdf.worker.min.js');
    const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const c = await (await pdf.getPage(i)).getTextContent();
      pages.push(c.items.map((it) => it.str).join(' '));
    }
    return pages.join('\n');
  }
  if (ext === 'docx') {
    await loadScript(MAMMOTH);
    return (await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })).value;
  }
  return file.text();
}

async function renderCvBox() {
  const { cvs } = await api('/api/cv');
  const box = $('#cvBox');
  box.classList.toggle('hidden', !cvs.length);
  if (!cvs.length) return;
  box.innerHTML = cvs.map((c) => {
    const names = Object.fromEntries((c.skills || []).map((k) => [k.id, k.label]));
    const chosen = (c.chosen || []).map((id) => names[id]).filter(Boolean);
    return `<div class="cv-row"><span>CV: <b>${esc(c.name)}</b> – ${chosen.length ? `searching for: ${chosen.map(esc).join(', ')} <span class="muted">(${c.searches} searches)</span>` : 'no skills picked yet'}</span>
      <span class="row gap"><button class="btn sm" data-cv-edit="${c.id}">Change</button><button class="btn sm danger" data-cv-del="${c.id}">Delete</button></span></div>`;
  }).join('');
  box.onclick = guard(async (e) => {
    const ed = e.target.closest('[data-cv-edit]');
    const del = e.target.closest('[data-cv-del]');
    const c = cvs.find((x) => String(x.id) === (ed || del)?.dataset[ed ? 'cvEdit' : 'cvDel']);
    if (!c) return;
    if (ed) return cvModal(c.id, c.skills || [], c.chosen || [], c.regions || []);
    if (!confirm(`Delete the CV "${c.name}" and its ${c.searches} searches? Prospects already found stay.`)) return;
    const r = await api(`/api/cv/${c.id}`, { method: 'DELETE' });
    toast(`CV deleted with ${r.deleted} searches`);
    await loaders.prospects();
  });
}

function cvModal(id, skills, chosen = [], regions = []) {
  const REG = { us: 'United States (remote)', uk: 'United Kingdom (remote)', ca: 'Canada (remote)', eu: 'Europe' };
  const pickAll = !chosen.length;
  const regAll = !regions.length;
  openModal('Searches from your CV', skills.length ? `
    <form id="cvForm" class="form">
      <p class="sub">These skills were found in this CV. Pick the ones you want – the bot will look for jobs with these titles and posts from people who need them.</p>
      <div class="cv-skills">${skills.map((k) => `<label class="cv-skill"><input type="checkbox" name="skill" value="${k.id}" ${pickAll || chosen.includes(k.id) ? 'checked' : ''}/>
        <span><b>${esc(k.label)}</b><small>mentioned ${k.count}× · jobs: ${k.jobs.map(esc).join(', ')}</small></span></label>`).join('')}</div>
      <p class="sub mt"><b>Job markets</b></p>
      <div class="row gap wrap">${Object.entries(REG).map(([rid, l]) => `<label class="cv-reg"><input type="checkbox" name="region" value="${rid}" ${regAll || regions.includes(rid) ? 'checked' : ''}/> ${l}</label>`).join('')}</div>
      <p class="sub">Only this CV's searches are replaced. Searches from your other CVs and your own searches stay as they are.</p>
      <div class="row gap mt"><button class="btn primary" type="submit" name="go" value="run">Create searches &amp; find now</button><button class="btn" type="submit" name="go" value="save">Only create searches</button><button class="btn" type="button" data-close>Cancel</button></div>
    </form>` : `<p>No lead generation, outreach or email marketing skills were found in this CV. Check that it isn't a scanned image, or add searches by hand under "Searches &amp; rules".</p>`);
  const f = $('#cvForm');
  if (!f) return;
  $('[data-close]', f).onclick = closeModal;
  f.onsubmit = guard(async (e) => {
    e.preventDefault();
    const pick = (n) => $$(`input[name="${n}"]:checked`, f).map((i) => i.value);
    const r = await api('/api/cv/apply', { method: 'POST', body: { id, skills: pick('skill'), regions: pick('region') } });
    closeModal();
    await loaders.prospects();
    if (e.submitter?.value === 'run') {
      renderStatus(await api('/api/runner/prospects', { method: 'POST', body: { search_ids: r.searchIds } }));
      toast(`${r.created} searches created from your CV – searching LinkedIn now`);
    } else toast(`${r.created} searches created from your CV`);
  });
}

$('#btnCv').onclick = () => $('#cvFile').click();
$('#cvFile').onchange = guard(async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  toast(`Reading ${file.name}…`);
  const text = await cvText(file);
  const { id, skills } = await api('/api/cv/analyze', { method: 'POST', body: { name: file.name, text } });
  await renderCvBox();
  cvModal(id, skills);
});

// ---------------- settings ----------------
loaders.settings = guard(async () => {
  SETTINGS = await api('/api/settings');
  const f = $('#settingsForm');
  for (const [k, v] of Object.entries(SETTINGS)) if (f.elements[k]) f.elements[k].value = v;
  if (APP === 'jobs') $('#jobsCv').value = (await api('/api/jobs/cv')).text;
});
$('#btnJobsCvSave').onclick = guard(async () => {
  await api('/api/jobs/cv', { method: 'PUT', body: { text: $('#jobsCv').value } });
  toast('CV saved');
});
$('#settingsForm').onsubmit = guard(async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {};
  for (const el of f.elements) {
    if (!el.name) continue;
    if (el.type === 'text') body[el.name] = el.value.trim();
    else if (String(el.value).trim() !== '') body[el.name] = Number(el.value);
  }
  SETTINGS = await api('/api/settings', { method: 'PUT', body });
  toast('Settings saved – applied immediately');
  updateDryHint();
});
async function updateDryHint() {
  const s = await api('/api/settings');
  $('#dryHint').textContent = s.dry_run ? '⚠ Test mode is ON – notes are filled but Send is not clicked. Turn it off in Settings to really send.' : '';
}

// ---------------- job applier ----------------
let JOBS_TAB = 'applied';
let JOBS = null;
let jobsTimer = null;
const loadJobsSoon = () => { clearTimeout(jobsTimer); jobsTimer = setTimeout(() => loaders.jobs(), 1500); };
const JOB_STATUS = { applied: 'Applied', queued: 'Waiting', tested: 'Tested', needs_answers: 'Needs answers', skipped: 'Skipped', failed: 'Failed' };

function renderJobsRun(s) {
  if (!s) return;
  const box = $('#jobsRun');
  const idle = s.status === 'idle';
  $('#btnJobsRun').disabled = !idle;
  $('#btnJobsTest').disabled = !idle;
  const stop = $('#btnJobsStop');
  stop.disabled = s.status === 'stopping' || (idle && s.stopped);
  stop.textContent = s.status === 'stopping' ? 'Stopping…' : idle && s.stopped ? 'Stopped' : 'Stop';
  box.classList.toggle('hidden', idle && !s.stopped);
  if (idle) {
    if (s.stopped) box.innerHTML = '<div><b>Stopped</b> · The bot will not apply until you press Apply now</div>';
    return;
  }
  const left = s.wait ? Math.max(0, Math.round((s.wait.until - Date.now()) / 1000)) : 0;
  box.innerHTML = `<span class="spin"></span><div><b>${s.test ? 'Test run' : 'Applying'}</b> · ${esc(s.current?.step || 'Starting…')}${s.current?.job ? ` <span class="muted">– ${esc(s.current.job)}</span>` : ''}</div>
    <small>${s.wait ? `${esc(s.wait.reason)} in ${left}s · ` : ''}${s.appliedToday} / ${s.target} today</small>`;
}

function jobQuestionInput(q) {
  const val = esc(q.answer || '');
  if (q.options && q.options.length) {
    const opts = q.options.map((o) => `<option ${o === q.answer ? 'selected' : ''}>${esc(o)}</option>`).join('');
    return `<select data-qkey="${esc(q.key)}"><option value="">Choose…</option>${opts}</select>`;
  }
  return `<input data-qkey="${esc(q.key)}" value="${val}" placeholder="${q.kind === 'number' ? 'A number' : 'Your answer'}" />`;
}
const jobQuestionRow = (q) => `<div class="jobs-q-row"><div class="lbl">${esc(q.label)}<small>asked in ${q.seen} form${q.seen === 1 ? '' : 's'}${q.source === 'cv' && q.answer ? ' · answered from your CV' : ''}</small>${(q.jobs || []).length ? `<small class="jobs-q-jobs">${q.jobs.map((j) => `<a href="${esc(j.url)}" target="_blank" rel="noopener">${esc(j.title)} – ${esc(j.company)}</a>${j.waiting ? ' <span class="badge needs_answers">waiting</span>' : ''}`).join('<br>')}</small>` : ''}</div>${jobQuestionInput(q)}<button class="btn sm${q.answer ? '' : ' primary'}" data-qsave="${esc(q.key)}">Save</button></div>`;

function renderJobQuestions(qs) {
  const box = $('#jobsQuestions');
  // never redraw under your hands: while you type in a box, or anything typed is not saved yet
  const typing = box.contains(document.activeElement) && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
  const unsaved = [...box.querySelectorAll('[data-qkey]')].filter((el) => {
    const q = (JOBS?.questions || []).find((x) => x.key === el.dataset.qkey);
    return el.value !== (q ? q.answer || '' : '') && el.value !== '';
  });
  if (typing || unsaved.length) return;
  const open = qs.filter((q) => !q.answer);
  const done = qs.filter((q) => q.answer);
  box.innerHTML = !qs.length ? '' : `<div class="card jobs-q">
    <h3>${open.length ? `${open.length} question${open.length === 1 ? '' : 's'} to answer` : 'Your form answers'}</h3>
    <p class="muted small">${open.length ? 'Application forms asked these and the bot had no answer, so those jobs wait. Answer once – the bot uses it for every job and applies to the waiting ones on the next run.' : 'The bot uses these for every application form. Change any of them here.'}</p>
    ${open.map(jobQuestionRow).join('')}
    ${done.length ? `<details ${open.length ? '' : 'open'}><summary>Saved answers (${done.length})</summary>${done.map(jobQuestionRow).join('')}</details>` : ''}
  </div>`;
}

function jobRow(r) {
  const when = (r.applied_at || r.updated_at || '').slice(0, 16);
  const qs = r.status === 'needs_answers' && r.questions.length ? `<div class="sub">Waiting for: ${r.questions.map((q) => esc(q.label)).join(' · ')}</div>` : '';
  const retry = ['skipped', 'failed', 'needs_answers'].includes(r.status) ? `<button class="btn sm" data-jretry="${r.id}" title="Put it back in the queue for the next run">Try again</button>` : '';
  return `<tr>
    <td><a href="${esc(r.url)}" target="_blank" rel="noopener"><b>${esc(r.title)}</b></a><div class="sub">${esc(r.company)}</div></td>
    <td>${esc(r.location || r.region)}<div class="sub">${esc(r.keyword)}</div></td>
    <td><span class="badge ${esc(r.status)}">${JOB_STATUS[r.status] || esc(r.status)}</span>${r.reason ? `<div class="sub">${esc(r.reason)}</div>` : ''}${qs}</td>
    <td>${r.resume ? esc(r.resume) : '<span class="muted">—</span>'}</td>
    <td class="sub">${esc(when)}</td>
    <td>${retry}</td>
  </tr>`;
}

loaders.jobs = guard(async () => {
  JOBS = await api(`/api/jobs?status=${JOBS_TAB}`);
  const c = JOBS.counts;
  const st = JOBS.status;
  const open = JOBS.questions.filter((q) => !q.answer).length;
  $('#jobsStats').innerHTML = `
    <div class="card stat"><span>Applied today</span><b>${st.appliedToday}</b><small>of ${st.target} a day</small><div class="bar"><div style="width:${Math.min(100, (st.appliedToday / Math.max(1, st.target)) * 100)}%"></div></div></div>
    <div class="card stat"><span>Applied in total</span><b>${c.applied || 0}</b><small>with Easy Apply</small></div>
    <div class="card stat${open ? ' warn' : ''}"><span>Questions to answer</span><b>${open}</b><small>${c.needs_answers || 0} job${c.needs_answers === 1 ? '' : 's'} waiting for them</small></div>
    <div class="card stat"><span>Waiting</span><b>${(c.queued || 0) + (c.tested || 0)}</b><small>found, applied on the next run</small></div>`;
  const counts = { applied: c.applied || 0, queued: (c.queued || 0) + (c.tested || 0), needs_answers: c.needs_answers || 0, skipped: (c.skipped || 0) + (c.failed || 0) };
  $$('#jobsTabs button').forEach((b) => { b.classList.toggle('on', b.dataset.tab === JOBS_TAB); b.querySelector('span').textContent = counts[b.dataset.tab] || ''; });
  renderJobQuestions(JOBS.questions);
  renderJobSearch();
  renderJobsRun(st);
  $('#jobsTbl').innerHTML = JOBS.rows.length
    ? `<thead><tr><th>Role & company</th><th>Location</th><th>Status</th><th>Resume</th><th>When</th><th></th></tr></thead><tbody>${JOBS.rows.map(jobRow).join('')}</tbody>`
    : `<tbody><tr><td class="jobs-tbl-empty">${{ applied: 'No applications yet. Press Test run to see the forms filled without sending, or Apply now.', queued: 'Nothing waiting.', needs_answers: 'No job is waiting for answers.', skipped: 'Nothing skipped.' }[JOBS_TAB]}</td></tr></tbody>`;
});

// Saved job searches. The selected one is what the bot runs; every keyword / region is saved as soon as it is
// added or removed, and a run in progress switches to it right away.
let jobSearchTags = null;
let jobSearchTimer = null;
function renderJobSearch() {
  const { searches, activeId, keywords, regions } = JOBS.search;
  $('#jobsSearchTabs').innerHTML = searches.map((s) => `<button type="button" class="chip-btn${s.id === activeId ? ' on' : ''}" data-search="${s.id}">${esc(s.name)}</button>`).join('')
    + '<button type="button" class="chip-btn" data-search-new>+ New search</button>';
  $('#jobsSearchDelete').classList.toggle('hidden', searches.length < 2);
  const sf = $('#jobsSearch');
  if (sf.dataset.active === String(activeId)) return; // same search: don't disturb what you are typing
  sf.dataset.active = activeId;
  const split = (t) => String(t || '').split(',').map((x) => x.trim()).filter(Boolean);
  $('#jobsSearchName').value = searches.find((s) => s.id === activeId)?.name || '';
  $('#jobsKeywordsField').innerHTML = tagField('keywords', split(keywords), [], 'e.g. Outreach Specialist');
  $('#jobsRegionsField').innerHTML = tagField('regions', split(regions), [], 'e.g. Pakistan');
  jobSearchTags = wireTags(sf, () => { clearTimeout(jobSearchTimer); jobSearchTimer = setTimeout(saveJobSearch, 300); });
}
async function saveJobSearch() {
  jobSearchTimer = null;
  const keywords = jobSearchTags('keywords');
  const regions = jobSearchTags('regions');
  const note = $('#jobsSearchNote');
  if (!keywords.length || !regions.length) { note.textContent = `Add at least one ${keywords.length ? 'region' : 'keyword'} – not saved yet`; return; }
  try {
    const r = await api('/api/jobs/search', { method: 'PUT', body: { keywords: keywords.join(','), regions: regions.join(',') } });
    note.textContent = `Saved: ${r.keywords.length} keyword(s) × ${r.regions.length} region(s) – the bot uses this search now`;
    await loaders.jobs();
  } catch (e) { toast(e.message, true); }
}
/** A change still waiting to be saved belongs to the search on screen, so it goes first */
async function flushJobSearch() {
  if (jobSearchTimer) { clearTimeout(jobSearchTimer); await saveJobSearch(); }
}
$('#jobsSearchTabs').addEventListener('click', guard(async (e) => {
  const pick = e.target.closest('[data-search]');
  if (e.target.closest('[data-search-new]')) {
    await flushJobSearch();
    const names = JOBS.search.searches.map((s) => s.name.toLowerCase());
    let n = names.length + 1;
    while (names.includes(`search ${n}`)) n++;
    await api('/api/jobs/searches', { method: 'POST', body: { name: `Search ${n}` } });
    await loaders.jobs();
    $('#jobsSearchName').focus();
    $('#jobsSearchName').select();
    $('#jobsSearchNote').textContent = 'New search selected – name it, then change its keywords and regions';
  } else if (pick && Number(pick.dataset.search) !== JOBS.search.activeId) {
    await flushJobSearch();
    await api(`/api/jobs/searches/${pick.dataset.search}/select`, { method: 'POST' });
    await loaders.jobs();
    $('#jobsSearchNote').textContent = 'Selected – the bot uses this search now';
  }
}));
$('#jobsSearchName').addEventListener('change', guard(async (e) => {
  try {
    await api(`/api/jobs/searches/${JOBS.search.activeId}`, { method: 'PUT', body: { name: e.target.value } });
  } catch (err) {
    e.target.value = JOBS.search.searches.find((s) => s.id === JOBS.search.activeId)?.name || '';
    throw err;
  }
  await loaders.jobs();
}));
$('#jobsSearchDelete').addEventListener('click', guard(async () => {
  const s = JOBS.search.searches.find((x) => x.id === JOBS.search.activeId);
  if (!confirm(`Delete the search "${s.name}"?`)) return;
  clearTimeout(jobSearchTimer);
  jobSearchTimer = null;
  await api(`/api/jobs/searches/${s.id}`, { method: 'DELETE' });
  await loaders.jobs();
  $('#jobsSearchNote').textContent = `Deleted "${s.name}"`;
}));
$('#jobsSearch').onsubmit = (e) => e.preventDefault();
$('#jobsQuestions').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !e.target.matches('input[data-qkey]')) return;
  e.preventDefault();
  [...document.querySelectorAll('[data-qsave]')].find((b) => b.dataset.qsave === e.target.dataset.qkey)?.click();
});
$('#jobsTabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  JOBS_TAB = b.dataset.tab;
  loaders.jobs();
});
$('#btnJobsRun').onclick = guard(async () => {
  if (!confirm('Apply to jobs now? The bot sends real applications with your LinkedIn resume, up to today\'s limit.')) return;
  renderJobsRun(await api('/api/jobs/run', { method: 'POST', body: {} }));
  toast('Applying – you can follow it here');
});
$('#btnJobsTest').onclick = guard(async () => {
  renderJobsRun(await api('/api/jobs/run', { method: 'POST', body: { test: true } }));
  toast('Test run: 3 forms are filled, nothing is sent');
});
$('#btnJobsStop').onclick = guard(async () => {
  renderJobsRun(await api('/api/jobs/stop', { method: 'POST' }));
  toast('Stopped – the bot will not apply until you press Apply now');
});
document.addEventListener('click', guard(async (e) => {
  const save = e.target.closest('[data-qsave]');
  if (save) {
    const key = save.dataset.qsave;
    const el = [...document.querySelectorAll('[data-qkey]')].find((x) => x.dataset.qkey === key);
    const q = JOBS.questions.find((x) => x.key === key);
    const r = await api('/api/jobs/answers', { method: 'PUT', body: { key, label: q?.label, answer: el.value } });
    toast(r.requeued ? `Saved – applying to ${r.requeued} job(s) that waited for it${r.started ? ' now' : ' next'}` : 'Saved');
    loaders.jobs();
  }
  const retry = e.target.closest('[data-jretry]');
  if (retry) {
    await api(`/api/jobs/${retry.dataset.jretry}/retry`, { method: 'POST' });
    toast('Back in the queue for the next run');
    loaders.jobs();
  }
}));
setInterval(() => { if (APP === 'jobs' && JOBS && JOBS.status.status !== 'idle') api('/api/jobs?status=none').then((j) => renderJobsRun(j.status)).catch(() => {}); }, 5000);

// ---------------- logs ----------------
loaders.logs = guard(async () => {
  const logs = await api('/api/logs?limit=500');
  $('#fullLog').innerHTML = logs.map(logItem).join('') || '<li class="muted">No activity yet.</li>';
});
$('#btnClearLogs').onclick = guard(async () => {
  if (!confirm('Clear the whole activity log?')) return;
  await api('/api/logs', { method: 'DELETE' });
  loaders.logs();
});

// ---------------- boot ----------------
connectEvents();
// both runners' status right away (the prospect finder runs on its own)
api('/api/runner/status').then(renderStatus).catch(() => {});
updateDryHint();
show(location.hash.slice(1) || HOME[APP]);
setInterval(() => (location.hash.slice(1) || 'dashboard') === 'dashboard' && loaders.dashboard(), 30000);
