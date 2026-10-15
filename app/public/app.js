// Dashboard front-end (no build step). Talks to the local API on the same port.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ERROR_LABEL = {
  outside_target_location: 'lives outside target countries',
  email_required: 'LinkedIn asked for their email',
  no_connect: 'no Connect option',
  no_dialog: 'invite popup did not open',
  no_note_button: 'no "Add a note" option',
  no_note_box: 'note box did not appear',
  no_first_name: 'no first name found',
  pending_invite: 'invite already pending',
};
const STATUS_LABEL = {
  pending: 'Pending', sent: 'Sent', skipped: 'Skipped', failed: 'Failed',
  already_connected: 'Already connected', pending_invite: 'Invite pending',
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (err ? ' err' : '');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add('hidden'), 3500);
}
const guard = (fn) => async (...a) => {
  try { await fn(...a); } catch (e) { toast(e.message, true); }
};

// ---------------- navigation ----------------
const loaders = {};
function show(view) {
  $$('nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  location.hash = view;
  loaders[view] && loaders[view]();
}
$$('nav a').forEach((a) => a.addEventListener('click', () => show(a.dataset.view)));
document.addEventListener('click', (e) => {
  const g = e.target.closest('[data-goto]');
  if (g) show(g.dataset.goto);
});

// ---------------- modal ----------------
function openModal(title, html) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = html;
  $('#modalBg').classList.remove('hidden');
}
const closeModal = () => $('#modalBg').classList.add('hidden');
$('#modalClose').onclick = closeModal;
$('#modalBg').addEventListener('mousedown', (e) => e.target.id === 'modalBg' && closeModal());

// ---------------- state ----------------
let TYPES = [];
let LISTS = [];
let SETTINGS = {};
let STATUS = {};

