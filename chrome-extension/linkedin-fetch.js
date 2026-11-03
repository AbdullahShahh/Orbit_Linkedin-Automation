// LinkedIn post search, read straight from the extension's background worker (no tab, so Chrome can't
// freeze it). Same requests the LinkedIn page itself makes; loaded into background.js with importScripts.
/* global self */
(() => {
  const csrf = async () => {
    const c = await chrome.cookies.get({ url: 'https://www.linkedin.com', name: 'JSESSIONID' });
    return c ? c.value.replace(/"/g, '') : '';
  };

  // "Failed to fetch" = a network blip (worker waking up, Wi-Fi hiccup) – try again before giving up
  async function net(url, opts, tries = 3) {
    for (let i = 1; ; i++) {
      try { return await fetch(url, opts); } catch (e) {
        if (i >= tries || !(e instanceof TypeError)) throw e;
        await new Promise((r) => setTimeout(r, 3000 * i));
      }
    }
  }

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
  // Job attached to a post in the search results: activity id -> job id (the first job after each post)
  function jobsByActivity(text) {
    const out = {};
    const re = /urn:li:activity:(\d{15,22})|(?:jobPosting[:(]|jobs\/view\/)(\d{6,})/g;
    let cur = null;
    let m;
    while ((m = re.exec(text))) { if (m[1]) cur = m[1]; else if (cur && !out[cur]) out[cur] = m[2]; }
    return out;
  }
  const activityIds = (text) => [...new Set((text.match(/urn:li:activity:(\d{15,22})/g) || []).map((u) => u.split(':').pop()))];

  async function postSearchStart(searchUrl, size = 10) {
    const res = await net(searchUrl, { credentials: 'include' });
    if (!res.ok) throw new Error(`Post search: LinkedIn answered ${res.status}`);
    const html = await res.text();
    const first = rscOfHtml(html) || html;
    const next = nextRequestIn(first);
    if (next?.requestedArguments?.payload) next.requestedArguments.payload.count = size;
    const text = first.length > 1000 ? first : html;
    return { ids: activityIds(text), next, jobs: jobsByActivity(text) };
  }

  async function postSearchPage(next) {
    const ra = next.requestedArguments;
    const body = { pagerId: next.pagerId, clientArguments: { ...ra, states: [], screenId: '', knownTemplateIds: [] }, paginationRequest: next };
    const res = await net(`https://www.linkedin.com/flagship-web/rsc-action/actions/pagination?sduiid=${encodeURIComponent(next.pagerId || '')}`, {
      method: 'POST', credentials: 'include', headers: { 'csrf-token': await csrf(), 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Post search: LinkedIn answered ${res.status}`);
    const text = await res.text();
    return { ids: activityIds(text), jobs: jobsByActivity(text) };
  }

  /** One post from its public page: link, text, date, author */
  async function fetchPost(id) {
    const res = await net(`https://www.linkedin.com/feed/update/urn:li:activity:${id}/`, { credentials: 'omit' });
    const html = await res.text();
    const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    if (!m) return { id, error: `post page not readable (${res.status})` };
    let j;
    try { j = JSON.parse(m[1]); } catch { return { id, error: 'post data not readable' }; }
    const a = j.author || {};
    let host = '';
    let url = '';
    try { const u = new URL(a.url); host = u.hostname; url = `https://www.linkedin.com${u.pathname.replace(/\/$/, '')}`; } catch { /* no author link */ }
    const jobLink = `${j.articleBody || ''} ${html}`.match(/linkedin\.com\/jobs\/view\/(?:[^"\s/?]*-)?(\d{6,})/);
    return {
      id,
      job_id: jobLink ? jobLink[1] : '',
      url: j['@id'] || `https://www.linkedin.com/feed/update/urn:li:activity:${id}/`,
      text: String(j.articleBody || j.headline || '').slice(0, 4000),
      posted_date: j.datePublished || '',
      author_name: a.name || '',
      author_url: url,
      author_kind: /\/in\//.test(url) ? 'person' : url ? 'company' : '',
      author_country_code: (host.match(/^([a-z]{2})\.linkedin\.com$/) || [])[1] || '',
    };
  }

  /** A job with your login (LinkedIn's own app API): still open? remote? – for jobs attached to posts */
  async function fetchJobMember(id) {
    const res = await net(`https://www.linkedin.com/voyager/api/jobs/jobPostings/${encodeURIComponent(id)}`, {
      credentials: 'include', headers: { 'csrf-token': await csrf(), 'x-restli-protocol-version': '2.0.0', accept: 'application/json' },
    });
    if (!res.ok) return { id, error: `Job ${id}: LinkedIn answered ${res.status}` };
    const t = await res.text();
    const g = (re) => (t.match(re) || [])[1];
    return {
      id,
      title: g(/"title":"([^"]*)"/) || '',
      state: g(/"jobState":"(\w+)"/) || '',
      closed: /"closed":true/.test(t),
      remote: g(/"workRemoteAllowed":(true|false)/) || '',
      location: g(/"formattedLocation":"([^"]*)"/) || '',
    };
  }

  /** Several posts at once (the backend decides how many) */
  const fetchPosts = (ids) => Promise.all(ids.map((id) => fetchPost(id).catch((e) => ({ id, error: String(e.message || e) }))));

  // ---------- jobs (LinkedIn's public job pages – no login, no tab) ----------
  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
  const decode = (t) => String(t || '').replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENT[e.toLowerCase()] ?? m;
  });
  const clean = (html) => decode(String(html || '').replace(/<br\s*\/?>/gi, ' ').replace(/<\/(p|li|div|h\d)>/gi, '. ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').replace(/(\.\s*){2,}/g, '. ').trim();
  /** inner HTML of the first element whose class list has `cls` */
  function byClass(html, cls, tag = '[a-z0-9]+') {
    const m = html.match(new RegExp(`<(${tag})\\b[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>([\\s\\S]*?)</\\1>`, 'i'));
    return m ? m[2] : '';
  }
  const urlOnly = (href) => { try { const u = new URL(decode(href)); return `${/linkedin\.com$/.test(u.hostname) ? 'https://www.linkedin.com' : u.origin}${u.pathname}`; } catch { return ''; } };

  /** One page (10 jobs) of the public job search */
  async function fetchJobPage(query, start = 0) {
    const r = await net(`https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${query}&start=${start}`, { credentials: 'omit' });
    if (!r.ok) { if (start === 0) throw new Error(`Job search: LinkedIn answered ${r.status}`); return []; }
    return parseJobList(await r.text());
  }
  function parseJobList(html) {
    const out = new Map();
    for (const block of html.split(/<li\b/i).slice(1)) {
      const id = (block.match(/jobPosting:(\d+)/) || block.match(/\/jobs\/view\/[^"]*?(\d{6,})/) || [])[1];
      if (!id || out.has(id)) continue;
      const time = block.match(/<time\b[^>]*datetime="([^"]*)"[^>]*>([\s\S]*?)<\/time>/i);
      const job = {
        job_id: id,
        title: clean(byClass(block, 'base-search-card__title')),
        company: clean(byClass(block, 'base-search-card__subtitle')),
        location: clean(byClass(block, 'job-search-card__location')),
        posted: time ? clean(time[2]) : '',
        posted_date: time ? time[1] : '',
      };
      if (job.title) out.set(id, job);
    }
    return [...out.values()];
  }

  /** Full public job posting: description, seniority, company, hiring person */
  async function fetchJob(jobId) {
    const r = await net(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${encodeURIComponent(jobId)}`, { credentials: 'omit' });
    if (!r.ok) throw new Error(`Job ${jobId}: LinkedIn answered ${r.status}`);
    return parseJob(await r.text());
  }
  function parseJob(html) {
    const criteria = {};
    const re = /description__job-criteria-subheader[^>]*>([\s\S]*?)<\/h3>\s*<span[^>]*>([\s\S]*?)<\/span>/gi;
    let m;
    while ((m = re.exec(html))) criteria[clean(m[1]).toLowerCase()] = clean(m[2]);
    const orgTag = (html.match(/<a\b[^>]*topcard__org-name-link[^>]*>[\s\S]*?<\/a>/i) || [])[0] || '';
    const orgHref = (orgTag.match(/href="([^"]+)"/) || [])[1] || '';
    const companyUrl = urlOnly(orgHref);
    // the hiring person's card ("Meet the hiring team")
    const posterTag = (html.match(/<a\b[^>]*href="https:\/\/[a-z]+\.linkedin\.com\/in\/[^"]+"[^>]*>[\s\S]*?<\/a>/i) || [])[0] || '';
    const posterHref = (posterTag.match(/href="([^"]+)"/) || [])[1] || '';
    const posterName = clean(byClass(posterTag, 'base-main-card__title') || posterTag).split(/\s[•·]\s/)[0].trim();
    return {
      description: clean(byClass(html, 'show-more-less-html__markup') || byClass(html, 'description__text')).slice(0, 8000),
      seniority: criteria['seniority level'] || '',
      employment: criteria['employment type'] || '',
      location: clean(byClass(html, 'topcard__flavor--bullet')),
      company_name: clean(orgTag),
      company_url: companyUrl ? companyUrl.replace(/\/?$/, '/') : '',
      person: posterHref && posterName ? { name: posterName, url: urlOnly(posterHref) } : null,
    };
  }

  self.linkedinFetch = { postSearchStart, postSearchPage, fetchPost, fetchPosts, fetchJobMember, fetchJobPage, fetchJob, parseJobList, parseJob };
})();
