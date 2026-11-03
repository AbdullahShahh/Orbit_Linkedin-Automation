// DOM actions injected into LinkedIn pages. Each one is called by background.js on request
// of the backend. They only click/type what you would click/type yourself.
(() => {
  if (window.__lcb && window.__lcb.v === 95) return;

  // The bot's tab is always in the background, where Chrome slows page timers down (to a minute after
  // a while). So waits are done by the extension's background worker, which isn't slowed down.
  const pageSleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const sleep = (ms) => {
    try {
      if (chrome?.runtime?.id) return chrome.runtime.sendMessage({ type: 'sleep', ms }).catch(() => pageSleep(ms));
    } catch { /* not available */ }
    return pageSleep(ms);
  };
  const jitter = (a, b) => sleep(a + Math.random() * (b - a));
  const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const textOf = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  const labelOf = (el) => (el.getAttribute('aria-label') || '').trim();

  async function waitFor(sel, timeout = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const el = [...document.querySelectorAll(sel)].find(visible);
      if (el) return true;
      await sleep(300);
    }
    return false;
  }

  function realClick(el) {
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, view: window, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
    el.dispatchEvent(new PointerEvent('pointerdown', o));
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new PointerEvent('pointerup', o));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.click();
  }

  function pressEscape() {
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
  }

  // LinkedIn's new UI renders some overlays inside shadow roots, so every lookup that may hit a
  // popup goes through deepAll(), which also searches open (and, via chrome.dom, closed) shadow roots.
  function shadowOf(el) {
    if (el.shadowRoot) return el.shadowRoot;
    try { return chrome.dom && chrome.dom.openOrClosedShadowRoot ? chrome.dom.openOrClosedShadowRoot(el) : null; } catch { return null; }
  }
  function allRoots() {
    const roots = [document];
    for (let i = 0; i < roots.length; i++) {
      for (const el of roots[i].querySelectorAll('*')) {
        const sr = shadowOf(el);
        if (sr) roots.push(sr);
      }
    }
    return roots;
  }
  const deepAll = (sel) => allRoots().flatMap((r) => [...r.querySelectorAll(sel)]);
  const parentOf = (el) => el.parentElement || (el.getRootNode && el.getRootNode().host) || null;

  const DIALOG_SEL = 'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"], .artdeco-modal';
  const dialogs = () => deepAll(DIALOG_SEL).filter(visible);
  const topDialog = () => dialogs().pop() || null;

  const NOTE_BTN = /^(Add a (free )?note|Add note)$/i;
  const EMAIL_SEL = 'input[type="email"], input[name*="email" i], input[id*="email" i], input[placeholder*="mail" i], input[aria-label*="mail" i]';
  // "To verify this member knows you, please enter their email to connect"
  const isEmailGate = (d) => !!d.querySelector(EMAIL_SEL) || (/e-?mail/i.test(textOf(d)) && /know|verify|enter/i.test(textOf(d)));
  const NO_NOTE_BTN = /^Send without( a)? note$/i;

  // The "Add a note to your invitation?" popup, found from its buttons / note box rather than
  // from a specific tag, so it works whatever element LinkedIn wraps it in.
  function inviteRoot() {
    // the invite note box: name="message"/id="custom-message", note-ish placeholder, or a 200/300 char limit
    const ta = deepAll('textarea').filter(visible).find((t) =>
      t.name === 'message' || /custom-message|note|invit|know each other/i.test([t.id, t.placeholder, labelOf(t)].join(' ')) ||
      [200, 300].includes(t.maxLength) || (parentOf(t) && t.closest && t.closest(DIALOG_SEL)));
    const btn = deepAll('button, [role="button"]').filter(visible)
      .find((b) => NOTE_BTN.test(textOf(b)) || NO_NOTE_BTN.test(textOf(b)) || /^(Add a note|Send without)/i.test(labelOf(b)));
    const email = deepAll(EMAIL_SEL).find(visible);
    const anchor = ta || btn || email || null;
    if (!anchor) return dialogs().find((d) => /invitation|add a note|connect/i.test(textOf(d))) || null;
    let el = anchor;
    for (let i = 0; i < 15 && el; i++) {
      if (el.matches && el.matches(DIALOG_SEL)) return el;
      el = parentOf(el);
    }
    el = anchor;
    for (let i = 0; i < 12 && el; i++) {
      el = parentOf(el);
      if (el && el.querySelectorAll && el.querySelectorAll('button').length >= 2 && /invitation|note/i.test(textOf(el))) return el;
    }
    return parentOf(anchor);
  }

  async function closeDialog(d) {
    const x = d && d.querySelector('button[aria-label="Dismiss"], button[aria-label*="close" i]');
    if (x) realClick(x);
    else pressEscape();
    await sleep(600);
  }

  // ---------------- Sales Navigator list ----------------
  async function scrollResults() {
    for (let i = 0; i < 14; i++) {
      const box =
        document.querySelector('#search-results-container') ||
        document.querySelector('.lists-detail__table-container') ||
        document.scrollingElement;
      box.scrollBy(0, 500);
      window.scrollBy(0, 500);
      await sleep(350);
    }
    return true;
  }

  function extractLeads() {
    const out = new Map();
    for (const a of document.querySelectorAll('a[href*="/sales/lead/"]')) {
      const href = a.getAttribute('href') || '';
      const m = href.match(/\/sales\/lead\/([^,/?#]+)/);
      if (!m) continue;
      const id = m[1];
      const row = a.closest('li, tr, article') || a.parentElement;
      const q = (s) => (row && row.querySelector(s) ? textOf(row.querySelector(s)) : '');
      const name = q('[data-anonymize="person-name"]') || textOf(a);
      if (!name || (out.has(id) && out.get(id).name)) continue;
      const deg = ((row ? row.innerText : '').match(/\b(1st|2nd|3rd\+?)\b/) || [])[1] || '';
      // profile picture (lazy-loaded while scrolling; people without one have no https image)
      const img = row && (row.querySelector('img[data-anonymize="headshot-photo"]') || [...row.querySelectorAll('img')].find((i) => /licdn\.com/.test(i.src)));
      out.set(id, {
        sales_id: id,
        name,
        sales_url: new URL(href, location.origin).href,
        title: q('[data-anonymize="title"]'),
        company: q('[data-anonymize="company-name"]'),
        location: q('[data-anonymize="location"]'),
        degree: deg,
        photo_url: img && /^https:/.test(img.src) ? img.src : '',
      });
    }
    return [...out.values()];
  }

  async function goNextPage(waitMs = 4000) {
    const btns = [...document.querySelectorAll('button.artdeco-pagination__button--next, button[aria-label="Next"]')].filter(visible);
    const next = btns.pop();
    if (!next || next.disabled || next.getAttribute('aria-disabled') === 'true') return false;
    const first = document.querySelector('a[href*="/sales/lead/"]')?.href;
    realClick(next);
    await sleep(waitMs);
    const start = Date.now();
    while (Date.now() - start < 20000) {
      const now = document.querySelector('a[href*="/sales/lead/"]')?.href;
      if (now && now !== first) return true;
      await sleep(400);
    }
    return true;
  }

  // ---------------- Sales lead page -> linkedin.com/in URL ----------------
  async function findProfileUrl() {
    const find = () => {
      const a = [...document.querySelectorAll('a[href*="linkedin.com/in/"]')].find((x) => !/\/in\/(me|ACo|ACw)/.test(x.href));
      return a ? a.href.split('?')[0] : null;
    };
    await waitFor('main, body', 10000);
    let url = find();
    if (url) return url;
    const overflow = [...document.querySelectorAll('button[aria-label*="overflow" i], button[aria-label*="more actions" i], button[aria-label*="Open actions" i]')].find(visible);
    if (overflow) {
      realClick(overflow);
      await sleep(1200);
      url = find();
      pressEscape();
    }
    return url;
  }

  // ---------------- LinkedIn profile: Connect -> Add a note -> Send ----------------
  const INTERACTIVE = 'a, button, [role="button"], [role="menuitem"], [role="link"]';
  const absTop = (el) => el.getBoundingClientRect().top + window.scrollY;
  const absLeft = (el) => el.getBoundingClientRect().left + window.scrollX;
  const clickable = (el) => el.closest(INTERACTIVE) || el;

  function vanity() {
    const m = location.pathname.match(/\/in\/([^/]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  function titleName() {
    return document.title.replace(/^\(\d+\)\s*/, '').split('|')[0].trim();
  }

  // The element that shows the person's name at the top of the profile
  function findNameEl(leadName) {
    const wanted = [titleName(), leadName || ''].map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const first = (wanted[0] || '').split(' ')[0];
    const h1 = [...document.querySelectorAll('main h1, h1')].find(visible);
    if (h1 && textOf(h1)) return h1;
    const els = [...document.querySelectorAll('main h1, main h2, main span, main div, main p, main a, h1, h2')]
      .filter((el) => visible(el) && el.children.length <= 3 && absTop(el) < 1200);
    let best = els.find((el) => wanted.includes(textOf(el)));
    if (!best && first) best = els.find((el) => textOf(el).startsWith(first) && textOf(el).length < 80);
    return best || null;
  }

  // Visible interactive elements that sit in the profile's top card (near the name)
  function topCardControls(nameEl) {
    const top = nameEl ? absTop(nameEl) : 0;
    return [...document.querySelectorAll(INTERACTIVE)].filter((el) => {
      if (!visible(el) || el.closest('aside, header, nav, [role="dialog"]')) return false;
      const t = absTop(el);
      return nameEl ? t > top - 60 && t < top + 420 : t < 900;
    });
  }

  const isConnectEl = (el, firstName, v) => {
    const txt = textOf(el);
    const lbl = labelOf(el);
    const href = el.getAttribute('href') || '';
    if (href.includes('custom-invite')) return !v || href.includes(v);
    if (/^Invite .+ to connect$/i.test(lbl)) return !firstName || lbl.toLowerCase().includes(firstName.toLowerCase());
    return /^Connect$/i.test(txt);
  };

  function allConnectCandidates(firstName, v) {
    return deepAll(INTERACTIVE).filter((el) => visible(el) && !el.closest('aside') && isConnectEl(el, firstName, v));
  }

  const describe = (el) => el ? `${el.tagName} text="${textOf(el).slice(0, 40)}" aria="${labelOf(el).slice(0, 60)}" href="${(el.getAttribute('href') || '').slice(0, 80)}" top=${Math.round(absTop(el))}` : null;

  /** Step 1: open the invite dialog. Returns 'opened' | 'already_connected' | 'pending_invite' | 'no_connect' */
  async function openInvite(leadName = '') {
    await waitFor('main, body', 15000);
    await jitter(800, 1500);
    window.scrollTo(0, 0);
    await sleep(500);

    const nameEl = findNameEl(leadName);
    const firstName = (titleName() || leadName).normalize('NFKC').split(/[\s,]/)[0];
    const v = vanity();

    // degree badge / pending state near the name
    let ctx = nameEl;
    for (let i = 0; i < 3 && ctx && ctx.parentElement; i++) ctx = ctx.parentElement;
    const nearText = ctx ? textOf(ctx).slice(0, 600) : '';
    if (/(·|•)\s*1st\b/.test(nearText)) return 'already_connected';

    const controls = topCardControls(nameEl);
    if (controls.some((el) => /^Pending$/i.test(textOf(el)) || /^Pending|Withdraw invitation/i.test(labelOf(el)))) return 'pending_invite';

    // The action row: Message / More / Save in Sales Navigator / Follow
    const more = controls.find((el) => /^More$/i.test(textOf(el)) || /^More actions$/i.test(labelOf(el)) || /^More$/i.test(labelOf(el)));
    const rowAnchor = more || controls.find((el) => /^(Message|Follow|Save in Sales Navigator)$/i.test(textOf(el)));
    const rowTop = rowAnchor ? absTop(rowAnchor) : null;

    // 2nd degree: Connect sits in the action row
    let connect = controls.find((el) => isConnectEl(el, firstName, v) && (rowTop === null || Math.abs(absTop(el) - rowTop) < 30));

    // 3rd degree: More -> Connect. Pick only the Connect item that APPEARED after opening More,
    // so "People similar" Connect buttons are never clicked.
    window.__lcbTrace = { name: nameEl ? textOf(nameEl) : null, firstName, more: describe(more), direct: describe(connect) };
    if (!connect && more) {
      const before = new Set(allConnectCandidates(firstName, v));
      realClick(more);
      await jitter(900, 1400);
      const appeared = allConnectCandidates(firstName, v).filter((el) => !before.has(el));
      window.__lcbTrace.appeared = appeared.map(describe);
      window.__lcbTrace.menuItems = deepAll('[role="menuitem"], [role="menu"] *').filter(visible).slice(0, 20).map((el) => textOf(el).slice(0, 40));
      const inMenu = appeared.filter((el) => el.closest('[role="menu"], .artdeco-dropdown__content, [aria-hidden="false"]'));
      connect = inMenu[0] || appeared[0] || null;
      if (connect) connect = clickable(connect);
      if (!connect) {
        pressEscape();
        await sleep(300);
      }
    }

    if (!connect) {
      if (controls.some((el) => /\bPending\b/i.test(textOf(el)))) return 'pending_invite';
      return 'no_connect';
    }
    await jitter(500, 1000);
    window.__lcbTrace.clicked = describe(connect);
    realClick(connect);
    return 'opened';
  }

  function typeInto(ta, text) {
    ta.focus();
    ta.select();
    let ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch { ok = false; }
    if (!ok || ta.value !== text) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, text);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return ta.value === text;
  }

  /** Step 2: Add a note -> type -> Send. Never sends without the note.
   *  Returns 'sent' | 'dry_run' | 'email_required' | 'note_limit' | 'weekly_limit' | 'no_dialog' */
  async function fillInvite(note, opts = {}) {
    let d = null;
    for (let i = 0; i < 50 && !d; i++) { d = inviteRoot(); if (!d) await sleep(300); }
    if (!d) return 'no_dialog';
    await jitter(700, 1200);
    d = inviteRoot() || d;
    const t = textOf(d);
    if (/weekly invitation limit|reached the weekly limit/i.test(t)) { await closeDialog(d); return 'weekly_limit'; }
    window.__lcbTrace = Object.assign(window.__lcbTrace || {}, { dialogText: t.slice(0, 600) });
    if (isEmailGate(d)) { await closeDialog(d); return 'email_required'; }

    if (!d.querySelector('textarea')) {
      const add = [...d.querySelectorAll(INTERACTIVE)].find((b) => visible(b) && (NOTE_BTN.test(textOf(b)) || /^Add a (free )?note/i.test(labelOf(b))));
      if (!add) {
        await closeDialog(d);
        return /personalized invitations|premium|upgrade/i.test(t) ? 'note_limit' : 'no_note_button';
      }
      realClick(add);
      for (let i = 0; i < 30; i++) {
        const r = inviteRoot();
        if (r && r.querySelector('textarea')) { d = r; break; }
        await sleep(250);
      }
    }
    if (d && isEmailGate(d)) { await closeDialog(d); return 'email_required'; }
    const ta = d && d.querySelector('textarea');
    if (!ta) {
      const tt = textOf(d || document.body);
      if (d) await closeDialog(d);
      return /personalized invitations|premium|upgrade/i.test(tt) ? 'note_limit' : 'no_note_box';
    }

    await jitter(600, 1200);
    if (!typeInto(ta, note)) {
      await sleep(500);
      if (!typeInto(ta, note)) { await closeDialog(d); throw new Error('Could not type the note'); }
    }
    await jitter(1200, 2200);
    if (ta.value.trim() !== note.trim()) { await closeDialog(d); throw new Error('Note text did not stick in the box'); }

    // Only "Send" / "Send invitation" – never "Send without a note"
    const findSend = () =>
      [...d.querySelectorAll('button')].find((b) => visible(b) && !/without/i.test(textOf(b) + labelOf(b)) &&
        (/^Send( invitation| now)?$/i.test(textOf(b)) || /^Send (invitation|now)$/i.test(labelOf(b))));
    let send = findSend();
    for (let i = 0; i < 20 && (!send || send.disabled); i++) { await sleep(300); send = findSend(); }
    if (!send) { await closeDialog(d); throw new Error('Send button not found'); }
    if (send.disabled) { await closeDialog(d); throw new Error('Send button stayed disabled (note not accepted)'); }

    if (opts.dryRun) { await closeDialog(d); return 'dry_run'; }

    realClick(send);
    await sleep(3000);
    const after = dialogs().map(textOf).join(' ') + ' ' + textOf(document.body).slice(0, 3000);
    if (/weekly invitation limit|reached the weekly limit|too many invitations/i.test(after)) {
      await closeDialog(topDialog());
      return 'weekly_limit';
    }
    return 'sent';
  }

  // Diagnostic dump used when something isn't found, so selectors can be fixed from real data
  // ---------------- Follow-up messages (1st-degree connections only) ----------------
  /** Profile page -> "Message". Returns { href } when it is a link to the messaging page (the bot loads that
   *  itself), else clicks it: 'opened' | 'not_connected' | 'no_message_button' (null = the click navigated) */
  async function openMessage(leadName = '') {
    await waitFor('main, body', 15000);
    await jitter(800, 1500);
    window.scrollTo(0, 0);
    await sleep(500);
    const nameEl = findNameEl(leadName);
    let ctx = nameEl;
    for (let i = 0; i < 3 && ctx && ctx.parentElement; i++) ctx = ctx.parentElement;
    // never message someone who is not a connection (that would be an InMail). The "· 1st" badge is not always
    // next to the name element found – it can also be anywhere on their profile next to their name (e.g. on their posts)
    const firstName = (titleName() || leadName).normalize('NFKC').split(/[\s,]/)[0].toLowerCase();
    const isFirst = (t) => /(·|•)\s*1st\b/.test(t);
    const badge = isFirst(ctx ? textOf(ctx).slice(0, 600) : '') ||
      [...document.querySelectorAll('main a, main span, main div, main p')].some((el) => el.children.length <= 4 && !el.closest('aside') &&
        visible(el) && isFirst(textOf(el).slice(0, 120)) && textOf(el).toLowerCase().includes(firstName));
    if (!badge) return 'not_connected';
    const isMsg = (el) => /^Message$/i.test(textOf(el)) || /^Message\b/i.test(labelOf(el));
    // the name may be found lower on the page than the top card – then take the profile's own Message
    // button: the topmost one outside the side column (others there say "Message <their name>")
    const first = firstName;
    const btn = topCardControls(nameEl).find(isMsg) ||
      [...document.querySelectorAll(INTERACTIVE)].filter((el) => visible(el) && !el.closest('aside') && isMsg(el) &&
        (!labelOf(el) || labelOf(el).toLowerCase().includes(first))).sort((a, b) => absTop(a) - absTop(b))[0];
    if (!btn) return 'no_message_button';
    const href = btn.getAttribute('href') || '';
    if (/\/messaging\//.test(href)) return { href: new URL(href, location.origin).href };
    await jitter(500, 1000);
    realClick(btn);
    return 'opened';
  }

  const MSG_BOX = '.msg-form__contenteditable[contenteditable="true"], [contenteditable="true"][role="textbox"]';
  const MSG_EVENT = 'li.msg-s-message-list__event, .msg-s-event-listitem';
  const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  /** The message box + the conversation it belongs to (overlay bubble or the full messaging page) */
  function messageThreadEls() {
    const box = deepAll(MSG_BOX).filter(visible).pop();
    if (!box) return null;
    let thread = null;
    for (let el = parentOf(box), i = 0; el && i < 15; el = parentOf(el), i++) {
      if (el.querySelector && el.querySelector('.msg-s-message-list, .msg-s-message-list-content, ' + MSG_EVENT)) { thread = el; break; }
    }
    return { box, thread };
  }

  /** Waits for the chat box and its conversation, and for the older messages to finish loading */
  async function openThread() {
    let els = null;
    for (let i = 0; i < 80 && !els; i++) { els = messageThreadEls(); if (!els) await sleep(300); }
    if (!els) return null;
    let last = -1;
    for (let i = 0; i < 12; i++) {
      els = messageThreadEls() || els;
      const n = els.thread ? els.thread.querySelectorAll(MSG_EVENT).length : -1;
      if (n === last && n > 0) break;
      last = n;
      await sleep(500);
    }
    return els;
  }

  /**
   * Every message in the open chat, oldest first: { messages: [{ other, sender, body }] }
   * (other = written by them) – or 'no_box' | 'thread_unreadable'. The bot decides on its side what to do.
   */
  async function readThread(leadName = '') {
    const els = await openThread();
    if (!els) return 'no_box';
    if (!els.thread) return 'thread_unreadable';
    const first = flat(leadName).split(' ')[0].toLowerCase();
    let sender = '';
    // when each message was sent: LinkedIn shows a day heading ("Today", "Monday", "Oct 21") above the first
    // message of a day and a time ("4:05 PM") above a group – both carry on to the messages below them
    let day = '';
    let time = '';
    const messages = [...els.thread.querySelectorAll('.msg-s-event-listitem')].map((el) => {
      const event = el.closest('.msg-s-message-list__event');
      const heading = event?.querySelector('.msg-s-message-list__time-heading');
      if (heading && textOf(heading)) day = flat(textOf(heading));
      const stamp = event?.querySelector('.msg-s-message-group__timestamp');
      if (stamp && textOf(stamp)) time = flat(textOf(stamp));
      // a group of messages shows the sender's name only above the first one
      const name = event?.querySelector('.msg-s-message-group__name');
      if (name && textOf(name)) sender = flat(textOf(name));
      const other = el.classList.contains('msg-s-event-listitem--other') || (!!first && sender.toLowerCase().startsWith(first));
      return { other, sender: sender.slice(0, 60), day, time, body: flat(textOf(el.querySelector('.msg-s-event-listitem__body') || el)).slice(0, 2000) };
    }).filter((m) => m.body);
    window.__lcbTrace = { chat: location.href, messages: messages.map((m) => ({ ...m, body: m.body.slice(0, 120) })) };
    return { messages };
  }

  /** Types the message in the open chat and sends it. Returns 'sent' | 'dry_run' | 'no_box' | 'not_sent' */
  async function sendInThread(text = '', opts = {}) {
    const els = messageThreadEls();
    if (!els || !els.thread) return 'no_box';
    const { box, thread } = els;
    box.focus();
    let ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch { ok = false; }
    await jitter(1200, 2200);
    if (!ok || !flat(textOf(box)).includes(flat(text).slice(0, 40))) return 'not_sent';
    const clear = () => { box.focus(); document.execCommand('selectAll'); document.execCommand('delete'); };
    if (opts.dryRun) { clear(); return 'dry_run'; } // no draft left behind

    const findSend = () => [...thread.querySelectorAll('button')].find((b) => visible(b) &&
      (b.classList.contains('msg-form__send-button') || /^Send$/i.test(textOf(b)) || /^Send$/i.test(labelOf(b))));
    let send = findSend();
    for (let i = 0; i < 20 && (!send || send.disabled); i++) { await sleep(300); send = findSend(); }
    if (!send || send.disabled) { clear(); return 'not_sent'; }
    realClick(send);
    await sleep(3000);
    // sent = the box is empty again
    return flat(textOf(box)) ? 'not_sent' : 'sent';
  }

  // ---------------- Messaging inbox (read only) ----------------
  /**
   * The most recent 1:1 conversations in your LinkedIn inbox, newest first, read from LinkedIn's own inbox API
   * (no chat is opened, nothing is marked as read):
   * [{ name, chat_url, profile_url, title, snippet, mine, time, at, photo_url, unread }] (mine = the last message is yours).
   * q = LinkedIn's ids for its inbox queries: { pages } (page by page, with a cursor) and { latest } (the newest 20 only).
   * When q.latest is null it is taken from the requests of the messaging page this runs on.
   * Returns 'bad_query' when neither id works any more (then the bot runs it again on the messaging page).
   */
  async function readInbox(maxItems = 60, q = {}) {
    let mailbox = '';
    let latest = q.latest ? `https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=${q.latest}&variables=` : '';
    if (q.latest) {
      const me = await apiGet('https://www.linkedin.com/voyager/api/me');
      mailbox = (JSON.stringify(me.json || {}).match(/urn:li:fs_miniProfile:([A-Za-z0-9_-]+)/) || [])[1] || '';
      if (!mailbox) return 'not_logged_in';
      latest += `(mailboxUrn:urn%3Ali%3Afsd_profile%3A${mailbox})`;
    } else {
      for (let i = 0; i < 40 && !latest; i++) {
        latest = performance.getEntriesByType('resource').map((e) => e.name).find((u) => /messengerConversations\.[0-9a-f]+&variables=\(mailboxUrn:[^,)]+\)$/.test(u)) || '';
        if (!latest) await sleep(500);
      }
      if (!latest) return 'bad_query';
      mailbox = decodeURIComponent(latest).match(/fsd_profile:([A-Za-z0-9_-]+)/)[1];
    }
    const pageUrl = (cursor) => `https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=${q.pages}&variables=(query:(predicateUnions:List((conversationCategoryPredicate:(category:INBOX)))),count:20,mailboxUrn:urn%3Ali%3Afsd_profile%3A${mailbox}${cursor ? `,nextCursor:${encodeURIComponent(cursor)}` : ''})`;
    const text = (t) => (t && (t.text ?? t)) || '';
    const seen = new Map();
    const take = (json) => {
      const inc = json.included || [];
      const byUrn = new Map(inc.map((x) => [x.entityUrn, x]));
      let n = 0;
      for (const c of inc.filter((x) => /\.Conversation$/.test(x.$type || '') && x.lastActivityAt)) {
        if (seen.has(c.entityUrn)) continue;
        n++;
        if (c.groupChat || !(c.categories || []).includes('INBOX')) continue;
        const them = (c['*conversationParticipants'] || []).filter((u) => !u.includes(mailbox)).map((u) => byUrn.get(u)).filter(Boolean);
        const m = them.length === 1 && them[0].participantType && them[0].participantType.member;
        if (!m) continue; // a company page, an ad, or more than one person
        const pic = m.profilePicture || {};
        const art = (pic.artifacts || []).slice().sort((x, y) => x.width - y.width).find((x) => x.width >= 100);
        const last = byUrn.get(((c.messages || {})['*elements'] || [])[0]);
        const body = last ? text(last.body) || ((last.renderContentUnions || []).length ? 'Sent an attachment' : '') : '';
        seen.set(c.entityUrn, {
          urn: c.entityUrn,
          name: flat(`${text(m.firstName)} ${text(m.lastName)}`).slice(0, 120),
          chat_url: c.conversationUrl || '',
          profile_url: m.profileUrl || '',
          title: flat(text(m.headline)).slice(0, 200),
          snippet: flat(body).slice(0, 220),
          mine: !!last && String(last['*sender'] || '').includes(mailbox),
          at: c.lastActivityAt,
          time: new Date(c.lastActivityAt).toLocaleString('sv-SE').slice(0, 16),
          photo_url: pic.rootUrl && art ? pic.rootUrl + art.fileIdentifyingUrlPathSegment : '',
          unread: c.read === false || c.unreadCount > 0,
        });
      }
      return n;
    };
    // page by page with LinkedIn's cursor; if that query stopped working, the newest 20 at least
    let cursor = '';
    for (let page = 0; q.pages && page < 25 && seen.size < maxItems; page++) {
      const r = await apiGet(pageUrl(cursor));
      const d = r.json && r.json.data;
      const data = d && (d.data || d).messengerConversationsByCategoryQuery; // normalized answers wrap it in data.data
      if (r.status !== 200 || !data) break;
      if (!take(r.json)) break;
      cursor = data.metadata && data.metadata.nextCursor;
      if (!cursor) break;
      await jitter(800, 1600);
    }
    if (!seen.size) {
      const r = await apiGet(latest);
      if (r.status !== 200 || !r.json || !take(r.json)) return 'bad_query';
    }
    return [...seen.values()].sort((x, y) => y.at - x.at).slice(0, maxItems);
  }

  /**
   * For each conversation urn: the last message the other person wrote { body, at } (null = they never wrote),
   * read from LinkedIn's messages API (the chat is not opened or marked as read). q.messages = LinkedIn's query id.
   */
  async function inboxReplies(urns = [], q = {}) {
    const out = {};
    for (const urn of urns) {
      const me = (urn.match(/fsd_profile:([A-Za-z0-9_-]+)/) || [])[1];
      const r = await apiGet(`https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=${q.messages}&variables=(conversationUrn:${encodeURIComponent(urn).replace(/\(/g, '%28').replace(/\)/g, '%29')})`);
      if (r.status !== 200 || !r.json) { out[urn] = 'error'; continue; }
      const theirs = (r.json.included || []).filter((x) => /\.Message$/.test(x.$type || '') && x.deliveredAt && !String(x['*sender'] || '').includes(me))
        .sort((a, b) => b.deliveredAt - a.deliveredAt)[0];
      const body = theirs && ((theirs.body && (theirs.body.text ?? theirs.body)) || ((theirs.renderContentUnions || []).length ? 'Sent an attachment' : ''));
      out[urn] = theirs ? { body: flat(body).slice(0, 2000), at: theirs.deliveredAt } : null;
      await jitter(600, 1200);
    }
    return out;
  }

  function snapshot() {
    const nameEl = findNameEl('');
    return {
      url: location.href,
      title: document.title,
      hasMain: !!document.querySelector('main'),
      nameEl: nameEl ? { tag: nameEl.tagName, text: textOf(nameEl), top: Math.round(absTop(nameEl)) } : null,
      trace: window.__lcbTrace || null,
      shadowRoots: allRoots().length - 1,
      inviteRoot: (() => { const r = inviteRoot(); return r ? { tag: r.tagName, text: textOf(r).slice(0, 600), html: r.outerHTML.slice(0, 6000) } : null; })(),
      noteish: deepAll('button, textarea, [role="button"], h2, h3').filter((el) => visible(el) && /note|invit|send|connect/i.test(textOf(el) + labelOf(el) + (el.placeholder || '')))
        .slice(0, 40).map((el) => ({ tag: el.tagName, text: textOf(el).slice(0, 80), aria: labelOf(el).slice(0, 80), top: Math.round(absTop(el)) })),
      controls: deepAll(INTERACTIVE).filter((el) => visible(el) && absTop(el) < 1300).slice(0, 120).map((el) => ({
        tag: el.tagName, role: el.getAttribute('role') || '', text: textOf(el).slice(0, 60), aria: labelOf(el).slice(0, 80),
        href: (el.getAttribute('href') || '').slice(0, 120), top: Math.round(absTop(el)), left: Math.round(absLeft(el)),
        inAside: !!el.closest('aside'),
      })),
      dialogs: dialogs().map((d) => ({ tag: d.tagName, text: textOf(d).slice(0, 500) })),
      topHtml: (nameEl && nameEl.closest('section') ? nameEl.closest('section').outerHTML : '').slice(0, 20000),
    };
  }

  // ---------------- My Network -> Connections (recently added first) ----------------
  // Returns the /in/<vanity> of your connections, scrolling / clicking "Show more" until maxItems
  // are loaded or nothing new appears.
  async function scrapeConnections(maxItems = 500) {
    await waitFor('main a[href*="/in/"], a[href*="/in/"]', 20000);
    const seen = new Map();
    const collect = () => {
      for (const a of deepAll('a[href*="/in/"]')) {
        if (a.closest('header, nav, aside, footer')) continue;
        const m = (a.getAttribute('href') || '').match(/\/in\/([^/?#]+)/);
        if (!m) continue;
        const v = decodeURIComponent(m[1]).toLowerCase();
        if (!seen.has(v) || (!seen.get(v) && textOf(a))) seen.set(v, textOf(a).slice(0, 80));
      }
    };
    let stale = 0;
    while (seen.size < maxItems && stale < 4) {
      const before = seen.size;
      collect();
      const more = deepAll('button').filter(visible).find((b) => /^(Show more results|Load more|Show more)$/i.test(textOf(b)));
      if (more) realClick(more);
      const links = deepAll('main a[href*="/in/"]');
      if (links.length) links[links.length - 1].scrollIntoView({ block: 'end' });
      window.scrollTo(0, document.body.scrollHeight);
      await jitter(1500, 2500);
      collect();
      stale = seen.size === before ? stale + 1 : 0;
    }
    return [...seen.entries()].map(([vanity, name]) => ({ vanity, name }));
  }

  /** GET a LinkedIn API URL with your login (same as the site itself does); returns { status, json } */
  async function apiGet(url) {
    const csrfTok = (document.cookie.match(/JSESSIONID="?([^";]+)/) || [])[1] || '';
    const res = await fetch(url, { credentials: 'include', headers: { 'csrf-token': csrfTok, accept: 'application/vnd.linkedin.normalized+json+2.1', 'x-restli-protocol-version': '2.0.0' } });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text: json ? '' : text.slice(0, 300) };
  }

  /** LinkedIn security check, restriction or "unusual activity" page? Returns what was seen, or '' */
  function securityCheck() {
    if (/\/(checkpoint\/(challenge|lg|rp|uas)|uas\/login|authwall)/.test(location.pathname)) return `security page (${location.pathname})`;
    const t = (document.body ? document.body.innerText || '' : '').slice(0, 4000);
    const m = t.match(/(your account (has been|is) (temporarily )?(restricted|limited|suspended)|we('ve| have) (temporarily )?restricted your account|unusual activity (on|from) your account|let'?s do a quick security check|please complete this security check|verify (that )?you'?re (a human|not a robot)|you('ve| have) reached the (weekly )?limit for profile views|commercial use limit)/i);
    return m ? m[0] : '';
  }

  function isLoggedIn() {
    if (/\/(login|checkpoint|authwall|uas\/)/.test(location.pathname)) return false;
    return !document.querySelector('input#username, form.login__form');
  }

  // ---------------- Prospect finder: content (posts) search ----------------
  const cleanUrl = (href) => { try { const u = new URL(href, location.origin); return `${u.origin}${u.pathname}`; } catch { return ''; } };

  // ---------- post search without scrolling (works while the bot window is in the background) ----------
  // The search page HTML has the first posts and LinkedIn's own "next page" request; we send that
  // request ourselves (like the page does when you scroll) until we have enough post ids.
  const csrf = () => (document.cookie.match(/JSESSIONID="?([^";]+)/) || [])[1] || '';

  /** RSC text of a search page: the strings in window.__como_rehydration__ = [ … ] (unescaped) */
  function rscOfHtml(html) {
    const out = [];
    const re = /window\.__como_rehydration__\s*=\s*(\[[\s\S]*?\])\s*;?\s*<\/script>/g;
    let m;
    while ((m = re.exec(html))) { try { out.push(...JSON.parse(m[1])); } catch { /* skip */ } }
    return out.join('');
  }

  /** The JSON object that starts at text[i] ("{"), string-aware brace matching */
  function jsonAt(text, i) {
    let depth = 0;
    let inStr = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inStr) { if (ch === '\\') j++; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) { try { return JSON.parse(text.slice(i, j + 1)); } catch { return null; } }
    }
    return null;
  }

  // The page has several pagers (search results, side modules…) – only the search results one counts
  function nextRequestIn(text) {
    const k = '"nextPageRequest":{';
    for (let i = text.indexOf(k); i !== -1; i = text.indexOf(k, i + 1)) {
      const r = jsonAt(text, i + k.length - 1);
      if (r && /contentSearchResults/.test(r.pagerId || '')) return r;
    }
    return null;
  }
  const activityIds = (text) => [...new Set((text.match(/urn:li:activity:(\d{15,22})/g) || []).map((u) => u.split(':').pop()))];

  // Post search in steps, one request per call (the backend waits between them, see fetchJobPage):
  //   postSearchStart(url) -> first post ids + LinkedIn's "next page" request
  //   postSearchPage(next) -> the next post ids (the backend moves next.requestedArguments.payload.startIndex on)
  async function postSearchStart(searchUrl, size = 10) {
    const html = await (await fetch(searchUrl, { credentials: 'include' })).text();
    const first = rscOfHtml(html) || html;
    const next = nextRequestIn(first);
    if (next?.requestedArguments?.payload) next.requestedArguments.payload.count = size;
    return { ids: activityIds(first.length > 1000 ? first : html), next };
  }

  async function postSearchPage(next) {
    const ra = next.requestedArguments;
    const body = { pagerId: next.pagerId, clientArguments: { ...ra, states: [], screenId: '', knownTemplateIds: [] }, paginationRequest: next };
    const res = await fetch(`/flagship-web/rsc-action/actions/pagination?sduiid=${encodeURIComponent(next.pagerId || '')}`, {
      method: 'POST', credentials: 'include', headers: { 'csrf-token': csrf(), 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Post search: LinkedIn answered ${res.status}`);
    return { ids: activityIds(await res.text()) };
  }

  /** One post from its public page: link, text, date, author (no tab needed) */
  async function fetchPost(id) {
    const res = await fetch(`https://www.linkedin.com/feed/update/urn:li:activity:${id}/`, { credentials: 'omit' });
    const html = await res.text();
    const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    if (!m) return { id, error: `post page not readable (${res.status})` };
    let j;
    try { j = JSON.parse(m[1]); } catch { return { id, error: 'post data not readable' }; }
    const a = j.author || {};
    let host = '';
    let url = '';
    try { const u = new URL(a.url); host = u.hostname; url = `https://www.linkedin.com${u.pathname.replace(/\/$/, '')}`; } catch { /* no author link */ }
    return {
      id,
      url: j['@id'] || `https://www.linkedin.com/feed/update/urn:li:activity:${id}/`,
      text: String(j.articleBody || j.headline || '').slice(0, 4000),
      posted_date: j.datePublished || '',
      author_name: a.name || '',
      author_url: url,
      author_kind: /\/in\//.test(url) ? 'person' : url ? 'company' : '',
      author_country_code: (host.match(/^([a-z]{2})\.linkedin\.com$/) || [])[1] || '',
    };
  }

  /** Job search results from LinkedIn's public job search (10 per page, no scrolling or rendering needed). */
  // One page (10 jobs) per call: the backend waits between pages. No timers in here – Chrome slows
  // timers down a lot in background tabs, and the bot's tab is always in the background.
  async function fetchJobPage(query, start = 0) {
    const r = await fetch(`/jobs-guest/jobs/api/seeMoreJobPostings/search?${query}&start=${start}`, { credentials: 'include' });
    if (!r.ok) { if (start === 0) throw new Error(`Job search: LinkedIn answered ${r.status}`); return []; }
    const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
    const out = new Map();
    for (const c of doc.querySelectorAll('[data-entity-urn*="jobPosting"], .base-card, li')) {
      const urn = c.getAttribute('data-entity-urn') || c.querySelector('[data-entity-urn]')?.getAttribute('data-entity-urn') || '';
      const link = c.querySelector('a[href*="/jobs/view/"]');
      const id = (urn.match(/jobPosting:(\d+)/) || (link ? link.href.match(/(\d{6,})/) : null) || [])[1];
      if (!id || out.has(id)) continue;
      const time = c.querySelector('time');
      out.set(id, {
        job_id: id,
        title: textOf(c.querySelector('.base-search-card__title, h3') || {}),
        company: textOf(c.querySelector('.base-search-card__subtitle, h4') || {}),
        location: textOf(c.querySelector('.job-search-card__location') || {}),
        posted: time ? textOf(time) : '',
        posted_date: time ? time.getAttribute('datetime') || '' : '',
      });
    }
    return [...out.values()].filter((j) => j.title);
  }

  /** Full job posting (description, seniority, company, poster) from LinkedIn's public job page. */
  async function fetchJob(jobId) {
    const r = await fetch(`/jobs-guest/jobs/api/jobPosting/${encodeURIComponent(jobId)}`, { credentials: 'include' });
    if (!r.ok) throw new Error(`Job ${jobId}: LinkedIn answered ${r.status}`);
    const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
    const q = (sel) => doc.querySelector(sel);
    const criteria = {};
    for (const li of doc.querySelectorAll('.description__job-criteria-item')) {
      const k = textOf(li.querySelector('h3') || {}).toLowerCase();
      const v = textOf(li.querySelector('span') || {});
      if (k) criteria[k] = v;
    }
    const company = q('a.topcard__org-name-link, a[href*="/company/"]');
    const poster = [...doc.querySelectorAll('a[href*="/in/"]')].find((a) => textOf(a));
    const desc = q('.show-more-less-html__markup, .description__text');
    return {
      description: desc ? (desc.innerText || desc.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 8000) : '',
      seniority: criteria['seniority level'] || '',
      employment: criteria['employment type'] || '',
      location: textOf(q('.topcard__flavor--bullet') || {}),
      company_name: company ? textOf(company) : '',
      company_url: company ? cleanUrl(company.href) + (cleanUrl(company.href).endsWith('/') ? '' : '/') : '',
      person: poster ? { name: (textOf(poster.querySelector('h3, .base-main-card__title') || poster)).split(/\s[•·]\s/)[0].trim(), url: cleanUrl(poster.href) } : null,
    };
  }

  // ---------------- Prospect finder: author location ----------------
  /** Profile location from the top card ("City, Country · Contact info"). */
  async function readProfile() {
    await waitFor('main, body', 15000);
    await sleep(1000);
    const ci = deepAll('a').find((a) => /^Contact info$/i.test(textOf(a)) || /overlay\/contact-info/.test(a.getAttribute('href') || ''));
    let loc = '';
    if (ci) {
      let el = ci;
      for (let i = 0; i < 4 && el && !loc; i++) {
        el = parentOf(el);
        const t = el ? textOf(el) : '';
        const m = t.match(/^(.{2,120}?)\s*[·•]\s*Contact info/i);
        if (m) loc = m[1].trim();
      }
    }
    const h1 = [...document.querySelectorAll('main h1, h1')].find(visible);
    const name = h1 ? textOf(h1) : titleName();
    // headline = first real line after the name in the top card (the block that has "Contact info")
    let headline = '';
    let lines = [];
    for (let el = ci, i = 0; el && i < 10; i++) {
      el = parentOf(el);
      const t = el ? (el.innerText || '') : '';
      if (name && t.includes(name)) { lines = t.split('\n').map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean); break; }
    }
    const skip = (t) => t === name || t.length < 4 || /contact info|^(he|she|they)\/(him|her|them)|^[·•]|^(1st|2nd|3rd\+?)$|followers|connections|verified/i.test(t) || t === loc;
    const after = lines.slice(Math.max(0, lines.indexOf(name) + 1));
    headline = (after.find((t) => !skip(t)) || '').slice(0, 220);
    return { location: loc, name, headline };
  }

  /** Company HQ from /company/<x>/about/ */
  async function readCompany() {
    await waitFor('main, body', 15000);
    await sleep(1500);
    let hq = '';
    const label = deepAll('dt, h3, h4, p, span, div').find((e) => e.children.length < 2 && /^Headquarters$/i.test(textOf(e)));
    if (label) {
      const next = label.nextElementSibling || parentOf(label)?.nextElementSibling;
      hq = next ? textOf(next) : '';
    }
    if (!hq) {
      // top card line like "Software Development · Austin, Texas · 2K followers"
      const line = [...document.querySelectorAll('main div, main p')].filter((e) => visible(e) && e.children.length <= 2 && /followers/i.test(textOf(e)) && textOf(e).length < 200)[0];
      if (line) hq = textOf(line).split(/[·•]/).map((s) => s.trim()).filter((s) => !/followers|employees/i.test(s)).slice(1).join(', ');
    }
    const h1 = [...document.querySelectorAll('main h1, h1')].find(visible);
    return { location: hq, name: h1 ? textOf(h1) : '' };
  }

  // ---------------- Easy Apply (job applier) ----------------
  // Fills LinkedIn's Easy Apply form step by step with your saved answers. A question it has no answer for
  // stops the application (it is discarded, nothing is sent) and comes back to the dashboard to answer once.
  const qKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 200);
  // the page first; LinkedIn's new UI draws the Easy Apply form inside a shadow root, so then look there too
  const findAny = (sel, ok) => [...document.querySelectorAll(sel)].find(ok) || deepAll(sel).find(ok);

  // LinkedIn repeats label text for screen readers ("Phone Phone") – keep one copy, drop the "*"
  function cleanLabel(el) {
    if (!el) return '';
    const shown = el.querySelector('span[aria-hidden="true"]');
    let t = textOf(shown && textOf(shown) ? shown : el);
    const h = t.length / 2;
    if (t.length > 3 && t.length % 2 === 0 && t.slice(0, h) === t.slice(h)) t = t.slice(0, h);
    const m = t.match(/^(.{3,}?)\s+\1$/);
    if (m) t = m[1];
    return t.replace(/\s*\brequired\b\s*$/i, '').replace(/\s*\*+\s*$/, '').trim();
  }

  function eaRoot() {
    return findAny('[data-test-modal-id="easy-apply-modal"], .jobs-easy-apply-modal', visible)
      // LinkedIn's new UI: a native <dialog> headed "Apply to <company>"
      || findAny('dialog', (d) => visible(d) && /^apply to\b/i.test(textOf(d.querySelector('h2, h1, header') || d)))
      || findAny('[role="dialog"]', (d) => visible(d) && (d.querySelector('.jobs-easy-apply-content, form') || /submit application|review your application|continue to next step/i.test(d.innerHTML)))
      // the newer full-page apply flow (/jobs/view/…/apply/)
      || (/\/apply\b/.test(location.pathname) ? findAny('form, main', (el) => visible(el) && /submit application|review your application|continue to next step|data-easy-apply-next-button/i.test(el.innerHTML)) : null);
  }
  const eaButton = () => findAny('button, a', (b) => visible(b) && (/^easy apply\b/i.test(textOf(b)) || /^easy apply to\b/i.test(labelOf(b))));

  function jobPageState() {
    if (eaButton()) return 'easy';
    const main = textOf(document.querySelector('main') || document.body).slice(0, 5000);
    if (/no longer accepting applications/i.test(main)) return 'closed';
    if (/\bapplied \d+ (second|minute|hour|day|week|month)s? ago\b|application submitted|you applied/i.test(main)) return 'already';
    if (!!findAny('button, a', (b) => visible(b) && /^apply( now)?\b/i.test(textOf(b)))) return 'external';
    return 'unknown';
  }

  const fieldBox = (el) => el.closest('.fb-dash-form-element, .jobs-easy-apply-form-element, [data-test-form-element], .jobs-easy-apply-form-section__grouping') || el.parentElement;
  function optionText(root, i) {
    const lab = (i.id && (root.querySelector(`label[for="${CSS.escape(i.id)}"]`) || document.querySelector(`label[for="${CSS.escape(i.id)}"]`))) || i.closest('label');
    let t = cleanLabel(lab);
    // new UI: "Yes" sits next to the radio (the radio's aria-label is the question) – the text of the
    // smallest box that holds only this one option
    for (let e = i; !t && e.parentElement && e.parentElement.querySelectorAll('input[type=radio], input[type=checkbox]').length === 1;) {
      e = e.parentElement;
      t = cleanLabel(e);
    }
    return t || (i.getAttribute('aria-label') || '').trim() || i.value;
  }
  const FILE_NAME = /[^\s/\\]{1,120}\.(pdf|docx?)\b/i;
  // the box around one radio that names its file ("Abdullah_Shah_BD.pdf") – new UI, no class names to go by
  function fileBox(input) {
    let e = input;
    for (let i = 0; i < 5 && e.parentElement; i++) {
      e = e.parentElement;
      if (FILE_NAME.test(textOf(e))) return e.querySelectorAll('input[type=radio]').length <= 1 ? e : null;
    }
    return null;
  }
  const inResumePicker = (el) => !!el.closest('[class*="document-upload"], [class*="resume-picker"], [class*="jobs-resume"]') || (el.type === 'radio' && !!fileBox(el));

  function eaFields(root) {
    const out = [];
    const used = new Set();
    // radio / checkbox groups: by fieldset, or by name (the new UI has no fieldset)
    const groups = new Map();
    for (const i of root.querySelectorAll('input[type=radio], input[type=checkbox]')) {
      if (inResumePicker(i)) continue;
      const fs = i.closest('fieldset');
      const key = fs || (i.name ? `name:${i.name}` : null);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(i);
    }
    for (const [key, inputs] of groups) {
      if (inputs.length === 1 && inputs[0].type === 'checkbox' && typeof key === 'string') continue; // a lone checkbox, below
      inputs.forEach((i) => used.add(i));
      // the box that holds every option = the question
      let box = typeof key === 'string' ? inputs[0].parentElement : key;
      while (box && box !== root && !inputs.every((i) => box.contains(i))) box = box.parentElement;
      // option names: one <label> per option inside the box, else the text next to each radio
      const labs = box ? [...box.querySelectorAll('label')].filter((l) => !l.querySelector('input[type=radio], input[type=checkbox]') || l.querySelectorAll('input').length === 1).map(cleanLabel).filter(Boolean) : [];
      const options = labs.length === inputs.length ? labs : inputs.map((i) => optionText(box || root, i));
      const aria = inputs.map((i) => (i.getAttribute('aria-label') || '').trim());
      let label = cleanLabel(box && box.querySelector('legend')) || (aria[0] && aria.every((x) => x === aria[0]) && inputs.length > 1 ? aria[0] : '');
      // the box's text without its options and messages: "Do you have a valid driver's license?*YesNo" -> the question
      const question = (b) => {
        let t = textOf(b).replace(/this field is required\.?|please make a selection\.?/gi, '');
        for (const o of options) if (o) t = t.split(o).join(' ');
        t = t.replace(/\s+/g, ' ').trim();
        return cleanLabel({ querySelector: () => null, innerText: t, textContent: t });
      };
      if (!label && box) {
        label = question(box);
        // the question may sit next to the options: go up while the box holds no other field
        while (label.length < 3 && box.parentElement && box !== root
          && [...box.parentElement.querySelectorAll('input, select, textarea')].every((e) => inputs.includes(e) || e.type === 'hidden')) {
          box = box.parentElement;
          label = question(box);
        }
      }
      out.push({ kind: inputs[0].type === 'radio' ? 'radio' : 'checkbox', el: box || inputs[0], inputs, label, options,
        html: label.length < 12 || options.some((o) => o.length > 60) ? (box || inputs[0].parentElement).outerHTML.replace(/\sclass="[^"]*"/g, '').slice(0, 2500) : undefined });
    }
    for (const el of root.querySelectorAll('input, select, textarea')) {
      if (used.has(el) || inResumePicker(el)) continue;
      const type = (el.type || '').toLowerCase();
      if (el.tagName === 'INPUT' && ['hidden', 'submit', 'button', 'file', 'search', 'radio'].includes(type)) continue;
      if (!visible(el) && type !== 'checkbox') continue;
      const box = fieldBox(el);
      const lab = (el.id && root.querySelector(`label[for="${CSS.escape(el.id)}"]`)) || (box && box.querySelector('label, legend'));
      const label = cleanLabel(lab) || el.getAttribute('aria-label') || el.placeholder || '';
      if (type === 'checkbox') { out.push({ kind: 'check', el, label }); continue; }
      const kind = el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? 'textarea' : el.getAttribute('role') === 'combobox' ? 'combobox' : type === 'number' ? 'number' : 'text';
      out.push({ kind, el, label, options: kind === 'select' ? [...el.options].map((o) => textOf(o)).filter((t) => t && !/^select an option$/i.test(t)) : undefined });
    }
    return out.filter((f) => f.label);
  }

  function valueOf(f) {
    if (f.kind === 'radio' || f.kind === 'checkbox') return f.inputs.filter((i) => i.checked).map((i) => optionText(f.el, i)).join('; ');
    if (f.kind === 'check') return f.el.checked ? 'Yes' : '';
    if (f.kind === 'select') { const o = f.el.options[f.el.selectedIndex]; return o && f.el.selectedIndex > 0 && !/^select an option$/i.test(textOf(o)) ? textOf(o) : ''; }
    return String(f.el.value || '').trim();
  }

  /** index of the option that fits the answer ("Yes", "4", "Fluent|Native"), or -1 */
  function matchOption(options, answer) {
    const opts = options.map((o) => o.toLowerCase().trim());
    for (const alt of String(answer).split('|').map((a) => a.toLowerCase().trim()).filter(Boolean)) {
      let i = opts.indexOf(alt);
      if (i < 0) i = opts.findIndex((o) => o.startsWith(alt) || alt.startsWith(o));
      if (i < 0 && /^\d+(\.\d+)?$/.test(alt)) {
        const n = Number(alt);
        i = opts.findIndex((o) => {
          const r = o.match(/(\d+)\s*(?:-|–|to)\s*(\d+)/);
          if (r) return n >= Number(r[1]) && n <= Number(r[2]);
          const p = o.match(/(\d+)\s*\+|more than (\d+)|over (\d+)/);
          if (p) return n >= Number(p[1] || p[2] || p[3]);
          return (o.match(/\d+/) || [])[0] === String(n);
        });
      }
      if (i < 0 && alt.length > 3) i = opts.findIndex((o) => o.includes(alt));
      if (i >= 0) return i;
    }
    return -1;
  }

  function setValue(el, v) {
    el.focus();
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    for (const t of ['input', 'change']) el.dispatchEvent(new Event(t, { bubbles: true }));
    el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
  }

  /** The answer for a question: what you saved for it, or a safe rule (years of experience, remote, English) */
  // the same question in other words shares one topic – keep in step with app/src/jobs/topics.js
  const TOPICS = [
    ['salary_current', /\b(current|present|last|existing)\b[^?]*\b(salary|pay|compensation|ctc|income)\b/],
    ['salary_expected', /\b(expect\w*|desired|asking)\b[^?]*\b(salary|pay|compensation|ctc|rate|income)\b|\b(salary|compensation|pay)\b[^?]*\b(expect\w*|desired|requirement)\b/],
    ['notice', /\bnotice period\b|\bhow soon can you (start|join)\b|\bearliest (start|joining) date\b|\bwhen can you (start|join)\b|\bavailab\w+ to start\b/],
    ['linkedin', /\blinked\s?in\b[^?]*\b(profile|url|link)\b|^linked\s?in\b/],
    ['website', /^(personal )?(website|portfolio)\b|\bportfolio (link|url)\b/],
    ['sales_target', /\b(sales|monthly|quarterly|revenue)\b[^?]*\b(target|quota)\b|\bquota\b/],
    ['deal_value', /\b(highest|largest|biggest)\b[^?]*\bdeal\b|\bdeal (size|value)\b/],
    ['hear', /\bhow did you (hear|find|learn|come across)\b/],
    ['pref_lang', /\bpreferred language\b/],
    ['country', /\bwhat country\b|\bcountry of residence\b|\bwhich country\b|^country\b/],
    ['sponsorship', /\bsponsor(ship)?\b/],
    ['auth_here', /\bauthori[sz]ed to work\b[^?]*\b(where you (are )?(located|live|reside|based)|your (current )?(country|location))\b/],
  ];
  const topicOf = (label) => { const l = String(label || '').toLowerCase(); return (TOPICS.find(([, re]) => re.test(l)) || [])[0] || ''; };

  const STOP = new Set('a an the you your yours do does did have has had are is was were be been being of in on at to for with and or any what which how many much this that these those there their our we us i me my currently current please would will can could should if as by from about into than'.split(' '));
  const stemW = (w) => (w.length > 5 ? w.replace(/(ments?|ers?|ing|ed|s)$/, '') : w);
  const keyWords = (t) => new Set((String(t || '').toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => !STOP.has(w)).map(stemW));
  /** your answer to a saved question that says nearly the same thing (≥ 75 % of the words shared), if it fits this field */
  function similarAnswer(f, saved) {
    const mine = keyWords(f.label);
    if (mine.size < 2) return null;
    let best = null;
    for (const x of saved) {
      if (!x.answer) continue;
      const theirs = keyWords(x.label);
      const both = [...mine].filter((w) => theirs.has(w)).length;
      const score = both / Math.max(mine.size, theirs.size);
      if (score >= 0.75 && (!best || score > best.score)) best = { score, answer: x.answer };
    }
    if (!best) return null;
    if ((f.options || []).length && matchOption(f.options, best.answer) < 0) return null;
    return best.answer;
  }

  function answerFor(f, ctx) {
    const l = f.label.toLowerCase();
    const topic = topicOf(f.label);
    // expected salary: PKR for Pakistani jobs, USD for the rest (a number when the box wants one)
    if (topic === 'salary_expected' && ctx.salary) {
      const numeric = f.kind === 'number' || /\bnumbers? only\b|\bnumeric\b|\bwhole number\b/.test(l) || f.el && /numeric/i.test(f.el.id || '');
      if (f.kind === 'select' || f.kind === 'radio') return ctx.salary.number;
      return numeric ? ctx.salary.number : ctx.salary.text;
    }
    // where you live / your nationality: you live in Pakistan and are Pakistani – Yes for Pakistan, No for any other country
    const home = /\b(located|based|living|live|resid\w*|currently in|reside)\b|\b(citizen\w*|national(ity)?|passport|hold (a|an)\b)/;
    if (home.test(l) && !/\b(authori[sz]ed|eligible|permit|visa|sponsor|willing|relocat|commut|open to)\b/.test(l) && !/^what|^which|^where|^in which/.test(l) && /\?|\b(are|do|is) you\b/.test(l)) {
      const yes = /pakistan/.test(l) || /\b(where you (are )?(located|based|live)|your (current )?(country|location))\b/.test(l);
      return yes ? 'Yes' : 'No';
    }
    if (/^(what|which) (country|nationality)|^what('s| is) your (nationality|citizenship|country)|^(country of )?(citizenship|nationality|residence)\b|^(where|in which country) (are you|do you)/.test(l)) {
      return /national|citizen/.test(l) ? 'Pakistani|Pakistan' : 'Pakistan';
    }
    // start date / notice period: immediately – a date box gets the nearest working day, a number box 0 days
    if (topic === 'notice' || /\bstart date\b|\bdate (you can|of) (start|join)|\bjoining date\b|\bnotice\b/.test(l)) {
      const isDate = (f.el && f.el.type === 'date') || /\bdate\b/.test(l) || /mm|dd|yyyy/i.test((f.el && f.el.placeholder) || '');
      if (isDate) {
        const d = new Date();
        while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
        const p2 = (n) => String(n).padStart(2, '0');
        const ph = String((f.el && f.el.placeholder) || '').toLowerCase();
        if (f.el && f.el.type === 'date') return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
        if (/^dd/.test(ph)) return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()}`;
        return `${p2(d.getMonth() + 1)}/${p2(d.getDate())}/${d.getFullYear()}`;
      }
      if (f.kind === 'number' || /\b(in )?days\b|\bnumbers? only\b|\bweeks\b/.test(l)) return '0';
      return 'Immediately|Immediate|0|Less than|Within 1 week|1 week|2 weeks';
    }
    const saved = ctx.answers[qKey(f.label)];
    if (saved != null && saved !== '') return saved;
    // nearly the same question answered before ("Have you used HubSpot?" / "Do you have experience with HubSpot?")
    const near = similarAnswer(f, ctx.saved || []);
    if (near != null) return near;
    // the same question asked in other words: your answer to it
    if (topic) {
      const same = (ctx.saved || []).find((x) => x.answer && topicOf(x.label) === topic);
      if (same) return same.answer;
    }
    // basics everyone knows
    const loc = (ctx.saved || []).find((x) => x.answer && /\b(location|city)\b/i.test(x.label));
    const country = loc ? String(loc.answer).split(',').pop().trim() : '';
    if (topic === 'hear') return 'LinkedIn|Linkedin|Job board|Online';
    if (topic === 'pref_lang') return 'English';
    if (topic === 'country' && country) return country;
    if (topic === 'sponsorship') return 'No';
    if (topic === 'auth_here') return 'Yes';
    // visa / work permit / right to work anywhere: always Yes (you asked for that)
    if (/\b(authori[sz]ed|eligible|permitted|legally able|right) to work\b|\bwork (permit|authori[sz]ation|visa)\b|\bvalid (visa|work permit|residence permit)\b|\bvisa (requirements?|status)\b|\bmeet the visa\b/.test(l) && !/\bsponsor/.test(l)) {
      return f.kind === 'select' || f.kind === 'radio' || f.kind === 'checkbox' ? 'Yes|I am authorized|Authorized|Yes, I am' : 'Yes';
    }
    // "Location", "City", "Where are you based?" -> your saved location answer
    if (/^(enter )?(location|city|current (city|location)|location \(city\)|city or location|where are you (currently )?(based|located|living))\b/.test(l) || (l.length < 40 && /\b(city|location)\b/.test(l) && /text|combobox/.test(f.kind))) {
      const k = Object.keys(ctx.answers).find((x) => /\blocation\b|\bcity\b/.test(x) && ctx.answers[x]);
      if (k) return ctx.answers[k];
    }
    if (/how many (years|yrs)|years of (work |professional |relevant )?experience|(years|yrs)\b.*\bexperience|experience\b.*\b(years|yrs)/.test(l)) return String(ctx.years);
    if (/\bremote(ly)?\b/.test(l) && /comfortable|willing|open to|able to|okay|ok with|happy to/.test(l)) return 'Yes';
    if (/english/.test(l) && /proficien|level|fluen|speak|communicat/.test(l)) return f.kind === 'text' || f.kind === 'textarea' ? 'Fluent' : 'Native or bilingual|Fluent|Full professional|Professional|Advanced|Yes';
    if (f.kind === 'check' && /\b(agree|acknowledge|consent|certify|confirm|terms|privacy)\b/.test(l)) return 'Yes';
    return null;
  }

  async function fill(f, answer) {
    if (f.kind === 'select') {
      const i = matchOption(f.options, answer);
      if (i < 0) return false;
      const opt = [...f.el.options].find((o) => textOf(o) === f.options[i]);
      setValue(f.el, opt.value);
    } else if (f.kind === 'radio' || f.kind === 'checkbox') {
      const want = f.kind === 'checkbox' ? String(answer).split(/;\s*/) : [answer];
      let hit = false;
      for (const w of want) {
        const i = matchOption(f.options, w);
        if (i < 0) continue;
        const input = f.inputs[i];
        if (!input.checked) {
          const lab = (input.id && f.el.querySelector(`label[for="${CSS.escape(input.id)}"]`)) || input;
          realClick(lab);
          await sleep(200);
          if (!input.checked) input.click();
        }
        hit = true;
      }
      if (!hit) return false;
    } else if (f.kind === 'check') {
      if (/^(yes|true|1|checked)$/i.test(String(answer)) && !f.el.checked) {
        const lab = (f.el.id && document.querySelector(`label[for="${CSS.escape(f.el.id)}"]`)) || f.el;
        realClick(lab);
        await sleep(200);
        if (!f.el.checked) f.el.click();
      }
    } else {
      setValue(f.el, String(answer));
      if (f.kind === 'combobox') {
        // a "City" box: type, then take LinkedIn's first suggestion
        await sleep(1500);
        let opt = findAny('[role="option"]', visible);
        if (!opt && String(answer).includes(',')) {
          // "Lahore, Pakistan" finds nothing -> "Lahore"
          setValue(f.el, String(answer).split(',')[0].trim());
          await sleep(1500);
          opt = findAny('[role="option"]', visible);
        }
        if (opt) { realClick(opt); await sleep(500); }
      }
    }
    await sleep(250);
    return !!valueOf(f);
  }

  /** Resume step: keep / pick the CV whose file name fits the job title best */
  async function pickResume(root, jobTitle) {
    const more = [...root.querySelectorAll('button')].find((b) => visible(b) && /show (more|all) resumes/i.test(textOf(b)));
    if (more) { realClick(more); await sleep(800); }
    let cards = [...root.querySelectorAll('.jobs-document-upload-redesign-card__container, [data-test-document-upload-card], .jobs-resume-picker__resume')].filter(visible);
    if (!cards.length) cards = [...root.querySelectorAll('input[type=radio]')].map(fileBox).filter(Boolean);
    if (!cards.length) return null;
    const nameOf = (c) => ((textOf(c).match(FILE_NAME) || [])[0] || textOf(c.querySelector('h3, .jobs-document-upload-redesign-card__file-name, [class*="file-name"]') || c)).slice(0, 120);
    const isOn = (c) => /--selected|is-selected/.test(c.className) || c.getAttribute('aria-checked') === 'true' || !!c.querySelector('input:checked');
    const words = new Set((String(jobTitle).toLowerCase().match(/[a-z]{3,}/g) || []).filter((w) => !['and', 'the', 'for', 'with', 'specialist', 'manager', 'executive', 'remote'].includes(w)));
    const score = (c) => (nameOf(c).toLowerCase().match(/[a-z]{3,}/g) || []).filter((w) => words.has(w)).length;
    const current = cards.find(isOn);
    const best = cards.reduce((a, c) => (score(c) > score(a) ? c : a), current || cards[0]);
    if (best !== current) {
      realClick(best.querySelector('label, input[type=radio]') || best);
      await sleep(600);
    }
    return { chosen: nameOf(best), all: cards.map(nameOf) };
  }

  function errorFields(root) {
    return eaFields(root).map((f) => {
      const box = fieldBox(f.el);
      const err = (box && box.querySelector('.artdeco-inline-feedback--error, [data-test-form-element-error-messages], .fb-dash-form-element-error')) || null;
      const bad = (f.el.getAttribute && f.el.getAttribute('aria-invalid') === 'true') || (err && textOf(err));
      return bad ? { ...f, error: err ? textOf(err).slice(0, 160) : '' } : null;
    }).filter(Boolean);
  }

  const sentConfirm = () => !!findAny('dialog, [role="dialog"], .artdeco-modal, h2, h3', (d) => visible(d) && /application (was )?sent|your application was sent|application submitted|applied to |you applied/i.test(textOf(d).slice(0, 400)));

  async function discardApplication() {
    for (let round = 0; round < 3; round++) {
      const r = eaRoot();
      if (!r) return true;
      const x = r.querySelector('button[aria-label="Dismiss"], button[aria-label*="dismiss" i], button[aria-label*="close" i]') || findAny('button[aria-label="Dismiss"]', visible);
      if (x) realClick(x); else pressEscape();
      for (let i = 0; i < 15; i++) {
        await sleep(300);
        // "Save this application?" -> Discard
        const d = findAny('button', (b) => visible(b) && (b.getAttribute('data-control-name') === 'discard_application_confirm_btn' || /^(discard|don.t save|do not save)\b/i.test(textOf(b)) || /^discard\b/i.test(labelOf(b))));
        if (d) { realClick(d); await sleep(900); break; }
        if (!eaRoot()) return true;
      }
    }
    const r = eaRoot();
    if (r) window.__lcbDiscard = `buttons: ${[...r.querySelectorAll('button')].map((b) => `${textOf(b)}|${labelOf(b)}`).join(' ; ')} || dialogs: ${deepAll('dialog, [role="dialog"]').filter(visible).map((d) => textOf(d).slice(0, 150)).join(' ## ')}`;
    return !r;
  }

  async function closeAfterSubmit() {
    for (let i = 0; i < 10; i++) {
      const b = findAny('button', (x) => visible(x) && (/^(done|not now)$/i.test(textOf(x)) || labelOf(x) === 'Dismiss'));
      if (!b) break;
      realClick(b);
      await sleep(700);
    }
  }

  /**
   * Applies to the job open in this tab.
   * opts: { answers: { key: answer }, years, submit (false = test: stop before Submit), title }
   * -> { status: applied | tested | needs_answers | already | external | closed | limit | failed, reason, questions, resume, trace }
   */
  async function easyApply(opts = {}) {
    window.__lcbDiscard = '';
    const r = await easyApplySteps(opts);
    if (window.__lcbDiscard) r.trace = [...(r.trace || []), { step: 99, heading: 'the form did not close', debug: window.__lcbDiscard, fields: [] }];
    return r;
  }
  async function easyApplySteps(opts) {
    const ctx = { answers: opts.answers || {}, saved: opts.saved || [], years: opts.years || 4, salary: opts.salary || null };
    const trace = [];
    let resume = null;
    await waitFor('main, body', 15000);
    let st = 'unknown';
    for (let i = 0; i < 30 && st === 'unknown'; i++) { st = jobPageState(); if (st === 'unknown') await sleep(500); }
    if (st === 'easy') {
      const top = textOf(document.querySelector('main') || document.body).slice(0, 700);
      const where = (top.match(/\b(On-site|Hybrid)\b/) || [])[1];
      if (where) return { status: 'unfit', reason: `${where} job – not remote` };
    }
    if (st !== 'easy') return { status: st, reason: { closed: 'no longer accepting applications', already: 'you already applied', external: 'not Easy Apply (applies on the company site)', unknown: 'no Apply button on the page' }[st] };
    await jitter(1500, 3000);
    const btn = eaButton();
    window.__lcbEaClicked = `${btn.tagName} ${btn.getAttribute('href') || ''} ${btn.outerHTML.slice(0, 300)}`;
    realClick(btn);
    let root = null;
    for (let i = 0; i < 40 && !root; i++) {
      await sleep(300);
      // LinkedIn's "job search safety" reminder before the form
      const go = findAny('button', (b) => visible(b) && /^continue applying$/i.test(textOf(b)));
      if (go) { realClick(go); await sleep(800); }
      root = eaRoot();
    }
    if (!root) {
      if (/reached (the|your) (daily )?(application|easy apply) limit|limit (for|on) (easy apply|applications)/i.test(textOf(document.body))) return { status: 'limit', reason: 'LinkedIn\'s daily Easy Apply limit' };
      // what the page shows instead (to fix the next version)
      const desc = (el) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${String(el.className || '').split(/\s+/).slice(0, 3).join('.')}[${['role', 'aria-label', 'data-test-modal-id', 'href'].map((a) => el.getAttribute(a) ? `${a}=${el.getAttribute(a).slice(0, 80)}` : '').filter(Boolean).join(',')}]`;
      const path = (el) => { const out = []; for (let e = el; e && out.length < 8; e = e.parentElement || (e.getRootNode && e.getRootNode().host)) out.push(desc(e)); return out; };
      const dialogs = deepAll('[role="dialog"], .artdeco-modal, [aria-modal="true"]').map((d) => ({ vis: visible(d), d: desc(d), text: textOf(d).slice(0, 200) }));
      const hits = deepAll('h1, h2, h3, button, label, span').filter((e) => /contact info|submit application|continue to next step|review your application|apply to /i.test(textOf(e) + ' ' + labelOf(e))).slice(0, 8).map((e) => ({ vis: visible(e), text: textOf(e).slice(0, 80), path: path(e) }));
      return { status: 'failed', reason: 'the Easy Apply form did not open', trace: [{ step: 0, heading: 'debug', url: location.href, clicked: window.__lcbEaClicked || '', dialogs, hits, roots: allRoots().length, fields: [] }] };
    }

    for (let step = 1; step <= 15; step++) {
      await jitter(900, 1600);
      root = eaRoot();
      if (!root) return sentConfirm() ? { status: 'applied', resume, trace } : { status: 'failed', reason: 'the form closed by itself', trace, resume };
      // the step may still be loading: wait for its Next / Review / Submit button
      const stepButton = (r) => [...r.querySelectorAll('button')].some((b) => visible(b) && /^(next|review|submit application|continue)\b/i.test(textOf(b) || labelOf(b)));
      for (let w = 0; w < 40 && root && !stepButton(root); w++) { await sleep(300); root = eaRoot(); }
      if (root && !stepButton(root) && step === 1 && !textOf(root.querySelector('[data-testid="dialog-content"]') || root).replace(/^apply to .*$/i, '').trim()) {
        // the form stayed empty: close it and press Easy Apply once more
        realClick(root.querySelector('button[aria-label="Dismiss"]') || root);
        await sleep(1500);
        await discardApplication();
        const again = eaButton();
        if (!again) return { status: 'retry', reason: 'the form stayed empty', trace };
        realClick(again);
        for (let w = 0; w < 50 && !(root && stepButton(root)); w++) { await sleep(300); root = eaRoot(); }
        if (!root || !stepButton(root)) { await discardApplication(); return { status: 'retry', reason: 'the form stayed empty', trace }; }
      }
      if (!root) return sentConfirm() ? { status: 'applied', resume, trace } : { status: 'failed', reason: 'the form closed by itself', trace, resume };
      const heading = textOf(root.querySelector('form h3, form h2, h3') || root.querySelector('h2') || root).slice(0, 80);
      const r = await pickResume(root, opts.title || '');
      if (r) resume = r;
      const fields = eaFields(root);
      // a form asking how well you speak another language = a job that needs it
      // any language but English (and Urdu, which you speak)
      const lang = fields.map((f) => (f.label.match(/proficiency in ([a-z]+)|(?:speak|fluent in|level of) ([a-z]+)\b/i) || []).slice(1).find(Boolean)).find((l) => l && /^[a-z]+(ish|ian|ese|ic|ch|an|ew|ali|aysian|ai|ni|ali)$|^(german|greek|dutch|danish|czech|thai|hindi|farsi|persian|mandarin|cantonese|tagalog|swahili|hebrew|malay)$/i.test(l) && !/^(english|urdu)$/i.test(l));
      const foreign = fields.find((f) => /[\u0600-\u06ff\u0400-\u04ff\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/.test(f.label));
      if (foreign) { await discardApplication(); return { status: 'language', reason: `the form is not in English ("${foreign.label.slice(0, 30)}")`, resume, trace }; }
      const calls = fields.find((f) => /\bdial(ing)?\b|cold[\s-]?call|calls per (day|hour)|volume of (outbound )?calls|phone calls/i.test(f.label));
      const onsite = fields.find((f) => /\bcommut\w*|\brelocat\w*|\bon[\s-]?site\b|\bin the office\b|\bin[\s-]person\b|\bwork from (our|the) office\b|\blocation (is )?suitable\b|\bis this location\b|\bour office (is|in)\b|\b(company|office) is located in\b|\bhybrid\b/i.test(f.label));
      const photo = fields.find((f) => /^(photo|picture|headshot|profile (photo|picture))\b/i.test(f.label) && !valueOf(f));
      if (photo) { await discardApplication(); return { status: 'unfit', reason: 'asks for a photo upload', resume, trace }; }
      if (onsite) { await discardApplication(); return { status: 'unfit', reason: `not remote ("${onsite.label.slice(0, 60)}")`, resume, trace }; }
      if (calls) { await discardApplication(); return { status: 'unfit', reason: `a calling job ("${calls.label.slice(0, 60)}")`, resume, trace }; }
      if (lang) { await discardApplication(); return { status: 'language', reason: `asks for ${lang[0].toUpperCase()}${lang.slice(1).toLowerCase()}`, resume, trace }; }
      const info = [];
      for (const f of fields) {
        let by = valueOf(f) ? 'prefilled' : '';
        if (!by && !/follow/i.test(f.label)) {
          const a = answerFor(f, ctx);
          if (a != null && await fill(f, a)) by = 'answer';
        }
        info.push({ label: f.label.slice(0, 150), kind: f.kind, options: (f.options || []).slice(0, 15), by, value: valueOf(f).slice(0, 60), html: f.html });
      }
      trace.push({ step, heading, fields: info });

      const btns = [...root.querySelectorAll('button')].filter((b) => visible(b) && !b.disabled);
      const find = (re) => btns.find((b) => re.test(textOf(b)) || re.test(labelOf(b)));
      const submit = find(/^submit application\b/i);
      if (submit) {
        // don't follow the company: "Follow <company> to stay up to date with their page"
        const follows = [root.querySelector('#follow-company-checkbox, input[type=checkbox][id*="follow"]'), ...eaFields(root).filter((f) => f.kind === 'check' && /^follow\b/i.test(f.label)).map((f) => f.el)].filter(Boolean);
        for (const follow of new Set(follows)) {
          if (!follow.checked) continue;
          realClick((follow.id && root.querySelector(`label[for="${CSS.escape(follow.id)}"]`)) || follow);
          await sleep(400);
          if (follow.checked) follow.click();
        }
        if (!opts.submit) { await discardApplication(); return { status: 'tested', reason: 'test run – stopped before Submit', resume, trace }; }
        await jitter(1200, 2500);
        realClick(submit);
        let ok = false;
        // sending can take a while (the form goes blank meanwhile)
        for (let i = 0; i < 110 && !ok; i++) { await sleep(400); ok = sentConfirm() || !eaRoot(); }
        ok = sentConfirm() || ok;
        await closeAfterSubmit();
        if (!ok) {
          // no message seen: the job page says "Applied …" when it went out
          await sleep(3000);
          ok = jobPageState() === 'already';
        }
        if (!ok) {
          const r2 = eaRoot();
          trace.push({ step: 96, heading: 'after Submit', debug: `url: ${location.href} || form: ${r2 ? textOf(r2).slice(0, 600) : 'closed'} || dialogs: ${deepAll('dialog, [role="dialog"]').filter(visible).map((d) => textOf(d).slice(0, 300)).join(' ## ')} || page: ${textOf(document.querySelector('main') || document.body).slice(0, 400)}`, fields: [] });
        }
        if (!ok && jobPageState() === 'easy') return { status: 'retry', reason: 'Submit did not go through', resume, trace };
        return ok ? { status: 'applied', resume, trace } : { status: 'failed', reason: 'no confirmation after Submit', resume, trace };
      }
      const next = find(/^review( your application)?\b/i) || find(/^(next|continue to next step|continue)\b/i);
      if (!next) {
        trace.push({ step: 97, heading: 'no button', debug: `${textOf(root).slice(0, 700)} || buttons: ${[...root.querySelectorAll('button, a')].map((b) => `${textOf(b).slice(0, 40)}|${labelOf(b).slice(0, 40)}`).join(' ; ')} || html: ${root.outerHTML.replace(/\sclass="[^"]*"/g, '').slice(0, 2500)}`, fields: [] });
        await discardApplication();
        return { status: 'failed', reason: `no Next / Review / Submit button on "${heading}"`, resume, trace };
      }
      const before = fields.map((f) => f.label).join('|') + heading;
      realClick(next);
      await sleep(1800);
      let after = eaRoot();
      if (!after) continue;
      const sameStep = (r) => eaFields(r).map((f) => f.label).join('|') + textOf(r.querySelector('h3, h2') || r).slice(0, 80) === before;
      let errs = errorFields(after);
      let still = sameStep(after);
      if (still && !errs.length) {
        // the next step may still be loading
        await sleep(2500);
        after = eaRoot();
        if (!after) continue;
        errs = errorFields(after);
        still = sameStep(after);
      }
      if (errs.length || still) {
        // stuck on this step: these questions need your answer (or a better one)
        const missing = errs.length ? errs : eaFields(after).filter((f) => !valueOf(f));
        const questions = missing.filter((f, n, a) => a.findIndex((x) => x.label === f.label) === n).map((f) => ({ key: qKey(f.label), label: f.label.slice(0, 300), kind: f.kind, options: (f.options || []).slice(0, 30), error: f.error || '', tried: valueOf(f).slice(0, 100) }));
        await discardApplication();
        // a language question that showed up only now = the job needs that language
        const langQ = questions.map((q) => (q.label.match(/proficiency in ([a-z]+)/i) || [])[1]).find((l) => l && !/^(english|urdu)$/i.test(l));
        if (langQ) return { status: 'language', reason: `asks for ${langQ}`, resume, trace };
        if (!questions.length) {
          trace.push({ step: 98, heading: 'stuck', debug: `${textOf(after).slice(0, 900)} || buttons: ${[...after.querySelectorAll('button')].map((b) => `${textOf(b)}|${labelOf(b)}|${b.disabled ? 'off' : 'on'}`).join(' ; ')} || inputs: ${[...after.querySelectorAll('input, select, textarea, [role="radio"], [role="checkbox"], [role="combobox"], [contenteditable]')].map((e) => `${e.tagName}:${e.type || e.getAttribute('role') || ''}:${visible(e) ? 'vis' : 'hid'}`).join(' ')}`, fields: [] });
          return { status: 'failed', reason: `stuck on "${heading}"`, resume, trace };
        }
        return { status: 'needs_answers', reason: `${questions.length} question(s) without an answer`, questions, resume, trace };
      }
    }
    await discardApplication();
    return { status: 'failed', reason: 'too many steps', resume, trace };
  }

  /** after a reload: 'already' when LinkedIn shows this job as applied */
  async function jobState() {
    await waitFor('main, body', 15000);
    let st = 'unknown';
    for (let i = 0; i < 30 && st === 'unknown'; i++) { st = jobPageState(); if (st === 'unknown') await sleep(500); }
    return st;
  }

  /**
   * The logged-in job search page (its Remote / Easy Apply filters work, unlike the public search):
   * every job on the page -> [{ job_id, title, company, location }]. Scrolls the list so all cards render.
   */
  async function jobSearchPage() {
    await waitFor('main, body', 20000);
    for (let i = 0; i < 30 && !document.querySelector('a[href*="/jobs/view/"], [data-job-id], [data-occludable-job-id]'); i++) {
      if (/no matching jobs|no results found|try (adjusting|changing) your search/i.test(textOf(document.querySelector('main') || document.body).slice(0, 3000))) return { jobs: [] };
      await sleep(500);
    }
    // the list scrolls inside its own box: scroll it (and the page) so every card renders
    const ids = () => new Set([...document.querySelectorAll('[data-occludable-job-id], [data-job-id]')].map((e) => e.getAttribute('data-occludable-job-id') || e.getAttribute('data-job-id')).concat([...document.querySelectorAll('a[href*="/jobs/view/"]')].map((a) => (a.href.match(/\/jobs\/view\/(\d+)/) || [])[1])).filter(Boolean));
    const anyLink = document.querySelector('a[href*="/jobs/view/"], [data-occludable-job-id]');
    let box = anyLink;
    while (box && box !== document.body && !(box.scrollHeight > box.clientHeight + 50 && /(auto|scroll)/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
    for (let i = 0; i < 14; i++) {
      if (box && box !== document.body) box.scrollTop += 600; else window.scrollBy(0, 800);
      await sleep(350);
    }
    const out = new Map();
    for (const id of ids()) {
      const card = document.querySelector(`[data-occludable-job-id="${id}"], [data-job-id="${id}"]`) || (document.querySelector(`a[href*="/jobs/view/${id}"]`) || {}).closest?.('li, div');
      if (!card) continue;
      const link = card.querySelector(`a[href*="/jobs/view/${id}"], a[href*="currentJobId=${id}"]`) || card.querySelector('a');
      const title = cleanLabel(link) || (link && (link.getAttribute('aria-label') || '').trim()) || '';
      const lines = (card.innerText || '').split('\n').map((x) => x.trim()).filter((x) => x && x !== title && !/^(promoted|easy apply|viewed|applied|actively (recruiting|reviewing)|be an early applicant|\d+ (applicants?|connections?)|.*school alumni.*|.*ago)$/i.test(x));
      const company = (card.querySelector('.artdeco-entity-lockup__subtitle, [class*="company-name"], [class*="subtitle"]') || {}).innerText || lines[0] || '';
      const location = (card.querySelector('.job-card-container__metadata-wrapper li, .artdeco-entity-lockup__caption, [class*="metadata"] li, [class*="caption"]') || {}).innerText || lines.find((x) => /remote|on-site|hybrid|,/i.test(x) && x !== company) || '';
      if (title) out.set(id, { job_id: id, title: title.replace(/\s+with verification$/i, '').trim(), company: company.trim(), location: location.trim(), applied: /\bapplied\b/i.test(card.innerText || '') });
    }
    return { jobs: [...out.values()], seen: ids().size, url: location.href };
  }

  window.__lcb = { v: 95, jobSearchPage, jobState, easyApply, openMessage, readThread, readInbox, inboxReplies, sendInThread, apiGet, securityCheck, postSearchStart, postSearchPage, fetchPost, fetchJobPage, fetchJob, readProfile, readCompany, scrapeConnections, snapshot, waitFor, scrollResults, extractLeads, goNextPage, findProfileUrl, openInvite, fillInvite, isLoggedIn };
})();