// ---------------- dashboard ----------------
loaders.dashboard = guard(async () => {
  const [stats, lists] = await Promise.all([api('/api/stats'), api('/api/lists')]);
  LISTS = lists;
  const b = stats.byStatus;
  $('#stPending').textContent = b.pending || 0;
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
    ? active.map((l) => `<label><input type="checkbox" value="${l.id}" ${checked.has(String(l.id)) ? 'checked' : ''}/> ${esc(l.name)} <small class="muted">(${l.pending || 0} leads waiting)</small></label>`).join('')
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
  const pill = $('#runPill');
  pill.textContent = { idle: 'Idle', running: s.mode === 'sync' ? 'Syncing leads' : s.mode === 'accept' ? 'Checking acceptances' : 'Running', paused: 'Paused', stopping: 'Stopping…' }[s.status];
  pill.className = 'status-pill ' + s.status;
  $('#stToday').textContent = s.sentToday;
  $('#stTodayOf').textContent = `notes sent of ${s.dailyLimit} daily limit`;
  $('#stTodayBar').style.width = Math.min(100, (s.sentToday / Math.max(1, s.dailyLimit)) * 100) + '%';
  renderCampaigns();
  $('#runNow').innerHTML = s.current
    ? `List <b>${esc(s.current.list?.name)}</b> → <b>${esc(s.current.lead?.name)}</b>`
    : s.status === 'idle' ? 'Nothing running.' : 'Working…';

  const idle = s.status === 'idle';
  $('#btnStart').disabled = !idle;
  $('#btnSync').disabled = !idle;
  $('#btnAccept').disabled = !idle;
  const la = s.lastAcceptanceCheck;
  $('#lastAccept').textContent = la ? `Last acceptance check: ${la.at} – read ${la.scanned} recent connections, ${la.found} new` : 'Acceptances not checked yet';
  $('#btnPause').disabled = s.status !== 'running';
  $('#btnResume').disabled = s.status !== 'paused';
  $('#btnStop').disabled = idle || s.status === 'stopping';
  const ep = $('#extPill');
  ep.textContent = s.extension ? 'Extension connected' : 'Extension not connected';
  ep.className = 'ext-pill ' + (s.extension ? 'on' : 'off');

  $('#sideStatus').innerHTML = `<div><span>Status</span><b>${pill.textContent}</b></div><div><span>Today</span><b>${s.sentToday}/${s.dailyLimit}</b></div><div><span>Extension</span><b>${s.extension ? 'connected' : 'offline'}</b></div>`;

  renderLimitPause(s.limitPause);

  if (s.wait) startCountdown(s.wait);
  else stopCountdown();
}

// ---------- LinkedIn limit -> all campaigns paused ----------
let limitShownAt = null;
function limitText(p) {
  return p.kind === 'notes'
    ? { title: 'Personalized notes limit reached', urdu: 'Connection notes ki limit puri hone ki wajah se yeh campaigns ruk gayi hain.' }
    : { title: 'LinkedIn weekly invitation limit reached', urdu: 'Weekly limit puri hone ki wajah se yeh campaigns ruk gayi hain.' };
}
function renderLimitPause(p) {
  const banner = $('#limitBanner');
  if (!p) {
    banner.classList.add('hidden');
    limitShownAt = null;
    return;
  }
  const t = limitText(p);
  banner.classList.remove('hidden');
  banner.innerHTML = `<div><b>⏸ ${esc(t.title)} – all campaigns paused</b><div class="sub">${esc(t.urdu)} Paused at ${esc(p.at)} · ${p.list_names.length} list(s)</div></div>
    <div class="row gap"><button class="btn sm primary" data-limit="resume">Resume campaigns</button><button class="btn sm" data-limit="details">Details</button></div>`;
  if (limitShownAt !== p.at) {
    limitShownAt = p.at;
    showLimitPopup(p);
  }
}
function showLimitPopup(p) {
  const t = limitText(p);
  openModal('⏸ Campaigns paused', `
    <div class="limit-pop">
      <p class="lp-title">${esc(t.title)}</p>
      <p class="lp-urdu">${esc(t.urdu)}</p>
      <p>LinkedIn stopped accepting more invitations, so the bot paused <b>all campaigns</b> automatically to protect your account.
         Nothing else will be sent until you resume.</p>
      <table class="lp-facts">
        <tr><td>Paused at</td><td>${esc(p.at)}</td></tr>
        <tr><td>Sent today</td><td>${p.sent_today}</td></tr>
        <tr><td>Lists paused</td><td>${p.list_names.map(esc).join('<br/>') || '—'}</td></tr>
      </table>
      <p class="sub">${p.kind === 'notes'
        ? 'Personalized-note quota usually resets monthly (or with Premium). Resume once LinkedIn lets you add notes again.'
        : 'The weekly limit usually frees up after about 7 days. Resume after that – the lists continue where they stopped.'}</p>
      <div class="row gap mt"><button class="btn primary" data-limit="resume">Resume campaigns now</button>
        <button class="btn" data-limit="close">Keep paused</button>
        <button class="btn ghost" data-limit="dismiss" title="Hide this notice; lists stay OFF">Dismiss notice</button></div>
    </div>`);
}
document.addEventListener('click', guard(async (e) => {
  const b = e.target.closest('[data-limit]');
  if (!b) return;
  const act = b.dataset.limit;
  if (act === 'details') return STATUS.limitPause && showLimitPopup(STATUS.limitPause);
  if (act === 'close') return closeModal();
  if (act === 'resume' && !confirm('Turn the paused lists back ON? Make sure LinkedIn lets you send invitations again.')) return;
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
  renderStatus(await api('/api/runner/start', { method: 'POST', body: { list_ids: selectedListIds() } }));
  toast('Started');
});
$('#btnAccept').onclick = guard(async () => {
  renderStatus(await api('/api/runner/check-acceptances', { method: 'POST' }));
  toast('Checking your connections page…');
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
  toast(r.loggedIn ? `Using your LinkedIn tab ✓ (${r.url.slice(0, 60)})` : 'That LinkedIn tab is not logged in', !r.loggedIn);
});

function logItem(l) {
  return `<li><time>${esc((l.ts || '').slice(5, 16))}</time><span class="${l.level}">${esc(l.message)}</span></li>`;
}

// ---------------- live events ----------------
function connectEvents() {
  const es = new EventSource('/api/events');
  es.addEventListener('status', (e) => renderStatus(JSON.parse(e.data)));
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
  es.addEventListener('lead', refresh);
  es.addEventListener('leads', refresh);
  es.onerror = () => { es.close(); setTimeout(connectEvents, 3000); };
}

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
        <div class="row gap"><button class="btn sm primary" data-edit-type="${t.id}">✎ Edit / add notes</button><button class="btn sm danger" data-del-type="${t.id}">Delete</button></div>
      </div>`;
      }).join('')
    : '<div class="card empty">No message types yet. Click <b>+ Add message type</b>.</div>';
});

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
    const body = { name: f.name.value, description: f.description.value, variants };
    await api(t.id ? `/api/types/${t.id}` : '/api/types', { method: t.id ? 'PUT' : 'POST', body });
    closeModal();
    toast('Connection notes saved');
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
        <label class="toggle" title="${l.active ? 'ON – click to pause' : 'OFF – click to turn ON'}"><input type="checkbox" data-active="${l.id}" ${l.active ? 'checked' : ''}/><span></span></label>
        <div class="ls-title">
          <h4>${esc(l.name)}</h4>
          <div class="ls-meta">
            ${l.type_name ? `<button class="chip type" ${l.type_id ? `data-notes="${l.type_id}"` : ''} title="Edit the connection notes">✉ ${esc(l.type_name)}</button>` : '<span class="chip bad">No message type – pick one</span>'}
            <a class="chip link-chip" href="${esc(l.url)}" target="_blank" title="${esc(l.url)}">↗ ${host}</a>
            ${l.target_countries ? `<span class="chip" title="Only people living here get a note">📍 ${esc(l.target_countries)}</span>` : ''}
          </div>
        </div>
        <span class="ls-state">${l.active ? 'ON' : 'OFF'}</span>
      </div>
      ${l.notes ? `<p class="ls-notes">${esc(l.notes)}</p>` : ''}

      <div class="ls-stats">
        <div><b>${total}</b><span>Leads</span></div>
        <div><b>${l.pending || 0}</b><span>Waiting</span></div>
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

      <div class="ls-foot">
        <span class="sub">⟳ Synced ${esc(l.last_synced_at || 'never')}</span>
        <div class="row gap">
          <button class="btn sm" data-leads="${l.id}">👥 Leads</button>
          <button class="btn sm" data-edit-list="${l.id}">Edit</button>
          <button class="btn sm icon danger" data-del-list="${l.id}" title="Delete list">🗑</button>
        </div>
      </div>
    </div>`;
}

function limitBlock(l) {
  const sent = l.sent_since_on || 0;
  const today = l.active ? `<span>Today <b>${l.sent_today || 0}</b> / ${l.daily_share || 0}</span>` : '<span class="muted">paused</span>';
  if (!l.send_limit) return `<div class="ls-limit"><div class="ls-limit-row"><span>Round: <b>${sent}</b> sent since ON · no limit</span>${today}</div></div>`;
  const pct = Math.min(100, (sent / l.send_limit) * 100);
  const done = sent >= l.send_limit;
  return `<div class="ls-limit ${done ? 'done' : ''}">
    <div class="ls-limit-row"><span>Round limit <b>${sent} / ${l.send_limit}</b>${done ? ' <span class="badge sent">done</span>' : ''}</span>${today}</div>
    <div class="bar"><div style="width:${pct}%"></div></div>
  </div>`;
}

function listForm(l = { active: 1, max_pages: 20, send_limit: 0 }) {
  if (!TYPES.length) return toast('Create a message type first', true);
  openModal(l.id ? 'Edit list' : 'Add list', `
    <form class="form" id="listForm">
      <label>List name<input name="name" required value="${esc(l.name)}" placeholder="e.g. US Bookkeepers – contractors" /></label>
      <label>Sales Navigator URL
        <input name="url" required value="${esc(l.url)}" placeholder="https://www.linkedin.com/sales/search/people?savedSearchId=..." />
        <small>Open the saved search (or lead list) in Sales Navigator and copy the address bar.</small>
      </label>
      <div class="grid-2">
        <label>Message type
          <select name="type_id" required>${TYPES.map((t) => `<option value="${t.id}" ${t.id == l.type_id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
          <small>the connection notes this list uses</small>
        </label>
        <label>Active
          <select name="active"><option value="1" ${l.active ? 'selected' : ''}>Yes – ON</option><option value="0" ${!l.active ? 'selected' : ''}>No – OFF</option></select>
          <small>only ON lists are processed</small>
        </label>
        <label>Connection notes limit<input type="number" name="send_limit" min="0" value="${l.send_limit || 0}" /><small>list turns OFF after this many. 0 = no limit. Restarts from 0 each time you turn it ON.</small></label>
        <label>Max pages to scan<input type="number" name="max_pages" min="1" max="100" value="${l.max_pages}" /><small>25 leads per page</small></label>
      </div>
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
    const body = { name: f.name.value, url: f.url.value, type_id: Number(f.type_id.value), max_pages: Number(f.max_pages.value), send_limit: Number(f.send_limit.value) || 0, target_countries: f.target_countries.value, active: f.active.value === '1', notes: f.notes.value };
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
  if (del && confirm('Delete this list and all its collected leads?')) {
    await api(`/api/lists/${del.dataset.delList}`, { method: 'DELETE' });
    loaders.lists();
  }
}));

// ---------------- leads ----------------
let leadsPage = 0;
const PAGE = 50;
loaders.leads = guard(async () => {
  const lists = await api('/api/lists');
  const sel = $('#fList');
  const cur = sel.value;
  sel.innerHTML = '<option value="">All lists</option>' + lists.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('');
  sel.value = cur;
  const qs = new URLSearchParams({ list_id: sel.value, status: $('#fStatus').value, q: $('#fQ').value, limit: PAGE, offset: leadsPage * PAGE });
  const { total, rows } = await api('/api/leads?' + qs);
  $('#leadsTbl').innerHTML = `<tr><th>Name</th><th>Company / title</th><th>List</th><th>Status</th><th>Note sent</th><th></th></tr>` +
    (rows.length ? rows.map((r) => `
      <tr>
        <td><b>${esc(r.name)}</b> <span class="sub">${esc(r.degree)}</span>
          <div class="sub">${r.profile_url ? `<a href="${esc(r.profile_url)}" target="_blank">profile</a> · ` : ''}${r.sales_url ? `<a href="${esc(r.sales_url)}" target="_blank">sales nav</a>` : ''}</div></td>
        <td>${esc(r.company)}<div class="sub">${esc(r.title)}</div><div class="sub">📍 ${esc(r.location || '—')}</div></td>
        <td class="sub">${esc(r.list_name)}</td>
        <td>${r.accepted_at ? `<span class="badge sent">✓ Accepted</span><div class="sub">${esc(r.accepted_at)}</div>` : `<span class="badge ${r.status}">${STATUS_LABEL[r.status] || r.status}</span>`}${r.error ? `<div class="sub">${esc(ERROR_LABEL[r.error] || r.error)}</div>` : ''}${r.sent_at ? `<div class="sub">${esc(r.sent_at)}</div>` : ''}</td>
        <td class="sub" style="max-width:320px">${esc(r.message)}</td>
        <td><div class="row gap">${r.status !== 'pending' ? `<button class="btn sm" data-reset="${r.id}" title="Put back in queue">↺</button>` : ''}<button class="btn sm danger" data-del-lead="${r.id}" title="Delete">✕</button></div></td>
      </tr>`).join('') : '<tr><td colspan="6" class="empty">No leads. Add a list and click "Sync leads only" or "Start sending" on the Dashboard.</td></tr>');
  $('#leadsCount').textContent = `${total} leads · page ${leadsPage + 1} of ${Math.max(1, Math.ceil(total / PAGE))}`;
  $('#pgPrev').disabled = leadsPage === 0;
  $('#pgNext').disabled = (leadsPage + 1) * PAGE >= total;
});
let qT;
$('#fQ').addEventListener('input', () => { clearTimeout(qT); qT = setTimeout(() => { leadsPage = 0; loaders.leads(); }, 300); });
$('#fList').onchange = $('#fStatus').onchange = () => { leadsPage = 0; loaders.leads(); };
$('#pgPrev').onclick = () => { leadsPage--; loaders.leads(); };
$('#pgNext').onclick = () => { leadsPage++; loaders.leads(); };
$('#btnResetFailed').onclick = guard(async () => {
  const r = await api('/api/leads/reset-failed', { method: 'POST', body: { list_id: $('#fList').value || undefined } });
  toast(`${r.reset} skipped leads put back in queue`);
  loaders.leads();
});
$('#leadsTbl').addEventListener('click', guard(async (e) => {
  const r = e.target.closest('[data-reset]');
  const d = e.target.closest('[data-del-lead]');
  if (r) await api(`/api/leads/${r.dataset.reset}/reset`, { method: 'POST' });
  if (d && confirm('Delete this lead? It may be collected again on next sync.')) await api(`/api/leads/${d.dataset.delLead}`, { method: 'DELETE' });
  if (r || d) loaders.leads();
}));

// ---------------- settings ----------------
loaders.settings = guard(async () => {
  SETTINGS = await api('/api/settings');
  const f = $('#settingsForm');
  for (const [k, v] of Object.entries(SETTINGS)) if (f.elements[k]) f.elements[k].value = v;
});
$('#settingsForm').onsubmit = guard(async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {};
  for (const el of f.elements) if (el.name && String(el.value).trim() !== '') body[el.name] = Number(el.value);
  SETTINGS = await api('/api/settings', { method: 'PUT', body });
  toast('Settings saved – applied immediately');
  updateDryHint();
});
async function updateDryHint() {
  const s = await api('/api/settings');
  $('#dryHint').textContent = s.dry_run ? '⚠ Test mode is ON – notes are filled but Send is not clicked. Turn it off in Settings to really send.' : '';
}

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

// ---------------- guide ----------------
loaders.guide = guard(async () => {
  if ($('#shots').children.length) return;
  const files = await api('/api/screenshots');
  $('#shots').innerHTML = files.map((f) => `<figure onclick="window.open('/screenshots/${encodeURIComponent(f)}')"><img loading="lazy" src="/screenshots/${encodeURIComponent(f)}"/><figcaption>${esc(f.replace('.png', '').replace(/_/g, ' '))}</figcaption></figure>`).join('');
});

// ---------------- boot ----------------
connectEvents();
updateDryHint();
show(location.hash.slice(1) || 'dashboard');
setInterval(() => (location.hash.slice(1) || 'dashboard') === 'dashboard' && loaders.dashboard(), 30000);
