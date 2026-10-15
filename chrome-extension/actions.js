// DOM actions injected into LinkedIn pages. Each one is called by background.js on request
// of the backend. They only click/type what you would click/type yourself.
(() => {
  if (window.__lcb && window.__lcb.v === 5) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
      out.set(id, {
        sales_id: id,
        name,
        sales_url: new URL(href, location.origin).href,
        title: q('[data-anonymize="title"]'),
        company: q('[data-anonymize="company-name"]'),
        location: q('[data-anonymize="location"]'),
        degree: deg,
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

  function isLoggedIn() {
    if (/\/(login|checkpoint|authwall|uas\/)/.test(location.pathname)) return false;
    return !document.querySelector('input#username, form.login__form');
  }

  window.__lcb = { v: 5, scrapeConnections, snapshot, waitFor, scrollResults, extractLeads, goNextPage, findProfileUrl, openInvite, fillInvite, isLoggedIn };
})();
